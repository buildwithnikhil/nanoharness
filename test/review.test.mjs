import { test } from "node:test";
import assert from "node:assert/strict";
import { run, defineTool, validate } from "../dist/index.js";
import { defineAgent, pipeline, parallel } from "../dist/agents.js";
import { createGraph } from "../dist/graph.js";
import { memoryStore } from "../dist/store.js";
import { defineZodTool } from "../dist/zod.js";
import { z } from "zod";

const text = (t, usage) => ({ content: [{ type: "text", text: t }], stopReason: "end_turn", usage });
const call = (name, input = {}) => ({ content: [{ type: "tool_use", id: "1", name, input }], stopReason: "tool_use" });
const scripted = (...rs) => ({ complete: async () => rs.shift() });

test("a tool call cut off by max_tokens is not run and the turn is dropped", async () => {
  let ran = false;
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, run: () => { ran = true; } });
  const truncated = { content: [{ type: "text", text: "let me" }, { type: "tool_use", id: "1", name: "t", input: {} }], stopReason: "max_tokens" };
  const r = await run({ adapter: scripted(truncated), prompt: "x", tools: [t] });
  assert.equal(ran, false);
  assert.equal(r.stopReason, "max_tokens");
  assert.equal(r.finalText, "let me");
  assert.deepEqual(r.messages, [{ role: "user", content: "x" }], "no dangling tool_use left in the history");
});

test("a tool that returns something JSON cannot encode does not crash the run", async () => {
  const fn = defineTool({ name: "fn", description: "", schema: { type: "object" }, run: () => () => 1 });
  const circ = defineTool({ name: "circ", description: "", schema: { type: "object" }, run: () => { const a = {}; a.a = a; return a; } });
  const reqs = [];
  const adapter = { complete: async (q) => (reqs.push(structuredClone({ ...q, signal: undefined })), [call("fn"), call("circ"), text("ok")][reqs.length - 1]) };
  const r = await run({ adapter, prompt: "x", tools: [fn, circ], maxToolResultChars: 100 });
  assert.equal(r.stopReason, "end_turn");
  assert.equal(reqs[1].messages.at(-1).content[0].content, "");
  assert.equal(reqs[2].messages.at(-1).content[0].is_error, true);
});

