# nanoharness-openai

An OpenAI-compatible chat model adapter for [nanoharness](https://www.npmjs.com/package/nanoharness). One adapter covers OpenAI and every server that speaks the Chat Completions format: Ollama, vLLM, OpenRouter, LM Studio, Groq, Together and more. It is a separate package so the core `nanoharness` package contains no network code.

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
| `maxRetries` | Retries for HTTP 408, 429, 500, 502, 503 and 504, with backoff that honours `retry-after` (seconds or an HTTP date). Default `2`. |
| `fetch` | A custom `fetch`, for proxies or tests. |

Tool calls work through the standard `tools` and `tool_calls` fields, so the model must support tool calling. If a model returns tool arguments that are not valid JSON (or are not a JSON object), the call is **not run**: the harness tells the model its arguments were invalid. A reply cut off by the token limit (`finish_reason: "length"`) is reported as `max_tokens`, and any tool call in it is not run either.

Requests never follow redirects, so a misconfigured `baseUrl` cannot forward your key or the conversation to another host. If you pass your own `fetch`, make sure it does the same.

Zero dependencies. Node 18 or later. MIT.
