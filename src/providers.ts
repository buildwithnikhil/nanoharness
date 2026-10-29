import { AdapterError, readSSE, sleep } from "./adapter-kit.js";
import type { Adapter, AdapterRequest, AdapterResponse, AdapterStopReason, ContentBlock, Message, ReasoningBlock, TextBlock, ToolUseBlock, Usage } from "./types.js";

// Adapters for any server that speaks the OpenAI Chat Completions or the Anthropic Messages format: OpenAI,
// Anthropic, Ollama, vLLM, LM Studio, OpenRouter, a gateway, or your own model server. You pass the `fetch` and
// the `baseUrl`, so the core itself never reaches for the network on its own. `nanoharness-openai` and
// `nanoharness-anthropic` are these same adapters with the official URLs and the global `fetch` filled in.

/** Options shared by `openaiCompatible`, `anthropicCompatible` and `geminiCompatible`. */
export interface HttpOptions {
  /** Base URL of the API. Must be https, or http on localhost (see `allowInsecureHttp`). */
  baseUrl: string;
  /** The `fetch` to send requests with: usually the global `fetch`, or one for a proxy or tests. */
  fetch: typeof fetch;
  /** The model name, as the server knows it. */
  model: string;
  /** Sent in the provider's own header. Optional, since local servers often need none. */
  apiKey?: string;
  /** Extra headers on every request, e.g. for a gateway. They can replace the default ones. */
  headers?: Record<string, string>;
  /** Most tokens the model may write in one reply. */
  maxTokens?: number;
  /** Sampling temperature, sent only when set. Some current models reject it. */
  temperature?: number;
  /** Retries for rate limits and server errors, with backoff that honours `retry-after`. Default 2. */
  maxRetries?: number;
  /** Permits plain http to a host other than localhost, e.g. a server on your LAN or in Docker. Off by default. */
  allowInsecureHttp?: boolean;
  /** Names the provider in error messages. */
  name?: string;
}

export interface OpenAICompatibleOptions extends HttpOptions {
  /** Base URL ending before /chat/completions; for Ollama, its address with /v1 added. */
  baseUrl: string;
  /** Sent as a Bearer token. Optional, since local servers often need none. */
  apiKey?: string;
  /** Which field carries `maxTokens`. Default "max_tokens"; OpenAI's newer models want "max_completion_tokens". */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** When streaming, ask for token usage in the last chunk (`stream_options.include_usage`). Turn off for servers that reject it. Default true. */
  streamUsage?: boolean;
}

export interface AnthropicCompatibleOptions extends HttpOptions {
  /** Base URL ending before /v1/messages. */
  baseUrl: string;
  /** Sent as the `x-api-key` header. */
  apiKey?: string;
  /** Default 16,000 (thinking counts toward it); the Messages format requires a limit. */
  maxTokens?: number;
  /** The `anthropic-version` header. Default "2023-06-01". */
  version?: string;
}

/** How long to wait before a retry: the server's `retry-after` (seconds or an HTTP date) if it sent one, else exponential backoff. */
function retryDelayMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  // Jitter keeps parallel agents from retrying in lockstep.
  return 500 * 2 ** attempt * (0.5 + Math.random() * 0.5);
}

// The same statuses AdapterError treats as retryable by default (529 is Anthropic's "overloaded").
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

const ERROR_BODY_LIMIT = 1000;

async function errorBody(res: Response): Promise<string> {
  // Read only as much as is kept, so a huge error page is never buffered whole.
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length <= ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return text;
  } finally {
    reader.cancel().catch(() => {});
  }
  return `${text.slice(0, ERROR_BODY_LIMIT)}... [truncated]`;
}

