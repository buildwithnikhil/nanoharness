import type { Store } from "./types.js";
import { lockStore } from "./lock.js";

export const END = "__end__";

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// Checkpointed state goes through JSON, so every run sees the same thing whether or not it was resumed.
function snapshot<S>(state: S): S {
  try {
    return JSON.parse(JSON.stringify(state)) as S;
  } catch (e) {
    throw new Error(`Graph state must be JSON-serialisable when checkpoints are enabled: ${e instanceof Error ? e.message : e}`);
  }
}

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
  /** Most nodes one `run()` call may execute. A run that stops here can be resumed with another call. Default 50. */
  maxSteps?: number;
  /**
   * With `id`, saves a checkpoint after every node so a crashed or stopped run can resume. State must then be
   * JSON-serialisable. Runs with the same `id` are queued, across processes too if the store has a `lock`.
   */
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
  if (!hasOwn(nodes, entry)) throw new Error(`Unknown entry node: ${entry}`);
  if (Boolean(opts.store) !== Boolean(opts.id)) throw new Error("createGraph: `store` and `id` must be given together to enable checkpoints");
  const store = opts.store;
  const key = store && opts.id ? `graph:${opts.id}` : undefined;

  async function execute(initial: S, runOpts: { signal?: AbortSignal; fresh?: boolean }): Promise<GraphResult<S>> {
    let state = initial;
    let current = entry;
    let step = 0;

    if (store && key && !runOpts.fresh) {
      const cp = await store.get<Checkpoint<S>>(key);
      if (cp) ({ state, next: current, step } = cp);
    }

    const path: string[] = [];
    let status: GraphResult<S>["status"] = "done";

    while (current !== END) {
      if (runOpts.signal?.aborted) {
        status = "aborted";
        break;
      }
      if (path.length >= maxSteps) {
        status = "max_steps";
        break;
      }
      if (!hasOwn(nodes, current)) throw new Error(`Unknown node: ${current}`);
      const node = nodes[current]!;

      const result = (await node({ state, signal: runOpts.signal })) ?? {};
      state = { ...state, ...result.state };
      if (key) state = snapshot(state);
      path.push(current);
      step++;

      const next = result.next ?? (hasOwn(edges, current) ? edges[current] : undefined) ?? END;
      // A mistyped `next` is reported before it can be saved, so it never ends up in a checkpoint.
      if (next !== END && !hasOwn(nodes, next)) throw new Error(`Unknown node: ${next}`);
      // Save first, then notify: if the hook throws, the node that already ran is not run again on resume.
      if (store && key) await store.set(key, { state, next, step } satisfies Checkpoint<S>);
      opts.onStep?.({ step, node: current, state });
      current = next;
    }

    if (store && key && status === "done") await store.delete(key);
    return { state, path, status };
  }

  return {
    /**
     * Runs from `entry`, or resumes from the saved checkpoint unless `fresh` is set. When it resumes, `initial`
     * is ignored. A run that stops on `max_steps` or `aborted` keeps its checkpoint, so calling `run` again continues it.
     */
    run: (initial: S, runOpts: { signal?: AbortSignal; fresh?: boolean } = {}): Promise<GraphResult<S>> =>
      store && key ? lockStore(store, key, () => execute(initial, runOpts)) : execute(initial, runOpts),
  };
}
