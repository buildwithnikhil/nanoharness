const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run, defineTool, allowTools } = require("nanoharness");
const { defineZodTool } = require("nanoharness/zod");
const { defineAgent, pipeline, parallel, createPlanTool } = require("nanoharness/agents");
const { createGraph, END } = require("nanoharness/graph");
const { memoryStore, session } = require("nanoharness/store");

test("CJS build loads all entry points and runs", async () => {
  for (const f of [defineZodTool, pipeline, parallel, createPlanTool, createGraph, memoryStore, session, allowTools]) {
    assert.equal(typeof f, "function");
  }
  assert.equal(END, "__end__");
  const adapter = { complete: async () => ({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }) };
  const r = await run({ adapter, prompt: "x", tools: [defineTool({ name: "t", description: "", schema: {}, run: () => 1 })] });
  assert.equal(r.finalText, "ok");
  assert.equal((await defineAgent({ name: "a", adapter }).run("x")).finalText, "ok");
});
