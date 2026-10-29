import { drain, run, stream } from "./agent.js";
import type { AgentEvent, RunOptions, RunResult } from "./agent.js";
import { defineTool } from "./tool.js";
import type { Budget, Tool } from "./tool.js";
import type { Message, Store, Usage } from "./types.js";

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

// Aborts when any of the signals does. `dispose` removes the listeners again (only needed on Node before 20.3).
function anySignal(signals: AbortSignal[]): { signal: AbortSignal; dispose: () => void } {
  if (typeof AbortSignal.any === "function") return { signal: AbortSignal.any(signals), dispose: () => {} };
  const ctl = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const s of signals) {
    if (s.aborted) {
      ctl.abort();
      break;
    }
    const onAbort = () => ctl.abort();
    s.addEventListener("abort", onAbort, { once: true });
    cleanups.push(() => s.removeEventListener("abort", onAbort));
  }
  return { signal: ctl.signal, dispose: () => cleanups.forEach((c) => c()) };
}

export interface AgentConfig extends Omit<RunOptions, "prompt" | "onEvent"> {
  /** Also the tool name when used via `asTool`, so it must match [a-zA-Z0-9_-]{1,64}. */
  name: string;
  /** Most model calls in total across this agent and all its sub-agents. Default 200; set Infinity to disable. */
  maxModelCalls?: number;
  /** Tool calls from one turn run up to this many at once, so sub-agents run in parallel. Default 4; set 1 for in-order. */
  toolConcurrency?: number;
  /** How deeply agents may call agents. Calls beyond this fail with a tool error. Default 4. */
  maxDepth?: number;
  /** Called for every event of this agent's loop, tagged with its name. */
  onEvent?: (agent: string, event: AgentEvent) => void | Promise<void>;
}

export interface Agent {
  name: string;
  run(prompt: string | Message[], overrides?: Partial<Omit<RunOptions, "prompt">>): Promise<RunResult>;
  /** Exposes this agent to another agent as a tool that takes a `task` string and returns the final answer. */
  asTool(description: string): Tool<{ task: string }>;
}

export function defineAgent(config: AgentConfig): Agent {
  const { name, onEvent, maxDepth = 4, ...base } = config;
  if (!NAME.test(name)) throw new Error(`Invalid agent name "${name}": use letters, digits, _ or - (max 64)`);

  const exec = async (prompt: string | Message[], overrides: Partial<Omit<RunOptions, "prompt">> = {}) => {
    const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
    const opts: RunOptions = { toolConcurrency: 4, maxModelCalls: 200, ...base, ...defined, prompt };
    // When this agent runs as a sub-agent, report usage to its own onUsage as well as to the parent.
    const own = base.onUsage;
    const parent = defined.onUsage as RunOptions["onUsage"];
    if (own && parent && own !== parent) opts.onUsage = (u) => (own(u), parent(u));
    // Keep the agent's own signal as well as the caller's.
    let dispose = () => {};
    if (base.signal && defined.signal) {
      const merged = anySignal([base.signal, defined.signal as AbortSignal]);
      opts.signal = merged.signal;
      dispose = merged.dispose;
    }
    try {
      if (!onEvent) return await run(opts);
      return await drain(stream(opts), (event) => onEvent(name, event));
    } finally {
      dispose();
    }
  };

  return {
    name,
    run: exec,
    asTool: (description) =>
      defineTool<{ task: string }>({
        name,
        description,
        schema: {
          type: "object",
          properties: { task: { type: "string", description: "A self-contained task for this agent" } },
          required: ["task"],
        },
        run: async ({ task }, ctx) => {
          const depth = ctx.depth ?? 0;
          if (depth >= maxDepth) throw new Error(`${name}: maximum agent depth (${maxDepth}) exceeded`);
          const r = await exec(task, { signal: ctx.signal, depth: depth + 1, budget: ctx.budget, onUsage: ctx.addUsage });
          if (r.stopReason !== "end_turn") throw new Error(`${name} stopped early (${r.stopReason})`);
          return r.finalText;
        },
      }),
  };
}

// One model-call budget for every agent in a pipeline or parallel group (otherwise each agent has its own).
function sharedBudget(max: number | undefined): Budget | undefined {
  return max === undefined ? undefined : { used: 0, max };
}

/** Runs agents in order; each one receives the previous one's final answer. Throws if a step does not finish. */
export async function pipeline(
  agents: Agent[],
  input: string,
  opts: { signal?: AbortSignal; maxModelCalls?: number } = {},
): Promise<{ finalText: string; results: RunResult[]; usage: Usage }> {
  const results: RunResult[] = [];
  const budget = sharedBudget(opts.maxModelCalls);
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let text = input;
  for (const agent of agents) {
    const r = await agent.run(text, { signal: opts.signal, budget });
    usage.inputTokens += r.usage.inputTokens;
    usage.outputTokens += r.usage.outputTokens;
    if (r.stopReason !== "end_turn") throw new Error(`${agent.name} stopped early (${r.stopReason})`);
    results.push(r);
    text = r.finalText;
  }
  return { finalText: text, results, usage };
}

/** Runs agents concurrently (optionally limited) on one shared input or one input each. Never rejects as a whole. */
export async function parallel(
  agents: Agent[],
  input: string | string[],
  opts: { concurrency?: number; signal?: AbortSignal; maxModelCalls?: number } = {},
): Promise<PromiseSettledResult<RunResult>[]> {
  if (Array.isArray(input) && input.length !== agents.length) {
    throw new Error(`parallel(): got ${input.length} inputs for ${agents.length} agents; pass one input each, or one string for all`);
  }
  const budget = sharedBudget(opts.maxModelCalls);
  const out: PromiseSettledResult<RunResult>[] = new Array(agents.length);
  let next = 0;
  const worker = async () => {
    while (next < agents.length) {
      const i = next++;
      try {
        const prompt = Array.isArray(input) ? (input[i] ?? "") : input;
        out[i] = { status: "fulfilled", value: await agents[i]!.run(prompt, { signal: opts.signal, budget }) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency ?? agents.length, agents.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

export interface PlanItem {
  text: string;
  status: "pending" | "in_progress" | "done";
}

/** A plan the model keeps up to date by calling `update_plan` with the full list each time. */
export function createPlanTool(opts: { store?: Store; key?: string } = {}) {
  const key = opts.key ?? "plan";
  let plan: PlanItem[] = [];

  const render = () => plan.map((p, i) => `${i + 1}. [${p.status === "done" ? "x" : p.status === "in_progress" ? "~" : " "}] ${p.text}`).join("\n");

  const tool = defineTool<{ items: PlanItem[] }>({
    name: "update_plan",
    description: "Set or update your step-by-step plan. Always send the complete list. Mark one step in_progress while working on it and done when finished.",
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["text", "status"],
          },
        },
      },
      required: ["items"],
    },
    run: async ({ items }) => {
      plan = items.map((i) => ({ text: i.text, status: i.status }));
      await opts.store?.set(key, plan);
      return render();
    },
  });

  return {
    tool,
    get: (): PlanItem[] => plan.map((p) => ({ ...p })),
    render,
    /** Restores the plan from the store, if one was saved. */
    load: async () => {
      plan = (await opts.store?.get<PlanItem[]>(key)) ?? plan;
      return plan;
    },
  };
}
