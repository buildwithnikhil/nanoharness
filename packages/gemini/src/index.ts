import { geminiCompatible } from "nanoharness";
import type { Adapter } from "nanoharness";

export interface GeminiOptions {
  /** The model name, e.g. "gemini-2.5-flash". Required, since Google adds and retires models often. */
  model: string;
  /** Your Gemini API key, sent as the `x-goog-api-key` header (never in the URL). Leave it out for Vertex AI. */
  apiKey?: string;
  /**
   * Default https://generativelanguage.googleapis.com/v1beta (the Gemini API). For Vertex AI, use
   * https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google
   * with `headers: { authorization: "Bearer <access token>" }`.
   */
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  /** A custom `fetch`, for proxies or tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Retries for 408, 429, 500, 502, 503 and 504 responses, with backoff. Default 2. */
  maxRetries?: number;
  /** Permits plain http to a non-localhost host, e.g. a server on your LAN. Off by default. */
  allowInsecureHttp?: boolean;
  /** Extra headers on every request, such as a Vertex AI access token. */
  headers?: Record<string, string>;
}

/** `geminiCompatible` from nanoharness, with Google's URL and the global `fetch` as defaults. */
export function gemini(opts: GeminiOptions): Adapter {
  if (!opts.model) throw new Error("gemini(): model is required");
  if (!opts.apiKey && !opts.headers) throw new Error("gemini(): pass apiKey, or headers with an access token for Vertex AI");
  return geminiCompatible({
    ...opts,
    baseUrl: opts.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta",
    fetch: opts.fetch ?? fetch,
    name: "Gemini API",
  });
}
