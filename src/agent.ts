import type { Adapter, ContentBlock, Message, ToolResultBlock, ToolUseBlock, Usage } from "./types.js";
import type { Budget, Tool, ToolContext } from "./tool.js";
import { appendUserInPlace } from "./messages.js";
import { canonical, validate } from "./validate.js";

export type Decision = "allow" | "deny" | { deny: string };

export type StopReason = "end_turn" | "max_turns" | "max_tokens" | "aborted" | "eval_failed" | "budget_exceeded";

/** `true` accepts the answer; `false` or `{ feedback }` rejects it and asks the model to try again. */
export type EvalResult = boolean | { feedback: string };

export interface ToolResultInfo {
  call: ToolUseBlock;
  content: string;
  isError: boolean;
}

export interface RunOptions {
  adapter: Adapter;
  prompt: string | Message[];
  system?: string;
  tools?: Tool[];
  maxTurns?: number;
  signal?: AbortSignal;
  /** Called before every tool runs. Anything but "allow" is reported to the model as an error. */
  onToolCall?: (call: ToolUseBlock) => Decision | Promise<Decision>;
  /** Rewrites tool output before the model sees it, e.g. to redact secrets or fence untrusted text. */
  onToolResult?: (info: ToolResultInfo) => string | Promise<string>;
  /** Hard cap on the characters of any single tool result, applied after `onToolResult`. */
  maxToolResultChars?: number;
  /** Aborts a tool that runs longer than this; the model gets an error result. */
  toolTimeoutMs?: number;
  /** Blocks a tool call once the identical call (name and input) has been made this many times. */
  maxRepeatedCalls?: number;
  /** Checks the model's final answer. Rejections are fed back to the model. */
  evaluate?: (ctx: { finalText: string; messages: Message[] }) => EvalResult | Promise<EvalResult>;
  /** How many times a rejected answer may be retried. Default 2. */
  maxEvalRetries?: number;
  /** Runs up to this many tool calls from one model turn at the same time. Default 1 (in order). */
  toolConcurrency?: number;
  /** Most model calls allowed in total, counting every sub-agent. Stops with `budget_exceeded`. Default: no limit. */
  maxModelCalls?: number;
  /** Called with the token usage of every model call, including those of sub-agents. Set by `defineAgent`. */
  onUsage?: (usage: Usage) => void;
  /** Nesting level, set by `defineAgent` for sub-agents. Not normally set by hand. */
  depth?: number;
  /** Budget inherited from a parent run, set by `defineAgent` for sub-agents. Not normally set by hand. */
  budget?: Budget;
}

export interface RunResult {
  messages: Message[];
  finalText: string;
  stopReason: StopReason;
  usage: Usage;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; call: ToolUseBlock }
  | { type: "tool_result"; result: ToolResultBlock }
  | { type: "eval_rejected"; feedback: string }
  | { type: "done"; result: RunResult };

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  return JSON.stringify(v) ?? "";
}

// Runs a tool and stops waiting for it when the run is aborted or `toolTimeoutMs` passes. The tool gets an
// AbortSignal for both cases; a tool that ignores it keeps running in the background, but its result is dropped.
async function runTool(tool: Tool, input: unknown, opts: RunOptions, base: ToolContext): Promise<unknown> {
  const { signal } = opts;
  const ms = opts.toolTimeoutMs;
  if (!signal && !ms) return tool.run(input, { ...base });

  const ctl = new AbortController();
  const cleanups: Array<() => void> = [];
  const guards: Array<Promise<never>> = [];
  if (signal) {
    guards.push(
      new Promise<never>((_, reject) => {
        const onAbort = () => {
          ctl.abort();
          reject(new Error("Aborted"));
        };
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        cleanups.push(() => signal.removeEventListener("abort", onAbort));
      }),
    );
  }
  if (ms) {
    guards.push(
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          ctl.abort();
          reject(new Error(`Tool timed out after ${ms}ms`));
        }, ms);
        cleanups.push(() => clearTimeout(timer));
      }),
    );
  }
  try {
    const running = Promise.resolve().then(() => tool.run(input, { ...base, signal: ctl.signal }));
    running.catch(() => {}); // a failure that arrives after an abort or timeout is ignored
    return await Promise.race([running, ...guards]);
  } finally {
    for (const cleanup of cleanups) cleanup();
  }
}

