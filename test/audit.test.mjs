import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run, defineTool, anthropic } from "../dist/index.js";
import { defineAgent, pipeline, parallel } from "../dist/agents.js";
import { fileStore, memoryStore, session } from "../dist/store.js";
import { createFsTools } from "../dist/tools-fs.js";

const text = (t, usage) => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage });
const calls = (...c) => ({
  content: c.map(([name, input = {}], i) => ({ type: "tool_use", id: `t${i}`, name, input })),
  stopReason: "tool_use",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scripted = (...rs) => ({ complete: async () => rs.shift() });

test("A1: an agent's own AbortSignal survives pipeline, parallel and asTool", async () => {
  const ctl = new AbortController();
  ctl.abort();
  let called = 0;
  const a = defineAgent({ name: "a", signal: ctl.signal, adapter: { complete: async () => (called++, text("x")) } });
  await assert.rejects(pipeline([a], "in"), /stopped early \(aborted\)/);
  const [r] = await parallel([a], "in");
  assert.equal(r.value.stopReason, "aborted");
  assert.equal(called, 0);
});

test("A1: caller signal and agent signal are both honoured", async () => {
  const own = new AbortController();
  const caller = new AbortController();
  const a = defineAgent({
    name: "a",
    signal: own.signal,
    adapter: { complete: ({ signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("x")))) },
  });
  const p = a.run("go", { signal: caller.signal });
  await sleep(10);
  caller.abort();
  assert.equal((await p).stopReason, "aborted");
});

test("A2: concurrent writes to one fileStore key all succeed", async () => {
  const s = fileStore(await fsp.mkdtemp(path.join(os.tmpdir(), "nh-conc-")));
  await Promise.all(Array.from({ length: 200 }, (_, i) => s.set("k", { i })));
  assert.equal(typeof (await s.get("k")).i, "number");
  assert.deepEqual(await s.keys(), ["k"]);
});

test("A3: concurrent session runs on one id are queued and keep every message", async () => {
  const store = memoryStore();
  const seen = [];
  const ad = { complete: async ({ messages }) => (seen.push(messages.length), await sleep(10), text("r")) };
  await Promise.all([
    session(store, "s").run({ adapter: ad, prompt: "one" }),
    session(store, "s").run({ adapter: ad, prompt: "two" }),
    session(store, "s").run({ adapter: ad, prompt: "three" }),
  ]);
  assert.deepEqual(seen, [1, 3, 5]);
  assert.equal((await session(store, "s").messages()).length, 6);
});

test("A3: a failed session run does not block later runs", async () => {
  const store = memoryStore();
  await assert.rejects(session(store, "s").run({ adapter: { complete: async () => { throw new Error("down"); } }, prompt: "a" }), /down/);
  const r = await session(store, "s").run({ adapter: scripted(text("fine")), prompt: "b" });
  assert.equal(r.finalText, "fine");
});

test("A4: sub-agent token usage is added to the parent's usage", async () => {
  const worker = defineAgent({ name: "worker", adapter: scripted(text("w", { inputTokens: 100, outputTokens: 50 })) });
  const lead = defineAgent({
    name: "lead",
    tools: [worker.asTool("w")],
    adapter: scripted(
      { ...calls(["worker", { task: "t" }]), usage: { inputTokens: 10, outputTokens: 5 } },
      text("done", { inputTokens: 10, outputTokens: 5 }),
    ),
  });
  const r = await lead.run("go");
  assert.deepEqual(r.usage, { inputTokens: 120, outputTokens: 60 });
});

test("A4: usage of a sub-agent that stops early is still counted", async () => {
  const worker = defineAgent({
    name: "worker",
    maxTurns: 1,
    tools: [defineTool({ name: "x", description: "", schema: { type: "object" }, run: () => "ok" })],
    adapter: scripted({ ...calls(["x"]), usage: { inputTokens: 7, outputTokens: 3 } }),
  });
  const lead = defineAgent({ name: "lead", tools: [worker.asTool("w")], adapter: scripted(calls(["worker", { task: "t" }]), text("ok")) });
  const r = await lead.run("go");
  assert.deepEqual(r.usage, { inputTokens: 7, outputTokens: 3 });
});

test("A5: defineAgent runs sub-agents from one turn concurrently, in order of results", async () => {
  const w = (n, ms) => defineAgent({ name: n, adapter: { complete: async () => (await sleep(ms), text(n)) } });
  const adapter = scripted(calls(["w1", { task: "x" }], ["w2", { task: "x" }], ["w3", { task: "x" }]), text("ok"));
  const requests = [];
  const lead = defineAgent({
    name: "lead",
    tools: [w("w1", 120).asTool("a"), w("w2", 10).asTool("b"), w("w3", 60).asTool("c")],
    adapter: { complete: async (req) => (requests.push(structuredClone({ ...req, signal: undefined })), adapter.complete(req)) },
  });
  const t0 = Date.now();
  await lead.run("go");
  assert.ok(Date.now() - t0 < 230, `took ${Date.now() - t0}ms`);
  assert.deepEqual(requests[1].messages.at(-1).content.map((b) => b.content), ["w1", "w2", "w3"]);
});

test("A5: core run() stays sequential unless toolConcurrency is set", async () => {
  const order = [];
  const t = (n) => defineTool({ name: n, description: "", schema: { type: "object" }, run: async () => { order.push(n + ":start"); await sleep(20); order.push(n + ":end"); return n; } });
  await run({ adapter: scripted(calls(["a"], ["b"]), text("ok")), prompt: "x", tools: [t("a"), t("b")] });
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end"]);
  order.length = 0;
  await run({ adapter: scripted(calls(["a"], ["b"]), text("ok")), prompt: "x", tools: [t("a"), t("b")], toolConcurrency: 2 });
  assert.deepEqual(order, ["a:start", "b:start", "a:end", "b:end"]);
});

test("A5: a failing tool in a concurrent batch does not affect its siblings", async () => {
  const adapter = scripted(calls(["bad"], ["good"]), text("ok"));
  const reqs = [];
  const tools = [
    defineTool({ name: "bad", description: "", schema: { type: "object" }, run: () => { throw new Error("nope"); } }),
    defineTool({ name: "good", description: "", schema: { type: "object" }, run: () => "fine" }),
  ];
  const r = await run({ adapter: { complete: async (q) => (reqs.push(structuredClone({ ...q, signal: undefined })), adapter.complete(q)) }, prompt: "x", tools, toolConcurrency: 4 });
  assert.equal(r.stopReason, "end_turn");
  const [bad, good] = reqs[1].messages.at(-1).content;
  assert.equal(bad.is_error, true);
  assert.equal(good.content, "fine");
});

test("A6: mutually-recursive agents stop at maxDepth", async () => {
  let n = 0;
  const ta = [], tb = [];
  const model = (other) => ({ complete: async () => (n++, n > 500 ? text("runaway") : calls([other, { task: "again" }])) });
  const a = defineAgent({ name: "a", maxDepth: 3, maxTurns: 3, tools: ta, adapter: model("b") });
  const b = defineAgent({ name: "b", maxDepth: 3, maxTurns: 3, tools: tb, adapter: model("a") });
  ta.push(b.asTool("x"));
  tb.push(a.asTool("x"));
  await a.run("go", { maxModelCalls: Infinity });
  assert.ok(n < 200, `${n} model calls`);
});

test("A6: a shared budget caps total model calls across the whole agent tree", async () => {
  let n = 0;
  const ta = [], tb = [];
  const model = (other) => ({ complete: async () => (n++, n > 5000 ? text("runaway") : calls([other, { task: "again" }], [other, { task: "again 2" }])) });
  const a = defineAgent({ name: "a", maxDepth: 50, maxTurns: 20, tools: ta, adapter: model("b"), maxModelCalls: 25 });
  const b = defineAgent({ name: "b", maxDepth: 50, maxTurns: 20, tools: tb, adapter: model("a") });
  ta.push(b.asTool("x"));
  tb.push(a.asTool("x"));
  const r = await a.run("go");
  assert.equal(n, 25);
  assert.equal(r.stopReason, "budget_exceeded");
});

test("A6: sub-agents share the parent's budget; their own limit is ignored", async () => {
  let childCalls = 0;
  const child = defineAgent({ name: "child", maxModelCalls: 1000, adapter: { complete: async () => (childCalls++, text("c")) } });
  const lead = defineAgent({
    name: "lead",
    maxModelCalls: 3,
    tools: [child.asTool("c")],
    adapter: { complete: async () => calls(["child", { task: "t" }], ["child", { task: "u" }]) },
  });
  const r = await lead.run("go");
  assert.equal(r.stopReason, "budget_exceeded");
  assert.equal(childCalls, 2); // lead 1 + child 2 = the budget of 3
});

test("A6: plain run() has no call limit unless maxModelCalls is set", async () => {
  const rs = Array.from({ length: 30 }, (_, i) => calls(["t"]));
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, run: () => "x" });
  const r = await run({ adapter: scripted(...rs, text("end")), prompt: "x", tools: [t], maxTurns: 100 });
  assert.equal(r.stopReason, "end_turn");
  const r2 = await run({ adapter: scripted(...rs, text("end")), prompt: "x", tools: [t], maxTurns: 100, maxModelCalls: 5 });
  assert.equal(r2.stopReason, "budget_exceeded");
});

