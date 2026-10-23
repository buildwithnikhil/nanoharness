import type { Adapter, AdapterResponse, AdapterStopReason, TextBlock, ToolUseBlock } from "./types.js";

export interface AnthropicOptions {
  apiKey: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
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
      const res = await doFetch(url, {
        method: "POST",
        signal: req.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model ?? "claude-sonnet-5-5",
          max_tokens: opts.maxTokens ?? 4096,
          system: req.system,
          messages: req.messages,
          ...(req.tools.length ? { tools: req.tools } : {}),
        }),
      });
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