// Keeps the result within `max` characters, marker included, without cutting an emoji in half.
function truncate(content: string, max: number): string {
  if (content.length <= max) return content;
  const reserve = `\n[truncated ${content.length} characters]`.length;
  let keep = max - reserve;
  const cut = (n: number) => (n > 0 && /[\uD800-\uDBFF]/.test(content[n - 1]!) ? n - 1 : n);
  if (keep <= 0) return content.slice(0, cut(max));
  keep = cut(keep);
  return `${content.slice(0, keep)}\n[truncated ${content.length - keep} characters]`;
}

async function execute(
  call: ToolUseBlock,
  tools: Map<string, Tool>,
  opts: RunOptions,
  seen: Map<string, number>,
  base: ToolContext,
): Promise<ToolResultBlock> {
  let isError = false;
  let content: string;

  if (opts.signal?.aborted) {
    isError = true;
    content = "Aborted before the tool could run.";
  } else {
    try {
      content = await dispatch(call, tools, opts, seen, base);
    } catch (e) {
      isError = true;
      content = e instanceof Error ? e.message : String(e);
    }
  }

  if (opts.onToolResult) {
    // A hook that fails or returns the wrong type must not let the raw output through, and must not end the run.
    try {
      const out = await opts.onToolResult({ call, content, isError });
      if (typeof out !== "string") throw new TypeError("onToolResult must return a string");
      content = out;
    } catch {
      isError = true;
      content = "The tool result could not be processed.";
    }
  }
  if (opts.maxToolResultChars !== undefined) content = truncate(content, opts.maxToolResultChars);
  return { type: "tool_result", tool_use_id: call.id, content, ...(isError && { is_error: true }) };
}

