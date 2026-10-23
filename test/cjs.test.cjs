const { test } = require("node:test");
const assert = require("node:assert/strict");
const { run, defineTool } = require("nanoharness");
const { createFsTools } = require("nanoharness/tools-fs");
const { defineZodTool } = require("nanoharness/zod");

test("CJS build loads all entry points and runs", async () => {
  assert.equal(typeof createFsTools, "function");
  assert.equal(typeof defineZodTool, "function");
  const adapter = { complete: async () => ({ content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }) };
  const r = await run({ adapter, prompt: "x", tools: [defineTool({ name: "t", description: "", schema: {}, run: () => 1 })] });
  assert.equal(r.finalText, "ok");
});
