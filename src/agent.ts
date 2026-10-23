import type { Adapter, ContentBlock, Message, ToolResultBlock, ToolUseBlock, Usage } from "./types.js";
import type { Tool } from "./tool.js";
import { validate } from "./validate.js";

export type Decision = "allow" | "deny" | { deny: string };

export type StopReason = "end_turn" | "max_turns" | "max_tokens" | "aborted";

export interface RunOptions {
  adapter: Adapter;
  prompt: string | Message[];
  system?: string;
  tools?: Tool[];
  maxTurns?: number;
  signal?: AbortSignal;
  /** Called before every tool runs. Anything but "allow" is reported to the model as an error. */
  onToolCall?: (call: ToolUseBlock) => Decision | Promise<Decision>;
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
  | { type: "done"; result: RunResult };

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === undefined) return "";
  return JSON.stringify(v);
}

async function execute(call: ToolUseBlock, tools: Map<string, Tool>, opts: RunOptions): Promise<ToolResultBlock> {
  const fail = (content: string): ToolResultBlock => ({
    type: "tool_result",
    tool_use_id: call.id,
    content,
    is_error: true,
  });

  const tool = tools.get(call.name);
  if (!tool) return fail(`Unknown tool: ${call.name}`);

  if (opts.onToolCall) {
    const decision = await opts.onToolCall(call);
    if (decision !== "allow") {
      return fail(typeof decision === "object" ? `Denied: ${decision.deny}` : "Denied by policy");
    }
  }

  let input: unknown = call.input;
  if (tool.parse) {
    const parsed = tool.parse(input);
    if (!parsed.ok) return fail(`Invalid input: ${parsed.error}`);
    input = parsed.value;
  } else {
    const err = validate(input, tool.schema);
    if (err) return fail(`Invalid input: ${err}`);
  }

  try {
    const out = await tool.run(input, { signal: opts.signal });
    return { type: "tool_result", tool_use_id: call.id, content: stringify(out) };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
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
      stopReason = res.stopReason === "max_tokens" ? "max_tokens" : "end_turn";
      break;
    }

    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      const result = await execute(call, tools, opts);
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
