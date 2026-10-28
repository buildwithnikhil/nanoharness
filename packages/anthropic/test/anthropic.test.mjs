import { test } from "node:test";
import assert from "node:assert/strict";
import { run } from "nanoharness";
import { anthropic } from "../dist/index.js";
import http from "node:http";

// Two local servers: A answers with a redirect to B. B records everything it receives.
async function redirectPair(status) {
  const seen = [];
  const b = http.createServer((req, res) => { let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => { seen.push({ method: req.method, url: req.url, headers: req.headers, body }); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); }); });
  await new Promise((r) => b.listen(0, "127.0.0.1", r));
  const a = http.createServer((req, res) => { req.resume(); res.writeHead(status, { location: `http://localhost:${b.address().port}/steal` }); res.end(); });
  await new Promise((r) => a.listen(0, "127.0.0.1", r));
  return { seen, base: `http://127.0.0.1:${a.address().port}`, close: () => { a.close(); b.close(); a.closeAllConnections?.(); b.closeAllConnections?.(); } };
}


const okBody = (text = "hi") =>
  JSON.stringify({
    content: [{ type: "text", text }, { type: "thinking" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 3, output_tokens: 4 },
  });

test("maps request and response", async () => {
  let sent;
  const adapter = anthropic({
    apiKey: "k",
    fetch: async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(okBody());
    },
  });
  const r = await run({ adapter, prompt: "yo", system: "sys" });
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.headers["x-api-key"], "k");
  assert.equal(sent.headers["anthropic-version"], "2023-06-01");
  assert.equal(sent.body.system, "sys");
  assert.equal(sent.body.model, "claude-sonnet-5-5");
  assert.equal(r.finalText, "hi");
  assert.deepEqual(r.usage, { inputTokens: 3, outputTokens: 4 });
});

test("sends tools only when there are tools, and maps tool_use", async () => {
  const bodies = [];
  const adapter = anthropic({
    apiKey: "k",
    fetch: async (_, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ content: [{ type: "tool_use", id: "1", name: "t", input: { a: 1 } }], stop_reason: "tool_use" }));
    },
  });
  const res = await adapter.complete({ messages: [{ role: "user", content: "x" }], tools: [{ name: "t", description: "d", input_schema: { type: "object" } }] });
  assert.equal(bodies[0].tools.length, 1);
  assert.equal(res.stopReason, "tool_use");
  assert.deepEqual(res.content[0].input, { a: 1 });
  await adapter.complete({ messages: [{ role: "user", content: "x" }], tools: [] });
  assert.equal("tools" in bodies[1], false);
});

test("temperature is sent only when set", async () => {
  const bodies = [];
  const fetchFn = async (_, init) => (bodies.push(JSON.parse(init.body)), new Response(okBody()));
  await run({ adapter: anthropic({ apiKey: "k", fetch: fetchFn }), prompt: "x" });
  await run({ adapter: anthropic({ apiKey: "k", temperature: 0, fetch: fetchFn }), prompt: "x" });
  assert.equal("temperature" in bodies[0], false);
  assert.equal(bodies[1].temperature, 0);
});

test("only API-defined fields are sent for tool_use blocks", async () => {
  let body;
  const adapter = anthropic({ apiKey: "k", fetch: async (_, init) => ((body = JSON.parse(init.body)), new Response(okBody())) });
  await adapter.complete({
    tools: [],
    messages: [
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "text", text: "t" }, { type: "tool_use", id: "1", name: "n", input: { a: 1 }, error: "internal flag" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "r", is_error: true }] },
    ],
  });
  assert.deepEqual(body.messages[1].content[1], { type: "tool_use", id: "1", name: "n", input: { a: 1 } });
  assert.deepEqual(body.messages[2].content[0], { type: "tool_result", tool_use_id: "1", content: "r", is_error: true });
});

test("retried responses are cancelled so connections are freed", async () => {
  let cancelled = 0, n = 0;
  const limited = () => {
    const r = new Response("slow", { status: 429, headers: { "retry-after": "0.001" } });
    const c = r.body.cancel.bind(r.body);
    r.body.cancel = (...a) => (cancelled++, c(...a));
    return r;
  };
  const adapter = anthropic({ apiKey: "k", fetch: async () => (++n < 3 ? limited() : new Response(okBody("ok"))) });
  assert.equal((await run({ adapter, prompt: "x" })).finalText, "ok");
  assert.equal(cancelled, 2);
});

test("surfaces HTTP errors", async () => {
  const adapter = anthropic({ apiKey: "k", fetch: async () => new Response("bad key", { status: 401 }) });
  await assert.rejects(run({ adapter, prompt: "x" }), /401: bad key/);
});

test("retries 429 honouring retry-after, and gives up after maxRetries", async () => {
  let n = 0;
  const mk = (maxRetries) =>
    anthropic({
      apiKey: "k",
      maxRetries,
      fetch: async () => {
        n++;
        return n < 3 ? new Response("slow down", { status: 429, headers: { "retry-after": "0.01" } }) : new Response(okBody("ok"));
      },
    });
  assert.equal((await run({ adapter: mk(2), prompt: "x" })).finalText, "ok");
  assert.equal(n, 3);
  n = 0;
  await assert.rejects(run({ adapter: mk(1), prompt: "x" }), /429: slow down/);
  assert.equal(n, 2);
});

