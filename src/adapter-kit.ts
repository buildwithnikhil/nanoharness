import type { Adapter, AdapterRequest, AdapterResponse, AdapterStreamEvent, Message, TextBlock, ToolUseBlock, Usage } from "./types.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * The error an adapter should throw when the provider fails. `withRetry` reads `retryable` and `retryAfterMs`.
 * By default a status of 408, 429 or 5xx (500, 502, 503, 504, 529) is retryable.
 */
export class AdapterError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;

  constructor(message: string, opts: { status?: number; retryAfterMs?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "AdapterError";
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    this.retryable = opts.retryable ?? (opts.status !== undefined && RETRYABLE_STATUS.has(opts.status));
  }
}

/** Gives a hand-written adapter its type. Write `complete`, and `stream` if the provider can stream. */
export function defineAdapter(adapter: Adapter): Adapter {
  return adapter;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Reads a Server-Sent Events body (as used by streaming model APIs) and yields one item per event.
 * Use it to write a streaming adapter for any provider.
 */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event?: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = function* () {
    if (data.length > 0) yield { event, data: data.join("\n") };
    event = undefined;
    data = [];
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
        if (line === "") {
          yield* dispatch();
          continue;
        }
        if (line.startsWith(":")) continue; // a comment, often a keep-alive
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        let val = colon === -1 ? "" : line.slice(colon + 1);
        if (val.startsWith(" ")) val = val.slice(1);
        if (field === "event") event = val;
        else if (field === "data") data.push(val);
      }
      if (done) {
        if (buffer !== "") {
          const colon = buffer.indexOf(":");
          if (buffer.slice(0, colon) === "data") data.push(buffer.slice(colon + 1).replace(/^ /, ""));
        }
        yield* dispatch();
        return;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export interface RetryOptions {
  /** Default 2. */
  maxRetries?: number;
  /** First backoff delay; it doubles each attempt. Default 500. */
  baseDelayMs?: number;
  /** Longest single wait, also applied to a server's retry-after. Default 30,000. */
  maxDelayMs?: number;
  /**
   * Decides whether an error is worth retrying. By default: an `AdapterError` marked retryable, or a network
   * failure from `fetch`.
   */
  retryable?: (error: unknown) => boolean;
}

const defaultRetryable = (e: unknown): boolean =>
  e instanceof AdapterError ? e.retryable : e instanceof TypeError && /fetch failed|network/i.test(e.message);

/**
 * Adds retry with backoff to any adapter. A streamed reply is retried only if it failed before any text arrived,
 * because text already shown cannot be taken back.
 */
export function withRetry(adapter: Adapter, opts: RetryOptions = {}): Adapter {
  const maxRetries = opts.maxRetries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  const cap = opts.maxDelayMs ?? 30_000;
  const retryable = opts.retryable ?? defaultRetryable;
  const delay = (e: unknown, attempt: number) => {
    const hinted = e instanceof AdapterError ? e.retryAfterMs : undefined;
    const backoff = base * 2 ** attempt * (0.5 + Math.random() * 0.5); // jitter keeps parallel agents from retrying in lockstep
    return Math.min(hinted ?? backoff, cap);
  };
  const retry = (e: unknown, attempt: number, signal?: AbortSignal) => !signal?.aborted && attempt < maxRetries && retryable(e);

  const wrapped: Adapter = {
    async complete(req) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await adapter.complete(req);
        } catch (e) {
          if (!retry(e, attempt, req.signal)) throw e;
          await sleep(delay(e, attempt), req.signal);
        }
      }
    },
  };
  if (adapter.stream) {
    const inner = adapter.stream.bind(adapter);
    wrapped.stream = async function* (req) {
      for (let attempt = 0; ; attempt++) {
        let started = false;
        try {
          for await (const ev of inner(req)) {
            started = true;
            yield ev;
          }
          return;
        } catch (e) {
          if (started || !retry(e, attempt, req.signal)) throw e;
          await sleep(delay(e, attempt), req.signal);
        }
      }
    };
  }
  return wrapped;
}

/**
 * Lets at most `max` calls to the adapter run at the same time, across every run and agent that uses it.
 * Extra calls wait their turn, and leave the queue if their run is aborted.
 */
