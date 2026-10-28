# Changelog

All notable changes are listed here. This project follows [semantic versioning](https://semver.org). The companion packages (`nanoharness-anthropic`, `nanoharness-openai`, `nanoharness-fs`) are versioned on their own and are listed under the core release they first shipped with.

## 2.1.0 (unreleased)

Everything here is opt-in and adds no dependencies. The core still has no network or filesystem code. Released together with `nanoharness-anthropic` 1.1.0 and `nanoharness-openai` 1.1.0 (streaming and `AdapterError`); publish the core first, since both need it.

### Added
- **Streaming.** `streaming: true` on `run`, `stream` and `defineAgent` uses the adapter's new optional `stream` method and emits `text_delta` events. `nanoharness-anthropic` and `nanoharness-openai` both stream.
- **Custom models.**
  - `promptAdapter({ generate })` gives tool calling to any text-in, text-out model.
  - `defineAdapter` types a hand-written adapter.
  - `readSSE` reads a streaming (Server-Sent Events) response.
  - `AdapterError` carries the HTTP status, whether to retry, and `retryAfterMs`. Both official adapters now throw it.
- **Scaling helpers.**
  - `limitConcurrency(adapter, n)` caps calls in flight across all runs and agents.
  - `withRetry(adapter, opts)` adds retry with jittered backoff to any adapter.
- **Long conversations.** `session(store, id, { maxMessages, summarize })` keeps a session's history bounded, cutting at a safe point and optionally keeping a summary of what was dropped. `trimHistory` is the same as a plain function.
- **Tracing.**
  - `onEvent` on `run()`.
  - A `model_call` event after every model call, with `durationMs`, `usage` and `stopReason`.
  - `tool_result` events now carry `durationMs`.
- **Custom stores.** `checkStore(store)` checks a store you wrote. The README has a Redis example.
- `Adapter.stream`, `AdapterStreamEvent` and `RunOptions.streaming` / `onEvent` in the types.

### Changed
- `stream()` (and `onEvent`) now also emits `model_call` events. Code that compares the exact sequence of events will see the new event; code that switches on `ev.type` is unaffected.
- The description no longer calls the package "for small apps".
- `nanoharness-anthropic` and `nanoharness-openai` 1.1.0 need `nanoharness` 2.1 or later. `nanoharness-fs` is unchanged (still 1.0.0).

## 2.0.0 (2026-10-28)

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
- **Schema checks could be bypassed by prototype-named keys.** A model-supplied `__proto__`, `constructor` or `toString` key slipped past `additionalProperties: false`, and an inherited property satisfied `required`. Checks now look at own properties only.
- `minLength` / `maxLength` counted UTF-16 units, so an emoji counted as two characters. They now count characters, and `pattern` matches in Unicode mode (with a fallback for patterns that mode rejects).
- An empty model reply no longer leaves an empty assistant message in the history, which providers reject when it is replayed.
- Adapters can now flag a malformed tool call (`error` on a `tool_use` block). The harness does not run it and tells the model what was wrong.
- The Anthropic adapter sends only the fields the API defines for `tool_use` blocks, and both adapters release the connection of a response they are about to retry.
- **OpenAI adapter:** a tool call cut off by the token limit (`finish_reason: "length"`) and a call with invalid JSON arguments are no longer run with an empty input.

### Found and fixed by independent review before release

Four reviewers each read the code with a different focus and reported only bugs they could reproduce.

**Security**
- The Anthropic and OpenAI adapters followed HTTP redirects, and the runtime forwards the `x-api-key` header (and, on a 307 or 308, the whole conversation) to the new host. Both adapters now refuse every redirect.
- `nanoharness-fs`: a dangling symlink inside the root let `write_file` create a file outside it. Paths that exist but cannot be resolved are now refused, and files are opened with `O_NOFOLLOW`.
- `nanoharness-fs`: `read_file` hung forever on a FIFO, and its size limit could be bypassed by a file that reports size 0 (such as those under `/proc`). It now opens the file, requires a regular file, and stops reading at the limit.

**Core loop**
- A rejected answer is no longer reported as `end_turn` when no turns are left. It is `eval_failed`, so agents and pipelines do not pass a rejected answer along as good.
- Aborting is prompt. Queued tool calls are skipped (and answered with an error so the history stays valid), a tool that ignores its signal is no longer waited for, and an already-aborted signal reaches the tool even with `toolTimeoutMs`.
- An `onToolResult` hook that throws or returns a non-string no longer crashes the run. The raw output is withheld and the model gets an error. Sibling tools no longer keep running after the run has settled.
- `maxToolResultChars` is now a true cap with the truncation marker inside it, and never cuts an emoji in half.
- Schema checks now also enforce `const`, `anyOf` / `oneOf` / `allOf`, `exclusiveMinimum` / `exclusiveMaximum`, `multipleOf`, `uniqueItems` and `additionalProperties` as a schema, and compare `enum` members by value. Before, a schema using these let invalid input through. A `pattern` that cannot compile, or a string over 100,000 characters, is reported instead of hanging.
- `maxRepeatedCalls` no longer misses a repeat whose object keys were reordered.
- Empty `evaluate` feedback falls back to a default message, and feedback after an empty reply no longer produces two user messages in a row.
- On Node before 20.3, an agent's abort-signal fallback no longer leaks listeners.

**Agents, graphs and stores**
- Usage of a sub-agent that fails part-way is still counted, and is reported to the parent as it happens.
- A graph that stopped on `max_steps` could never be resumed: every later call returned `max_steps` immediately. `maxSteps` now applies to each call.
- A node returning a `next` that does not exist saved a checkpoint that made every resume throw. It now throws before saving.
- The checkpoint is saved before `onStep` runs, so a throwing hook does not re-run the node that already ran.
- With a store, graph state is saved as JSON after every node, so a resumed run sees the same state as an uninterrupted one. State that cannot be saved is reported at once.
- Concurrent runs of one graph id are queued. `session().clear()` is queued behind a run in flight instead of being undone by it.
- Node names are looked up as own properties, so a `next` of `"constructor"` is not a node.
- `fileStore` (now in `nanoharness-fs`): writes to one key are applied in call order; long, empty and non-ASCII keys work (they were failing with `ENAMETOOLONG`); one stray file in the directory no longer breaks `keys()`; file names are safe on case-insensitive and Windows file systems; and `store.lock()` adds a lock that also holds across processes, which sessions and checkpointed graphs now use.

**Adapters and Zod**
- `Retry-After` is understood as an HTTP date as well as seconds. A 2xx body that is not JSON gives a clear error, and API error text is cut to 1,000 characters. Anthropic's `refusal` stop reason ends the turn. The OpenAI adapter leaves out an assistant message that has neither text nor tool calls.
- `defineZodTool` shows the model the input schema (a field with a default is optional) and rejects a schema that is not a `z.object(...)` when the tool is defined.

**Second pass (master review of the fixes above)**
- `fileStore`: a key containing a lone surrogate shared a file with `"\uFFFD"` and made `get`/`delete` throw. Such keys are now stored under a hash.
- `fileStore`: a key such as `con.foo` gave a name Windows treats as a device. The part before the first dot is now checked.
- `fileStore` lock: a holder that stalled past `lockStaleMs` and lost the lock could delete the lock of whoever took over. Each holder now writes a token and removes the lock file only if it is still its own.
- A run aborted while `onToolCall` was deciding still started the tool. It no longer does.
- Very deeply nested input or schemas (thousands of levels) are reported as "nested too deeply" instead of overflowing the stack.
- A sub-agent's own `onUsage` is called as well as the parent's.
- API error bodies are read only up to the 1,000 characters that are kept, and a refused redirect now says so instead of a bare "fetch failed".

### Behaviour changes to know about
- `fileStore` file names changed (and `nanoharness-fs` is a new package). Files written by `nanoharness` 1.x are still read, except where the 1.x name contained upper-case letters or special characters. Re-save those keys once.
- `maxToolResultChars` output is now shorter than before for the same limit, because the marker counts toward it.
- Schemas that used the keywords listed above now reject input that 1.x let through. That is the intent.

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
