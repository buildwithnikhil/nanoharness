import { anthropicCompatible } from "nanoharness";
import type { Adapter } from "nanoharness";

export interface AnthropicOptions {
  apiKey: string;
  /** Default "claude-sonnet-5-5". */
  model?: string;
  /** Default 16,000. Thinking counts toward it. */
  maxTokens?: number;
  /** Only for older models and compatible servers: current Claude models reject `temperature` with a 400. */
  temperature?: number;
  /** Where requests, and so the API key, are sent. Must be https (or http on localhost). Default https://api.anthropic.com. */
  baseUrl?: string;
  /** A custom `fetch`, for proxies or tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Retries for rate limits and server errors (408, 429, 500, 502, 503, 504, 529), with backoff. Default 2. */
  maxRetries?: number;
  /** Permits plain http to a non-localhost host, e.g. a gateway on your LAN. Off by default. */
  allowInsecureHttp?: boolean;
  /** Extra headers on every request, e.g. a beta flag or a gateway header. */
  headers?: Record<string, string>;
}

/** `anthropicCompatible` from nanoharness, with Anthropic's URL, a default model and the global `fetch` filled in. */
export function anthropic(opts: AnthropicOptions): Adapter {
  if (!opts.apiKey) throw new Error("anthropic(): apiKey is required");
  return anthropicCompatible({
    ...opts,
    model: opts.model ?? "claude-sonnet-5-5",
    baseUrl: opts.baseUrl ?? "https://api.anthropic.com",
    fetch: opts.fetch ?? fetch,
    name: "Anthropic API",
  });
}
