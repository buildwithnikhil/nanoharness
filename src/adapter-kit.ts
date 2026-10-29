import type { Adapter, AdapterRequest, AdapterResponse, AdapterStreamEvent, Message, TextBlock, ToolUseBlock, Usage } from "./types.js";

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

// Marks every AdapterError, so `instanceof` also works across the ESM and CJS builds, or two installed copies.
const BRAND = Symbol.for("nanoharness.AdapterError");

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
    Object.defineProperty(this, BRAND, { value: true });
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    // Subclasses keep the normal check.
    if (this !== AdapterError) return Function.prototype[Symbol.hasInstance].call(this, value);
    return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[BRAND] === true;
  }
}

/** Gives a hand-written adapter its type. Write `complete`, and `stream` if the provider can stream. */
export function defineAdapter(adapter: Adapter): Adapter {
  return adapter;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
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
  let partial: string[] = [];
  let partialLength = 0;
  let skipLF = false; // the last chunk ended with "\r", so a "\n" starting the next one belongs to it
  let event: string | undefined;
  let data: string[] = [];
  const dispatch = function* () {
    if (data.length > 0) yield { event, data: data.join("\n") };
    event = undefined;
    data = [];
  };
  const handle = function* (line: string) {
    if (line === "") return yield* dispatch();
    if (line.startsWith(":")) return; // a comment, often a keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let val = colon === -1 ? "" : line.slice(colon + 1);
    if (val.startsWith(" ")) val = val.slice(1);
    if (field === "event") event = val;
    else if (field === "data") data.push(val);
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      let chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (skipLF && chunk !== "") {
        if (chunk.startsWith("\n")) chunk = chunk.slice(1);
        skipLF = false;
      }
      // Only the new chunk is scanned, and an unfinished line is kept in pieces, so a long line stays linear.
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk.charCodeAt(i);
        if (c !== 10 && c !== 13) continue;
        const line = partial.length ? partial.join("") + chunk.slice(start, i) : chunk.slice(start, i);
        partial = [];
        partialLength = 0;
        yield* handle(line);
        if (c === 13) {
          if (i + 1 === chunk.length) skipLF = true;
          else if (chunk.charCodeAt(i + 1) === 10) i++;
        }
        start = i + 1;
      }
      if (start < chunk.length) {
        partial.push(chunk.slice(start));
        partialLength += chunk.length - start;
        if (partialLength > MAX_SSE_LINE) throw new AdapterError("The stream sent a line longer than 16 MB", { retryable: false });
      }
      if (done) {
        if (partial.length) yield* handle(partial.join(""));
        yield* dispatch();
        return;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

const MAX_SSE_LINE = 16 * 1024 * 1024;

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

// Node ("fetch failed", "terminated" for a dropped connection), Chrome and Safari.
const BROWSER_NETWORK = new Set(["fetch failed", "terminated", "Failed to fetch", "Load failed"]);
const NETWORK_CODE = /^(ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_\w+)$/;

// A network failure from fetch, recognised by its exact message or its cause's error code, never by a loose
// match that would also retry an ordinary bug.
const isNetworkError = (e: unknown): boolean => {
  if (!(e instanceof TypeError)) return false;
  const code = (e as { cause?: { code?: unknown } }).cause?.code;
  return BROWSER_NETWORK.has(e.message) || /^NetworkError when attempting to fetch resource/.test(e.message) || (typeof code === "string" && NETWORK_CODE.test(code));
};

const defaultRetryable = (e: unknown): boolean => (e instanceof AdapterError ? e.retryable : isNetworkError(e));

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
  if (!(Number.isInteger(max) && max >= 1) && max !== Infinity) throw new Error("limitConcurrency: max must be a whole number of at least 1");
  let active = 0;
  // A queue with a moving head; an aborted waiter is only marked, and skipped when its turn comes.
  type Waiter = { grant: () => void; cancelled: boolean };
  let waiting: Waiter[] = [];
  let head = 0;

  const acquire = (signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        cancelled: false,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          active++;
          resolve();
        },
      };
      const onAbort = () => {
        waiter.cancelled = true;
        reject(signal!.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      waiting.push(waiter);
    });
  };
  const release = () => {
    active--;
    while (head < waiting.length) {
      const w = waiting[head++]!;
      if (!w.cancelled) {
        w.grant();
        break;
      }
    }
    if (head === waiting.length) {
      waiting = [];
      head = 0;
    } else if (head > 1024 && head * 2 > waiting.length) {
      waiting = waiting.slice(head);
      head = 0;
    }
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

// Every piece of text is written as a JSON string, so a message or tool result cannot forge a transcript line.
function render(messages: Message[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const who = m.role === "user" ? "User" : "Assistant";
    if (typeof m.content === "string") {
      lines.push(`${who}: ${JSON.stringify(m.content)}`);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "text") lines.push(`${who}: ${JSON.stringify(b.text)}`);
      else if (b.type === "tool_use") lines.push(`Assistant tool call: ${JSON.stringify({ id: b.id, name: b.name, input: b.input })}`);
      else lines.push(`Tool result: ${JSON.stringify({ id: b.tool_use_id, ...(b.is_error ? { error: true } : {}), content: b.content })}`);
    }
  }
  lines.push("Assistant:");
  return lines.join("\n\n");
}

