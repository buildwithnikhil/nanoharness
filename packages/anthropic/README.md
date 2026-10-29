# nanoharness-anthropic

The [Anthropic](https://www.anthropic.com) model adapter for [nanoharness](https://www.npmjs.com/package/nanoharness). It is `anthropicCompatible` from the core with the official URL and the global `fetch` filled in, kept separate so the core never uses the network by itself. If you would rather not install it, `anthropicCompatible` from `nanoharness` does the same with the `fetch` and `baseUrl` you pass.

```sh
npm install nanoharness nanoharness-anthropic
```

```ts
import { run } from "nanoharness";
import { anthropic } from "nanoharness-anthropic";

const { finalText } = await run({
  adapter: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-sonnet-5-5" }),
  prompt: "Say hi in one word.",
});
```

| Option | Description |
|---|---|
| `apiKey` | Required. |
| `model` | Default `claude-sonnet-5-5`. |
| `maxTokens` | Default `4096`. |
| `headers` | Extra headers on every request, such as a gateway header. They can replace the default ones. |
| `maxRetries` | Retries for HTTP 408, 429, 500, 502, 503, 504 and 529, with backoff that honours `retry-after` (seconds or an HTTP date). Default `2`. |
| `baseUrl` | Where requests, and so the API key, are sent. Must be `https` (`http` only for `localhost`) and must not contain credentials. Default `https://api.anthropic.com`. |
| `fetch` | A custom `fetch`, for proxies or tests. Defaults to the global `fetch`. |

## Streaming and errors

Both `complete` and `stream` are supported. Pass `streaming: true` to `run`, `stream` or `defineAgent` to receive `text_delta` events as text arrives.

A failed request throws an `AdapterError` (from `nanoharness`) with the HTTP `status`, `retryable`, and `retryAfterMs` when the server sent one. The adapter retries on its own (`maxRetries`). To use jittered backoff or share a rate limit across agents instead, turn that off and wrap it, with `withRetry` outside:

```ts
import { limitConcurrency, withRetry } from "nanoharness";
import { anthropic } from "nanoharness-anthropic";

const adapter = withRetry(limitConcurrency(anthropic({ apiKey: process.env.ANTHROPIC_API_KEY!, maxRetries: 0 }), 4));
```

Needs `nanoharness` 2.1 or later.

Requests never follow redirects, so a misconfigured or hostile `baseUrl` cannot forward your key to another host. If you pass your own `fetch`, make sure it does the same. Error text from the API is cut to 1,000 characters.

Zero dependencies. Node 18 or later. MIT.
