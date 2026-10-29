# nanoharness-fs

Sandboxed file tools and a file-backed store for [nanoharness](https://www.npmjs.com/package/nanoharness). It is a separate package so the core `nanoharness` package contains no filesystem code.

```sh
npm install nanoharness nanoharness-fs
```

## File tools

```ts
import { run } from "nanoharness";
import { createFsTools } from "nanoharness-fs";

const tools = createFsTools({ root: "./workspace" }); // read_file, list_dir
// createFsTools({ root, allowWrite: true }) also adds write_file
await run({ adapter, prompt: "What is in notes.txt?", tools });
```

Every path is resolved inside `root`. Symlinks that point outside it are rejected, and so is a path that exists but cannot be resolved (a dangling or looping link), because writing through it could create a file wherever it points. A link that stays inside `root` is fine.

`read_file` opens the file first and then checks it: it refuses anything that is not a regular file (a FIFO, a device), refuses files larger than `maxFileBytes` (default 1,000,000), and stops reading at that limit even for files that report size 0, such as those under `/proc`. `write_file` exists only with `allowWrite: true`, and opens with `O_NOFOLLOW` where the platform supports it. A name that merely starts with two dots (`..hidden`) is allowed.

What the sandbox cannot do: it checks a path and then uses it, so a symlink that an attacker swaps in on a directory component between those two steps is not caught. Give the agent a root that only trusted code can write to.

## File store

```ts
import { fileStore } from "nanoharness-fs";
import { session } from "nanoharness/store";

const chat = session(fileStore("./.agent-data"), "user-42"); // survives restarts
```

`fileStore(dir, options?)` keeps one JSON file per key and writes atomically. Keys cannot escape `dir`. It works anywhere nanoharness takes a `Store`: sessions, graph checkpoints and the plan tool.

- **Any key works.** File names are percent-encoded so two keys never collide, even on case-insensitive file systems, and no name contains a character Windows forbids or is a reserved device name. Empty keys and keys whose encoded name would exceed 200 characters (long ids, non-ASCII text) are stored under a hash, with the real key kept inside the file, so `keys()` still returns them.
- **Writes are ordered.** Writes and deletes to one key through one store are applied in call order.
- **Locking.** `store.lock(key, fn)` runs `fn` while holding an exclusive lock that also holds across processes on the same local disk. `session()` and checkpointed graphs use it automatically, so several processes can share one directory. It is an advisory lock file refreshed by a heartbeat; a lock whose file has not been touched for `lockStaleMs` (default 30,000) is taken to belong to a crashed process and is taken over, and `lockTimeoutMs` (default 600,000) limits how long a caller waits. It is meant for a few cooperating processes, **not for network file systems**.
- **Use a directory of its own.** Every `.json` file in the directory is treated as a key (so files written by `nanoharness` 1.x are still read), so do not point a store at a folder holding other JSON files. Only unreadable hashed names are skipped. In 1.x, names that contained upper-case letters or special characters were stored under different names, so look those keys up by listing the directory once and re-saving them.

Zero dependencies. Node 18 or later. MIT.