export function limitConcurrency(adapter: Adapter, max: number): Adapter {
  if (!(max >= 1)) throw new Error("limitConcurrency: max must be at least 1");
  let active = 0;
  const waiting: Array<() => void> = [];

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = waiting.indexOf(grant);
        if (i !== -1) waiting.splice(i, 1);
        reject(signal!.reason);
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        active++;
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.push(grant);
    });
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };

  const wrapped: Adapter = {
    async complete(req) {
      await acquire(req.signal);
      try {
        return await adapter.complete(req);
      } finally {
        release();
      }
    },
  };
  if (adapter.stream) {
    const inner = adapter.stream.bind(adapter);
    wrapped.stream = async function* (req) {
      await acquire(req.signal);
      try {
        yield* inner(req);
      } finally {
        release();
      }
    };
  }
  return wrapped;
}

export interface PromptAdapterOptions {
  /**
   * Calls your model with plain text and returns its reply. The system text and a transcript of the conversation
   * are provided; tool instructions are added to the system text when the run has tools.
   */
  generate: (input: { system: string; prompt: string; signal?: AbortSignal }) => Promise<string | { text: string; usage?: Usage }>;
}

function render(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const who = m.role === "user" ? "User" : "Assistant";
    if (typeof m.content === "string") {
      lines.push(`${who}: ${m.content}`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") lines.push(`${who}: ${b.text}`);
      else if (b.type === "tool_use") lines.push(`Assistant called tool ${b.name} (call ${b.id}) with input ${JSON.stringify(b.input)}`);
      else lines.push(`Tool result for call ${b.tool_use_id}${b.is_error ? " (error)" : ""}: ${b.content}`);
    }
  }
  lines.push("Assistant:");
  return lines.join("\n\n");
}

function parseToolCalls(text: string): Array<{ name: string; input: unknown }> | undefined {
  let body = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fence) body = fence[1]!;
  if (!body.startsWith("{")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const o = parsed as Record<string, unknown>;
  if (Array.isArray(o.tool_calls)) {
    return o.tool_calls.map((c) => {
      const call = (c ?? {}) as Record<string, unknown>;
      return { name: String(call.name ?? call.tool ?? ""), input: call.input ?? call.arguments ?? {} };
    });
  }
  if (typeof o.tool === "string") return [{ name: o.tool, input: o.input ?? {} }];
  return undefined;
}

/**
 * Turns any text-in, text-out model into an adapter with tool calling: a local model, a CLI, or an API without
 * native tools. Tools are described in the system text, and the model calls them by replying with JSON.
 */
export function promptAdapter(opts: PromptAdapterOptions): Adapter {
  let counter = 0;
  const prefix = Math.random().toString(36).slice(2, 8);
  return {
    async complete(req: AdapterRequest): Promise<AdapterResponse> {
      let system = req.system ?? "";
      if (req.tools.length > 0) {
        system +=
          (system ? "\n\n" : "") +
          "You can use these tools (input described as JSON Schema):\n" +
          req.tools.map((t) => `- ${t.name}: ${t.description}\n  input: ${JSON.stringify(t.input_schema)}`).join("\n") +
          '\n\nTo call tools, reply with ONLY this JSON and no other text: {"tool_calls": [{"name": "<tool name>", "input": { ... }}]}' +
          "\nYou will then see each tool result. When you have the final answer, reply with plain text and no JSON.";
      }
      const reply = await opts.generate({ system, prompt: render(req.messages), signal: req.signal });
      const text = typeof reply === "string" ? reply : reply.text;
      const usage = typeof reply === "string" ? undefined : reply.usage;

      const calls = req.tools.length > 0 ? parseToolCalls(text) : undefined;
      if (calls && calls.length > 0) {
        const content: ToolUseBlock[] = calls.map((c) => {
          const valid = c.name !== "" && c.input !== null && typeof c.input === "object" && !Array.isArray(c.input);
          return {
            type: "tool_use",
            id: `call_${prefix}_${++counter}`,
            name: c.name || "unknown",
            input: valid ? (c.input as Record<string, unknown>) : {},
            ...(valid ? {} : { error: "the tool call needs a name and an input object" }),
          };
        });
        return { content, stopReason: "tool_use", usage };
      }
      const trimmed = text.trim();
      const content: TextBlock[] = trimmed ? [{ type: "text", text: trimmed }] : [];
      return { content, stopReason: "end_turn", usage };
    },
  };
}

export type { AdapterStreamEvent };
