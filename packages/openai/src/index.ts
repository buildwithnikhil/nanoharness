import { AdapterError, readSSE } from "nanoharness";
import type { Adapter, AdapterRequest, AdapterResponse, AdapterStopReason, ContentBlock, Message, TextBlock, ToolUseBlock, Usage } from "nanoharness";

export interface OpenAIOptions {
  /** The model name, e.g. "gpt-4.1" or "llama3.1". Required because every server names models differently. */
  model: string;
  /** Sent as a Bearer token. Optional, since local servers such as Ollama do not need one. */
  apiKey?: string;
  /** Base URL of the API, ending before /chat/completions. Default https://api.openai.com/v1. Must be https, or http on localhost. */
  baseUrl?: string;
  /** Permits plain http to a non-localhost host, e.g. a server on your LAN or in Docker. Off by default. */
  allowInsecureHttp?: boolean;
  maxTokens?: number;
  /** Which field carries `maxTokens`. Default "max_tokens"; OpenAI's newer models want "max_completion_tokens". */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  temperature?: number;
  /** A custom `fetch`, for proxies or tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Retries for 408, 429, 500, 502, 503 and 504 responses, with backoff. Default 2. */
  maxRetries?: number;
  /** When streaming, ask the server for token usage in the last chunk (`stream_options.include_usage`). Turn off for servers that reject it. Default true. */
  streamUsage?: boolean;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const STOP: Record<string, AdapterStopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
};

/** How long to wait before a retry: the server's `retry-after` (seconds or an HTTP date) if it sent one, else exponential backoff. */
function retryDelayMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  }
  return 500 * 2 ** attempt;
}

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

// A redirect is refused (redirect: "error"), and the error says so instead of a bare "fetch failed".
async function send(doFetch: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause?.message ?? "";
    if (!init.signal?.aborted && /redirect/i.test(cause)) {
      throw new AdapterError("OpenAI API: the server answered with a redirect, which is never followed so your API key and conversation stay with baseUrl", { cause: e, retryable: false });
    }
    throw e;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function chatUrl(baseUrl: string, allowInsecureHttp: boolean): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`openai(): invalid baseUrl "${baseUrl}"`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && (local || allowInsecureHttp))) {
    throw new Error("openai(): baseUrl must use https (http is only allowed for localhost, or with allowInsecureHttp)");
  }
  if (u.username || u.password) throw new Error("openai(): baseUrl must not contain credentials");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}/chat/completions`;
}

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
function assemble(text: string, calls: Array<{ id: string; name: string; args: string }>, finish: string | undefined, usage?: Usage): AdapterResponse {
  const content: Array<TextBlock | ToolUseBlock> = [];
  if (text) content.push({ type: "text", text });
  for (const tc of calls) {
    let input: Record<string, unknown> = {};
    let error: string | undefined;
    try {
      const parsed: unknown = JSON.parse(tc.args || "{}");
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
      else error = "arguments must be a JSON object";
    } catch {
      error = "arguments were not valid JSON";
    }
    // A malformed call is flagged, not run with an empty input: the harness reports it to the model instead.
    content.push({ type: "tool_use", id: tc.id, name: tc.name, input, ...(error ? { error } : {}) });
  }
  return {
    content,
    // "length" wins over tool calls: arguments cut off by the token limit are incomplete and must not run.
    stopReason:
      finish === "length"
        ? "max_tokens"
        : content.some((b) => b.type === "tool_use")
          ? "tool_use"
          : (STOP[finish ?? ""] ?? "other"),
    ...(usage ? { usage } : {}),
  };
}

export function openai(opts: OpenAIOptions): Adapter {
  if (!opts.model) throw new Error("openai(): model is required");
  const doFetch = opts.fetch ?? fetch;
  const url = chatUrl(opts.baseUrl ?? "https://api.openai.com/v1", opts.allowInsecureHttp ?? false);
  const maxRetries = opts.maxRetries ?? 2;

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

  // Sends the request, retrying rate limits and server errors; a final failure is an AdapterError with the status.
  async function request(payload: string, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await send(doFetch, url, {
        method: "POST",
        signal,
        // Never follow a redirect: the request carries your API key and the whole conversation.
        redirect: "error",
        headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        body: payload,
      });
      if (res.ok) return res;
      const retryAfterMs = Math.min(retryDelayMs(res.headers.get("retry-after"), attempt), 30_000);
      if (!RETRYABLE.has(res.status) || attempt >= maxRetries) {
        throw new AdapterError(`OpenAI API error ${res.status}: ${await errorBody(res)}`, {
          status: res.status,
          ...(res.headers.has("retry-after") ? { retryAfterMs } : {}),
        });
      }
      await res.body?.cancel().catch(() => {}); // free the connection before waiting
      await sleep(retryAfterMs, signal);
    }
  }

  return {
    async complete(req): Promise<AdapterResponse> {
      const res = await request(body(req, false), req.signal);
      let data: {
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        throw new AdapterError("OpenAI API returned invalid JSON");
      }
      const choice = data.choices?.[0];
      if (!choice?.message) throw new AdapterError("OpenAI API returned no choices");
      const calls = (choice.message.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments }));
      return assemble(
        choice.message.content ?? "",
        calls,
        choice.finish_reason,
        data.usage && { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
      );
    },

    async *stream(req) {
      const res = await request(body(req, true), req.signal);
      if (!res.body) throw new AdapterError("OpenAI API returned an empty stream");
      let text = "";
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
          choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: { prompt_tokens: number; completion_tokens: number } | null;
          error?: { message?: string };
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new AdapterError("OpenAI API sent an invalid stream chunk");
        }
        if (chunk.error) throw new AdapterError(`OpenAI API stream error: ${chunk.error.message ?? "unknown"}`);
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) {
          text += choice.delta.content;
          yield { type: "text_delta", text: choice.delta.content };
        }
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
      if (!done && finish === undefined) throw new AdapterError("OpenAI API stream ended early", { retryable: false });
      yield { type: "response", response: assemble(text, calls.filter(Boolean), finish, usage) };
    },
  };
}