test("validate enforces number, string, array and object keywords", () => {
  const s = {
    type: "object",
    additionalProperties: false,
    properties: {
      n: { type: "number", minimum: 1, maximum: 5 },
      s: { type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" },
      a: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer" } },
    },
  };
  assert.equal(validate({ n: 3, s: "abc", a: [1] }, s), null);
  assert.match(validate({ n: 0 }, s), /input\.n: must be >= 1/);
  assert.match(validate({ n: 6 }, s), /must be <= 5/);
  assert.match(validate({ s: "a" }, s), /at least 2 characters/);
  assert.match(validate({ s: "abcde" }, s), /at most 4 characters/);
  assert.match(validate({ s: "ABC" }, s), /must match \^\[a-z\]\+\$/);
  assert.match(validate({ a: [] }, s), /needs at least 1 items/);
  assert.match(validate({ a: [1, 2, 3] }, s), /allows at most 2 items/);
  assert.match(validate({ a: [1.5] }, s), /input\.a\[0\]: expected integer/);
  assert.match(validate({ extra: 1 }, s), /input\.extra: not allowed/);
  assert.equal(validate({ extra: 1 }, { type: "object" }), null, "extra keys are fine unless additionalProperties is false");
});

test("zod tools do not send the $schema marker to the model", () => {
  const t = defineZodTool({ name: "t", description: "", schema: z.object({ a: z.string() }), run: () => "" });
  assert.equal("$schema" in t.schema, false);
  assert.equal(t.schema.type, "object");
  assert.deepEqual(t.schema.required, ["a"]);
});

test("createGraph requires store and id together", () => {
  const nodes = { a: () => ({}) };
  assert.throws(() => createGraph({ entry: "a", nodes, store: memoryStore() }), /`store` and `id` must be given together/);
  assert.throws(() => createGraph({ entry: "a", nodes, id: "x" }), /`store` and `id` must be given together/);
  createGraph({ entry: "a", nodes });
  createGraph({ entry: "a", nodes, store: memoryStore(), id: "x" });
});

test("pipeline shares one budget across its agents and totals their usage", async () => {
  let calls = 0;
  const mk = (name) => defineAgent({ name, adapter: { complete: async () => (calls++, text(name, { inputTokens: 2, outputTokens: 1 })) } });
  const ok = await pipeline([mk("a"), mk("b")], "in", { maxModelCalls: 5 });
  assert.deepEqual(ok.usage, { inputTokens: 4, outputTokens: 2 });
  await assert.rejects(pipeline([mk("a"), mk("b"), mk("c")], "in", { maxModelCalls: 2 }), /c stopped early \(budget_exceeded\)/);
});

test("parallel shares one budget across its agents", async () => {
  const mk = (name) => defineAgent({ name, adapter: { complete: async () => text(name) } });
  const res = await parallel([mk("a"), mk("b"), mk("c")], "in", { concurrency: 1, maxModelCalls: 2 });
  assert.deepEqual(res.map((r) => r.value.stopReason), ["end_turn", "end_turn", "budget_exceeded"]);
});

test("schema checks cannot be bypassed with keys that exist on Object.prototype", () => {
  const strict = { type: "object", additionalProperties: false, properties: { a: { type: "string" } } };
  for (const key of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
    const evil = JSON.parse(`{"a":"x","${key}":1}`);
    assert.match(validate(evil, strict), /not allowed/, key);
  }
  assert.equal(validate({ a: "x" }, strict), null);
  assert.match(validate({}, { type: "object", required: ["toString"] }), /toString: required/);
  assert.equal(validate({ toString: "x" }, { type: "object", required: ["toString"] }), null);
  // a property named like an inherited one is validated as its own value, not the inherited function
  assert.match(validate({ toString: 1 }, { type: "object", properties: { toString: { type: "string" } } }), /expected string/);
});

test("an empty model reply is not stored, so the history can be replayed", async () => {
  const r = await run({ adapter: scripted({ content: [], stopReason: "end_turn" }), prompt: "x" });
  assert.deepEqual(r.messages, [{ role: "user", content: "x" }]);
  assert.equal(r.finalText, "");
  assert.equal(r.stopReason, "end_turn");
});

test("a tool call flagged by the adapter is not run and the model is told why", async () => {
  let ran = 0;
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, run: () => (ran++, "x") });
  const reqs = [];
  const adapter = {
    complete: async (q) => (reqs.push(structuredClone({ ...q, signal: undefined })),
      reqs.length === 1 ? { content: [{ type: "tool_use", id: "1", name: "t", input: {}, error: "arguments were not valid JSON" }], stopReason: "tool_use" } : text("ok")),
  };
  await run({ adapter, prompt: "x", tools: [t] });
  assert.equal(ran, 0);
  const res = reqs[1].messages.at(-1).content[0];
  assert.equal(res.is_error, true);
  assert.equal(res.content, "Invalid tool call: arguments were not valid JSON");
});

test("minLength and maxLength count characters, so an emoji is one", () => {
  assert.match(validate("😀", { type: "string", minLength: 2 }), /at least 2 characters/);
  assert.equal(validate("😀", { type: "string", maxLength: 1 }), null);
  assert.equal(validate("a😀", { type: "string", minLength: 2, maxLength: 2 }), null);
  assert.match(validate("😀😀", { type: "string", maxLength: 1 }), /at most 1 characters/);
});

test("pattern matches whole characters, and falls back for patterns unicode mode rejects", () => {
  assert.equal(validate("😀", { type: "string", pattern: "^.$" }), null);
  assert.match(validate("😀😀", { type: "string", pattern: "^.$" }), /must match/);
  assert.equal(validate("a-b", { type: "string", pattern: "^a\\-b$" }), null, "an escape that is invalid in unicode mode still works");
});
