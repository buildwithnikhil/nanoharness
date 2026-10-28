# Examples

Each file runs on its own. Set the key for the provider you use, install the packages, and run it with Node 18 or later.

| File | Shows |
|---|---|
| [`basic.mjs`](basic.mjs) | The tool loop with one tool, on Anthropic or any OpenAI-compatible server. |
| [`multi-agent.mjs`](multi-agent.mjs) | A lead agent delegating to a worker, with budget, tracing and token totals. |
| [`workflow.mjs`](workflow.mjs) | A graph that loops until a reviewer approves, with a file checkpoint so it can resume. |

```sh
npm install nanoharness nanoharness-anthropic nanoharness-fs
ANTHROPIC_API_KEY=... node basic.mjs
```

To use another provider, replace the adapter line, for example:

```js
import { openai } from "nanoharness-openai";
const adapter = openai({ model: "llama3.1", baseUrl: "http://localhost:11434/v1" }); // Ollama
```
