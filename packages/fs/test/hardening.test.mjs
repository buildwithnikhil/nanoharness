import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "nanoharness";
import { session } from "nanoharness/store";
import { createFsTools, fileStore } from "../dist/index.js";

const text = (t) => ({ content: [{ type: "text", text: t }], stopReason: "end_turn" });
const tmp = (p) => fsp.mkdtemp(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fileStore (reviewer 2)
test("F3: writes to one key are applied in call order", async () => {
  const s = fileStore(await tmp("nh-order-"));
  for (let trial = 0; trial < 60; trial++) {
    await Promise.all([0, 1, 2, 3, 4].map((i) => s.set("k", { i })));
    assert.equal((await s.get("k")).i, 4, `trial ${trial}`);
  }
});

test("F4: very long and non-ASCII keys round-trip and are listed by their real names", async () => {
  const dir = await tmp("nh-long-");
  const s = fileStore(dir);
  const keys = ["a".repeat(300), "\u4f1a".repeat(30), "x/".repeat(500), "emoji-\u{1F600}".repeat(40)];
  for (const [i, k] of keys.entries()) await s.set(k, { i });
  for (const [i, k] of keys.entries()) assert.deepEqual(await s.get(k), { i });
  assert.deepEqual((await s.keys()).sort(), [...keys].sort());
  for (const name of await fsp.readdir(dir)) assert.ok(Buffer.byteLength(name) <= 255, name);
  await s.delete(keys[0]);
  assert.equal(await s.get(keys[0]), undefined);
});

test("F5: keys() skips files it did not write, and legacy raw-value files still read", async () => {
  const dir = await tmp("nh-foreign-");
  const s = fileStore(dir);
  await s.set("mine", 1);
  await fsp.writeFile(path.join(dir, "100%.json"), "{}");
  await fsp.writeFile(path.join(dir, "notes.txt"), "x");
  await fsp.writeFile(path.join(dir, "legacy.json"), JSON.stringify({ a: 1 }));
  assert.deepEqual((await s.keys()).sort(), ["legacy", "mine"]);
  assert.deepEqual(await s.get("legacy"), { a: 1 });
});

test("F5: file names are safe on case-insensitive and Windows file systems", async () => {
  const dir = await tmp("nh-names-");
  const s = fileStore(dir);
  for (const k of ["A", "a", "con", "nul", "COM1", "star*key", 'q"?<>|:']) await s.set(k, k);
  for (const k of ["A", "a", "con", "nul", "COM1", "star*key", 'q"?<>|:']) assert.equal(await s.get(k), k);
  const names = await fsp.readdir(dir);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, "no two names collide when case is ignored");
  for (const n of names) {
    assert.ok(!/[*"?<>|:]/.test(n), n);
    assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(n), `reserved name ${n}`);
  }
});

test("locking: stores for the same directory exclude each other, like separate processes would", async () => {
  const dir = await tmp("nh-lock-");
  const a = fileStore(dir), b = fileStore(dir);
  let active = 0, peak = 0, done = 0;
  const work = (store) => store.lock("k", async () => { active++; peak = Math.max(peak, active); await sleep(15); active--; done++; });
  await Promise.all([work(a), work(b), work(a), work(b), work(a), work(b)]);
  assert.equal(peak, 1);
  assert.equal(done, 6);
});

test("locking: sessions on two stores for one directory do not lose messages", async () => {
  const dir = await tmp("nh-sess2-");
  const adapter = { complete: async () => (await sleep(10), text("r")) };
  await Promise.all(Array.from({ length: 8 }, (_, i) => session(fileStore(dir), "s").run({ adapter, prompt: `m${i}` })));
  assert.equal((await session(fileStore(dir), "s").messages()).length, 16);
});

test("locking: a stale lock left by a crashed process is taken over", async () => {
  const dir = await tmp("nh-stale-");
  const s = fileStore(dir, { lockStaleMs: 200 });
  await s.set("k", 1);
  const lockFile = fs.readdirSync(dir).find((n) => n.endsWith(".json")).replace(/\.json$/, ".lock");
  await fsp.writeFile(path.join(dir, lockFile), "dead");
  const old = new Date(Date.now() - 5000);
  await fsp.utimes(path.join(dir, lockFile), old, old);
  const t0 = Date.now();
  await s.lock("k", async () => {});
  assert.ok(Date.now() - t0 < 1500);
});

test("locking: a lock held by a live holder is kept alive and not stolen", async () => {
  const dir = await tmp("nh-live-");
  const a = fileStore(dir, { lockStaleMs: 150 }), b = fileStore(dir, { lockStaleMs: 150 });
  let overlap = false, inside = false;
  await Promise.all([
    a.lock("k", async () => { inside = true; await sleep(600); inside = false; }),
    sleep(30).then(() => b.lock("k", async () => { if (inside) overlap = true; })),
  ]);
  assert.equal(overlap, false, "the second store waited for the heartbeat-kept lock");
});

test("locking: waiting longer than lockTimeoutMs fails clearly, and the lock is released after an error", async () => {
  const dir = await tmp("nh-timeout-");
  const a = fileStore(dir), b = fileStore(dir, { lockTimeoutMs: 100 });
  const holder = a.lock("k", () => sleep(400));
  await sleep(20);
  await assert.rejects(b.lock("k", async () => {}), /Timed out waiting for the lock/);
  await holder;
  await assert.rejects(a.lock("k", async () => { throw new Error("inner"); }), /inner/);
  await a.lock("k", async () => {});
});

// ---- file tools (reviewer 3)
test("a dangling symlink inside root cannot be used to write outside it", async () => {
  const root = await tmp("nh-root-"), outside = await tmp("nh-out-");
  await fsp.symlink(path.join(outside, "new.txt"), path.join(root, "dl"));
  const write = createFsTools({ root, allowWrite: true }).find((t) => t.name === "write_file");
  await assert.rejects(write.run({ path: "dl", content: "PWNED" }, {}), /escapes root|symbolic/i);
  assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
  await fsp.symlink("loop2", path.join(root, "loop1"));
  await fsp.symlink("loop1", path.join(root, "loop2"));
  await assert.rejects(write.run({ path: "loop1", content: "x" }, {}));
});

test("names that merely start with two dots are allowed", async () => {
  const root = await tmp("nh-dots-");
  const tools = createFsTools({ root, allowWrite: true });
  await tools.find((t) => t.name === "write_file").run({ path: "..hidden", content: "ok" }, {});
  assert.equal(await tools.find((t) => t.name === "read_file").run({ path: "..hidden" }, {}), "ok");
  await assert.rejects(tools.find((t) => t.name === "read_file").run({ path: "../x" }, {}), /escapes root/);
});

test("read_file refuses special files instead of hanging", async () => {
  const root = await tmp("nh-fifo-");
  try { execFileSync("mkfifo", [path.join(root, "ff")]); } catch { return; }
  const read = createFsTools({ root }).find((t) => t.name === "read_file");
  const result = await Promise.race([read.run({ path: "ff" }, {}).then(() => "read", (e) => e.message), sleep(1500).then(() => "HUNG")]);
  assert.match(result, /not a regular file/i);
});

test("read_file stops at maxFileBytes even when the file reports size 0", async () => {
  if (!fs.existsSync("/proc/self/status")) return;
  const root = "/proc/self";
  const read = createFsTools({ root, maxFileBytes: 100 }).find((t) => t.name === "read_file");
  await assert.rejects(read.run({ path: "status" }, {}), /too large/i);
});

test("tools still work end to end after the hardening", async () => {
  const root = await tmp("nh-e2e-");
  await fsp.writeFile(path.join(root, "n.txt"), "hello");
  await fsp.symlink(path.join(root, "n.txt"), path.join(root, "alias"));
  const tools = createFsTools({ root, allowWrite: true });
  const read = tools.find((t) => t.name === "read_file"), write = tools.find((t) => t.name === "write_file");
  assert.equal(await read.run({ path: "alias" }, {}), "hello", "a symlink that stays inside root is fine");
  await write.run({ path: "d/e/f.txt", content: "deep" }, {});
  assert.equal(await read.run({ path: "d/e/f.txt" }, {}), "deep");
});
