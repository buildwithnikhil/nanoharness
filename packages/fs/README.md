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

Every path is resolved inside `root`, and symlinks that point outside it are rejected. `read_file` refuses files larger than `maxFileBytes` (default 1,000,000). `write_file` exists only with `allowWrite: true`.

## File store

```ts
import { fileStore } from "nanoharness-fs";
import { session } from "nanoharness/store";

const chat = session(fileStore("./.agent-data"), "user-42"); // survives restarts
```

`fileStore(dir)` keeps one JSON file per key and writes atomically. Keys cannot escape `dir`. It works anywhere nanoharness takes a `Store`: sessions, graph checkpoints and the plan tool.

Zero dependencies. Node 18 or later. MIT.
