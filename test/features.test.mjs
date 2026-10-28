import { test } from "node:test";
import assert from "node:assert/strict";
import { run, stream, defineTool, AdapterError, defineAdapter, limitConcurrency, withRetry, readSSE, promptAdapter, trimHistory } from "../dist/index.js";
import { defineAgent, parallel } from "../dist/agents.js";
import { memoryStore, session, checkStore } from "../dist/store.js";

const text = (t, usage) => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage });
const call = (name, input = {}, id = "c1") => ({ content: [{ type: "tool_use", id, name, input }], stopReason: "tool_use" });
const scripted = (...rs) => ({ complete: async () => rs.shift() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const add = defineTool({ name: "add", description: "Add", schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, run: ({ a, b }) => a + b });
const body = (chunks) => new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(new TextEncoder().encode(ch)); c.close(); } });
const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };

// ---------------- history
const u = (t) => ({ role: "user", content: t });
const a = (t) => ({ role: "assistant", content: [{ type: "text", text: t }] });
const tu = (id) => ({ role: "assistant", content: [{ type: "tool_use", id, name: "t", input: {} }] });
const tr = (id) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "r" }] });

test("trimHistory keeps at most maxMessages, starting at a plain user message", () => {
  const h = [u("1"), a("1"), u("2"), tu("x"), tr("x"), a("2"), u("3"), a("3")];
  const kept = trimHistory(h, { maxMessages: 4 });
  assert.deepEqual(kept, [u("3"), a("3")], "a window starting at a tool result moves forward to the next plain user message");
  assert.deepEqual(trimHistory(h, { maxMessages: 6 }), h.slice(2));
  assert.deepEqual(trimHistory(h, { maxMessages: 100 }), h);
  for (let max = 1; max <= h.length; max++) {
    const k = trimHistory(h, { maxMessages: max });
    assert.equal(k[0].role, "user");
    assert.ok(typeof k[0].content === "string" || !k[0].content.some((b) => b.type === "tool_result"), `max ${max}`);
    assert.deepEqual(k, h.slice(h.length - k.length), "always a suffix");
  }
});

test("trimHistory falls back to the shortest valid tail when the window has no safe start", () => {
  const h = [u("1"), tu("x"), tr("x"), tu("y"), tr("y"), a("done")];
  assert.deepEqual(trimHistory(h, { maxMessages: 2 }), h, "only the first message is a safe start");
});

test("session maxMessages keeps stored history bounded and valid", async () => {
  const store = memoryStore();
  const s = session(store, "s", { maxMessages: 4 });
  for (let i = 0; i < 10; i++) await s.run({ adapter: scripted(text(`r${i}`)), prompt: `m${i}` });
  const msgs = await s.messages();
  assert.ok(msgs.length <= 6, `stored ${msgs.length}`);
  assert.equal(msgs[0].role, "user");
  assert.equal(msgs.at(-1).content[0].text, "r9");
});

test("session summarize turns dropped messages into a summary at the front", async () => {
  const store = memoryStore();
  const dropped = [];
  const s = session(store, "s", { maxMessages: 2, summarize: (msgs) => (dropped.push(msgs.length), `summary of ${msgs.length}`) });
  const seen = [];
  const adapter = { complete: async (q) => (seen.push(q.messages), text("ok")) };
  for (let i = 0; i < 4; i++) await s.run({ adapter, prompt: `m${i}` });
  assert.ok(dropped.length > 0);
  const first = seen.at(-1)[0];
  assert.equal(first.role, "user");
  assert.match(first.content[0].text, /^Summary of the earlier conversation:\nsummary of \d+/);
  assert.deepEqual(seen.at(-1).map((m) => m.role).filter((r, i, arr) => i > 0 && r === arr[i - 1]), [], "roles still alternate");
});

// ---------------- AdapterError, withRetry, limitConcurrency, defineAdapter
test("AdapterError marks 408/429/5xx retryable by default", () => {
  assert.equal(new AdapterError("x", { status: 429 }).retryable, true);
  assert.equal(new AdapterError("x", { status: 529 }).retryable, true);
  assert.equal(new AdapterError("x", { status: 400 }).retryable, false);
  assert.equal(new AdapterError("x").retryable, false);
  assert.equal(new AdapterError("x", { status: 400, retryable: true }).retryable, true);
  assert.ok(new AdapterError("x") instanceof Error);
});

