import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { run, defineTool, validate } from "../dist/index.js";
import { defineAgent } from "../dist/agents.js";
import { createGraph, END } from "../dist/graph.js";
import { memoryStore, session } from "../dist/store.js";

const text = (t, usage) => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage });
const calls = (...c) => ({ content: c.map(([name, input = {}], i) => ({ type: "tool_use", id: "t" + i, name, input })), stopReason: "tool_use" });
const scripted = (...rs) => ({ complete: async () => rs.shift() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (name, fn) => defineTool({ name, description: "", schema: { type: "object" }, run: fn });
const recording = (...rs) => { const reqs = []; return { reqs, complete: async (q) => (reqs.push(structuredClone({ ...q, signal: undefined })), rs.shift()) }; };
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// ---- core loop (reviewer 1)
test("CR-1: a rejected answer with no turns left is eval_failed, not end_turn", async () => {
  const r = await run({ adapter: { complete: async () => text("bad") }, prompt: "x", maxTurns: 1, evaluate: () => false });
  assert.equal(r.stopReason, "eval_failed");
  const ok = await run({ adapter: scripted(text("fine")), prompt: "x", maxTurns: 1, evaluate: () => true });
  assert.equal(ok.stopReason, "end_turn");
});

test("CR-1: agents treat a rejected answer as a failure", async () => {
  const worker = defineAgent({ name: "w", maxTurns: 1, evaluate: () => false, adapter: { complete: async () => text("bad") } });
  const adapter = recording(calls(["w", { task: "t" }]), text("ok"));
  await defineAgent({ name: "lead", tools: [worker.asTool("w")], adapter }).run("go");
  assert.equal(adapter.reqs[1].messages.at(-1).content[0].is_error, true);
});

test("CR-2: abort skips queued tool calls (each still gets a result) and the run reports aborted", async () => {
  const ctl = new AbortController();
  const ran = [];
  const t1 = tool("t1", () => (ran.push(1), ctl.abort(), "a"));
  const t2 = tool("t2", () => (ran.push(2), "b"));
  const adapter = recording(calls(["t1"], ["t2"]), text("never"));
  const r = await run({ adapter, prompt: "x", tools: [t1, t2], signal: ctl.signal });
  assert.deepEqual(ran, [1]);
  assert.equal(r.stopReason, "aborted");
  const last = r.messages.at(-1).content;
  assert.equal(last.length, 2, "history stays valid: every tool_use has a tool_result");
  assert.equal(last[1].is_error, true);
});

test("CR-2: a tool that ignores its signal does not hold up an aborted run", async () => {
  const ctl = new AbortController();
  const slow = tool("slow", () => sleep(1500));
  const t0 = Date.now();
  const p = run({ adapter: scripted(calls(["slow"]), text("never")), prompt: "x", tools: [slow], signal: ctl.signal });
  setTimeout(() => ctl.abort(), 100);
  const r = await p;
  assert.ok(Date.now() - t0 < 700, `took ${Date.now() - t0}ms`);
  assert.equal(r.stopReason, "aborted");
});

test("CR-3: an already-aborted signal reaches the tool context even with toolTimeoutMs, and the tool does not start", async () => {
  const ctl = new AbortController();
  let started = 0;
  const t = tool("t", () => (started++, "x"));
  const adapter = { complete: async () => (ctl.abort(), calls(["t"])) };
  const r = await run({ adapter, prompt: "x", tools: [t], signal: ctl.signal, toolTimeoutMs: 1000 });
  assert.equal(started, 0);
  assert.equal(r.stopReason, "aborted");
});

test("CR-4: a throwing or non-string onToolResult hook fails closed without crashing the run", async () => {
  for (const hook of [() => { throw new Error("hook boom"); }, () => undefined, () => 42]) {
    const adapter = recording(calls(["t"]), text("done"));
    const r = await run({ adapter, prompt: "x", tools: [tool("t", () => "SECRET")], onToolResult: hook });
    assert.equal(r.stopReason, "end_turn");
    const res = adapter.reqs[1].messages.at(-1).content[0];
    assert.equal(res.is_error, true);
    assert.equal(res.content, "The tool result could not be processed.");
    assert.ok(!JSON.stringify(adapter.reqs[1]).includes("SECRET"), "raw output never reaches the model");
  }
});

test("CR-4: a failing hook does not leave sibling tools running after the run settles", async () => {
  let finished = 0;
  const slow = tool("slow", async () => (await sleep(60), finished++, "s"));
  const fast = tool("fast", () => "f");
  const adapter = scripted(calls(["fast"], ["slow"]), text("done"));
  await run({ adapter, prompt: "x", tools: [slow, fast], toolConcurrency: 2, onToolResult: ({ call }) => { if (call.name === "fast") throw new Error("boom"); return "ok"; } });
  assert.equal(finished, 1, "the slow tool had finished before run() returned");
});

test("CR-5: maxToolResultChars is a hard cap including the marker, and never splits an emoji", async () => {
  for (const max of [5, 20, 33, 60, 100]) {
    const adapter = recording(calls(["t"]), text("ok"));
    await run({ adapter, prompt: "x", tools: [tool("t", () => "a😀".repeat(40))], maxToolResultChars: max });
    const c = adapter.reqs[1].messages.at(-1).content[0].content;
    assert.ok(c.length <= max, `max ${max}: got ${c.length}`);
    assert.ok(!lone.test(c), `max ${max}: lone surrogate`);
  }
  const adapter = recording(calls(["t"]), text("ok"));
  await run({ adapter, prompt: "x", tools: [tool("t", () => "x".repeat(500))], maxToolResultChars: 100 });
  const c = adapter.reqs[1].messages.at(-1).content[0].content;
  assert.match(c, /\[truncated \d+ characters\]$/);
  assert.ok(c.length <= 100);
  const short = recording(calls(["t"]), text("ok"));
  await run({ adapter: short, prompt: "x", tools: [tool("t", () => "tiny")], maxToolResultChars: 100 });
  assert.equal(short.reqs[1].messages.at(-1).content[0].content, "tiny");
});

test("CR-6: schema keywords that generators commonly emit are enforced", () => {
  assert.match(validate(2, { const: 1 }), /must equal/);
  assert.equal(validate(1, { const: 1 }), null);
  assert.equal(validate({ a: 1 }, { const: { a: 1 } }), null, "const compares deeply");
  assert.equal(validate({ c: { x: 1 } }, { type: "object", properties: { c: { enum: [{ x: 1 }, [2]] } } }), null, "enum compares deeply");
  const anyOf = { anyOf: [{ type: "string" }, { type: "integer", minimum: 5 }] };
  assert.equal(validate("a", anyOf), null);
  assert.equal(validate(7, anyOf), null);
  assert.match(validate(2, anyOf), /does not match any/);
  const oneOf = { oneOf: [{ type: "number" }, { type: "integer" }] };
  assert.match(validate(3, oneOf), /exactly one/);
  assert.equal(validate(3.5, oneOf), null);
  assert.match(validate(1, { allOf: [{ type: "number" }, { minimum: 2 }] }), />= 2/);
  assert.match(validate(5, { exclusiveMinimum: 5 }), /> 5/);
  assert.match(validate(5, { exclusiveMaximum: 5 }), /< 5/);
  assert.equal(validate(6, { exclusiveMinimum: 5, exclusiveMaximum: 7 }), null);
  assert.match(validate(7, { multipleOf: 2 }), /multiple of 2/);
  assert.equal(validate(0.3, { multipleOf: 0.1 }), null, "floating point multiples");
  assert.match(validate([1, 1], { uniqueItems: true }), /unique/);
  assert.match(validate([{ a: 1, b: 2 }, { b: 2, a: 1 }], { uniqueItems: true }), /unique/);
  assert.equal(validate([1, "1"], { uniqueItems: true }), null);
  const extra = { type: "object", properties: { a: { type: "number" } }, additionalProperties: { type: "string" } };
  assert.equal(validate({ a: 1, k: "v" }, extra), null);
  assert.match(validate({ a: 1, k: 5 }, extra), /input\.k: expected string/);
  assert.equal(validate({ a: 1, k: 5 }, { ...extra, additionalProperties: true }), null);
});

test("CR-6: a schema with an invalid pattern, or a huge string, is reported instead of hanging or crashing", () => {
  assert.match(validate("a", { type: "string", pattern: "(" }), /invalid pattern/);
  assert.match(validate("x".repeat(200_000), { type: "string", pattern: "^x+$" }), /too long to check/);
  assert.equal(validate("x".repeat(200_000), { type: "string" }), null);
});

test("CR-7: maxRepeatedCalls sees through key reordering", async () => {
  let ran = 0;
  const t = tool("t", () => ++ran);
  const adapter = scripted(calls(["t", { a: 1, b: { y: 1, z: 2 } }]), calls(["t", { b: { z: 2, y: 1 }, a: 1 }]), text("ok"));
  await run({ adapter, prompt: "x", tools: [t], maxRepeatedCalls: 1 });
  assert.equal(ran, 1);
});

test("CR-8: empty evaluate feedback falls back to a real message", async () => {
  const adapter = recording(text("a"), text("b"));
  await run({ adapter, prompt: "x", evaluate: () => ({ feedback: "" }), maxEvalRetries: 1 });
  assert.notEqual(adapter.reqs[1].messages.at(-1).content, "");
  assert.ok(adapter.reqs[1].messages.at(-1).content.length > 0);
});

test("F8: an empty reply followed by an evaluate retry does not produce two user messages in a row", async () => {
  const adapter = recording({ content: [], stopReason: "end_turn" }, text("answer"));
  let n = 0;
  await run({ adapter, prompt: "x", evaluate: () => (n++ === 0 ? { feedback: "try again" } : true) });
  const roles = adapter.reqs[1].messages.map((m) => m.role);
  assert.deepEqual(roles, ["user"], `roles were ${roles}`);
  assert.match(JSON.stringify(adapter.reqs[1].messages[0].content), /x.*try again/s);
});

test("CR-9: the AbortSignal fallback for older Node removes its listeners", async () => {
  const original = AbortSignal.any;
  AbortSignal.any = undefined;
  try {
    const base = new AbortController();
    const agent = defineAgent({ name: "a", signal: base.signal, adapter: { complete: async () => text("ok") } });
    const caller = new AbortController();
    for (let i = 0; i < 5; i++) await agent.run("x", { signal: caller.signal });
    assert.equal(getEventListeners(base.signal, "abort").length, 0);
    assert.equal(getEventListeners(caller.signal, "abort").length, 0);
  } finally {
    AbortSignal.any = original;
  }
});

// ---- agents, graph, sessions (reviewer 2)
test("F8: usage of a sub-agent that throws is still counted", async () => {
  const worker = defineAgent({
    name: "w",
    adapter: { complete: (() => { let n = 0; return async () => { if (n++ === 0) return { ...calls(["x"]), usage: { inputTokens: 7, outputTokens: 3 } }; throw new Error("adapter down"); }; })() },
    tools: [tool("x", () => "ok")],
  });
  const lead = defineAgent({ name: "lead", tools: [worker.asTool("w")], adapter: scripted({ ...calls(["w", { task: "t" }]), usage: { inputTokens: 1, outputTokens: 1 } }, text("ok", { inputTokens: 1, outputTokens: 1 })) });
  const r = await lead.run("go");
  assert.deepEqual(r.usage, { inputTokens: 1 + 1 + 7, outputTokens: 1 + 1 + 3 }, "the worker's one completed call is counted even though it then failed");
});

test("F8: usage is not double counted through two levels of agents", async () => {
  const leaf = defineAgent({ name: "leaf", adapter: scripted(text("l", { inputTokens: 100, outputTokens: 10 })) });
  const mid = defineAgent({ name: "mid", tools: [leaf.asTool("l")], adapter: scripted({ ...calls(["leaf", { task: "t" }]), usage: { inputTokens: 20, outputTokens: 2 } }, text("m", { inputTokens: 20, outputTokens: 2 })) });
  const top = defineAgent({ name: "top", tools: [mid.asTool("m")], adapter: scripted({ ...calls(["mid", { task: "t" }]), usage: { inputTokens: 3, outputTokens: 1 } }, text("t", { inputTokens: 3, outputTokens: 1 })) });
  const r = await top.run("go");
  assert.deepEqual(r.usage, { inputTokens: 3 + 3 + 20 + 20 + 100, outputTokens: 1 + 1 + 2 + 2 + 10 });
});

test("F8: session.clear() waits for a run in flight instead of being undone by it", async () => {
  const store = memoryStore();
  const slow = { complete: async () => (await sleep(40), text("r")) };
  const s = session(store, "s");
  const running = s.run({ adapter: slow, prompt: "a" });
  await sleep(5);
  const cleared = s.clear();
  await Promise.all([running, cleared]);
  assert.deepEqual(await s.messages(), [], "clear() ran after the run and won");
});

test("F1: maxSteps applies to each call, so a stopped graph resumes and makes progress", async () => {
  const store = memoryStore();
  const g = createGraph({ entry: "a", maxSteps: 2, store, id: "j", edges: { a: "b", b: "c", c: "d" }, nodes: { a: () => ({ state: { a: 1 } }), b: () => ({ state: { b: 1 } }), c: () => ({ state: { c: 1 } }), d: () => ({ state: { d: 1 } }) } });
  const r1 = await g.run({});
  assert.deepEqual([r1.status, r1.path], ["max_steps", ["a", "b"]]);
  const r2 = await g.run({});
  assert.deepEqual([r2.status, r2.path], ["done", ["c", "d"]]);
  assert.deepEqual(r2.state, { a: 1, b: 1, c: 1, d: 1 });
});

test("F2: a node returning an unknown next fails once and does not poison the checkpoint", async () => {
  const store = memoryStore();
  let typo = true;
  const g = createGraph({ entry: "a", store, id: "j", nodes: { a: () => ({ next: typo ? "tpyo" : "b" }), b: () => ({ state: { done: true }, next: END }) } });
  await assert.rejects(g.run({}), /Unknown node: tpyo/);
  typo = false;
  const r = await g.run({});
  assert.deepEqual(r.path, ["a", "b"], "the fixed graph reruns from the last good checkpoint");
});

test("F2: node names are own properties, so 'constructor' is not a node", async () => {
  const g = createGraph({ entry: "a", nodes: { a: () => ({ next: "constructor" }) } });
  await assert.rejects(g.run({}), /Unknown node: constructor/);
  assert.throws(() => createGraph({ entry: "toString", nodes: {} }), /Unknown entry node/);
});

test("F6: the checkpoint is saved before onStep, so a throwing hook does not re-run the node", async () => {
  const store = memoryStore();
  let ran = 0, throwOnce = true;
  const g = createGraph({ entry: "a", store, id: "j", edges: { a: "b" }, onStep: () => { if (throwOnce) { throwOnce = false; throw new Error("hook"); } },
    nodes: { a: () => (ran++, { state: { a: 1 } }), b: () => ({ next: END }) } });
  await assert.rejects(g.run({}), /hook/);
  await g.run({});
  assert.equal(ran, 1);
});

test("F7: with a store, a resumed run sees the same state as an uninterrupted one", async () => {
  const seen = [];
  const mk = (failOnce) => {
    let fail = failOnce;
    return createGraph({ entry: "a", store: memoryStore(), id: "j", edges: { a: "b", b: "c" },
      nodes: { a: () => ({ state: { d: new Date(0), u: undefined, n: 1 } }),
               b: ({ state }) => { if (fail) { fail = false; throw new Error("crash"); } seen.push(JSON.stringify([typeof state.d, "u" in state, state.n])); return {}; },
               c: () => ({}) } });
  };
  await mk(false).run({});
  const crashing = mk(true);
  await assert.rejects(crashing.run({}), /crash/);
  await crashing.run({});
  assert.equal(seen.length, 2);
  assert.equal(seen[0], seen[1]);
});

test("F7: state that cannot be saved is reported before more work is done", async () => {
  const cyc = {}; cyc.self = cyc;
  let bRan = 0;
  const g = createGraph({ entry: "a", store: memoryStore(), id: "j", edges: { a: "b" }, nodes: { a: () => ({ state: { cyc } }), b: () => (bRan++, {}) } });
  await assert.rejects(g.run({}), /JSON-serialisable/);
  assert.equal(bRan, 0);
});

test("F7: concurrent runs of one graph id are queued, not interleaved", async () => {
  const store = memoryStore();
  let active = 0, peak = 0, total = 0;
  const g = createGraph({ entry: "a", store, id: "j", nodes: { a: async () => { active++; peak = Math.max(peak, active); await sleep(10); total++; active--; return { next: END }; } } });
  await Promise.all([g.run({}), g.run({}), g.run({})]);
  assert.equal(peak, 1);
  assert.equal(total, 3);
});

import { defineZodTool } from "../dist/zod.js";
import { z } from "zod";

test("zod: the model is shown the input schema, so defaulted fields are optional", () => {
  const t = defineZodTool({ name: "t", description: "", schema: z.object({ a: z.string().default("x"), b: z.coerce.number() }), run: (i) => i });
  assert.deepEqual(t.schema.required, ["b"]);
  assert.deepEqual(t.parse({ b: "5" }), { ok: true, value: { a: "x", b: 5 } });
});

test("zod: a schema that is not an object is rejected up front", () => {
  assert.throws(() => defineZodTool({ name: "t", description: "", schema: z.string(), run: () => "" }), /must be a z\.object/);
});
