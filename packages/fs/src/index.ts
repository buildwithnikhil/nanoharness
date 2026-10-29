import { createHash, randomUUID } from "node:crypto";
import { constants as C, lstatSync, promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { defineTool } from "nanoharness";
import type { Store, Tool } from "nanoharness";

export interface FsToolsOptions {
  /** Every path the model passes is resolved inside this directory. */
  root: string;
  /** Adds write_file. Off by default. */
  allowWrite?: boolean;
  /** read_file refuses files larger than this. Default 1,000,000 bytes. */
  maxFileBytes?: number;
}

const NOFOLLOW = C.O_NOFOLLOW ?? 0; // 0 where the platform has no such flag (Windows)
const NONBLOCK = C.O_NONBLOCK ?? 0;

/** `read_file` and `list_dir` (and `write_file` with `allowWrite`) confined to `root`. */
export function createFsTools(opts: FsToolsOptions): Tool[] {
  const root = realpathSync(path.resolve(opts.root));
  const maxFileBytes = opts.maxFileBytes ?? 1_000_000;

  const inside = (full: string): boolean => {
    const rel = path.relative(root, full);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  };
  const entryExists = (p: string): boolean => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  // Resolves symlinks on the deepest existing ancestor so a link cannot point outside root.
  // A path that exists but cannot be resolved (a dangling link or a loop) is refused, since writing through it
  // could create a file wherever the link points.
  const resolve = (p: string): string => {
    const abs = path.resolve(root, p);
    let probe = abs;
    for (;;) {
      let real: string;
      try {
        real = realpathSync(probe);
      } catch {
        if (entryExists(probe)) throw new Error(`Path escapes root: ${p}`);
        const parent = path.dirname(probe);
        if (parent === probe) throw new Error(`Path escapes root: ${p}`);
        probe = parent;
        continue;
      }
      const full = path.join(real, path.relative(probe, abs));
      if (!inside(full)) throw new Error(`Path escapes root: ${p}`);
      return full;
    }
  };

  const tools: Tool[] = [
    defineTool<{ path: string }>({
      name: "read_file",
      description: "Read a UTF-8 text file relative to the project root.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      run: async ({ path: p }) => {
        const file = resolve(p);
        // Open first, then inspect the open file: no hang on a FIFO, no size check that a growing file can slip past.
        const handle = await fs.open(file, C.O_RDONLY | NOFOLLOW | NONBLOCK);
        try {
          const st = await handle.stat();
          if (!st.isFile()) throw new Error(`Not a regular file: ${p}`);
          if (st.size > maxFileBytes) throw new Error(`File too large: ${st.size} bytes (limit ${maxFileBytes})`);
          const chunks: Buffer[] = [];
          let total = 0;
          for (;;) {
            const chunk = Buffer.allocUnsafe(Math.min(65_536, maxFileBytes + 1 - total));
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) break;
            total += bytesRead;
            if (total > maxFileBytes) throw new Error(`File too large: more than ${maxFileBytes} bytes (limit ${maxFileBytes})`);
            chunks.push(chunk.subarray(0, bytesRead));
          }
          return Buffer.concat(chunks).toString("utf8");
        } finally {
          await handle.close();
        }
      },
    }),
    defineTool<{ path?: string }>({
      name: "list_dir",
      description: "List entries of a directory relative to the project root. Directories end with /.",
      schema: { type: "object", properties: { path: { type: "string" } } },
      run: async ({ path: p = "." }) => {
        const entries = await fs.readdir(resolve(p), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
      },
    }),
  ];

  if (opts.allowWrite) {
    tools.push(
      defineTool<{ path: string; content: string }>({
        name: "write_file",
        description: "Write a UTF-8 text file relative to the project root, creating parent directories.",
        schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        run: async ({ path: p, content }) => {
          const target = resolve(p);
          await fs.mkdir(path.dirname(target), { recursive: true });
          try {
            if (!lstatSync(target).isFile()) throw new Error(`Not a regular file: ${p}`);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          // O_NOFOLLOW: if the last component was swapped for a symlink after the check above, opening it fails.
          const handle = await fs.open(target, C.O_WRONLY | C.O_CREAT | C.O_TRUNC | NOFOLLOW, 0o644);
          try {
            await handle.writeFile(content);
          } finally {
            await handle.close();
          }
          return `Wrote ${content.length} characters to ${p}`;
        },
      }),
    );
  }

  // System errors name the absolute path on disk; the model only ever sees the path it asked for.
  return tools.map((t) => ({ ...t, run: async (input, ctx) => {
    try {
      return await t.run(input, ctx);
    } catch (e) {
      throw plainError(e, (input as { path?: unknown }).path);
    }
  } }));
}

const ERRNO: Record<string, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EPERM: "Permission denied",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
  ELOOP: "Is a symlink",
  EEXIST: "Already exists",
  ENOSPC: "No space left on the device",
};