test("withRetry retries retryable errors, honours retryAfterMs, and stops on others", async () => {
  let n = 0;
  const flaky = withRetry({ complete: async () => { if (n++ < 2) throw new AdapterError("busy", { status: 503, retryAfterMs: 10 }); return text("ok"); } }, { maxRetries: 2 });
  const t0 = Date.now();
  assert.equal((await run({ adapter: flaky, prompt: "x" })).finalText, "ok");
  assert.equal(n, 3);
  assert.ok(Date.now() - t0 < 400, "used the 10ms hint, not the 500ms default");
  let m = 0;
  await assert.rejects(run({ adapter: withRetry({ complete: async () => { m++; throw new AdapterError("bad request", { status: 400 }); } }), prompt: "x" }), /bad request/);
  assert.equal(m, 1);
  let k = 0;
  await assert.rejects(run({ adapter: withRetry({ complete: async () => { k++; throw new Error("bug"); } }), prompt: "x" }), /bug/);
  assert.equal(k, 1, "a plain error is not retried");
  let net = 0;
  const netFlaky = withRetry({ complete: async () => { if (net++ === 0) throw new TypeError("fetch failed"); return text("ok"); } }, { baseDelayMs: 1 });
  assert.equal((await run({ adapter: netFlaky, prompt: "x" })).finalText, "ok");
  let c = 0;
  const custom = withRetry({ complete: async () => { if (c++ === 0) throw new Error("custom"); return text("ok"); } }, { retryable: (e) => e.message === "custom", baseDelayMs: 1 });
  assert.equal((await run({ adapter: custom, prompt: "x" })).finalText, "ok");
});

test("withRetry gives up when the run is aborted during backoff", async () => {
  const ctl = new AbortController();
  const slow = withRetry({ complete: async () => { throw new AdapterError("busy", { status: 503, retryAfterMs: 20_000 }); } }, { maxDelayMs: 20_000 });
  const p = run({ adapter: slow, prompt: "x", signal: ctl.signal });
  setTimeout(() => ctl.abort(), 30);
  const t0 = Date.now();
  assert.equal((await p).stopReason, "aborted");
  assert.ok(Date.now() - t0 < 1000);
});

test("withRetry retries a stream only if it failed before any text arrived", async () => {
  let attempts = 0;
  const early = withRetry({ complete: async () => text("x"), async *stream() { attempts++; if (attempts === 1) throw new AdapterError("busy", { status: 503, retryAfterMs: 1 }); yield { type: "text_delta", text: "hi" }; yield { type: "response", response: text("hi") }; } });
  assert.equal((await run({ adapter: early, prompt: "x", streaming: true })).finalText, "hi");
  assert.equal(attempts, 2);
  let late = 0;
  const mid = withRetry({ complete: async () => text("x"), async *stream() { late++; yield { type: "text_delta", text: "partial" }; throw new AdapterError("dropped", { status: 503, retryAfterMs: 1 }); } });
  await assert.rejects(run({ adapter: mid, prompt: "x", streaming: true }), /dropped/);
  assert.equal(late, 1);
  assert.equal(withRetry({ complete: async () => text("x") }).stream, undefined, "no stream is invented for an adapter without one");
});

test("limitConcurrency caps calls in flight across agents and runs", async () => {
  let active = 0, peak = 0;
  const shared = limitConcurrency({ complete: async () => { active++; peak = Math.max(peak, active); await sleep(20); active--; return text("ok"); } }, 2);
  const agents = Array.from({ length: 6 }, (_, i) => defineAgent({ name: `a${i}`, adapter: shared }));
  const res = await parallel(agents, "x");
  assert.equal(peak, 2);
  assert.ok(res.every((r) => r.status === "fulfilled"));
  assert.throws(() => limitConcurrency(shared, 0), /at least 1/);
});

test("limitConcurrency: an aborted run leaves the queue without taking a slot", async () => {
  let active = 0, peak = 0, calls = 0;
  const shared = limitConcurrency({ complete: async () => { calls++; active++; peak = Math.max(peak, active); await sleep(60); active--; return text("ok"); } }, 1);
  const ctl = new AbortController();
  const first = run({ adapter: shared, prompt: "x" });
  const waiting = run({ adapter: shared, prompt: "x", signal: ctl.signal });
  await sleep(10);
  ctl.abort();
  assert.equal((await waiting).stopReason, "aborted");
  await first;
  await run({ adapter: shared, prompt: "x" });
  assert.equal(calls, 2, "the aborted call never reached the model");
  assert.equal(peak, 1);
});

test("limitConcurrency also limits streams, and releases the slot when a stream stops early", async () => {
  let active = 0, peak = 0;
  const inner = { complete: async () => text("x"), async *stream() { active++; peak = Math.max(peak, active); try { yield { type: "text_delta", text: "a" }; await sleep(15); yield { type: "response", response: text("a") }; } finally { active--; } } };
  const shared = limitConcurrency(inner, 1);
  await Promise.all([run({ adapter: shared, prompt: "x", streaming: true }), run({ adapter: shared, prompt: "x", streaming: true })]);
  assert.equal(peak, 1);
  const it = shared.stream({ messages: [], tools: [] });
  await it.next();
  await it.return();
  await run({ adapter: shared, prompt: "x", streaming: true }); // would hang if the slot leaked
});

