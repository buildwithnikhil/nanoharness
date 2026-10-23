import { test } from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineTool } from "../dist/index.js";
import { defineAgent, pipeline, parallel, createPlanTool } from "../dist/agents.js";
import { createGraph, END } from "../dist/graph.js";
import { memoryStore, fileStore, session } from "../dist/store.js";

const text = (t) => ({ content: [{ type: "text", text: t }], stopReason: "end_turn" });
const call = (id, name, input = {}) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});
function fake(...responses) {
  const requests = [];
  return {
    requests,
    async complete(req) {
      requests.push(structuredClone({ ...req, signal: undefined }));
      const r = responses.shift();
      if (!r) throw new Error("fake adapter ran out of responses");
      return r;
    },
  };
}
// Replies by function of the last user text, for agents that run concurrently.
const echoAdapter = (fn) => ({ complete: async ({ messages }) => text(fn(messages.at(-1).content)) });

test("orchestrator delegates to a worker agent through asTool", async () => {
  const workerAdapter = fake(text("worker result: 42"));
  const worker = defineAgent({ name: "worker", adapter: workerAdapter, system: "You are a worker" });
  const leadAdapter = fake(call("1", "worker", { task: "compute" }), text("lead says 42"));
  const events = [];
  const lead = defineAgent({
    name: "lead",
    adapter: leadAdapter,
    tools: [worker.asTool("Does computations")],
    onEvent: (agent, ev) => events.push(`${agent}:${ev.type}`),
  });
  const r = await lead.run("what is the answer?");
  assert.equal(r.finalText, "lead says 42");
  assert.equal(leadAdapter.requests[1].messages.at(-1).content[0].content, "worker result: 42");
  assert.equal(workerAdapter.requests[0].system, "You are a worker");
  assert.equal(workerAdapter.requests[0].messages[0].content, "compute");
  assert.deepEqual(events, ["lead:tool_call", "lead:tool_result", "lead:text", "lead:done"]);
});

test("a sub-agent that stops early surfaces as a tool error", async () => {
  const worker = defineAgent({ name: "worker", adapter: fake(call("1", "x"), call("2", "x")), maxTurns: 1, tools: [defineTool({ name: "x", description: "", schema: { type: "object" }, run: () => "ok" })] });
  const leadAdapter = fake(call("1", "worker", { task: "t" }), text("handled"));
  const lead = defineAgent({ name: "lead", adapter: leadAdapter, tools: [worker.asTool("w")] });
  await lead.run("go");
  const res = leadAdapter.requests[1].messages.at(-1).content[0];
  assert.equal(res.is_error, true);
  assert.match(res.content, /worker stopped early \(max_turns\)/);
});

test("pipeline feeds each answer to the next agent", async () => {
  const a = defineAgent({ name: "a", adapter: echoAdapter((m) => `A(${m})`) });
  const b = defineAgent({ name: "b", adapter: echoAdapter((m) => `B(${m})`) });
  const { finalText, results } = await pipeline([a, b], "in");
  assert.equal(finalText, "B(A(in))");
  assert.equal(results.length, 2);
});

test("pipeline throws when a step does not finish", async () => {
  const a = defineAgent({ name: "a", adapter: echoAdapter(() => "x"), evaluate: () => false, maxEvalRetries: 0 });
  await assert.rejects(pipeline([a], "in"), /a stopped early \(eval_failed\)/);
});

test("parallel respects concurrency and reports failures per agent", async () => {
  let active = 0, peak = 0;
  const slow = (name, fail) => defineAgent({
    name,
    adapter: { complete: async () => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      if (fail) throw new Error("boom");
      return text(name);
    } },
  });
  const res = await parallel([slow("a"), slow("b", true), slow("c"), slow("d")], "in", { concurrency: 2 });
  assert.equal(peak, 2);
  assert.deepEqual(res.map((r) => r.status), ["fulfilled", "rejected", "fulfilled", "fulfilled"]);
  assert.equal(res[0].value.finalText, "a");
  assert.match(res[1].reason.message, /boom/);
});

test("parallel can give each agent its own input", async () => {
  const mk = (n) => defineAgent({ name: n, adapter: echoAdapter((m) => `${n}:${m}`) });
  const res = await parallel([mk("a"), mk("b")], ["one", "two"]);
  assert.deepEqual(res.map((r) => r.value.finalText), ["a:one", "b:two"]);
});

test("plan tool tracks and persists the plan, and restores it", async () => {
  const store = memoryStore();
  const plan = createPlanTool({ store });
  const items = [{ text: "research", status: "done" }, { text: "write", status: "in_progress" }, { text: "ship", status: "pending" }];
  const adapter = fake(call("1", "update_plan", { items }), text("planned"));
  await defineAgent({ name: "p", adapter, tools: [plan.tool] }).run("plan it");
  assert.equal(adapter.requests[1].messages.at(-1).content[0].content, "1. [x] research\n2. [~] write\n3. [ ] ship");
  assert.deepEqual(plan.get(), items);
  const restored = createPlanTool({ store });
  assert.deepEqual(await restored.load(), items);
});

test("plan tool rejects an invalid status", async () => {
  const plan = createPlanTool();
  const adapter = fake(call("1", "update_plan", { items: [{ text: "a", status: "nope" }] }), text("ok"));
  await defineAgent({ name: "p", adapter, tools: [plan.tool] }).run("x");
  assert.equal(adapter.requests[1].messages.at(-1).content[0].is_error, true);
});

