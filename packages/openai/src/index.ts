import { openaiCompatible } from "nanoharness";
import type { Adapter } from "nanoharness";

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
  /**
   * Which field carries `maxTokens`. Default "max_completion_tokens" for OpenAI (the older "max_tokens" is deprecated
   * and rejected by reasoning models), and "max_tokens" when `baseUrl` is set, since most compatible servers expect it.
   */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  temperature?: number;
  /** A custom `fetch`, for proxies or tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Retries for 408, 429, 500, 502, 503 and 504 responses, with backoff. Default 2. */
  maxRetries?: number;
  /** When streaming, ask the server for token usage in the last chunk (`stream_options.include_usage`). Turn off for servers that reject it. Default true. */
  streamUsage?: boolean;
  /** Extra headers on every request, e.g. for a gateway. */
  headers?: Record<string, string>;
}

/** `openaiCompatible` from nanoharness, with OpenAI's URL and the global `fetch` as defaults. */
export function openai(opts: OpenAIOptions): Adapter {
  if (!opts.model) throw new Error("openai(): model is required");
  return openaiCompatible({
    ...opts,
    baseUrl: opts.baseUrl ?? "https://api.openai.com/v1",
    maxTokensParam: opts.maxTokensParam ?? (opts.baseUrl ? "max_tokens" : "max_completion_tokens"),
    fetch: opts.fetch ?? fetch,
    name: "OpenAI API",
  });
}