function endpoint(name: string, baseUrl: string, path: string, allowInsecureHttp: boolean): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`${name}: invalid baseUrl "${baseUrl}"`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (local || allowInsecureHttp))) {
    throw new Error(`${name}: baseUrl must use https (http is only allowed for localhost, or with allowInsecureHttp), so the API key is never sent in clear text`);
  }
  if (u.username || u.password) throw new Error(`${name}: baseUrl must not contain credentials`);
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}${path}`;
}

// Header names are case-insensitive, so `Authorization` from the caller replaces the default `authorization`
// instead of being sent next to it.
function mergeHeaders(defaults: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(defaults)) out[k.toLowerCase()] = v;
  for (const [k, v] of Object.entries(extra)) out[k.toLowerCase()] = v;
  return out;
}

// Reads a JSON body. A connection dropped while reading stays a network error (so withRetry can retry it); only
// a body that is not JSON, or not an object, becomes "invalid JSON".
// A whole (non-streamed) reply is read up to this size, so a misbehaving server cannot exhaust memory.
const MAX_BODY = 64 * 1024 * 1024;

async function readText(name: string, res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) throw new AdapterError(`${name} sent a reply larger than 64 MB`, { retryable: false });
      parts.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  parts.push(decoder.decode());
  return parts.join("");
}

async function readJson(name: string, res: Response): Promise<Record<string, unknown>> {
  const text = await readText(name, res);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new AdapterError(`${name} returned invalid JSON: ${text.slice(0, 200)}`, { cause: e });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new AdapterError(`${name} returned an unexpected body: ${text.slice(0, 200)}`);
  return data as Record<string, unknown>;
}

// Sends a JSON request, retrying rate limits and server errors; a final failure is an AdapterError with the status.
function requester(name: string, opts: HttpOptions, url: string, headers: Record<string, string>, retryable: Set<number>) {
  if (typeof opts.fetch !== "function") throw new Error(`${name}: fetch is required (pass the global fetch, or your own)`);
  const send = opts.fetch;
  const maxRetries = opts.maxRetries ?? 2;
  return async function request(payload: string, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await send(url, {
          method: "POST",
          signal,
          // Never follow a redirect: the request carries your API key and the whole conversation.
          redirect: "error",
          headers: mergeHeaders({ "content-type": "application/json", ...headers }, opts.headers),
          body: payload,
        });
      } catch (e) {
        const cause = (e as { cause?: { message?: string } }).cause?.message ?? "";
        if (!signal?.aborted && /redirect/i.test(cause)) {
          throw new AdapterError(`${name}: the server answered with a redirect, which is never followed so your API key and conversation stay with baseUrl`, { cause: e, retryable: false });
        }
        throw e;
      }
      if (res.ok) return res;
      const retryAfterMs = Math.min(retryDelayMs(res.headers.get("retry-after"), attempt), 30_000);
      if (!retryable.has(res.status) || attempt >= maxRetries) {
        throw new AdapterError(`${name} error ${res.status}: ${await errorBody(res)}`, {
          status: res.status,
          ...(res.headers.has("retry-after") ? { retryAfterMs } : {}),
        });
      }
      await res.body?.cancel().catch(() => {}); // free the connection before waiting
      await sleep(retryAfterMs, signal);
    }
  };
}

// A tool call's input arrives as JSON text; a malformed one is flagged so the harness does not run it.
function toolBlock(id: string, name: string, json: string): ToolUseBlock {
  try {
    const parsed: unknown = JSON.parse(json || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { type: "tool_use", id, name, input: parsed as Record<string, unknown> };
    return { type: "tool_use", id, name, input: {}, error: "arguments must be a JSON object" };
  } catch {
    return { type: "tool_use", id, name, input: {}, error: "arguments were not valid JSON" };
  }
}

// ---------------------------------------------------------------- OpenAI Chat Completions format

const OPENAI_STOP: Record<string, AdapterStopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
  content_filter: "refusal",
};

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAIMessages(system: string | undefined, messages: Message[]): OpenAIMessage[] {
  const out: OpenAIMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const blocks: ContentBlock[] = m.content;
    const text = blocks.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("");

    if (m.role === "assistant") {
      const toolCalls = blocks
        .filter((b): b is ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function" as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      if (!text && toolCalls.length === 0) continue; // an empty assistant message is invalid for the API, so leave it out
      out.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    } else {
      // Tool results become their own "tool" messages, and they must directly follow the assistant's tool calls.
      for (const b of blocks) {
        if (b.type === "tool_result") {
          out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${b.content}` : b.content });
        }
      }
      if (text) out.push({ role: "user", content: text });
    }
  }
  return out;
}

