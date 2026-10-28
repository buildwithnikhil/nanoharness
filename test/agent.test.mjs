import { test } from "node:test";
import assert from "node:assert/strict";
import { run, stream, defineTool } from "../dist/index.js";
import { defineZodTool } from "../dist/zod.js";
import { z } from "zod";

const text = (t) => ({ content: [{ type: "text", text: t }], stopReason: "end_turn" });
const call = (id, name, input) => ({
  content: [{ type: "tool_use", id, name, input }],
  stopReason: "tool_use",
});

// Replays scripted responses and records every request.
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

const add = defineTool({
  name: "add",
  description: "Add two numbers",
  schema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  run: ({ a, b }) => a + b,
});

test("runs a tool and returns the final text", async () => {
  const adapter = fake(call("t1", "add", { a: 2, b: 3 }), text("The answer is 5"));
  const r = await run({ adapter, prompt: "2+3?", tools: [add] });
  assert.equal(r.finalText, "The answer is 5");
  assert.equal(r.stopReason, "end_turn");
  assert.deepEqual(adapter.requests[1].messages.at(-1).content, [
    { type: "tool_result", tool_use_id: "t1", content: "5" },
  ]);
});

test("stream emits events in order and ends with done", async () => {
  const adapter = fake(call("t1", "add", { a: 1, b: 1 }), text("2"));
  const types = [];
  for await (const ev of stream({ adapter, prompt: "x", tools: [add] })) types.push(ev.type);
  assert.deepEqual(types, ["tool_call", "tool_result", "text", "done"]);
});

test("invalid arguments go back to the model as is_error", async () => {
  const adapter = fake(call("t1", "add", { a: "x", b: 1 }), text("sorry"));
  await run({ adapter, prompt: "x", tools: [add] });
  const result = adapter.requests[1].messages.at(-1).content[0];
  assert.equal(result.is_error, true);
  assert.match(result.content, /input\.a: expected number/);
});

test("unknown tool and throwing tool are reported, not thrown", async () => {
  const boom = defineTool({ name: "boom", description: "", schema: { type: "object" }, run: () => { throw new Error("kaboom"); } });
  const adapter = fake(call("t1", "nope", {}), call("t2", "boom", {}), text("ok"));
  const r = await run({ adapter, prompt: "x", tools: [boom] });
  assert.equal(r.stopReason, "end_turn");
  assert.match(adapter.requests[1].messages.at(-1).content[0].content, /Unknown tool/);
  assert.match(adapter.requests[2].messages.at(-1).content[0].content, /kaboom/);
});

test("onToolCall can deny with a reason", async () => {
  let ran = false;
  const t = defineTool({ name: "t", description: "", schema: { type: "object" }, run: () => { ran = true; } });
  const adapter = fake(call("t1", "t", {}), text("ok"));
  await run({ adapter, prompt: "x", tools: [t], onToolCall: () => ({ deny: "not today" }) });
  assert.equal(ran, false);
  assert.equal(adapter.requests[1].messages.at(-1).content[0].content, "Denied: not today");
});

test("maxTurns stops a looping model", async () => {
  const loop = Array.from({ length: 5 }, (_, i) => call(`t${i}`, "add", { a: 1, b: 1 }));
  const r = await run({ adapter: fake(...loop), prompt: "x", tools: [add], maxTurns: 3 });
  assert.equal(r.stopReason, "max_turns");
});

test("abort signal yields stopReason aborted", async () => {
  const ctl = new AbortController();
  const adapter = {
    complete: ({ signal }) =>
      new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
  };
  const p = run({ adapter, prompt: "x", signal: ctl.signal });
  ctl.abort();
  assert.equal((await p).stopReason, "aborted");
});

test("adapter errors propagate", async () => {
  await assert.rejects(run({ adapter: fake(), prompt: "x" }), /ran out of responses/);
});

test("zod tool validates and runs", async () => {
  const t = defineZodTool({
    name: "greet",
    description: "",
    schema: z.object({ name: z.string() }),
    run: ({ name }) => `hi ${name}`,
  });
  assert.equal(t.schema.type, "object");
  const adapter = fake(call("t1", "greet", { name: 1 }), call("t2", "greet", { name: "Ada" }), text("done"));
  await run({ adapter, prompt: "x", tools: [t] });
  assert.equal(adapter.requests[1].messages.at(-1).content[0].is_error, true);
  assert.equal(adapter.requests[2].messages.at(-1).content[0].content, "hi Ada");
});

