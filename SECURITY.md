# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue. Use GitHub's private reporting: open the **Security** tab of this repository and choose **Report a vulnerability**. Include the package and version, what you did, and what happened.

You can expect an acknowledgement within a few days. Fixes are released as patch versions, and the advisory credits the reporter unless you ask otherwise.

## Supported versions

Only the latest major version of each package gets fixes.

## What to know about the security model

- The **core** (`nanoharness`) has no network or filesystem code and no runtime dependencies.
- **Tools run with your process's permissions.** The harness validates what the model sends and offers hooks (`onToolCall`, `onToolResult`, `evaluate`, limits on size, time, repeats and model calls), but the model can still be talked into misusing any tool you give it. Give an agent the fewest and narrowest tools it needs.
- **No prompt-injection defence is complete.** Fencing untrusted output with `markUntrusted` and restricting tools lowers the risk but does not remove it.
- **`nanoharness-fs`** confines every path to the root you give it and rejects symlinks that lead outside it, including dangling ones. It refuses special files and stops reading at `maxFileBytes`. `write_file` exists only with `allowWrite: true`. It cannot stop a symlink swapped in between its check and its use, so give the agent a root that only trusted code can write to.
- **`nanoharness-anthropic` and `nanoharness-openai`** send your API key only to the `baseUrl` you set, which must be `https` (or `http` on localhost, or with `allowInsecureHttp` in the OpenAI adapter). They never follow redirects, so the key and the conversation cannot be forwarded elsewhere. If you pass your own `fetch`, it must do the same.
- **Schema checks run on the model's input**, with `pattern` matching limited to strings of 100,000 characters. A pattern with nested quantifiers can still take exponential time, so write patterns carefully.
- Releases are built and published by GitHub Actions with signed provenance. Check one with `npm audit signatures`.
