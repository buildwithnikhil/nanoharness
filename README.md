# nanoharness

A lightweight, zero-dependency agent harness for small apps. You give it a model adapter and some tools. It runs the tool-use loop.

- **Zero runtime dependencies.** The Anthropic adapter uses `fetch`.
- **Provider-agnostic.** A model provider is one method: `complete(request) → response`.
- **Bring your own tools.** There are no built-in tools and no shell access. An optional, sandboxed file tool set is available at `nanoharness/tools-fs`.
- **ESM and CJS**, with types. Node 18 or later.

```sh
npm install nanoharness
```

## Quickstart

```ts
import { run, defineTool, anthropic } from "nanoharness";

const add = defineTool<{ a: number; b: number }>({
  name: "add",
  description: "Add two numbers",
  schema: {
    type: "object",
    properties: { a: { type: "number" }, b: { type: "number" } },
    required: ["a", "b"],
  },
  run: ({ a, b }) => a + b,
});

const { finalText } = await run({
  adapter: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  prompt: "What is 1234 + 5678?",
  tools: [add],
});
console.log(finalText);
```

## API

### `run(options)` and `stream(options)`

`run` returns `{ messages, finalText, stopReason, usage }`. `stream` is an async generator over the same loop, yielding `text`, `tool_call`, `tool_result` and a final `done` event (whose `result` is the same object `run` returns). `run` is the stream collected to the end.

```ts
for await (const ev of stream({ adapter, prompt, tools })) {
  if (ev.type === "text") process.stdout.write(ev.text);
}
```

| Option | Description |
|---|---|
| `adapter` | Required. Any `{ complete(req) }`. |
| `prompt` | A string, or an existing `Message[]` to continue a conversation. |
| `system` | System prompt. |
| `tools` | Tools from `defineTool`. |
| `maxTurns` | Default `20`. Stops with `stopReason: "max_turns"`. |
| `signal` | An `AbortSignal`. Stops with `stopReason: "aborted"`. |
| `onToolCall` | `(call) => "allow" \| "deny" \| { deny: reason }`, called before each tool runs. |

`stopReason` is one of `end_turn`, `max_turns`, `max_tokens` or `aborted`.

Errors from tools, from invalid model arguments, from unknown tool names and from `onToolCall` denials are returned to the model as `tool_result` blocks with `is_error: true`. Only adapter failures throw.

The caller owns `messages`. There is no hidden memory, persistence or compaction. To continue a conversation, pass `result.messages` plus a new user message as `prompt`.

### `defineTool({ name, description, schema, run })`

`schema` is plain JSON Schema. Model arguments are checked against `type`, `required`, `properties`, `enum` and `items`. Other keywords are sent to the model but not enforced.

### Zod (optional)

```ts
import { z } from "zod"; // zod >= 4
import { defineZodTool } from "nanoharness/zod";

const greet = defineZodTool({
  name: "greet",
  description: "Greet someone",
  schema: z.object({ name: z.string() }),
  run: ({ name }) => `hi ${name}`,
});
```

### File tools (optional)

```ts
import { createFsTools } from "nanoharness/tools-fs";

const tools = createFsTools({ root: "./workspace" }); // read_file, list_dir
// createFsTools({ root, allowWrite: true }) also adds write_file
```

Paths are resolved inside `root`, and symlinks pointing outside it are rejected.

### Writing an adapter

```ts
const myAdapter: Adapter = {
  async complete({ system, messages, tools, signal }) {
    // call your provider, then return:
    return { content: [{ type: "text", text: "..." }], stopReason: "end_turn" };
  },
};
```

Messages and content blocks use the Anthropic shape (`text`, `tool_use`, `tool_result`). Adapters for other providers translate to and from it.

## Not in v1

Token-level streaming, shell tools, sub-agents, memory and context compaction. The event stream is additive, so token deltas can be added later without breaking the API.

## License

MIT
