# nanoharness-anthropic

The [Anthropic](https://www.anthropic.com) model adapter for [nanoharness](https://www.npmjs.com/package/nanoharness). It is a separate package so the core `nanoharness` package contains no network code.

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
| `maxRetries` | Retries for 408, 429 and 5xx responses, with backoff that honours `retry-after`. Default `2`. |
| `baseUrl` | Where requests, and so the API key, are sent. Must be `https` (`http` only for `localhost`) and must not contain credentials. Default `https://api.anthropic.com`. |
| `fetch` | A custom `fetch`, for proxies or tests. Defaults to the global `fetch`. |

Zero dependencies. Node 18 or later. MIT.
