import { AdapterError, readSSE } from "nanoharness";
import type { Adapter, AdapterRequest, AdapterResponse, AdapterStopReason, Message, TextBlock, ToolUseBlock, Usage } from "nanoharness";

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Where requests, and so the API key, are sent. Must be https (or http on localhost). Default https://api.anthropic.com. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries for rate limits and server errors (408, 429, 500, 502, 503, 504, 529), with backoff. Default 2. */
  maxRetries?: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

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
      throw new AdapterError("Anthropic API: the server answered with a redirect, which is never followed so your API key and conversation stay with baseUrl", { cause: e, retryable: false });
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

const STOP: Record<string, AdapterStopReason> = {
  end_turn: "end_turn",
  refusal: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
};

// Send only the fields the API defines, so nothing an adapter or hook attached to a block reaches the provider.
function cleanMessage(m: Message): Message {
  if (typeof m.content === "string") return m;
  return {
    role: m.role,
    content: m.content.map((b) => (b.type === "tool_use" ? { type: "tool_use", id: b.id, name: b.name, input: b.input } : b)),
  };
}

function messagesUrl(baseUrl: string): string {
  let u: URL;
  try {
    u = new URL(baseUrl);
  } catch {
    throw new Error(`anthropic(): invalid baseUrl "${baseUrl}"`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) {
    throw new Error("anthropic(): baseUrl must use https (http is only allowed for localhost), so the API key is never sent in clear text");
  }
  if (u.username || u.password) throw new Error("anthropic(): baseUrl must not contain credentials");
  return `${u.origin}${u.pathname.replace(/\/+$/, "")}/v1/messages`;
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

export function anthropic(opts: AnthropicOptions): Adapter {
  if (!opts.apiKey) throw new Error("anthropic(): apiKey is required");
  const doFetch = opts.fetch ?? fetch;
  const url = messagesUrl(opts.baseUrl ?? "https://api.anthropic.com");
  const maxRetries = opts.maxRetries ?? 2;

  const body = (req: AdapterRequest, stream: boolean) =>
    JSON.stringify({
      model: opts.model ?? "claude-sonnet-5-5",
      max_tokens: opts.maxTokens ?? 4096,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      system: req.system,
      messages: req.messages.map(cleanMessage),
      ...(req.tools.length ? { tools: req.tools } : {}),
      ...(stream ? { stream: true } : {}),
    });

  // Sends the request, retrying rate limits and server errors; a final failure is an AdapterError with the status.
  async function request(payload: string, signal?: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await send(doFetch, url, {
        method: "POST",
        signal,
        // Never follow a redirect: the request carries your API key and the whole conversation.
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: payload,
      });
      if (res.ok) return res;
      const retryAfterMs = Math.min(retryDelayMs(res.headers.get("retry-after"), attempt), 30_000);
      if (!RETRYABLE.has(res.status) || attempt >= maxRetries) {
        throw new AdapterError(`Anthropic API error ${res.status}: ${await errorBody(res)}`, {
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
        content: Array<TextBlock | ToolUseBlock | { type: string }>;
        stop_reason: string;
        usage?: { input_tokens: number; output_tokens: number };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        throw new AdapterError("Anthropic API returned invalid JSON");
      }
      return {
        content: data.content.filter(
          (b): b is TextBlock | ToolUseBlock => b.type === "text" || b.type === "tool_use",
        ),
        stopReason: STOP[data.stop_reason] ?? "other",
        usage: data.usage && {
          inputTokens: data.usage.input_tokens,
          outputTokens: data.usage.output_tokens,
        },
      };
    },

    async *stream(req) {
      const res = await request(body(req, true), req.signal);
      if (!res.body) throw new AdapterError("Anthropic API returned an empty stream");
      type Partial = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; json: string } | { type: "other" };
      const blocks: Partial[] = [];
      const usage: Usage = { inputTokens: 0, outputTokens: 0 };
      let stop = "";
      let finished = false;
      for await (const { data } of readSSE(res.body)) {
        let ev: {
          type?: string;
          index?: number;
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          content_block?: { type?: string; text?: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          error?: { type?: string; message?: string };
        };
        try {
          ev = JSON.parse(data);
        } catch {
          throw new AdapterError("Anthropic API sent an invalid stream event");
        }
        const i = ev.index ?? 0;
        if (ev.type === "message_start") {
          usage.inputTokens = ev.message?.usage?.input_tokens ?? 0;
          usage.outputTokens = ev.message?.usage?.output_tokens ?? 0;
        } else if (ev.type === "content_block_start") {
          const b = ev.content_block ?? {};
          blocks[i] =
            b.type === "text"
              ? { type: "text", text: b.text ?? "" }
              : b.type === "tool_use"
                ? { type: "tool_use", id: b.id ?? "", name: b.name ?? "", json: "" }
                : { type: "other" };
        } else if (ev.type === "content_block_delta") {
          const b = blocks[i];
          if (ev.delta?.type === "text_delta" && b?.type === "text" && ev.delta.text) {
            b.text += ev.delta.text;
            yield { type: "text_delta", text: ev.delta.text };
          } else if (ev.delta?.type === "input_json_delta" && b?.type === "tool_use") {
            b.json += ev.delta.partial_json ?? "";
          }
        } else if (ev.type === "message_delta") {
          if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
          if (ev.usage?.output_tokens !== undefined) usage.outputTokens = ev.usage.output_tokens;
          if (ev.usage?.input_tokens !== undefined) usage.inputTokens = ev.usage.input_tokens;
        } else if (ev.type === "message_stop") {
          finished = true;
        } else if (ev.type === "error") {
          throw new AdapterError(`Anthropic API stream error: ${ev.error?.message ?? "unknown"}`, {
            retryable: ev.error?.type === "overloaded_error",
          });
        }
      }
      if (!finished) throw new AdapterError("Anthropic API stream ended early", { retryable: false });
      const content: Array<TextBlock | ToolUseBlock> = [];
      for (const b of blocks) {
        if (b?.type === "text" && b.text) content.push({ type: "text", text: b.text });
        else if (b?.type === "tool_use") content.push(toolBlock(b.id, b.name, b.json));
      }
      yield { type: "response", response: { content, stopReason: STOP[stop] ?? "other", usage } };
    },
  };
}