test("defineAdapter returns the adapter unchanged", () => {
  const a = { complete: async () => text("x") };
  assert.equal(defineAdapter(a), a);
});

// ---------------- readSSE
test("readSSE handles events split across chunks, CRLF, comments and multi-line data", async () => {
  const chunks = ["event: a\r\ndata: one\r\n\r\n: keep-alive\n\nda", "ta: two\ndata: lines\n\nevent: b\ndata:no-space\n", "\n", "data: last-without-blank-line"];
  assert.deepEqual(await collect(readSSE(body(chunks))), [
    { event: "a", data: "one" },
    { event: undefined, data: "two\nlines" },
    { event: "b", data: "no-space" },
    { event: undefined, data: "last-without-blank-line" },
  ]);
});

test("readSSE splits correctly even one byte at a time, including multi-byte characters", async () => {
  const text = "data: héllo 😀\n\ndata: x\n\n";
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
  assert.deepEqual((await collect(readSSE(stream))).map((e) => e.data), ["héllo 😀", "x"]);
});

// ---------------- streaming, events, observability
test("streaming: text_delta events arrive before the final text, and the result is the same", async () => {
  const adapter = {
    complete: async () => { throw new Error("complete should not be called when streaming"); },
    async *stream() { yield { type: "text_delta", text: "Hel" }; yield { type: "text_delta", text: "lo" }; yield { type: "response", response: text("Hello", { inputTokens: 2, outputTokens: 1 }) }; },
  };
  const types = [];
  let result;
  for await (const ev of stream({ adapter, prompt: "x", streaming: true })) { types.push(ev.type === "text_delta" ? `delta:${ev.text}` : ev.type); if (ev.type === "done") result = ev.result; }
  assert.deepEqual(types, ["delta:Hel", "delta:lo", "model_call", "text", "done"]);
  assert.equal(result.finalText, "Hello");
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 1 });
});

test("streaming falls back to complete() for adapters without stream, and is off by default", async () => {
  const types = [];
  for await (const ev of stream({ adapter: scripted(text("plain")), prompt: "x", streaming: true })) types.push(ev.type);
  assert.deepEqual(types, ["model_call", "text", "done"]);
  let streamed = 0;
  const both = { complete: async () => text("c"), async *stream() { streamed++; yield { type: "response", response: text("s") }; } };
  assert.equal((await run({ adapter: both, prompt: "x" })).finalText, "c");
  assert.equal(streamed, 0);
});

test("streaming: a stream with no final response is an error, and abort mid-stream stops the run", async () => {
  await assert.rejects(run({ adapter: { complete: async () => text("x"), async *stream() { yield { type: "text_delta", text: "a" }; } }, prompt: "x", streaming: true }), /ended without a response/);
  const ctl = new AbortController();
  const slow = { complete: async () => text("x"), async *stream({ signal }) { yield { type: "text_delta", text: "a" }; await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))); } };
  const p = run({ adapter: slow, prompt: "x", streaming: true, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  assert.equal((await p).stopReason, "aborted");
});

test("streaming works with tools, and with agents", async () => {
  let n = 0;
  const adapter = { complete: async () => text("x"), async *stream() { if (n++ === 0) { yield { type: "response", response: call("add", { a: 2, b: 3 }) }; return; } yield { type: "text_delta", text: "5" }; yield { type: "response", response: text("5") }; } };
  const deltas = [];
  const agent = defineAgent({ name: "a", adapter, tools: [add], streaming: true, onEvent: (_, ev) => ev.type === "text_delta" && deltas.push(ev.text) });
  assert.equal((await agent.run("2+3")).finalText, "5");
  assert.deepEqual(deltas, ["5"]);
});

test("onEvent on run() reports every event, with timing for model calls and tools", async () => {
  const events = [];
  const slowAdd = defineTool({ name: "add", description: "", schema: { type: "object" }, run: async () => (await sleep(25), 5) });
  const adapter = { complete: async (q) => (await sleep(15), q.messages.length === 1 ? { ...call("add"), usage: { inputTokens: 3, outputTokens: 1 } } : text("5")) };
  const r = await run({ adapter, prompt: "x", tools: [slowAdd], onEvent: (ev) => events.push(ev) });
  assert.equal(r.finalText, "5");
  assert.deepEqual(events.map((e) => e.type), ["model_call", "tool_call", "tool_result", "model_call", "text", "done"]);
  const [m1] = events;
  assert.ok(m1.durationMs >= 10, `model call ${m1.durationMs}ms`);
  assert.deepEqual(m1.usage, { inputTokens: 3, outputTokens: 1 });
  assert.equal(m1.stopReason, "tool_use");
  assert.ok(events[2].durationMs >= 20, `tool ${events[2].durationMs}ms`);
  assert.equal(events.at(-1).result, r);
});

