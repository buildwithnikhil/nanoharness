// The core used on its own, with no companion package: openaiCompatible and anthropicCompatible.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { run, defineTool, openaiCompatible, anthropicCompatible, geminiCompatible, withRetry, limitConcurrency, AdapterError } from "../dist/index.js";

const add = defineTool({ name: "add", description: "Add", schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] }, run: ({ a, b }) => a + b });
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

test("openaiCompatible runs a tool loop against a custom server, with only the core", async () => {
  const sent = [];
  const replies = [
    { choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "add", arguments: '{"a":2,"b":3}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [{ message: { content: "5" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1 } },
  ];
  const adapter = openaiCompatible({
    baseUrl: "http://localhost:11434/v1/",
    model: "llama3.1",
    headers: { "x-team": "a" },
    fetch: async (url, init) => (sent.push({ url, headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect }), json(replies.shift())),
  });
  const r = await run({ adapter, prompt: "2+3?", tools: [add] });
  assert.equal(r.finalText, "5");
  assert.equal(sent[0].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(sent[0].headers["x-team"], "a");
  assert.equal("authorization" in sent[0].headers, false, "no key, no authorization header");
  assert.equal(sent[0].redirect, "error");
  assert.equal(sent[1].body.messages.at(-1).role, "tool");
});

test("anthropicCompatible works without an API key and with a custom version header", async () => {
  let sent;
  const adapter = anthropicCompatible({
    baseUrl: "https://gateway.example.com/anthropic",
    model: "my-model",
    version: "2024-01-01",
    fetch: async (url, init) => ((sent = { url, headers: init.headers, body: JSON.parse(init.body) }), json({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" })),
  });
  const r = await run({ adapter, prompt: "yo" });
  assert.equal(r.finalText, "hi");
  assert.equal(sent.url, "https://gateway.example.com/anthropic/v1/messages");
  assert.equal(sent.headers["anthropic-version"], "2024-01-01");
  assert.equal("x-api-key" in sent.headers, false);
  assert.equal(sent.body.max_tokens, 4096);
});

test("custom headers can replace the default ones, e.g. a gateway's own auth header", async () => {
  let headers;
  const adapter = openaiCompatible({ baseUrl: "https://gw.example.com/v1", model: "m", apiKey: "k", headers: { authorization: "Token xyz" }, fetch: async (_, init) => ((headers = init.headers), json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })) });
  await run({ adapter, prompt: "x" });
  assert.equal(headers.authorization, "Token xyz");
});

test("the core adapters check their options", () => {
  const fetch = async () => json({});
  assert.throws(() => openaiCompatible({ baseUrl: "https://x.example.com", model: "m" }), /fetch is required/);
  assert.throws(() => openaiCompatible({ baseUrl: "https://x.example.com", fetch }), /model is required/);
  assert.throws(() => anthropicCompatible({ baseUrl: "http://10.0.0.5:8080", model: "m", fetch }), /must use https/);
  anthropicCompatible({ baseUrl: "http://10.0.0.5:8080", model: "m", fetch, allowInsecureHttp: true });
  assert.throws(() => openaiCompatible({ baseUrl: "not a url", model: "m", fetch, name: "Ollama" }), /^Error: Ollama: invalid baseUrl/);
});

test("errors are AdapterErrors named after the provider, and work with withRetry and limitConcurrency", async () => {
  let calls = 0;
  const flaky = openaiCompatible({ baseUrl: "https://x.example.com", model: "m", name: "Ollama", maxRetries: 0, fetch: async () => (++calls < 3 ? json({ error: "busy" }, 503) : json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] })) });
  await assert.rejects(flaky.complete({ messages: [{ role: "user", content: "x" }], tools: [] }), (e) => e instanceof AdapterError && e.status === 503 && /^Ollama error 503/.test(e.message));
  const r = await run({ adapter: withRetry(limitConcurrency(flaky, 2), { baseDelayMs: 1 }), prompt: "x" });
  assert.equal(r.finalText, "ok");
  assert.equal(calls, 3);
});

test("streaming from a real local server with the global fetch, core only", async () => {
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const c of ["Hel", "lo"]) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const adapter = openaiCompatible({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, model: "m", fetch });
    const deltas = [];
    const r = await run({ adapter, prompt: "x", streaming: true, onEvent: (e) => e.type === "text_delta" && deltas.push(e.text) });
    assert.deepEqual(deltas, ["Hel", "lo"]);
    assert.equal(r.finalText, "Hello");
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test("geminiCompatible works with only the core, and a Gemini signature never reaches another provider", async () => {
  const sent = [];
  const replies = [
    { candidates: [{ content: { parts: [{ functionCall: { name: "add", args: { a: 2, b: 3 } }, thoughtSignature: "sig" }] }, finishReason: "STOP" }] },
    { candidates: [{ content: { parts: [{ text: "5" }] }, finishReason: "STOP" }] },
  ];
  const adapter = geminiCompatible({ baseUrl: "https://gemini.example.com/v1beta", model: "g", apiKey: "k", fetch: async (url, init) => (sent.push({ url, body: init.body }), json(replies.shift())) });
  const r = await run({ adapter, prompt: "2+3?", tools: [add] });
  assert.equal(r.finalText, "5");
  assert.equal(sent[0].url, "https://gemini.example.com/v1beta/models/g:generateContent");

  // The same history continued with Anthropic and OpenAI: the signature is Gemini's only.
  for (const make of [
    (fetch) => anthropicCompatible({ baseUrl: "https://a.example.com", model: "m", fetch }),
    (fetch) => openaiCompatible({ baseUrl: "https://o.example.com/v1", model: "m", fetch }),
  ]) {
    let body = "";
    const reply = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] };
    await run({ adapter: make(async (_, init) => ((body = init.body), json(reply))), prompt: [...r.messages, { role: "user", content: "and?" }] });
    assert.ok(!body.includes("sig"), body);
  }
});
