import { defineTool } from "nanoharness";
import { defineAgent } from "nanoharness/agents";
import { anthropic } from "nanoharness-anthropic";

const adapter = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const add = defineTool({
  name: "add",
  description: "Add two numbers",
  schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } }, required: ["a", "b"] },
  run: ({ a, b }) => a + b,
});

const calculator = defineAgent({ name: "calculator", adapter, system: "You do arithmetic with your tools.", tools: [add] });

const lead = defineAgent({
  name: "lead",
  adapter,
  system: "Delegate arithmetic to the calculator, then answer in one sentence.",
  tools: [calculator.asTool("Does arithmetic. Input: a task in plain English.")],
  maxModelCalls: 20, // one budget for the lead and everything it calls
  onEvent: (agent, ev) => ev.type !== "done" && console.log(`[${agent}]`, ev.type),
});

const r = await lead.run("What is 1234 + 5678?");
console.log(r.finalText, "| total usage:", r.usage); // includes the calculator's tokens