test("does not retry 4xx client errors and aborts during backoff", async () => {
  let n = 0;
  const bad = anthropic({ apiKey: "k", fetch: async () => (n++, new Response("no", { status: 401 })) });
  await assert.rejects(run({ adapter: bad, prompt: "x" }), /401/);
  assert.equal(n, 1);
  const ctl = new AbortController();
  const slow = anthropic({ apiKey: "k", fetch: async () => new Response("x", { status: 503, headers: { "retry-after": "20" } }) });
  const p = run({ adapter: slow, prompt: "x", signal: ctl.signal });
  setTimeout(() => ctl.abort(), 30);
  const t0 = Date.now();
  assert.equal((await p).stopReason, "aborted");
  assert.ok(Date.now() - t0 < 1000);
});

test("baseUrl: custom https URL is used, with a path prefix and trailing slash handled", async () => {
  const urls = [];
  const fetchFn = async (url) => (urls.push(url), new Response(okBody()));
  await run({ adapter: anthropic({ apiKey: "k", baseUrl: "https://proxy.example.com/anthropic/", fetch: fetchFn }), prompt: "x" });
  await run({ adapter: anthropic({ apiKey: "k", baseUrl: "http://localhost:8080", fetch: fetchFn }), prompt: "x" });
  assert.deepEqual(urls, ["https://proxy.example.com/anthropic/v1/messages", "http://localhost:8080/v1/messages"]);
});

test("baseUrl: refuses plain http to remote hosts, credentials and garbage, so the key is never leaked", () => {
  for (const baseUrl of ["http://api.example.com", "https://user:pw@example.com", "not a url", "ftp://example.com", "http://localhost.evil.com"]) {
    assert.throws(() => anthropic({ apiKey: "k", baseUrl }), /anthropic\(\)/, baseUrl);
  }
});

test("apiKey is required", () => {
  assert.throws(() => anthropic({ apiKey: "" }), /apiKey is required/);
});

test("live call (needs ANTHROPIC_API_KEY)", { skip: !process.env.ANTHROPIC_API_KEY }, async () => {
  const r = await run({ adapter: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }), prompt: "Say hi in one word." });
  assert.ok(r.finalText.length > 0);
});

test("a redirect is never followed, so the API key cannot reach another host", async () => {
  for (const status of [301, 302, 307, 308]) {
    const { seen, base, close } = await redirectPair(status);
    try {
      const adapter = anthropic({ apiKey: "SECRETKEY", baseUrl: base });
      await assert.rejects(run({ adapter, prompt: "x" }), /redirect|fetch failed/i, `status ${status}`);
      assert.equal(seen.length, 0, `status ${status}: the second server received a request`);
    } finally { close(); }
  }
});

test("retry-after is understood in seconds and as an HTTP date", async () => {
  const waits = [];
  const mk = (header) => { let n = 0; return anthropic({ apiKey: "k", maxRetries: 1, fetch: async () => (n++ === 0 ? new Response("x", { status: 429, headers: { "retry-after": header } }) : new Response(okBody("ok"))) }); };
  const t0 = Date.now();
  await run({ adapter: mk(new Date(Date.now() + 300).toUTCString()), prompt: "x" });
  waits.push(Date.now() - t0);
  assert.ok(waits[0] >= 0, "a date in the past or near future is accepted");
  const t1 = Date.now();
  await run({ adapter: mk("Wed, 21 Oct 2015 07:28:00 GMT"), prompt: "x" });
  assert.ok(Date.now() - t1 < 250, "a date in the past means retry now, not the 500ms default backoff");
});

test("a 2xx body that is not JSON, and huge error bodies, give clear errors", async () => {
  const notJson = anthropic({ apiKey: "k", fetch: async () => new Response("<html>gateway</html>") });
  await assert.rejects(run({ adapter: notJson, prompt: "x" }), /invalid JSON/);
  const huge = anthropic({ apiKey: "k", maxRetries: 0, fetch: async () => new Response("E".repeat(100_000), { status: 400 }) });
  await assert.rejects(run({ adapter: huge, prompt: "x" }), (e) => e.message.length < 2500 && /400/.test(e.message) && /truncated/.test(e.message));
});

test("stop reasons: refusal ends the turn, unknown ones map to other", async () => {
  const mk = (stop) => anthropic({ apiKey: "k", fetch: async () => new Response(JSON.stringify({ content: [{ type: "text", text: "no" }], stop_reason: stop })) });
  const go = (stop) => mk(stop).complete({ messages: [{ role: "user", content: "x" }], tools: [] });
  assert.equal((await go("refusal")).stopReason, "end_turn");
  assert.equal((await go("stop_sequence")).stopReason, "end_turn");
  assert.equal((await go("pause_turn")).stopReason, "other");
});
