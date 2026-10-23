import type { Adapter, AdapterResponse, AdapterStopReason, TextBlock, ToolUseBlock } from "./types.js";

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Retries for rate limits and server errors (429, 5xx), with backoff. Default 2. */
  maxRetries?: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

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
  stop_sequence: "end_turn",
  tool_use: "tool_use",
  max_tokens: "max_tokens",
};

export function anthropic(opts: AnthropicOptions): Adapter {
  const doFetch = opts.fetch ?? fetch;
  const url = `${opts.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;

  return {
    async complete(req): Promise<AdapterResponse> {
      const body = JSON.stringify({
        model: opts.model ?? "claude-sonnet-5-5",
        max_tokens: opts.maxTokens ?? 4096,
        system: req.system,
        messages: req.messages,
        ...(req.tools.length ? { tools: req.tools } : {}),
      });
      const maxRetries = opts.maxRetries ?? 2;
      let res: Response;
      for (let attempt = 0; ; attempt++) {
        res = await doFetch(url, {
          method: "POST",
          signal: req.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": opts.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body,
        });
        if (res.ok || !RETRYABLE.has(res.status) || attempt >= maxRetries) break;
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await sleep(Math.min(wait, 30_000), req.signal);
      }
      if (!res.ok) {
        throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
      }
      const data = (await res.json()) as {
        content: Array<TextBlock | ToolUseBlock | { type: string }>;
        stop_reason: string;
        usage?: { input_tokens: number; output_tokens: number };
      };
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
