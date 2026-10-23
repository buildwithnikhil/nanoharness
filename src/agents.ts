import { run, stream } from "./agent.js";
import type { AgentEvent, RunOptions, RunResult } from "./agent.js";
import { defineTool } from "./tool.js";
import type { Tool } from "./tool.js";
import type { Message, Store } from "./types.js";

const NAME = /^[a-zA-Z0-9_-]{1,64}$/;

function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const ctl = new AbortController();
  for (const s of signals) {
    if (s.aborted) ctl.abort();
    else s.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  return ctl.signal;
}

export interface AgentConfig extends Omit<RunOptions, "prompt"> {
  /** Also the tool name when used via `asTool`, so it must match [a-zA-Z0-9_-]{1,64}. */
  name: string;
  /** Most model calls in total across this agent and all its sub-agents. Default 200; set Infinity to disable. */
  maxModelCalls?: number;
  /** Tool calls from one turn run up to this many at once (sub-agents in parallel). Default 4; set 1 for in-order. */
  /** How deeply agents may call agents. Calls beyond this fail with a tool error. Default 4. */
  maxDepth?: number;
  /** Called for every event of this agent's loop, tagged with its name. */
  onEvent?: (agent: string, event: AgentEvent) => void;
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
    // Keep the agent's own signal as well as the caller's.
    if (base.signal && defined.signal) opts.signal = anySignal([base.signal, defined.signal as AbortSignal]);
    if (!onEvent) return run(opts);
    const it = stream(opts);
    for (;;) {
      const next = await it.next();
      if (next.done) return next.value;
      onEvent(name, next.value);
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
          const r = await exec(task, { signal: ctx.signal, depth: depth + 1, budget: ctx.budget });
          ctx.addUsage?.(r.usage);
          if (r.stopReason !== "end_turn") throw new Error(`${name} stopped early (${r.stopReason})`);
          return r.finalText;
        },
      }),
  };
}

/** Runs agents in order; each one receives the previous one's final answer. Throws if a step does not finish. */
export async function pipeline(
  agents: Agent[],
  input: string,
  opts: { signal?: AbortSignal } = {},
): Promise<{ finalText: string; results: RunResult[] }> {
  const results: RunResult[] = [];
  let text = input;
  for (const agent of agents) {
    const r = await agent.run(text, { signal: opts.signal });
    if (r.stopReason !== "end_turn") throw new Error(`${agent.name} stopped early (${r.stopReason})`);
    results.push(r);
    text = r.finalText;
  }
  return { finalText: text, results };
}

/** Runs agents concurrently (optionally limited) on one shared input or one input each. Never rejects as a whole. */
export async function parallel(
  agents: Agent[],
  input: string | string[],
  opts: { concurrency?: number; signal?: AbortSignal } = {},
): Promise<PromiseSettledResult<RunResult>[]> {
  const out: PromiseSettledResult<RunResult>[] = new Array(agents.length);
  let next = 0;
  const worker = async () => {
    while (next < agents.length) {
      const i = next++;
      try {
        const prompt = Array.isArray(input) ? (input[i] ?? "") : input;
        out[i] = { status: "fulfilled", value: await agents[i]!.run(prompt, { signal: opts.signal }) };
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
