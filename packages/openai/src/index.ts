import type { Adapter, AdapterResponse, AdapterStopReason, ContentBlock, Message, TextBlock, ToolUseBlock } from "nanoharness";

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
  /** Retries for 408, 429 and 5xx responses, with backoff. Default 2. */
  maxRetries?: number;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

const STOP: Record<string, AdapterStopReason> = {
  stop: "end_turn",
  tool_calls: "tool_use",
  function_call: "tool_use",
  length: "max_tokens",
};

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

export function openai(opts: OpenAIOptions): Adapter {
  if (!opts.model) throw new Error("openai(): model is required");
  const doFetch = opts.fetch ?? fetch;
  const url = chatUrl(opts.baseUrl ?? "https://api.openai.com/v1", opts.allowInsecureHttp ?? false);
  const maxRetries = opts.maxRetries ?? 2;

  return {
    async complete(req): Promise<AdapterResponse> {
      const body = JSON.stringify({
        model: opts.model,
        messages: toOpenAIMessages(req.system, req.messages),
        ...(opts.maxTokens !== undefined ? { [opts.maxTokensParam ?? "max_tokens"]: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })) }
          : {}),
      });

      let res: Response;
      for (let attempt = 0; ; attempt++) {
        res = await doFetch(url, {
          method: "POST",
          signal: req.signal,
          headers: { "content-type": "application/json", ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
          body,
        });
        if (res.ok || !RETRYABLE.has(res.status) || attempt >= maxRetries) break;
        await res.body?.cancel().catch(() => {}); // free the connection before waiting
        const retryAfter = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
        await sleep(Math.min(wait, 30_000), req.signal);
      }
      if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);

      const data = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      };
      const choice = data.choices?.[0];
      if (!choice?.message) throw new Error("OpenAI API returned no choices");

      const content: Array<TextBlock | ToolUseBlock> = [];
      if (choice.message.content) content.push({ type: "text", text: choice.message.content });
      for (const tc of choice.message.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        let error: string | undefined;
        try {
          const parsed: unknown = JSON.parse(tc.function.arguments || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
          else error = "arguments must be a JSON object";
        } catch {
          error = "arguments were not valid JSON";
        }
        // A malformed call is flagged, not run with an empty input: the harness reports it to the model instead.
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input, ...(error ? { error } : {}) });
      }

      return {
        content,
        // "length" wins over tool calls: arguments cut off by the token limit are incomplete and must not run.
        stopReason:
          choice.finish_reason === "length"
            ? "max_tokens"
            : content.some((b) => b.type === "tool_use")
              ? "tool_use"
              : (STOP[choice.finish_reason ?? ""] ?? "other"),
        usage: data.usage && { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens },
      };
    },
  };
}
