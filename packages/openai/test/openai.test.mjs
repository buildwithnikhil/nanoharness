import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { run, defineTool } from "nanoharness";
import { openai } from "../dist/index.js";

const reply = (message, finish = "stop", usage = { prompt_tokens: 3, completion_tokens: 4 }) =>
  new Response(JSON.stringify({ choices: [{ message, finish_reason: finish }], usage }));

test("maps a plain request and response", async () => {
  let sent;
  const adapter = openai({
    model: "gpt-x", apiKey: "k", maxTokens: 50, temperature: 0.2,
    fetch: async (url, init) => ((sent = { url, headers: init.headers, body: JSON.parse(init.body) }), reply({ content: "hi" })),
  });
  const r = await run({ adapter, prompt: "yo", system: "sys" });
  assert.equal(sent.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(sent.headers.authorization, "Bearer k");
  assert.deepEqual(sent.body.messages, [{ role: "system", content: "sys" }, { role: "user", content: "yo" }]);
  assert.equal(sent.body.model, "gpt-x");
  assert.equal(sent.body.max_tokens, 50);
  assert.equal(sent.body.temperature, 0.2);
  assert.equal("tools" in sent.body, false);
  assert.equal(r.finalText, "hi");
  assert.deepEqual(r.usage, { inputTokens: 3, outputTokens: 4 });
});

test("a full tool round trip: tools are sent, tool_calls come back, results follow as tool messages", async () => {
  const bodies = [];
  let n = 0;
  const adapter = openai({
    model: "m", maxTokensParam: "max_completion_tokens", maxTokens: 9,
    fetch: async (_, init) => {
      bodies.push(JSON.parse(init.body));
      return n++ === 0
        ? reply({ content: "checking", tool_calls: [{ id: "call_1", function: { name: "add", arguments: '{"a":2,"b":3}' } }] }, "tool_calls")
        : reply({ content: "5" });
    },
  });
  const add = defineTool({ name: "add", description: "Add", schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, run: ({ a, b }) => a + b });
  const r = await run({ adapter, prompt: "2+3?", tools: [add] });
  assert.equal(r.finalText, "5");
  assert.equal(bodies[0].max_completion_tokens, 9);
  assert.deepEqual(bodies[0].tools, [{ type: "function", function: { name: "add", description: "Add", parameters: add.schema } }]);
  assert.deepEqual(bodies[1].messages.slice(1), [
    { role: "assistant", content: "checking", tool_calls: [{ id: "call_1", type: "function", function: { name: "add", arguments: '{"a":2,"b":3}' } }] },
    { role: "tool", tool_call_id: "call_1", content: "5" },
  ]);
});

test("tool errors are labelled, and a tool result plus follow-up text is split into tool then user messages", async () => {
  let sent;
  const adapter = openai({ model: "m", fetch: async (_, init) => ((sent = JSON.parse(init.body)), reply({ content: "ok" })) });
  await adapter.complete({
    tools: [],
    messages: [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "tool_use", id: "c1", name: "t", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "boom", is_error: true }, { type: "text", text: "continue" }] },
    ],
  });
  assert.deepEqual(sent.messages.slice(1), [
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "Error: boom" },
    { role: "user", content: "continue" },
  ]);
});

test("finish_reason mapping, and unparseable tool arguments become an empty input", async () => {
  const mk = (message, finish) => openai({ model: "m", fetch: async () => reply(message, finish) });
  const complete = (a) => a.complete({ messages: [{ role: "user", content: "x" }], tools: [] });
  assert.equal((await complete(mk({ content: "a" }, "length"))).stopReason, "max_tokens");
  assert.equal((await complete(mk({ content: "a" }, "content_filter"))).stopReason, "other");
  const bad = await complete(mk({ content: null, tool_calls: [{ id: "1", function: { name: "t", arguments: "{not json" } }] }, "tool_calls"));
  assert.deepEqual(bad.content, [{ type: "tool_use", id: "1", name: "t", input: {} }]);
  assert.equal(bad.stopReason, "tool_use");
});

test("no apiKey means no authorization header (local servers)", async () => {
  let headers;
  const adapter = openai({ model: "llama3.1", baseUrl: "http://localhost:11434/v1", fetch: async (_, init) => ((headers = init.headers), reply({ content: "hi" })) });
  await run({ adapter, prompt: "x" });
  assert.equal("authorization" in headers, false);
});

test("baseUrl rules: https or localhost only, unless allowInsecureHttp; no credentials; trailing slash handled", async () => {
  const urls = [];
  const f = async (url) => (urls.push(url), reply({ content: "x" }));
  for (const baseUrl of ["https://openrouter.ai/api/v1/", "http://localhost:8000/v1"]) await run({ adapter: openai({ model: "m", baseUrl, fetch: f }), prompt: "x" });
  await run({ adapter: openai({ model: "m", baseUrl: "http://ollama:11434/v1", allowInsecureHttp: true, fetch: f }), prompt: "x" });
  assert.deepEqual(urls, ["https://openrouter.ai/api/v1/chat/completions", "http://localhost:8000/v1/chat/completions", "http://ollama:11434/v1/chat/completions"]);
  for (const baseUrl of ["http://api.example.com/v1", "https://u:p@example.com", "nope", "ftp://x.com"]) {
    assert.throws(() => openai({ model: "m", baseUrl }), /openai\(\)/, baseUrl);
  }
});

test("model is required", () => assert.throws(() => openai({}), /model is required/));

test("retries 429 and gives up after maxRetries; 4xx is not retried; errors carry the body", async () => {
  let n = 0;
  const mk = (maxRetries) => openai({ model: "m", maxRetries, fetch: async () => (n++, n < 3 ? new Response("slow", { status: 429, headers: { "retry-after": "0.01" } }) : reply({ content: "ok" })) });
  assert.equal((await run({ adapter: mk(2), prompt: "x" })).finalText, "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(run({ adapter: mk(1), prompt: "x" }), /429: slow/);
  assert.equal(n, 2);
  let m = 0;
  await assert.rejects(run({ adapter: openai({ model: "m", fetch: async () => (m++, new Response("bad key", { status: 401 })) }), prompt: "x" }), /401: bad key/);
  assert.equal(m, 1);
});

test("an empty choices array is reported clearly", async () => {
  const adapter = openai({ model: "m", fetch: async () => new Response(JSON.stringify({ choices: [] })) });
  await assert.rejects(run({ adapter, prompt: "x" }), /returned no choices/);
});

test("CJS build loads", () => {
  assert.equal(typeof createRequire(import.meta.url)("../dist/index.cjs").openai, "function");
});
