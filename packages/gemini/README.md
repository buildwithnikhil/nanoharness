# nanoharness-gemini

The Google Gemini model adapter for [nanoharness](https://www.npmjs.com/package/nanoharness), for the Gemini API (Google AI Studio) and Vertex AI. It is `geminiCompatible` from the core with Google's URL and the global `fetch` filled in, kept separate so the core never uses the network by itself. If you would rather not install it, `geminiCompatible` from `nanoharness` does the same with the `fetch` and `baseUrl` you pass.

```sh
npm install nanoharness nanoharness-gemini
```

```ts
import { run } from "nanoharness";
import { gemini } from "nanoharness-gemini";

const adapter = gemini({ model: "gemini-2.5-flash", apiKey: process.env.GEMINI_API_KEY });
const { finalText } = await run({ adapter, prompt: "Say hi in one word." });
```

| Option | Description |
|---|---|
| `model` | Required, e.g. `gemini-2.5-flash`. A `models/` prefix is accepted. |
| `apiKey` | Your Gemini API key. Sent as the `x-goog-api-key` header, never in the URL. |
| `baseUrl` | Default `https://generativelanguage.googleapis.com/v1beta`. Must be `https` (`http` only for `localhost`) and must not contain credentials. |
| `headers` | Extra headers on every request, such as a Vertex AI access token. They can replace the default ones. |
| `maxTokens` | Sent as `generationConfig.maxOutputTokens`. |
| `temperature` | Sent only when set. |
| `maxRetries` | Retries for HTTP 408, 429, 500, 502, 503 and 504, with backoff that honours `retry-after`. Default `2`. |
| `fetch` | A custom `fetch`, for proxies or tests. Defaults to the global `fetch`. |

## Vertex AI

Point `baseUrl` at your project's publisher and pass an access token (for example from `gcloud auth print-access-token` or `google-auth-library`) instead of a key:

```ts
const adapter = gemini({
  model: "gemini-2.5-pro",
  baseUrl: `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/google`,
  headers: { authorization: `Bearer ${accessToken}` },
});
```

Access tokens expire after about an hour, so create the adapter again with a fresh token when it does.

## How it maps

- Tools are sent as `functionDeclarations` with the full JSON Schema (`parametersJsonSchema`), so `additionalProperties`, `$ref` and the like work.
- Gemini's thought signatures are kept on each tool call in the history and sent back, as thinking models require. Thought summaries are not shown as text.
- Token usage counts thinking tokens as output, as they are billed.
- A prompt blocked by safety settings throws an `AdapterError` naming the reason. A reply stopped for safety ends with stop reason `other`.

## Streaming and errors

Both `complete` and `stream` are supported. Pass `streaming: true` to `run`, `stream` or `defineAgent` to receive `text_delta` events as text arrives.

A failed request throws an `AdapterError` (from `nanoharness`) with the HTTP `status`, `retryable`, and `retryAfterMs` when the server sent one. The adapter retries on its own (`maxRetries`). To use jittered backoff or share a rate limit across agents instead, turn that off and wrap it, with `withRetry` outside:

```ts
import { limitConcurrency, withRetry } from "nanoharness";
const adapter = withRetry(limitConcurrency(gemini({ ..., maxRetries: 0 }), 4));
```

Redirects are never followed, so your key and conversation cannot be forwarded to another host.

Needs `nanoharness` 2.1 or later.
