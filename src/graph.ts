import type { Store } from "./types.js";

export const END = "__end__";

export interface NodeContext<S> {
  state: S;
  signal?: AbortSignal;
}

export interface NodeResult<S> {
  /** Shallow-merged into the state. */
  state?: Partial<S>;
  /** Name of the next node, or `END`. Falls back to `edges[node]`, then ends. */
  next?: string;
}

export type GraphNode<S> = (ctx: NodeContext<S>) => NodeResult<S> | void | Promise<NodeResult<S> | void>;

export interface GraphOptions<S> {
  nodes: Record<string, GraphNode<S>>;
  entry: string;
  /** Default next node for nodes that do not choose one. */
  edges?: Record<string, string>;
  maxSteps?: number;
  /** With `id`, saves a checkpoint after every node so a crashed or aborted run can resume. */
  store?: Store;
  id?: string;
  onStep?: (e: { step: number; node: string; state: unknown }) => void;
}

export interface GraphResult<S> {
  state: S;
  /** Nodes executed in this call, in order. */
  path: string[];
  status: "done" | "max_steps" | "aborted";
}

interface Checkpoint<S> {
  state: S;
  next: string;
  step: number;
}

export function createGraph<S extends object>(opts: GraphOptions<S>) {
  const { nodes, entry, edges = {}, maxSteps = 50 } = opts;
  if (!(entry in nodes)) throw new Error(`Unknown entry node: ${entry}`);
  const key = opts.store && opts.id ? `graph:${opts.id}` : undefined;

  return {
    /** Runs from `entry`, or resumes from the saved checkpoint unless `fresh` is set. */
    async run(initial: S, runOpts: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<GraphResult<S>> {
      let state = initial;
      let current = entry;
      let step = 0;

      if (key && !runOpts.fresh) {
        const cp = await opts.store!.get<Checkpoint<S>>(key);
        if (cp) ({ state, next: current, step } = cp);
      }

      const path: string[] = [];
      let status: GraphResult<S>["status"] = "done";

      while (current !== END) {
        if (runOpts.signal?.aborted) {
          status = "aborted";
          break;
        }
        if (step >= maxSteps) {
          status = "max_steps";
          break;
        }
        const node = nodes[current];
        if (!node) throw new Error(`Unknown node: ${current}`);

        const result = (await node({ state, signal: runOpts.signal })) ?? {};
        state = { ...state, ...result.state };
        path.push(current);
        step++;
        opts.onStep?.({ step, node: current, state });

        const next = result.next ?? edges[current] ?? END;
        if (key) await opts.store!.set(key, { state, next, step } satisfies Checkpoint<S>);
        current = next;
      }

      if (key && status === "done") await opts.store!.delete(key);
      return { state, path, status };
    },
  };
}