function plainError(e: unknown, p: unknown): unknown {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (typeof code !== "string" || !(e instanceof Error) || !("syscall" in e)) return e;
  return new Error(`${ERRNO[code] ?? code}: ${typeof p === "string" ? p : "(path)"}`);
}

export interface FileStoreOptions {
  /** A lock whose file has not been touched for this long is taken to belong to a crashed process. Default 30,000. */
  lockStaleMs?: number;
  /** How long `lock()` waits before giving up. Default 600,000 (ten minutes). */
  lockTimeoutMs?: number;
}

// Windows treats these as devices even with an extension ("con.json", "con.foo.json"), so the part before the first dot is checked.
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
// A lone surrogate cannot be encoded as UTF-8 without becoming U+FFFD, which would make two keys share a file.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const MAX_NAME = 200;

// One file per key. Everything except a-z, 0-9 and - _ . ~ is percent-encoded, upper-case letters included, so two
// keys never map to names that differ only by case, and no name holds a character Windows forbids. Keys that are
// empty, very long, or that would give a reserved device name are stored under a hash instead (the real key is kept
// inside the file), so a name is never longer than a file system allows.
function fileName(key: string): string {
  if (LONE_SURROGATE.test(key)) return `%h-${createHash("sha256").update(Buffer.from(key, "utf16le")).digest("hex")}.json`;
  let name = "";
  for (const ch of key) {
    if (/[a-z0-9\-_.~]/.test(ch)) name += ch;
    else for (const b of Buffer.from(ch)) name += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  if (name === "" || name.length > MAX_NAME) return `%h-${createHash("sha256").update(key).digest("hex")}.json`;
  if (RESERVED.test(name)) name = `%${name.charCodeAt(0).toString(16).toUpperCase()}${name.slice(1)}`;
  return `${name}.json`;
}

// What 1.x of nanoharness wrote: encodeURIComponent, with no case or reserved-name handling. It is only looked
// up when it is a legal file name, since 1.x could not store longer keys at all.
const legacyFileName = (key: string): string | undefined => {
  let name: string;
  try {
    name = `${encodeURIComponent(key)}.json`;
  } catch {
    return undefined; // a key 1.x could not have stored
  }
  return name.length <= MAX_NAME ? name : undefined;
};

interface Envelope {
  $nanoharness: 1;
  key: string;
  value: unknown;
}

const isEnvelope = (v: unknown): v is Envelope =>
  typeof v === "object" && v !== null && (v as Envelope).$nanoharness === 1 && typeof (v as Envelope).key === "string";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let counter = 0;

/**
 * One JSON file per key under `dir`. Writes are atomic (a temp file, then a rename) and are applied in call order
 * within a process. `lock()` gives an exclusive lock that also holds across processes on the same local disk,
 * which `session()` and checkpointed graphs use automatically. It is an advisory lock file with a heartbeat and
 * stale-lock takeover, meant for a few cooperating processes. Do not rely on it over network file systems.
 */
export function fileStore(dir: string, options: FileStoreOptions = {}): Store {
  const staleMs = options.lockStaleMs ?? 30_000;
  const timeoutMs = options.lockTimeoutMs ?? 600_000;
  const queues = new Map<string, Promise<unknown>>();

  // Runs fn after earlier work in the same queue has settled.
  const serial = <T>(queue: string, fn: () => Promise<T>): Promise<T> => {
    const prev = queues.get(queue) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    queues.set(queue, tail);
    void tail.then(() => {
      if (queues.get(queue) === tail) queues.delete(queue);
    });
    return next;
  };

  const read = async (name: string): Promise<unknown | undefined> => {
    try {
      return JSON.parse(await fs.readFile(path.join(dir, name), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  };

  const acquire = async (key: string): Promise<() => Promise<void>> => {
    await fs.mkdir(dir, { recursive: true });
    const lockFile = path.join(dir, fileName(`lock:${key}`).replace(/\.json$/, ".lock"));
    const deadline = Date.now() + timeoutMs;
    // A token identifies this holder, so a holder that stalled past lockStaleMs (and lost the lock) cannot
    // delete the lock of whoever took over.
    const token = `${process.pid} ${randomUUID()}`;
    for (;;) {
      try {
        const handle = await fs.open(lockFile, "wx"); // fails if it exists, atomically
        await handle.writeFile(token);
        await handle.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      try {
        const seen = await fs.stat(lockFile);
        if (Date.now() - seen.mtimeMs > staleMs) {
          // Look again just before removing, so a lock that was refreshed or replaced in between is left alone.
          const again = await fs.stat(lockFile);
          if (again.ino === seen.ino && again.mtimeMs === seen.mtimeMs) await fs.rm(lockFile, { force: true });
          continue;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // released while we looked
        throw e;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for the lock on "${key}"`);
      await sleep(20 + Math.random() * 30);
    }
    const heartbeat = setInterval(() => {
      const now = new Date();
      fs.utimes(lockFile, now, now).catch(() => {});
    }, Math.max(10, Math.floor(staleMs / 3)));
    heartbeat.unref();
    return async () => {
      clearInterval(heartbeat);
      const current = await fs.readFile(lockFile, "utf8").catch(() => undefined);
      if (current === token) await fs.rm(lockFile, { force: true });
    };
  };

  return {
    async get<T>(key: string) {
      const legacy = legacyFileName(key);
      const parsed = (await read(fileName(key))) ?? (legacy ? await read(legacy) : undefined);
      if (parsed === undefined) return undefined;
      return (isEnvelope(parsed) ? parsed.value : parsed) as T; // a file with no envelope is a raw value from 1.x
    },
    set: (key, value) =>
      serial(`w:${key}`, async () => {
        await fs.mkdir(dir, { recursive: true });
        const target = path.join(dir, fileName(key));
        const tmp = `${target}.${process.pid}.${counter++}.${Math.random().toString(36).slice(2)}.tmp`;
        const envelope: Envelope = { $nanoharness: 1, key, value };
        await fs.writeFile(tmp, JSON.stringify(envelope));
        await fs.rename(tmp, target);
      }),
    delete: (key) =>
      serial(`w:${key}`, async () => {
        await fs.rm(path.join(dir, fileName(key)), { force: true });
        const legacy = legacyFileName(key);
        if (legacy) await fs.rm(path.join(dir, legacy), { force: true });
      }),
    async keys(prefix = "") {
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      const found = new Set<string>();
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const base = name.slice(0, -5);
        let key: string | undefined;
        if (base.startsWith("%h-")) {
          const parsed = await read(name).catch(() => undefined);
          if (isEnvelope(parsed)) key = parsed.key;
        } else {
          try {
            key = decodeURIComponent(base);
          } catch {
            // not a name this store wrote, so it is skipped
          }
        }
        if (key !== undefined && key.startsWith(prefix)) found.add(key);
      }
      return [...found];
    },
    lock: <T>(key: string, fn: () => Promise<T>): Promise<T> =>
      serial(`l:${key}`, async () => {
        const release = await acquire(key);
        try {
          return await fn();
        } finally {
          await release();
        }
      }),
  };
}