for (const [label, make] of [
  ["memoryStore", async () => memoryStore()],
  ["fileStore", async () => fileStore(await fsp.mkdtemp(path.join(os.tmpdir(), "nh-store-")))],
]) {
  test(`${label}: get/set/delete/keys round-trip`, async () => {
    const s = await make();
    assert.equal(await s.get("missing"), undefined);
    await s.set("a/b", { n: 1 });
    await s.set("a:c", [1, 2]);
    await s.set("z", "x");
    assert.deepEqual(await s.get("a/b"), { n: 1 });
    assert.deepEqual((await s.keys("a")).sort(), ["a/b", "a:c"]);
    await s.delete("a/b");
    assert.equal(await s.get("a/b"), undefined);
    await s.delete("never-existed");
  });
}

test("fileStore keys cannot escape the directory", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nh-esc-"));
  const s = fileStore(path.join(dir, "store"));
  await s.set("../../evil", "x");
  assert.deepEqual(await fsp.readdir(dir), ["store"]);
  assert.equal(await s.get("../../evil"), "x");
});

test("session persists the conversation across runs and store instances", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "nh-sess-"));
  const a1 = fake(text("hello Ada"));
  await session(fileStore(dir), "u1").run({ adapter: a1, prompt: "I am Ada" });
  const a2 = fake(text("you are Ada"));
  const r = await session(fileStore(dir), "u1").run({ adapter: a2, prompt: "who am I?" });
  assert.deepEqual(a2.requests[0].messages.map((m) => m.content), ["I am Ada", [{ type: "text", text: "hello Ada" }], "who am I?"]);
  assert.equal(r.messages.length, 4);
  await session(fileStore(dir), "u1").clear();
  assert.deepEqual(await session(fileStore(dir), "u1").messages(), []);
});

test("session merges a new prompt after a run that stopped on tool results", async () => {
  const store = memoryStore();
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, run: () => "r" });
  await session(store, "s").run({ adapter: fake(call("1", "t")), prompt: "go", tools: [t], maxTurns: 1 });
  const a = fake(text("ok"));
  await session(store, "s").run({ adapter: a, prompt: "continue" });
  const msgs = a.requests[0].messages;
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(msgs[2].content.map((b) => b.type), ["tool_result", "text"]);
});

test("graph routes by node choice and by default edges", async () => {
  const g = createGraph({
    entry: "classify",
    edges: { fix: "verify" },
    nodes: {
      classify: ({ state }) => ({ state: { kind: state.input.includes("bug") ? "bug" : "feature" }, next: state.input.includes("bug") ? "fix" : "build" }),
      fix: () => ({ state: { fixed: true } }),
      build: () => ({ state: { built: true }, next: END }),
      verify: () => ({ state: { verified: true } }),
    },
  });
  const bug = await g.run({ input: "a bug" });
  assert.deepEqual(bug.path, ["classify", "fix", "verify"]);
  assert.deepEqual(bug.state, { input: "a bug", kind: "bug", fixed: true, verified: true });
  assert.equal(bug.status, "done");
  assert.deepEqual((await g.run({ input: "idea" })).path, ["classify", "build"]);
});

test("graph stops at maxSteps and on abort", async () => {
  const loop = createGraph({ entry: "a", maxSteps: 5, nodes: { a: () => ({ next: "a" }) } });
  const r = await loop.run({});
  assert.equal(r.status, "max_steps");
  assert.equal(r.path.length, 5);
  const ctl = new AbortController();
  ctl.abort();
  assert.equal((await loop.run({}, { signal: ctl.signal })).status, "aborted");
});

test("graph throws on an unknown node", async () => {
  const g = createGraph({ entry: "a", nodes: { a: () => ({ next: "ghost" }) } });
  await assert.rejects(g.run({}), /Unknown node: ghost/);
  assert.throws(() => createGraph({ entry: "nope", nodes: {} }), /Unknown entry node/);
});

test("graph resumes from its checkpoint after a node fails", async () => {
  const store = memoryStore();
  const calls = { a: 0, b: 0, c: 0 };
  let failB = true;
  const g = createGraph({
    entry: "a", store, id: "job1",
    edges: { a: "b", b: "c" },
    nodes: {
      a: () => (calls.a++, { state: { a: 1 } }),
      b: () => { calls.b++; if (failB) throw new Error("crash"); return { state: { b: 1 } }; },
      c: () => (calls.c++, { state: { c: 1 } }),
    },
  });
  await assert.rejects(g.run({}), /crash/);
  failB = false;
  const r = await g.run({});
  assert.deepEqual(calls, { a: 1, b: 2, c: 1 });
  assert.deepEqual(r.path, ["b", "c"]);
  assert.deepEqual(r.state, { a: 1, b: 1, c: 1 });
  assert.deepEqual(await store.keys(), [], "checkpoint is removed when the run completes");
  const fresh = await g.run({});
  assert.deepEqual(fresh.path, ["a", "b", "c"]);
});

test("graph nodes can run agents", async () => {
  const writer = defineAgent({ name: "writer", adapter: echoAdapter((m) => `draft of ${m}`) });
  const g = createGraph({
    entry: "write",
    nodes: { write: async ({ state }) => ({ state: { draft: (await writer.run(state.topic)).finalText } }) },
  });
  assert.equal((await g.run({ topic: "cats" })).state.draft, "draft of cats");
});
