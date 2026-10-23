import { promises as fs } from "node:fs";
import path from "node:path";
import type { Message, Store } from "./types.js";
import type { RunOptions, RunResult } from "./agent.js";
import { run } from "./agent.js";

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

let tmpCounter = 0;

/** One JSON file per key under `dir`. Writes are atomic (temp file then rename). */
export function fileStore(dir: string): Store {
  const file = (key: string) => path.join(dir, `${encodeURIComponent(key)}.json`);
  return {
    async get<T>(key: string) {
      try {
        return JSON.parse(await fs.readFile(file(key), "utf8")) as T;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    async set(key, value) {
      await fs.mkdir(dir, { recursive: true });
      const target = file(key);
      const tmp = `${target}.${process.pid}.${tmpCounter++}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, target);
    },
    async delete(key) {
      await fs.rm(file(key), { force: true });
    },
    async keys(prefix = "") {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      return names
        .filter((n) => n.endsWith(".json"))
        .map((n) => decodeURIComponent(n.slice(0, -5)))
        .filter((k) => k.startsWith(prefix));
    },
  };
}

function appendUser(history: Message[], text: string): Message[] {
  const last = history.at(-1);
  // Two user turns in a row are invalid for most providers, so merge into the last one.
  if (last?.role === "user") {
    const blocks = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
    return [...history.slice(0, -1), { role: "user", content: [...blocks, { type: "text", text }] }];
  }
  return [...history, { role: "user", content: text }];
}

const locks = new WeakMap<Store, Map<string, Promise<unknown>>>();

// Runs fn after earlier work on the same (store, key) has settled, so read-modify-write cycles don't interleave.
function withLock<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  let byKey = locks.get(store);
  if (!byKey) locks.set(store, (byKey = new Map()));
  const prev = byKey.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.then(
    () => undefined,
    () => undefined,
  );
  byKey.set(key, tail);
  void tail.then(() => {
    if (byKey.get(key) === tail) byKey.delete(key);
  });
  return next;
}

/**
 * A conversation that persists in `store` under `id`, so it survives across `run` calls and restarts.
 * Concurrent runs on the same id are queued, in order, as long as they share one `store` object.
 */
export function session(store: Store, id: string) {
  const key = `session:${id}`;
  return {
    messages: async (): Promise<Message[]> => (await store.get<Message[]>(key)) ?? [],
    clear: () => store.delete(key),
    run: (opts: Omit<RunOptions, "prompt"> & { prompt: string }): Promise<RunResult> =>
      withLock(store, key, async () => {
        const history = (await store.get<Message[]>(key)) ?? [];
        const result = await run({ ...opts, prompt: appendUser(history, opts.prompt) });
        await store.set(key, result.messages);
        return result;
      }),
  };
}
