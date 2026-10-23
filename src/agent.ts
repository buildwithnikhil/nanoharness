import type { Adapter, ContentBlock, Message, ToolResultBlock, ToolUseBlock, Usage } from "./types.js";
import type { Tool } from "./tool.js";
import { validate } from "./validate.js";

export type Decision = "allow" | "deny" | { deny: string };

export type StopReason = "end_turn" | "max_turns" | "max_tokens" | "aborted" | "eval_failed";

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
  return JSON.stringify(v);
}

async function runTool(tool: Tool, input: unknown, opts: RunOptions): Promise<unknown> {
  const ms = opts.toolTimeoutMs;
  if (!ms) return tool.run(input, { signal: opts.signal });

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error(`Tool timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([Promise.resolve(tool.run(input, { signal: ctl.signal })), timeout]);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

async function execute(
  call: ToolUseBlock,
  tools: Map<string, Tool>,
  opts: RunOptions,
  seen: Map<string, number>,
): Promise<ToolResultBlock> {
  let isError = false;
  let content: string;

  try {
    content = await dispatch(call, tools, opts, seen);
  } catch (e) {
    isError = true;
    content = e instanceof Error ? e.message : String(e);
  }

  if (opts.onToolResult) content = await opts.onToolResult({ call, content, isError });
  const max = opts.maxToolResultChars;
  if (max !== undefined && content.length > max) {
    content = `${content.slice(0, max)}\n[truncated ${content.length - max} characters]`;
  }
  return { type: "tool_result", tool_use_id: call.id, content, ...(isError && { is_error: true }) };
}

async function dispatch(
  call: ToolUseBlock,
  tools: Map<string, Tool>,
  opts: RunOptions,
  seen: Map<string, number>,
): Promise<string> {
  const tool = tools.get(call.name);
  if (!tool) throw new Error(`Unknown tool: ${call.name}`);

  if (opts.maxRepeatedCalls !== undefined) {
    const key = `${call.name}:${JSON.stringify(call.input)}`;
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

  let input: unknown = call.input;
  if (tool.parse) {
    const parsed = tool.parse(input);
    if (!parsed.ok) throw new Error(`Invalid input: ${parsed.error}`);
    input = parsed.value;
  } else {
    const err = validate(input, tool.schema);
    if (err) throw new Error(`Invalid input: ${err}`);
  }

  return stringify(await runTool(tool, input, opts));
}

export async function* stream(opts: RunOptions): AsyncGenerator<AgentEvent, RunResult> {
  const { adapter, signal, maxTurns = 20 } = opts;
  const tools = new Map((opts.tools ?? []).map((t) => [t.name, t]));
  const specs = [...tools.values()].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.schema,
  }));
  const messages: Message[] =
    typeof opts.prompt === "string" ? [{ role: "user", content: opts.prompt }] : [...opts.prompt];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let finalText = "";
  let stopReason: StopReason = "max_turns";
  const seen = new Map<string, number>();
  const maxEvalRetries = opts.maxEvalRetries ?? 2;
  let evalRetries = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (signal?.aborted) {
      stopReason = "aborted";
      break;
    }

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

    usage.inputTokens += res.usage?.inputTokens ?? 0;
    usage.outputTokens += res.usage?.outputTokens ?? 0;
    messages.push({ role: "assistant", content: res.content as ContentBlock[] });

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
            typeof verdict === "object" ? verdict.feedback : "Your answer was rejected. Please try again.";
          yield { type: "eval_rejected", feedback };
          if (evalRetries >= maxEvalRetries) {
            stopReason = "eval_failed";
            break;
          }
          evalRetries++;
          messages.push({ role: "user", content: feedback });
          continue;
        }
      }
      break;
    }

    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      const result = await execute(call, tools, opts, seen);
      results.push(result);
      yield { type: "tool_result", result };
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