// Builds the harness response from text and tool calls, the same way for a whole reply and a streamed one.
// A refusal comes back as its own field; its text is kept as the answer and the stop reason says it was a refusal.
function assemble(text: string, calls: Array<{ id: string; name: string; args: string }>, finish: string | undefined, usage?: Usage, refusal = ""): AdapterResponse {
  if (refusal) return { content: [{ type: "text", text: refusal }], stopReason: "refusal", ...(usage ? { usage } : {}) };
  const content: Array<TextBlock | ToolUseBlock> = [];
  if (text) content.push({ type: "text", text });
  // A malformed call is flagged, not run with an empty input: the harness reports it to the model instead.
  for (const tc of calls) content.push(toolBlock(tc.id, tc.name, tc.args));
  return {
    content,
    // "length" wins over tool calls: arguments cut off by the token limit are incomplete and must not run.
    stopReason:
      finish === "length"
        ? "max_tokens"
        : content.some((b) => b.type === "tool_use")
          ? "tool_use"
          : (OPENAI_STOP[finish ?? ""] ?? "other"),
    ...(usage ? { usage } : {}),
  };
}

/** An adapter for any server that speaks the OpenAI Chat Completions format. */
export function openaiCompatible(opts: OpenAICompatibleOptions): Adapter {
  const name = opts.name ?? "OpenAI-compatible API";
  if (!opts.model) throw new Error(`${name}: model is required`);
  const url = endpoint(name, opts.baseUrl, "/chat/completions", opts.allowInsecureHttp ?? false);
  const request = requester(name, opts, url, opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}, RETRYABLE);

  const body = (req: AdapterRequest, stream: boolean) =>
    JSON.stringify({
      model: opts.model,
      messages: toOpenAIMessages(req.system, req.messages),
      ...(opts.maxTokens !== undefined ? { [opts.maxTokensParam ?? "max_tokens"]: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(req.tools.length
        ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
        : {}),
      ...(stream ? { stream: true, ...(opts.streamUsage !== false ? { stream_options: { include_usage: true } } : {}) } : {}),
    });

  return {
    async complete(req): Promise<AdapterResponse> {
      const res = await request(body(req, false), req.signal);
      const data = (await readJson(name, res)) as {
        choices?: { message?: { content?: string | null; refusal?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
        error?: { message?: string };
      };
      const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
      if (!choice?.message) throw new AdapterError(`${name} returned no choices${data.error?.message ? `: ${data.error.message}` : ""}`);
      const toolCalls = Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : [];
      const calls = toolCalls.map((tc) => ({ id: tc?.id ?? "", name: tc?.function?.name ?? "", args: tc?.function?.arguments ?? "" }));
      return assemble(
        typeof choice.message.content === "string" ? choice.message.content : "",
        calls,
        choice.finish_reason,
        data.usage && { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
        typeof choice.message.refusal === "string" ? choice.message.refusal : "",
      );
    },

    async *stream(req) {
      const res = await request(body(req, true), req.signal);
      if (!res.body) throw new AdapterError(`${name} returned an empty stream`);
      let text = "";
      let refusal = "";
      let finish: string | undefined;
      let usage: Usage | undefined;
      let done = false;
      const calls: Array<{ id: string; name: string; args: string }> = [];
      for await (const { data } of readSSE(res.body)) {
        if (data === "[DONE]") {
          done = true;
          break;
        }
        let chunk: {
          choices?: { delta?: { content?: string | null; refusal?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: { prompt_tokens: number; completion_tokens: number } | null;
          error?: { message?: string };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new AdapterError(`${name} sent an invalid stream chunk`);
        }
        if (chunk.error) throw new AdapterError(`${name} stream error: ${chunk.error.message ?? "unknown"}`);
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          text += choice.delta.content;
          yield { type: "text_delta", text: choice.delta.content };
        }
        if (choice.delta?.refusal) refusal += choice.delta.refusal;
        for (const tc of choice.delta?.tool_calls ?? []) {
          // Some compatible servers leave out `index` and send each call whole: a new id starts a new call.
          let slot = tc.index;
          if (slot === undefined) {
            const last = calls.length - 1;
            slot = last >= 0 && (!tc.id || tc.id === calls[last]?.id) ? last : calls.length;
          }
          const c = (calls[slot] ??= { id: "", name: "", args: "" });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name && !c.name) c.name = tc.function.name;
          c.args += tc.function?.arguments ?? "";
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      if (!done && finish === undefined) throw new AdapterError(`${name} stream ended early`, { retryable: false });
      yield { type: "response", response: assemble(text, calls.filter(Boolean), finish, usage, refusal) };
    },
  };
}

// ---------------------------------------------------------------- Anthropic Messages format

const ANTHROPIC_STOP: Record<string, AdapterStopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
  // The context window filled up, so the reply is cut off.
  model_context_window_exceeded: "max_tokens",
  refusal: "refusal",
};

type AnthropicUsage = { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };

// Anthropic counts cached input apart from `input_tokens`; all three are input the model read.
const anthropicInput = (u: AnthropicUsage) => (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);

// Thinking blocks must go back to the API complete and unmodified, in their place, with the tool results.
const reasoning = (data: Record<string, unknown>): ReasoningBlock => ({
  type: "reasoning",
  provider: "anthropic",
  data,
  ...(typeof data.thinking === "string" && data.thinking ? { text: data.thinking } : {}),
});

// Send only the fields the API defines, so nothing an adapter or hook attached to a block reaches the provider.
// Reasoning written by another provider is left out.
function cleanMessage(m: Message): unknown {
  if (typeof m.content === "string") return m;
  const content: unknown[] = [];
  for (const b of m.content) {
    if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    else if (b.type === "reasoning") {
      if (b.provider === "anthropic") content.push(b.data);
    } else content.push(b);
  }
  return { role: m.role, content };
}

/** An adapter for any server that speaks the Anthropic Messages format. */
export function anthropicCompatible(opts: AnthropicCompatibleOptions): Adapter {
  const name = opts.name ?? "Anthropic-compatible API";
  if (!opts.model) throw new Error(`${name}: model is required`);
  const url = endpoint(name, opts.baseUrl, "/v1/messages", opts.allowInsecureHttp ?? false);
  const request = requester(
    name,
    opts,
    url,
    { "anthropic-version": opts.version ?? "2023-06-01", ...(opts.apiKey ? { "x-api-key": opts.apiKey } : {}) },
    RETRYABLE,
  );

  const body = (req: AdapterRequest, stream: boolean) =>
    JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 16_000,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      system: req.system,
      messages: req.messages.map(cleanMessage),
      ...(req.tools.length ? { tools: req.tools } : {}),
      ...(stream ? { stream: true } : {}),
    });

  return {
    async complete(req): Promise<AdapterResponse> {
      const res = await request(body(req, false), req.signal);
      const data = (await readJson(name, res)) as {
        content?: Array<TextBlock | ToolUseBlock | { type: string }>;
        stop_reason?: string;
        usage?: AnthropicUsage;
        error?: { message?: string };
      };
      if (!Array.isArray(data.content)) throw new AdapterError(`${name} returned no content${data.error?.message ? `: ${data.error.message}` : ""}`);
      const content: Array<TextBlock | ToolUseBlock | ReasoningBlock> = [];
      for (const b of data.content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text" || b.type === "tool_use") content.push(b as TextBlock | ToolUseBlock);
        else if (b.type === "thinking" || b.type === "redacted_thinking") content.push(reasoning(b as Record<string, unknown>));
      }
      return {
        content,
        stopReason: ANTHROPIC_STOP[data.stop_reason ?? ""] ?? "other",
        usage: data.usage && { inputTokens: anthropicInput(data.usage), outputTokens: data.usage.output_tokens ?? 0 },
      };
    },

    async *stream(req) {
      const res = await request(body(req, true), req.signal);
      if (!res.body) throw new AdapterError(`${name} returned an empty stream`);
      type Partial =
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; json: string }
        | { type: "thinking"; thinking: string; signature: string }
        | { type: "redacted_thinking"; data: string }
        | { type: "other" };
      const blocks: Partial[] = [];
      // Usage arrives in message_start and is updated (field by field, cumulatively) by message_delta.
      const raw: AnthropicUsage = {};
      const merge = (u?: AnthropicUsage) => {
        for (const [k, v] of Object.entries(u ?? {})) if (typeof v === "number") (raw as Record<string, number>)[k] = v;
      };
      let stop = "";
      let finished = false;
      for await (const { data } of readSSE(res.body)) {
        let ev: {
          type?: string;
          index?: number;
          message?: { usage?: AnthropicUsage };
          content_block?: { type?: string; text?: string; id?: string; name?: string; thinking?: string; signature?: string; data?: string };
          delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; stop_reason?: string };
          usage?: AnthropicUsage;
          error?: { type?: string; message?: string };
        };
        try {
          ev = JSON.parse(data);
        } catch {
          throw new AdapterError(`${name} sent an invalid stream event`);
        }
        const i = ev.index ?? 0;
        if (ev.type === "message_start") {
          merge(ev.message?.usage);
        } else if (ev.type === "content_block_start") {
          const b = ev.content_block ?? {};
          blocks[i] =
            b.type === "text"
              ? { type: "text", text: b.text ?? "" }
              : b.type === "tool_use"
                ? { type: "tool_use", id: b.id ?? "", name: b.name ?? "", json: "" }
                : b.type === "thinking"
                  ? { type: "thinking", thinking: b.thinking ?? "", signature: b.signature ?? "" }
                  : b.type === "redacted_thinking"
                    ? { type: "redacted_thinking", data: b.data ?? "" }
                    : { type: "other" };
        } else if (ev.type === "content_block_delta") {
          const b = blocks[i];
          if (ev.delta?.type === "text_delta" && b?.type === "text" && ev.delta.text) {
            b.text += ev.delta.text;
            yield { type: "text_delta", text: ev.delta.text };
          } else if (ev.delta?.type === "input_json_delta" && b?.type === "tool_use") {
            b.json += ev.delta.partial_json ?? "";
          } else if (ev.delta?.type === "thinking_delta" && b?.type === "thinking") {
            b.thinking += ev.delta.thinking ?? "";
          } else if (ev.delta?.type === "signature_delta" && b?.type === "thinking") {
            b.signature += ev.delta.signature ?? "";
          }
        } else if (ev.type === "message_delta") {
          if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
          merge(ev.usage);
        } else if (ev.type === "message_stop") {
          finished = true;
        } else if (ev.type === "error") {
          throw new AdapterError(`${name} stream error: ${ev.error?.message ?? "unknown"}`, {
            retryable: ev.error?.type === "overloaded_error",
          });
        }
      }
      if (!finished) throw new AdapterError(`${name} stream ended early`, { retryable: false });
      const content: Array<TextBlock | ToolUseBlock | ReasoningBlock> = [];
      for (const b of blocks) {
        if (b?.type === "text" && b.text) content.push({ type: "text", text: b.text });
        else if (b?.type === "tool_use") content.push(toolBlock(b.id, b.name, b.json));
        else if (b?.type === "thinking" || b?.type === "redacted_thinking") content.push(reasoning({ ...b }));
      }
      const usage: Usage = { inputTokens: anthropicInput(raw), outputTokens: raw.output_tokens ?? 0 };
      yield { type: "response", response: { content, stopReason: ANTHROPIC_STOP[stop] ?? "other", usage } };
    },
  };
}

// ---------------------------------------------------------------- Gemini generateContent format

export interface GeminiCompatibleOptions extends HttpOptions {
  /**
   * Base URL ending before /models/{model}:generateContent: for the Gemini API, Google's address with /v1beta
   * added; for Vertex AI, the address of your project's publisher, e.g. .../v1/projects/P/locations/L/publishers/google.
   */
  baseUrl: string;
  /** Sent as the `x-goog-api-key` header. For Vertex AI, leave it out and pass `headers: { authorization: "Bearer ..." }`. */
  apiKey?: string;
}

type GeminiPart = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
};
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };
type GeminiChunk = {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  error?: { message?: string; status?: string };
};

