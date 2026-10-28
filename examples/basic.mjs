import { run, defineTool, allowTools } from "nanoharness";
import { anthropic } from "nanoharness-anthropic";

const add = defineTool({
  name: "add",
  description: "Add two numbers",
  schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"], additionalProperties: false },
  run: ({ a, b }) => a + b,
});

const result = await run({
  adapter: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }),
  prompt: "What is 1234 + 5678? Use the add tool.",
  tools: [add],
  onToolCall: allowTools(["add"]), // only this tool may run
  maxTurns: 5,
});

console.log(result.finalText, "|", result.stopReason, "|", result.usage);