test("tool durations are reported for concurrent tools too", async () => {
  const t = (name, ms) => defineTool({ name, description: "", schema: { type: "object" }, run: async () => (await sleep(ms), name) });
  const events = [];
  const adapter = scripted({ content: [{ type: "tool_use", id: "1", name: "slow", input: {} }, { type: "tool_use", id: "2", name: "fast", input: {} }], stopReason: "tool_use" }, text("ok"));
  await run({ adapter, prompt: "x", tools: [t("slow", 40), t("fast", 5)], toolConcurrency: 2, onEvent: (e) => e.type === "tool_result" && events.push(e.durationMs) });
  assert.ok(events[0] >= 35 && events[1] < 35, JSON.stringify(events));
});

// ---------------- promptAdapter (custom text-only models)
test("promptAdapter gives a text-only model tool calling", async () => {
  const prompts = [];
  const model = async ({ system, prompt }) => {
    prompts.push({ system, prompt });
    if (!prompt.includes("Tool result")) return '{"tool_calls": [{"name": "add", "input": {"a": 1234, "b": 5678}}]}';
    return { text: "The answer is 6912.", usage: { inputTokens: 9, outputTokens: 4 } };
  };
  const r = await run({ adapter: promptAdapter({ generate: model }), prompt: "What is 1234 + 5678?", system: "Be brief.", tools: [add] });
  assert.equal(r.finalText, "The answer is 6912.");
  assert.equal(r.stopReason, "end_turn");
  assert.deepEqual(r.usage, { inputTokens: 9, outputTokens: 4 });
  assert.match(prompts[0].system, /^Be brief\.\n\nYou can use these tools/);
  assert.match(prompts[0].system, /- add: Add/);
  assert.match(prompts[1].prompt, /Tool result for call call_\w+: 6912/);
  assert.match(prompts[1].prompt, /Assistant called tool add/);
  assert.match(prompts[1].prompt, /Assistant:$/);
});

test("promptAdapter accepts fenced JSON and the single-call form, and flags malformed calls", async () => {
  const one = (reply) => promptAdapter({ generate: async () => reply }).complete({ messages: [{ role: "user", content: "x" }], tools: [{ name: "t", description: "", input_schema: { type: "object" } }] });
  const fenced = await one('```json\n{"tool_calls": [{"name": "t", "input": {"k": 1}}]}\n```');
  assert.deepEqual([fenced.stopReason, fenced.content[0].name, fenced.content[0].input], ["tool_use", "t", { k: 1 }]);
  const single = await one('{"tool": "t", "input": {"k": 2}}');
  assert.deepEqual(single.content[0].input, { k: 2 });
  const bad = await one('{"tool_calls": [{"name": "t", "input": [1, 2]}, {"input": {}}]}');
  assert.equal(bad.content.length, 2);
  assert.ok(bad.content.every((b) => b.error), "both malformed calls are flagged");
  const plain = await one("Just an answer, no JSON.");
  assert.deepEqual([plain.stopReason, plain.content[0].text], ["end_turn", "Just an answer, no JSON."]);
  const notACall = await one('{"answer": 42}');
  assert.equal(notACall.stopReason, "end_turn", "JSON that is not a tool call is treated as the answer");
  const empty = await one("   ");
  assert.deepEqual(empty.content, []);
  const noTools = await promptAdapter({ generate: async () => '{"tool": "t", "input": {}}' }).complete({ messages: [{ role: "user", content: "x" }], tools: [] });
  assert.equal(noTools.stopReason, "end_turn", "without tools, JSON is just text");
});

test("promptAdapter: a flagged call is not run and the model is told", async () => {
  let ran = 0;
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, run: () => ran++ });
  const prompts = [];
  const model = async ({ prompt }) => (prompts.push(prompt), prompts.length === 1 ? '{"tool_calls": [{"name": "t", "input": "oops"}]}' : "ok");
  await run({ adapter: promptAdapter({ generate: model }), prompt: "x", tools: [t] });
  assert.equal(ran, 0);
  assert.match(prompts[1], /\(error\): Invalid tool call/);
});

// ---------------- checkStore
test("checkStore passes a correct store and reports a broken one", async () => {
  assert.deepEqual(await checkStore(memoryStore()), []);
  const data = new Map();
  const broken = {
    get: async (k) => data.get(k) || undefined, // loses falsy values
    set: async (k, v) => void data.set(k, v),
    delete: async () => {}, // never deletes
    keys: async () => [...data.keys()],
  };
  const problems = await checkStore(broken);
  assert.ok(problems.some((p) => /falsy/.test(p)), problems.join("; "));
  assert.ok(problems.some((p) => /delete/.test(p)), problems.join("; "));
});
