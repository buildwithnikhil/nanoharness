# Changelog

All notable changes are listed here. This project follows [semantic versioning](https://semver.org). The companion packages (`nanoharness-anthropic`, `nanoharness-openai`, `nanoharness-fs`) are versioned on their own and are listed under the core release they first shipped with.

## 2.0.0 (unreleased)

The core package no longer contains any network or filesystem code. The Anthropic adapter and the file tools moved into companion packages, so `nanoharness` itself has no `fetch`, no `fs` and no URLs. This is a breaking release.

### Migrating from 1.x

| 1.x | 2.0 |
|---|---|
| `import { anthropic } from "nanoharness"` | `import { anthropic } from "nanoharness-anthropic"` |
| `import { createFsTools } from "nanoharness/tools-fs"` | `import { createFsTools } from "nanoharness-fs"` |
| `import { fileStore } from "nanoharness/store"` | `import { fileStore } from "nanoharness-fs"` (`memoryStore` and `session` stay in `nanoharness/store`) |

Install what you use: `npm install nanoharness nanoharness-anthropic` (and `nanoharness-fs` if you use file tools or `fileStore`). Everything else keeps working unchanged.

### New packages
- **`nanoharness-anthropic` 1.0.0**: the Claude adapter, moved out of the core.
  - `baseUrl` must be `https` (plain `http` only for `localhost`) and must not contain credentials, so the API key is never sent in clear text or to a malformed address.
  - `apiKey` is now checked up front, and a `temperature` option was added.
- **`nanoharness-openai` 1.0.0** (new): one adapter for OpenAI and any OpenAI-compatible server, including Ollama, vLLM, OpenRouter, LM Studio and Groq. It maps tools and tool results, retries 429 and 5xx, and has the same `baseUrl` protection (with an explicit `allowInsecureHttp` for LAN servers).
- **`nanoharness-fs` 1.0.0**: the sandboxed file tools and `fileStore`, moved out of the core.

### Added
- Schema checks now enforce `additionalProperties: false`, `minimum` / `maximum`, `minLength` / `maxLength`, `pattern` and `minItems` / `maxItems`, in addition to the keywords from before.
- `pipeline()` and `parallel()` accept `maxModelCalls` to share one budget across their agents, and `pipeline()` returns the total `usage`.
- `examples/` with three runnable examples, plus `CONTRIBUTING.md` and `SECURITY.md`.

### Fixed
- A tool call cut off by the token limit is no longer run with incomplete input. The turn is dropped from the history, so `stopReason: "max_tokens"` leaves a conversation you can retry.
- A tool that returns a value JSON cannot encode (a function, for example) no longer crashes the run.
- `defineZodTool` no longer sends the `$schema` marker to the model.
- `createGraph` now throws if only one of `store` and `id` is given. Before, it silently turned checkpoints off.

## 1.3.0 (2026-10-23)

Multi-agent hardening, found by auditing how agents behave together.

### Fixed
- Agents that call each other no longer recurse without limit. `defineAgent` now enforces `maxDepth` (default 4) and one `maxModelCalls` budget (default 200) shared by the whole agent tree.
- An agent's own `AbortSignal` was silently dropped by `pipeline`, `parallel` and `asTool`. Both the agent's and the caller's signals are now honoured.
- Concurrent writes to one `fileStore` key could fail with `ENOENT`.
- Concurrent `session.run` calls on one id lost messages. They are now queued in order.
- Sub-agent token usage is now added to the parent's `usage`.
- Two tools with the same name are rejected instead of one silently replacing the other, and agent names are checked to be valid tool names.

### Added
- `toolConcurrency`: tool calls from one turn can run at the same time. It is `1` for `run()` and `4` for `defineAgent`, so sub-agents requested together run in parallel.
- The Anthropic adapter retries 429 and 5xx responses with backoff (`maxRetries`, default 2).
- `read_file` refuses files over `maxFileBytes` (default 1,000,000).

## 1.2.0 (2026-10-23)

### Added
- **Multi-agent orchestration**, `nanoharness/agents`: `defineAgent` (an agent can be given to another agent as a tool with `asTool`), `pipeline`, `parallel` and `createPlanTool`.
- **Workflow graphs**, `nanoharness/graph`: nodes over a shared state, conditional routing, and checkpoints so a run resumes after a crash.
- **Persistence**, `nanoharness/store`: `memoryStore`, `fileStore` and `session`.
- **Guardrails**, all opt-in: `evaluate` (an evaluator for the final answer), `onToolResult`, `markUntrusted`, `allowTools`, `maxToolResultChars`, `toolTimeoutMs` and `maxRepeatedCalls`.

(Version 1.1.0 was not published. Its guardrails shipped in 1.2.0.)

## 1.0.1 (2026-10-23)

- Published from GitHub Actions with signed provenance, and the repository link in `package.json` now resolves.

## 1.0.0 (2026-10-23)

First release: the tool-use loop (`run` and `stream`), `defineTool` with JSON Schema validation, the Anthropic adapter, sandboxed file tools at `nanoharness/tools-fs`, and optional Zod support at `nanoharness/zod`. ESM and CJS builds, no runtime dependencies.