test("A6: depth error reaches the caller as a tool error", async () => {
  const inner = defineAgent({ name: "inner", maxDepth: 1, adapter: scripted(text("never")) });
  const mid = defineAgent({ name: "mid", maxDepth: 1, tools: [inner.asTool("i")], adapter: scripted(calls(["inner", { task: "t" }]), text("mid handled")) });
  const reqs = [];
  const top = defineAgent({
    name: "top",
    tools: [mid.asTool("m")],
    adapter: { complete: async (q) => (reqs.push(structuredClone({ ...q, signal: undefined })), [calls(["mid", { task: "t" }]), text("top done")][reqs.length - 1]) },
  });
  assert.equal((await top.run("go")).finalText, "top done");
});

test("A7: duplicate tool names are rejected", async () => {
  const a = defineAgent({ name: "dup", adapter: scripted(text("x")) });
  const b = defineAgent({ name: "dup", adapter: scripted(text("y")) });
  await assert.rejects(run({ adapter: scripted(text("ok")), prompt: "x", tools: [a.asTool("1"), b.asTool("2")] }), /Duplicate tool name: dup/);
});

test("A8: invalid agent names are rejected", () => {
  for (const name of ["my agent!", "", "a".repeat(65), "naïve"]) {
    assert.throws(() => defineAgent({ name, adapter: scripted() }), /Invalid agent name/);
  }
  defineAgent({ name: "ok_name-1", adapter: scripted() });
});