async function dispatch(
  call: ToolUseBlock,
  tools: Map<string, Tool>,
  opts: RunOptions,
  seen: Map<string, number>,
  base: ToolContext,
): Promise<string> {
  if (call.error) throw new Error(`Invalid tool call: ${call.error}`);
  const tool = tools.get(call.name);
  if (!tool) throw new Error(`Unknown tool: ${call.name}`);

  if (opts.maxRepeatedCalls !== undefined) {
    const key = `${call.name}:${canonical(call.input)}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > opts.maxRepeatedCalls) {
      throw new Error(`Repeated identical call to ${call.name} blocked; try a different approach`);
    }
  }

  if (opts.onToolCall) {
    const decision = await opts.onToolCall(call);
    if (decision !== "allow") {
      throw new Error(typeof decision === "object" ? `Denied: ${decision.deny}` : "Denied by policy");
    }
  }

  // The run may have been aborted while onToolCall was deciding.
  if (opts.signal?.aborted) throw new Error("Aborted before the tool could run.");

  let input: unknown = call.input;
  if (tool.parse) {
    const parsed = tool.parse(input);
    if (!parsed.ok) throw new Error(`Invalid input: ${parsed.error}`);
    input = parsed.value;
  } else {
    const err = validate(input, tool.schema);
    if (err) throw new Error(`Invalid input: ${err}`);
  }

  return stringify(await runTool(tool, input, opts, base));
}

export async function* stream(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult> {
  const { adapter, signal, maxTurns = 20 } = opts;
  const tools = new Map<string, Tool>();
  for (const t of opts.tools ?? []) {
    if (tools.has(t.name)) throw new Error(`Duplicate tool name: ${t.name}`);
    tools.set(t.name, t);
  }
  const specs = [...tools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
  }));
  const messages: Message[] =
    typeof opts.prompt === "string" ? [{ role: "user", content: opts.prompt }] : [...opts.prompt];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const budget = opts.budget ?? (opts.maxModelCalls !== undefined ? { used: 0, max: opts.maxModelCalls } : undefined);
  // Every model call in this run, and in the sub-agents it starts, is counted here and reported upward as it happens,
  // so usage is not lost when a sub-agent fails part-way.
  const credit = (u: Usage) => {
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    opts.onUsage?.(u);
  };
  const base: ToolContext = { depth: opts.depth ?? 0, budget, addUsage: credit };
  const concurrency = Math.max(1, Math.floor(opts.toolConcurrency ?? 1));
  let finalText = "";
  let stopReason: StopReason = "max_turns";
  const seen = new Map<string, number>();
  const maxEvalRetries = opts.maxEvalRetries ?? 2;
  let evalRetries = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    stopReason = "max_turns"; // stays this way if the loop ends because no turns are left
    if (signal?.aborted) {
      stopReason = "aborted";
      break;
    }

    if (budget && budget.used >= budget.max) {
      stopReason = "budget_exceeded";
      break;
    }
    if (budget) budget.used++;

    let res;
    try {
      res = await adapter.complete({ system: opts.system, messages, tools: specs, signal });
    } catch (e) {
      if (signal?.aborted) {
        stopReason = "aborted";
        break;
      }
      throw e;
    }

    if (res.usage) credit(res.usage);
    if (res.stopReason === "max_tokens" && res.content.some((b) => b.type === "tool_use")) {
      // A tool call cut off by the token limit has incomplete input, so it must not run.
      // The turn is dropped so the conversation stays valid and can be retried with a larger limit.
      finalText = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      stopReason = "max_tokens";
      break;
    }
    // An empty reply is not stored: providers reject empty assistant messages when the history is replayed.
    if (res.content.length > 0) messages.push({ role: "assistant", content: res.content as ContentBlock[] });

    const calls: ToolUseBlock[] = [];
    finalText = "";
    for (const block of res.content) {
      if (block.type === "text") {
        finalText += block.text;
        yield { type: "text", text: block.text };
      } else {
        calls.push(block);
        yield { type: "tool_call", call: block };
      }
    }

    if (calls.length === 0) {
      if (res.stopReason === "max_tokens") {
        stopReason = "max_tokens";
        break;
      }
      stopReason = "end_turn";
      if (opts.evaluate) {
        const verdict = await opts.evaluate({ finalText, messages });
        if (verdict !== true) {
          const feedback =
            typeof verdict === "object" && typeof verdict.feedback === "string" && verdict.feedback.trim()
              ? verdict.feedback
              : "Your answer was rejected. Please try again.";
          yield { type: "eval_rejected", feedback };
          // An answer that was rejected is never reported as a success, even if no turns are left to retry.
          stopReason = "eval_failed";
          if (evalRetries >= maxEvalRetries) break;
          evalRetries++;
          appendUserInPlace(messages, feedback);
          continue;
        }
      }
      break;
    }

    const results: ToolResultBlock[] = [];
    if (concurrency === 1) {
      for (const call of calls) {
        const result = await execute(call, tools, opts, seen, base);
        results.push(result);
        yield { type: "tool_result", result };
      }
    } else {
      // Results are reported in call order once the batch finishes.
      let next = 0;
      const out: ToolResultBlock[] = new Array(calls.length);
      const worker = async () => {
        while (next < calls.length) {
          const i = next++;
          out[i] = await execute(calls[i]!, tools, opts, seen, base);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, calls.length) }, worker));
      for (const result of out) {
        results.push(result);
        yield { type: "tool_result", result };
      }
    }
    messages.push({ role: "user", content: results });
  }

  const result: RunResult = { messages, finalText, stopReason, usage };
  yield { type: "done", result };
  return result;
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const it = stream(opts);
  for (;;) {
    const next = await it.next();
    if (next.done) return next.value;
  }
}
