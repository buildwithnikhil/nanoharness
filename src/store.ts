import type { Message, Store } from "./types.js";
import type { RunOptions, RunResult } from "./agent.js";
import { run } from "./agent.js";
import { lockStore } from "./lock.js";
import { appendUser } from "./messages.js";

export type { Store } from "./types.js";

export function memoryStore(): Store {
  const data = new Map<string, string>();
  return {
    async get<T>(key: string) {
      const v = data.get(key);
      return v === undefined ? undefined : (JSON.parse(v) as T);
    },
    async set(key, value) {
      data.set(key, JSON.stringify(value));
    },
    async delete(key) {
      data.delete(key);
    },
    async keys(prefix = "") {
      return [...data.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

/**
 * A conversation that persists in `store` under `id`, so it survives across `run` calls and restarts.
 * Runs and `clear()` on the same id are queued in order. A store with its own `lock` (such as `fileStore`
 * from nanoharness-fs) extends that to other processes sharing it; otherwise it holds within one process,
 * for stores that are the same object.
 */
export function session(store: Store, id: string) {
  const key = `session:${id}`;
  return {
    messages: async (): Promise<Message[]> => (await store.get<Message[]>(key)) ?? [],
    clear: (): Promise<void> => lockStore(store, key, () => store.delete(key)),
    run: (opts: Omit<RunOptions, "prompt"> & { prompt: string }): Promise<RunResult> =>
      lockStore(store, key, async () => {
        const history = (await store.get<Message[]>(key)) ?? [];
        const result = await run({ ...opts, prompt: appendUser(history, opts.prompt) });
        await store.set(key, result.messages);
        return result;
      }),
  };
}