test("anthropic adapter retries 429 honouring retry-after, and gives up after maxRetries", async () => {
  let n = 0;
  const mk = (maxRetries) => anthropic({
    apiKey: "k", maxRetries,
    fetch: async () => {
      n++;
      return n < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } })
        : new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    },
  });
  assert.equal((await run({ adapter: mk(2), prompt: "x" })).finalText, "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(run({ adapter: mk(1), prompt: "x" }), /429: slow down/);
  assert.equal(n, 2);
});

test("anthropic adapter does not retry 4xx client errors and aborts during backoff", async () => {
  let n = 0;
  const bad = anthropic({ apiKey: "k", fetch: async () => (n++, new Response("no", { status: 401 })) });
  await assert.rejects(run({ adapter: bad, prompt: "x" }), /401/);
  assert.equal(n, 1);
  const ctl = new AbortController();
  const slow = anthropic({ apiKey: "k", fetch: async () => new Response("x", { status: 503, headers: { "retry-after": "20" } }) });
  const p = run({ adapter: slow, prompt: "x", signal: ctl.signal });
  setTimeout(() => ctl.abort(), 30);
  const t0 = Date.now();
  assert.equal((await p).stopReason, "aborted");
  assert.ok(Date.now() - t0 < 1000);
});

test("read_file refuses files over maxFileBytes", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nh-big-"));
  await fsp.writeFile(path.join(dir, "big.txt"), "x".repeat(100));
  await fsp.writeFile(path.join(dir, "small.txt"), "ok");
  const read = createFsTools({ root: dir, maxFileBytes: 50 }).find((t) => t.name === "read_file");
  await assert.rejects(read.run({ path: "big.txt" }, {}), /File too large: 100 bytes \(limit 50\)/);
  assert.equal(await read.run({ path: "small.txt" }, {}), "ok");
});
