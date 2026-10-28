import type { Adapter, AdapterResponse, AdapterStopReason, Message, TextBlock, ToolUseBlock } from "nanoharness";

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /** Where requests, and so the API key, are sent. Must be https (or http on localhost). Default https://api.anthropic.com. */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries for rate limits and server errors (429, 5xx), with backoff. Default 2. */
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
  const text = await res.text().catch(() => "");
  return text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}... [truncated ${text.length - ERROR_BODY_LIMIT} characters]` : text;
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

export function anthropic(opts: AnthropicOptions): Adapter {
  if (!opts.apiKey) throw new Error("anthropic(): apiKey is required");
  const doFetch = opts.fetch ?? fetch;
  const url = messagesUrl(opts.baseUrl ?? "https://api.anthropic.com");

  return {
    async complete(req): Promise<AdapterResponse> {
      const body = JSON.stringify({
        model: opts.model ?? "claude-sonnet-5-5",
        max_tokens: opts.maxTokens ?? 4096,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        system: req.system,
        messages: req.messages.map(cleanMessage),
        ...(req.tools.length ? { tools: req.tools } : {}),
      });
      const maxRetries = opts.maxRetries ?? 2;
      let res: Response;
      for (let attempt = 0; ; attempt++) {
        res = await doFetch(url, {
          method: "POST",
          signal: req.signal,
          // Never follow a redirect: the request carries your API key and the whole conversation.
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body,
        });
        if (res.ok || !RETRYABLE.has(res.status) || attempt >= maxRetries) break;
        await res.body?.cancel().catch(() => {}); // free the connection before waiting
        await sleep(Math.min(retryDelayMs(res.headers.get("retry-after"), attempt), 30_000), req.signal);
      }
      if (!res.ok) {
        throw new Error(`Anthropic API error ${res.status}: ${await errorBody(res)}`);
      }
      let data: {
        content: Array<TextBlock | ToolUseBlock | { type: string }>;
        stop_reason: string;
        usage?: { input_tokens: number; output_tokens: number };
      };
      try {
        data = (await res.json()) as typeof data;
      } catch {
        throw new Error("Anthropic API returned invalid JSON");
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
  };
}
