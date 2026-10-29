import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { run, defineTool, AdapterError, withRetry } from "nanoharness";
import { gemini } from "../dist/index.js";

const add = defineTool({ name: "add", description: "Add", schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false }, run: ({ a, b }) => a + b });
const json = (v, status = 200, headers = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const reply = (parts, finishReason = "STOP", usageMetadata) => ({ candidates: [{ content: { role: "model", parts }, finishReason }], ...(usageMetadata ? { usageMetadata } : {}) });
const sse = (list) => {
  const bytes = new TextEncoder().encode(list.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
};
const recorder = (...responses) => {
  const sent = [];
  const fetch = async (url, init) => (sent.push({ url, headers: init.headers, body: JSON.parse(init.body), redirect: init.redirect }), responses.shift());
  return { sent, fetch };
};

test("maps a request: URL, key header, system instruction, tools as JSON Schema, generation config", async () => {
  const { sent, fetch } = recorder(json(reply([{ text: "hi" }], "STOP", { promptTokenCount: 5, candidatesTokenCount: 2, thoughtsTokenCount: 3 })));
  const adapter = gemini({ model: "models/gemini-2.5-flash", apiKey: "secret", maxTokens: 100, temperature: 0.3, fetch });
  const r = await run({ adapter, prompt: "yo", system: "be brief", tools: [add] });
  const s = sent[0];
  assert.equal(s.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent");
  assert.ok(!s.url.includes("secret"), "the key is never in the URL");
  assert.equal(s.headers["x-goog-api-key"], "secret");
  assert.equal(s.redirect, "error");
  assert.deepEqual(s.body.systemInstruction, { parts: [{ text: "be brief" }] });
  assert.deepEqual(s.body.contents, [{ role: "user", parts: [{ text: "yo" }] }]);
  assert.deepEqual(s.body.generationConfig, { maxOutputTokens: 100, temperature: 0.3 });
  assert.equal(s.body.tools[0].functionDeclarations[0].name, "add");
  assert.equal(s.body.tools[0].functionDeclarations[0].parametersJsonSchema.additionalProperties, false, "the full JSON Schema is sent");
  assert.equal(r.finalText, "hi");
  assert.deepEqual(r.usage, { inputTokens: 5, outputTokens: 5 }, "thinking tokens count as output");
});

test("a tool loop: function calls with and without ids, responses named after their function", async () => {
  const { sent, fetch } = recorder(
    json(reply([{ text: "Adding." }, { functionCall: { name: "add", args: { a: 2, b: 3 } } }, { functionCall: { id: "g-7", name: "add", args: { a: 1, b: 1 } } }])),
    json(reply([{ text: "5 and 2" }])),
  );
  const r = await run({ adapter: gemini({ model: "m", apiKey: "k", fetch }), prompt: "go", tools: [add], toolConcurrency: 2 });
  assert.equal(r.finalText, "5 and 2");
  const [, model, results] = sent[1].body.contents;
  assert.equal(model.role, "model");
  assert.deepEqual(model.parts[1], { functionCall: { name: "add", args: { a: 2, b: 3 } } }, "a made-up id is not sent back");
  assert.deepEqual(model.parts[2], { functionCall: { id: "g-7", name: "add", args: { a: 1, b: 1 } } });
  assert.equal(results.role, "user");
  assert.deepEqual(results.parts, [
    { functionResponse: { name: "add", response: { result: "5" } } },
    { functionResponse: { id: "g-7", name: "add", response: { result: "2" } } },
  ]);
});

test("thought signatures are kept with the call and sent back; thought text is not shown", async () => {
  const { sent, fetch } = recorder(
    json(reply([{ text: "planning...", thought: true }, { functionCall: { name: "add", args: { a: 1, b: 2 } }, thoughtSignature: "sig-abc" }])),
    json(reply([{ text: "3" }])),
  );
  const r = await run({ adapter: gemini({ model: "m", apiKey: "k", fetch }), prompt: "go", tools: [add] });
  assert.equal(r.messages[1].content[0].signature, "sig-abc");
  assert.ok(!JSON.stringify(r.messages).includes("planning..."));
  assert.equal(sent[1].body.contents[1].parts[0].thoughtSignature, "sig-abc");
  assert.equal(r.finalText, "3");
});

test("a failed tool is reported as an error response", async () => {
  const boom = defineTool({ name: "boom", description: "", schema: { type: "object" }, run: () => { throw new Error("disk full"); } });
  const { sent, fetch } = recorder(json(reply([{ functionCall: { name: "boom", args: {} } }])), json(reply([{ text: "sorry" }])));
  await run({ adapter: gemini({ model: "m", apiKey: "k", fetch }), prompt: "go", tools: [boom] });
  assert.match(sent[1].body.contents[2].parts[0].functionResponse.response.error, /disk full/);
});

test("stop reasons: MAX_TOKENS wins over a call, safety stops are 'other', a blocked prompt is an error", async () => {
  const one = async (res) => gemini({ model: "m", apiKey: "k", fetch: async () => res }).complete({ messages: [{ role: "user", content: "x" }], tools: [] });
  assert.equal((await one(json(reply([{ functionCall: { name: "add", args: { a: 1 } } }], "MAX_TOKENS")))).stopReason, "max_tokens");
  assert.equal((await one(json(reply([], "SAFETY")))).stopReason, "refusal");
  assert.equal((await one(json(reply([{ functionCall: { name: "add", args: {} } }], "PROHIBITED_CONTENT")))).stopReason, "refusal", "a refusal wins over a call");
  await assert.rejects(one(json(reply([], "MISSING_THOUGHT_SIGNATURE"))), /missing a thought signature/);
  assert.equal((await one(json(reply([{ text: "x" }], "MALFORMED_FUNCTION_CALL")))).stopReason, "other");
  await assert.rejects(one(json({ promptFeedback: { blockReason: "SAFETY" } })), (e) => e instanceof AdapterError && /blocked the prompt: SAFETY/.test(e.message) && !e.retryable);
  await assert.rejects(one(json({})), /no candidates/);
  const bad = await one(json(reply([{ functionCall: { name: "add", args: [1, 2] } }])));
  assert.equal(bad.content[0].error, "arguments must be a JSON object");
});

test("streaming: text deltas, a whole function call, usage, and the stream URL", async () => {
  const { sent, fetch } = recorder(
    sse([
      reply([{ text: "Let me " }], null),
      reply([{ text: "add." }], null),
      reply([{ functionCall: { name: "add", args: { a: 2, b: 2 } }, thoughtSignature: "s1" }], "STOP", { promptTokenCount: 9, candidatesTokenCount: 4 }),
    ]),
    sse([reply([{ text: "4" }], "STOP", { promptTokenCount: 12, candidatesTokenCount: 1 })]),
  );
  const deltas = [];
  const r = await run({ adapter: gemini({ model: "m", apiKey: "k", fetch }), prompt: "go", tools: [add], streaming: true, onEvent: (e) => e.type === "text_delta" && deltas.push(e.text) });
  assert.equal(sent[0].url, "https://generativelanguage.googleapis.com/v1beta/models/m:streamGenerateContent?alt=sse");
  assert.deepEqual(deltas, ["Let me ", "add.", "4"]);
  assert.equal(r.finalText, "4");
  assert.equal(r.messages[1].content[1].signature, "s1");
  assert.deepEqual(r.usage, { inputTokens: 21, outputTokens: 5 });
});

test("streaming errors: early end, an error chunk, a blocked prompt, invalid JSON", async () => {
  const drain = async (res) => { for await (const _ of gemini({ model: "m", apiKey: "k", fetch: async () => res }).stream({ messages: [{ role: "user", content: "x" }], tools: [] })); };
  await assert.rejects(drain(sse([reply([{ text: "par" }], null)])), /ended early/);
  await assert.rejects(drain(sse([{ error: { message: "quota" } }])), /stream error: quota/);
  await assert.rejects(drain(sse([{ promptFeedback: { blockReason: "OTHER" } }])), /blocked the prompt/);
  await assert.rejects(drain(new Response("data: {nope\n\n")), /invalid stream chunk/);
});

test("rate limits are retried with retry-after, and failures are AdapterErrors with the status", async () => {
  let calls = 0;
  const fetch = async () => (++calls === 1 ? json({ error: { message: "slow down" } }, 429, { "retry-after": "0" }) : json(reply([{ text: "ok" }])));
  const r = await run({ adapter: gemini({ model: "m", apiKey: "k", fetch }), prompt: "x" });
  assert.equal(r.finalText, "ok");
  assert.equal(calls, 2);
  const failing = gemini({ model: "m", apiKey: "k", maxRetries: 0, fetch: async () => json({ error: { message: "bad key" } }, 400) });
  await assert.rejects(run({ adapter: failing, prompt: "x" }), (e) => e instanceof AdapterError && e.status === 400 && /^Gemini API error 400/.test(e.message));
  let n = 0;
  const flaky = gemini({ model: "m", apiKey: "k", maxRetries: 0, fetch: async () => (++n < 3 ? json({}, 503) : json(reply([{ text: "ok" }]))) });
  assert.equal((await run({ adapter: withRetry(flaky, { baseDelayMs: 1 }), prompt: "x" })).finalText, "ok");
});

test("Vertex AI: a project base URL and a bearer token instead of a key", async () => {
  const { sent, fetch } = recorder(json(reply([{ text: "hi" }])));
  const base = "https://us-central1-aiplatform.googleapis.com/v1/projects/p1/locations/us-central1/publishers/google";
  await run({ adapter: gemini({ model: "gemini-2.5-pro", baseUrl: base, headers: { authorization: "Bearer tok" }, fetch }), prompt: "x" });
  assert.equal(sent[0].url, `${base}/models/gemini-2.5-pro:generateContent`);
  assert.equal(sent[0].headers.authorization, "Bearer tok");
  assert.equal("x-goog-api-key" in sent[0].headers, false);
});

test("options are checked", () => {
  assert.throws(() => gemini({ apiKey: "k" }), /model is required/);
  assert.throws(() => gemini({ model: "m" }), /apiKey, or headers/);
  assert.throws(() => gemini({ model: "a?b", apiKey: "k" }), /invalid model/);
  assert.throws(() => gemini({ model: "m", apiKey: "k", baseUrl: "http://example.com" }), /must use https/);
  assert.throws(() => gemini({ model: "m", apiKey: "k", baseUrl: "https://u:p@example.com" }), /credentials/);
});

test("a redirect is never followed, so the key cannot reach another host", async () => {
  const seen = [];
  const b = http.createServer((req, res) => { seen.push(req.headers); res.end("{}"); });
  await new Promise((r) => b.listen(0, "127.0.0.1", r));
  const a = http.createServer((req, res) => { req.resume(); res.writeHead(307, { location: `http://localhost:${b.address().port}/steal` }); res.end(); });
  await new Promise((r) => a.listen(0, "127.0.0.1", r));
  try {
    const adapter = gemini({ model: "m", apiKey: "k", baseUrl: `http://127.0.0.1:${a.address().port}/v1beta`, maxRetries: 0 });
    await assert.rejects(run({ adapter, prompt: "x" }), /redirect, which is never followed/);
    assert.equal(seen.length, 0);
  } finally {
    for (const s of [a, b]) { s.close(); s.closeAllConnections?.(); }
  }
});

test("streaming over real HTTP: deltas arrive while the server is still sending", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const server = http.createServer(async (req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify(reply([{ text: "first " }], null))}\n\n`);
    await gate;
    res.end(`data: ${JSON.stringify(reply([{ text: "second" }], "STOP"))}\n\n`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const adapter = gemini({ model: "m", apiKey: "k", baseUrl: `http://127.0.0.1:${server.address().port}/v1beta` });
    const r = await run({ adapter, prompt: "x", streaming: true, onEvent: (e) => e.type === "text_delta" && e.text === "first " && release() });
    assert.equal(r.finalText, "first second");
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test("the CJS build loads", () => {
  const require = createRequire(import.meta.url);
  assert.equal(typeof require("../dist/index.cjs").gemini, "function");
});
