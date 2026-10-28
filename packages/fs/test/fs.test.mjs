import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "nanoharness";
import { session } from "nanoharness/store";
import { createFsTools, fileStore } from "../dist/index.js";

const text = (t) => ({ content: [{ type: "text", text: t }], stopReason: "end_turn" });
const tmp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));

test("fs tools stay inside root and write is opt-in", async () => {
  const dir = await tmp("nh-fs-");
  await fsp.writeFile(path.join(dir, "a.txt"), "hello");
  await fsp.symlink(os.tmpdir(), path.join(dir, "link"));

  const ro = createFsTools({ root: dir });
  assert.deepEqual(ro.map((t) => t.name), ["read_file", "list_dir"]);
  const read = ro.find((t) => t.name === "read_file");
  assert.equal(await read.run({ path: "a.txt" }, {}), "hello");
  await assert.rejects(read.run({ path: "../x" }, {}), /escapes root/);
  await assert.rejects(read.run({ path: "link/anything" }, {}), /escapes root/);

  const rw = createFsTools({ root: dir, allowWrite: true });
  const write = rw.find((t) => t.name === "write_file");
  await write.run({ path: "sub/b.txt", content: "x" }, {});
  assert.equal(await fsp.readFile(path.join(dir, "sub/b.txt"), "utf8"), "x");
  await assert.rejects(async () => write.run({ path: "../evil", content: "x" }, {}), /escapes root/);
  await assert.rejects(write.run({ path: "link/evil.txt", content: "x" }, {}), /escapes root/);
});

test("list_dir marks directories", async () => {
  const dir = await tmp("nh-ls-");
  await fsp.mkdir(path.join(dir, "d"));
  await fsp.writeFile(path.join(dir, "f.txt"), "x");
  const list = createFsTools({ root: dir }).find((t) => t.name === "list_dir");
  assert.deepEqual((await list.run({}, {})).split("\n").sort(), ["d/", "f.txt"]);
});

test("read_file refuses files over maxFileBytes", async () => {
  const dir = await tmp("nh-big-");
  await fsp.writeFile(path.join(dir, "big.txt"), "x".repeat(100));
  await fsp.writeFile(path.join(dir, "small.txt"), "ok");
  const read = createFsTools({ root: dir, maxFileBytes: 50 }).find((t) => t.name === "read_file");
  await assert.rejects(read.run({ path: "big.txt" }, {}), /File too large: 100 bytes \(limit 50\)/);
  assert.equal(await read.run({ path: "small.txt" }, {}), "ok");
});

test("tools work end to end inside run()", async () => {
  const dir = await tmp("nh-run-");
  await fsp.writeFile(path.join(dir, "n.txt"), "secret42");
  let n = 0;
  const seen = [];
  const adapter = {
    complete: async ({ messages }) => {
      seen.push(messages.at(-1));
      return n++ === 0
        ? { content: [{ type: "tool_use", id: "1", name: "read_file", input: { path: "n.txt" } }], stopReason: "tool_use" }
        : text("done");
    },
  };
  await run({ adapter, prompt: "read it", tools: createFsTools({ root: dir }) });
  assert.equal(seen[1].content[0].content, "secret42");
});

test("fileStore: get/set/delete/keys round-trip", async () => {
  const s = fileStore(await tmp("nh-store-"));
  assert.equal(await s.get("missing"), undefined);
  assert.deepEqual(await s.keys(), []);
  await s.set("a/b", { n: 1 });
  await s.set("a:c", [1, 2]);
  await s.set("z", "x");
  assert.deepEqual(await s.get("a/b"), { n: 1 });
  assert.deepEqual((await s.keys("a")).sort(), ["a/b", "a:c"]);
  await s.delete("a/b");
  assert.equal(await s.get("a/b"), undefined);
  await s.delete("never-existed");
});

test("fileStore: keys cannot escape the directory", async () => {
  const dir = await tmp("nh-esc-");
  const s = fileStore(path.join(dir, "store"));
  await s.set("../../evil", "x");
  assert.deepEqual(await fsp.readdir(dir), ["store"]);
  assert.equal(await s.get("../../evil"), "x");
});

test("fileStore: 200 concurrent writes to one key all succeed", async () => {
  const s = fileStore(await tmp("nh-conc-"));
  await Promise.all(Array.from({ length: 200 }, (_, i) => s.set("k", { i })));
  assert.equal(typeof (await s.get("k")).i, "number");
  assert.deepEqual(await s.keys(), ["k"]);
});

test("session persists across runs and fileStore instances", async () => {
  const dir = await tmp("nh-sess-");
  const reqs = [];
  const mk = (t) => ({ complete: async (r) => (reqs.push(structuredClone({ ...r, signal: undefined })), text(t)) });
  await session(fileStore(dir), "u1").run({ adapter: mk("hello Ada"), prompt: "I am Ada" });
  const r = await session(fileStore(dir), "u1").run({ adapter: mk("you are Ada"), prompt: "who am I?" });
  assert.deepEqual(reqs[1].messages.map((m) => m.content), ["I am Ada", [{ type: "text", text: "hello Ada" }], "who am I?"]);
  assert.equal(r.messages.length, 4);
  await session(fileStore(dir), "u1").clear();
  assert.deepEqual(await session(fileStore(dir), "u1").messages(), []);
});

test("CJS build loads", () => {
  const require = createRequire(import.meta.url);
  const m = require("../dist/index.cjs");
  assert.equal(typeof m.createFsTools, "function");
  assert.equal(typeof m.fileStore, "function");
});
