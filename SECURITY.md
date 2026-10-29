# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's private reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Include the package and version, what you did, and what happened.

You can expect an acknowledgement within a few days. Fixes are released as patch versions, and the advisory credits the reporter unless you ask otherwise.

## Supported versions

Only the latest major version of each package gets fixes.

## What to know about the security model

- The **core** (`nanoharness`) never uses the network or the filesystem by itself and has no runtime dependencies. Its model adapters send requests only through the `fetch` you pass in.
- **Tools run with your process's permissions.** The harness validates what the model sends and offers hooks (`onToolCall`, `onToolResult`, `evaluate`, limits on size, time, repeats and model calls), but the model can still be talked into misusing any tool you give it. Give an agent the fewest and narrowest tools it needs.
- **No prompt-injection defence is complete.** Fencing untrusted output with `markUntrusted` and restricting tools lowers the risk but does not remove it.
- **`nanoharness-fs`** confines every path to the root you give it and rejects symlinks that lead outside it, including dangling ones. It refuses special files and stops reading at `maxFileBytes`. `write_file` exists only with `allowWrite: true`. It cannot stop a symlink swapped in between its check and its use, so give the agent a root that only trusted code can write to. On Windows the `O_NOFOLLOW` guard against such a swap is not available, so that advice matters more there.
- **`nanoharness-anthropic`, `nanoharness-openai` and `nanoharness-gemini`, and the core's `openaiCompatible`, `anthropicCompatible` and `geminiCompatible`,** send your API key only to the `baseUrl` you set, which must be `https` (or `http` on localhost, or with `allowInsecureHttp` where offered). The Gemini key goes in a header, never in the URL. They never follow redirects, so the key and the conversation cannot be forwarded elsewhere. If you pass your own `fetch`, it must do the same.
- **Schema checks run on the model's input**, with `pattern` matching limited to strings of 100,000 characters. A pattern with nested quantifiers can still take exponential time, so write patterns carefully.
- **Limits are opt-in.** By default only `maxTurns` (20) and a 64 MB cap on a whole model reply apply. Set `maxToolResultChars`, `toolTimeoutMs` and `maxModelCalls` (and a `signal` with a timeout) for agents that take untrusted input.
- **Provenance.** `nanoharness` releases are built and published by GitHub Actions with signed provenance; check one with `npm audit signatures`. The companion packages publish the same way from their 1.1.0 releases (`nanoharness-gemini` from 1.0.0); their 1.0.0 releases were published by hand, without provenance.