// Ids made up here (Gemini does not always give one) are not sent back.
const LOCAL_ID = "nh_gemini_";

function toGeminiContents(messages: Message[]): GeminiContent[] {
  const out: GeminiContent[] = [];
  const names = new Map<string, string>(); // a function response must name its function
  for (const m of messages) {
    const role = m.role === "assistant" ? "model" : "user";
    const parts: GeminiPart[] = [];
    if (typeof m.content === "string") {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const b of m.content) {
        if (b.type === "text") {
          if (b.text) parts.push({ text: b.text });
        } else if (b.type === "tool_use") {
          names.set(b.id, b.name);
          const id = b.id.startsWith(LOCAL_ID) ? {} : { id: b.id };
          parts.push({ functionCall: { ...id, name: b.name, args: b.input }, ...(b.signature ? { thoughtSignature: b.signature } : {}) });
        } else if (b.type === "tool_result") {
          const id = b.tool_use_id.startsWith(LOCAL_ID) ? {} : { id: b.tool_use_id };
          const response = b.is_error ? { error: b.content } : { result: b.content };
          parts.push({ functionResponse: { ...id, name: names.get(b.tool_use_id) ?? "unknown", response } });
        }
      }
    }
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

const GEMINI_STOP: Record<string, AdapterStopReason> = {
  STOP: "end_turn",
  MAX_TOKENS: "max_tokens",
  // Stopped by Google's safety and policy filters.
  SAFETY: "refusal",
  RECITATION: "refusal",
  BLOCKLIST: "refusal",
  PROHIBITED_CONTENT: "refusal",
  SPII: "refusal",
  IMAGE_SAFETY: "refusal",
  IMAGE_PROHIBITED_CONTENT: "refusal",
};

function geminiUsage(u: GeminiChunk["usageMetadata"]): Usage | undefined {
  if (!u) return undefined;
  // Thinking tokens are billed as output.
  return { inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
}

/** An adapter for the Gemini API (Google AI Studio) or Vertex AI, or any server that speaks Gemini's format. */
export function geminiCompatible(opts: GeminiCompatibleOptions): Adapter {
  const name = opts.name ?? "Gemini-compatible API";
  if (!opts.model) throw new Error(`${name}: model is required`);
  const model = opts.model.replace(/^models\//, "");
  if (/[?#\s]/.test(model)) throw new Error(`${name}: invalid model "${opts.model}"`);
  const path = `/models/${encodeURI(model)}`;
  const headers: Record<string, string> = opts.apiKey ? { "x-goog-api-key": opts.apiKey } : {};
  const once = requester(name, opts, endpoint(name, opts.baseUrl, `${path}:generateContent`, opts.allowInsecureHttp ?? false), headers, RETRYABLE);
  const streamed = requester(name, opts, endpoint(name, opts.baseUrl, `${path}:streamGenerateContent?alt=sse`, opts.allowInsecureHttp ?? false), headers, RETRYABLE);
  let counter = 0;
  const prefix = Math.random().toString(36).slice(2, 8);

  const body = (req: AdapterRequest) =>
    JSON.stringify({
      contents: toGeminiContents(req.messages),
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      ...(req.tools.length
        ? { tools: [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.input_schema })) }] }
        : {}),
      ...(opts.maxTokens !== undefined || opts.temperature !== undefined
        ? { generationConfig: { ...(opts.maxTokens !== undefined ? { maxOutputTokens: opts.maxTokens } : {}), ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}) } }
        : {}),
    });

  const call = (part: GeminiPart): ToolUseBlock => {
    const fc = part.functionCall!;
    const id = fc.id || `${LOCAL_ID}${prefix}_${++counter}`;
    const args = fc.args ?? {};
    const ok = args !== null && typeof args === "object" && !Array.isArray(args);
    return {
      type: "tool_use",
      id,
      name: fc.name ?? "",
      input: ok ? (args as Record<string, unknown>) : {},
      ...(ok ? {} : { error: "arguments must be a JSON object" }),
      ...(part.thoughtSignature ? { signature: part.thoughtSignature } : {}),
    };
  };

  const respond = (text: string, calls: ToolUseBlock[], finish: string | undefined, usage?: Usage): AdapterResponse => {
    if (finish === "MISSING_THOUGHT_SIGNATURE") {
      throw new AdapterError(`${name}: the history is missing a thought signature (Gemini needs the one sent with each earlier tool call)`, { retryable: false });
    }
    const content: Array<TextBlock | ToolUseBlock> = [];
    if (text) content.push({ type: "text", text });
    content.push(...calls);
    return {
      content,
      // A call cut off by the token limit is incomplete, so MAX_TOKENS wins over tool calls.
      stopReason:
        finish === "MAX_TOKENS" || GEMINI_STOP[finish ?? ""] === "refusal"
          ? GEMINI_STOP[finish!]!
          : calls.length
            ? "tool_use"
            : (GEMINI_STOP[finish ?? ""] ?? "other"),
      ...(usage ? { usage } : {}),
    };
  };

  const blocked = (data: GeminiChunk) => {
    if (!data.candidates?.length && data.promptFeedback?.blockReason) {
      throw new AdapterError(`${name} blocked the prompt: ${data.promptFeedback.blockReason}`, { retryable: false });
    }
  };

  return {
    async complete(req): Promise<AdapterResponse> {
      const res = await once(body(req), req.signal);
      const data = (await readJson(name, res)) as GeminiChunk;
      blocked(data);
      const cand = data.candidates?.[0];
      if (!cand) throw new AdapterError(`${name} returned no candidates${data.error?.message ? `: ${data.error.message}` : ""}`);
      let text = "";
      const calls: ToolUseBlock[] = [];
      for (const part of Array.isArray(cand.content?.parts) ? cand.content.parts : []) {
        if (part?.functionCall) calls.push(call(part));
        else if (typeof part?.text === "string" && !part.thought) text += part.text;
      }
      return respond(text, calls, cand.finishReason, geminiUsage(data.usageMetadata));
    },

    async *stream(req) {
      const res = await streamed(body(req), req.signal);
      if (!res.body) throw new AdapterError(`${name} returned an empty stream`);
      let text = "";
      const calls: ToolUseBlock[] = [];
      let finish: string | undefined;
      let usage: Usage | undefined;
      for await (const { data } of readSSE(res.body)) {
        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new AdapterError(`${name} sent an invalid stream chunk`);
        }
        if (chunk.error) throw new AdapterError(`${name} stream error: ${chunk.error.message ?? chunk.error.status ?? "unknown"}`);
        blocked(chunk);
        usage = geminiUsage(chunk.usageMetadata) ?? usage;
        const cand = chunk.candidates?.[0];
        if (!cand) continue;
        for (const part of cand.content?.parts ?? []) {
          if (part.functionCall) calls.push(call(part));
          else if (part.text && !part.thought) {
            text += part.text;
            yield { type: "text_delta", text: part.text };
          }
        }
        if (cand.finishReason) finish = cand.finishReason;
      }
      if (finish === undefined) throw new AdapterError(`${name} stream ended early`, { retryable: false });
      yield { type: "response", response: respond(text, calls, finish, usage) };
    },
  };
}
