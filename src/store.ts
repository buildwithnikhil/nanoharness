import type { Message, Store } from "./types.js";
import type { RunOptions, RunResult } from "./agent.js";
import { run } from "./agent.js";
import { lockStore } from "./lock.js";
import { appendUser } from "./messages.js";
import { trimHistory, withSummary } from "./history.js";
import { canonical } from "./validate.js";

export type { Store } from "./types.js";
export { trimHistory } from "./history.js";

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
export interface SessionOptions {
  /** Keep at most this many messages (cut at a safe point) before each run, so a long conversation stays bounded. */
  maxMessages?: number;
  /** Turns the messages that are about to be dropped into a short summary that is kept instead. Needs `maxMessages`. */
  summarize?: (dropped: Message[]) => string | Promise<string>;
}

export function session(store: Store, id: string, sessionOpts: SessionOptions = {}) {
  const { maxMessages, summarize } = sessionOpts;
  if (maxMessages !== undefined && !(Number.isInteger(maxMessages) && maxMessages >= 1)) {
    throw new Error("session(): maxMessages must be a whole number of at least 1");
  }
  if (summarize && maxMessages === undefined) throw new Error("session(): summarize needs maxMessages");
  const key = `session:${id}`;
  return {
    messages: async (): Promise<Message[]> => (await store.get<Message[]>(key)) ?? [],
    clear: (): Promise<void> => lockStore(store, key, () => store.delete(key)),
    run: (opts: Omit<RunOptions, "prompt"> & { prompt: string }): Promise<RunResult> =>
      lockStore(store, key, async () => {
        let history = (await store.get<Message[]>(key)) ?? [];
        if (maxMessages !== undefined && history.length > maxMessages) {
          const kept = trimHistory(history, { maxMessages });
          const dropped = history.slice(0, history.length - kept.length);
          history = summarize && dropped.length > 0 ? withSummary(kept, await summarize(dropped)) : kept;
        }
        const result = await run({ ...opts, prompt: appendUser(history, opts.prompt) });
        await store.set(key, result.messages);
        return result;
      }),
  };
}

/**
 * Checks that a store you wrote (for Redis, Postgres, ...) behaves the way nanoharness expects. It writes and
 * deletes keys under `prefix` (and one key that only contains it). Returns a list of problems; an empty list means
 * it passed. Gives up after `timeoutMs` (default 10,000) if the store hangs.
 */
export async function checkStore(store: Store, prefix = "nanoharness-check:", opts: { timeoutMs?: number } = {}): Promise<string[]> {
  const problems: string[] = [];
  const k = (s: string) => prefix + s;
  const outside = `x${prefix}outside`; // contains the prefix but does not start with it
  const written = [k("a"), k("b"), k("weird/key :%"), outside];
  const fresh = () => ({ text: "héllo 😀", n: 1.5, list: [1, null, true], nested: { a: [{ b: "c" }] } });
  // Compared in canonical form, so a store that reorders object keys (such as Postgres jsonb) still passes.
  const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
  const checks = async () => {
    if ((await store.get(k("missing"))) !== undefined) problems.push("get() of a missing key should return undefined");
    const value = fresh();
    await store.set(k("a"), value);
    value.nested.a[0]!.b = "changed after set";
    const back = await store.get<ReturnType<typeof fresh>>(k("a"));
    if (!same(back, fresh())) problems.push("get() did not return what set() stored (JSON values must round-trip, and set() must keep a copy)");
    if (back && typeof back === "object") back.nested.a[0]!.b = "changed after get";
    if (!same(await store.get(k("a")), fresh())) problems.push("get() must return a copy: changing what it returned changed the stored value");
    await store.set(k("a"), "overwritten");
    if ((await store.get(k("a"))) !== "overwritten") problems.push("set() should overwrite an existing key");
    await store.set(k("b"), 0);
    if ((await store.get(k("b"))) !== 0) problems.push("falsy values such as 0 must be stored");
    await store.set(k("weird/key :%"), 1);
    if ((await store.get(k("weird/key :%"))) !== 1) problems.push("keys may contain any characters");
    await store.set(outside, 1);
    const keys = (await store.keys(prefix)).sort();
    const want = [k("a"), k("b"), k("weird/key :%")].sort();
    if (!same(keys, want)) problems.push(`keys(prefix) returned ${JSON.stringify(keys)}, expected ${JSON.stringify(want)} (only keys that start with the prefix)`);
    await store.delete(k("a"));
    if ((await store.get(k("a"))) !== undefined) problems.push("delete() did not remove the key");
    await store.delete(k("never-set")); // must not throw
    if (store.lock) {
      let active = 0;
      let overlap = false;
      const work = () =>
        store.lock!(k("lock"), async () => {
          active++;
          if (active > 1) overlap = true;
          await new Promise((r) => setTimeout(r, 10));
          active--;
        });
      await Promise.all([work(), work(), work()]);
      if (overlap) problems.push("lock() let two callers in at once");
    }
  };
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      checks(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not finish within ${timeoutMs} ms (a call never settled)`)), timeoutMs);
      }),
    ]);
  } catch (e) {
    problems.push(`threw: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
    for (const key of written) await store.delete(key).catch(() => {});
  }
  return problems;
}
