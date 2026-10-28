import type { Store } from "./types.js";

const queues = new WeakMap<Store, Map<string, Promise<unknown>>>();

// Runs fn after earlier work on the same (store, key) has settled, so read-modify-write cycles don't interleave.
export function withLock<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  let byKey = queues.get(store);
  if (!byKey) queues.set(store, (byKey = new Map()));
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

/** Uses the store's own lock when it has one (a file store's lock also covers other processes), and an in-process queue otherwise. */
export function lockStore<T>(store: Store, key: string, fn: () => Promise<T>): Promise<T> {
  return store.lock ? store.lock(key, fn) : withLock(store, key, fn);
}
