# nanoharness-openai

An OpenAI-compatible chat model adapter for [nanoharness](https://www.npmjs.com/package/nanoharness). One adapter covers OpenAI and every server that speaks the Chat Completions format: Ollama, vLLM, OpenRouter, LM Studio, Groq, Together and more. It is `openaiCompatible` from the core with the official URL and the global `fetch` filled in, kept separate so the core never uses the network by itself. If you would rather not install it, `openaiCompatible` from `nanoharness` does the same with the `fetch` and `baseUrl` you pass.

```sh
npm install nanoharness nanoharness-openai
```

```ts
import { run } from "nanoharness";
import { openai } from "nanoharness-openai";

// OpenAI
const adapter = openai({ model: "gpt-4.1", apiKey: process.env.OPENAI_API_KEY });

// A local model with Ollama (no key needed)
const local = openai({ model: "llama3.1", baseUrl: "http://localhost:11434/v1" });

const { finalText } = await run({ adapter, prompt: "Say hi in one word." });
```

| Option | Description |
|---|---|
| `model` | Required. |
| `apiKey` | Sent as a Bearer token. Optional for local servers. |
| `baseUrl` | Default `https://api.openai.com/v1`. Must be `https`, or `http` on `localhost`, and must not contain credentials. |
| `allowInsecureHttp` | Allows plain `http` to a non-localhost host, such as a server on your LAN or in Docker. Off by default. |
| `maxTokens`, `maxTokensParam` | `maxTokensParam` is `"max_tokens"` (default) or `"max_completion_tokens"`, which OpenAI's newer models require. |
| `temperature` | Sent only when set. |
| `headers` | Extra headers on every request, such as a gateway header. They can replace the default ones. |
| `maxRetries` | Retries for HTTP 408, 429, 500, 502, 503 and 504, with backoff that honours `retry-after` (seconds or an HTTP date). Default `2`. |
| `streamUsage` | When streaming, ask for token usage in the last chunk (`stream_options.include_usage`). Turn off for servers that reject it. Default `true`. |
| `fetch` | A custom `fetch`, for proxies or tests. |

Tool calls work through the standard `tools` and `tool_calls` fields, so the model must support tool calling. If a model returns tool arguments that are not valid JSON (or are not a JSON object), the call is **not run**: the harness tells the model its arguments were invalid. A reply cut off by the token limit (`finish_reason: "length"`) is reported as `max_tokens`, and any tool call in it is not run either.

## Streaming and errors

Both `complete` and `stream` are supported. Pass `streaming: true` to `run`, `stream` or `defineAgent` to receive `text_delta` events as text arrives.

A failed request throws an `AdapterError` (from `nanoharness`) with the HTTP `status`, `retryable`, and `retryAfterMs` when the server sent one. The adapter retries on its own (`maxRetries`). To use jittered backoff or share a rate limit across agents instead, turn that off and wrap it, with `withRetry` outside:

```ts
import { limitConcurrency, withRetry } from "nanoharness";
const adapter = withRetry(limitConcurrency(openai({ ..., maxRetries: 0 }), 4));
```

Needs `nanoharness` 2.1 or later.

Requests never follow redirects, so a misconfigured `baseUrl` cannot forward your key or the conversation to another host. If you pass your own `fetch`, make sure it does the same.

Zero dependencies. Node 18 or later. MIT.