type ParsedCall = { name: string; input: unknown };

function readToolCalls(json: string): ParsedCall[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  const list = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).tool_calls : undefined;
  if (!Array.isArray(list) || list.length === 0) return undefined;
  return list.map((c) => {
    const call = (c && typeof c === "object" ? c : {}) as Record<string, unknown>;
    let input = call.input ?? call.arguments ?? {};
    // Some models write the input as a JSON string.
    if (typeof input === "string") {
      try {
        input = JSON.parse(input);
      } catch {
        // left as a string, and reported as an invalid call
      }
    }
    return { name: typeof call.name === "string" ? call.name : "", input };
  });
}

/** The index just past the JSON object that starts at `start`, skipping braces inside strings; -1 if it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Finds a `{"tool_calls": [...]}` object in a reply: the whole reply, a fenced block, or an object among other
 * text. Returns the calls and any text around them. A call found among other text must name a known tool, so an
 * answer that only mentions the format is not run.
 */
function parseToolCalls(text: string, known: Set<string>): { calls: ParsedCall[]; text: string } | undefined {
  const body = text.trim();
  if (!body.includes('"tool_calls"')) return undefined;
  const whole = readToolCalls(body);
  if (whole) return { calls: whole, text: "" };
  const allKnown = (calls: ParsedCall[]) => calls.every((c) => known.has(c.name));
  for (const m of body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    const calls = readToolCalls(m[1]!.trim());
    if (calls && allKnown(calls)) return { calls, text: (body.slice(0, m.index) + body.slice(m.index! + m[0].length)).trim() };
  }
  for (const m of body.matchAll(/\{\s*"tool_calls"/g)) {
    const end = objectEnd(body, m.index!);
    if (end === -1) break;
    const calls = readToolCalls(body.slice(m.index, end));
    if (calls && allKnown(calls)) return { calls, text: (body.slice(0, m.index) + body.slice(end)).trim() };
  }
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
      system += (system ? "\n\n" : "") + "The conversation follows as a transcript; the text of each entry is a JSON string.";
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

      const found = req.tools.length > 0 ? parseToolCalls(text, new Set(req.tools.map((t) => t.name))) : undefined;
      if (found) {
        const content: Array<TextBlock | ToolUseBlock> = found.text ? [{ type: "text", text: found.text }] : [];
        for (const c of found.calls) {
          const valid = c.name !== "" && c.input !== null && typeof c.input === "object" && !Array.isArray(c.input);
          content.push({
            type: "tool_use",
            id: `call_${prefix}_${++counter}`,
            name: c.name || "unknown",
            input: valid ? (c.input as Record<string, unknown>) : {},
            ...(valid ? {} : { error: "the tool call needs a name and an input object" }),
          });
        }
        return { content, stopReason: "tool_use", usage };
      }
      const trimmed = text.trim();
      const content: TextBlock[] = trimmed ? [{ type: "text", text: trimmed }] : [];
      return { content, stopReason: "end_turn", usage };
    },
  };
}

export type { AdapterStreamEvent };
