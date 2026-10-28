import { defineAgent } from "nanoharness/agents";
import { createGraph, END } from "nanoharness/graph";
import { anthropic } from "nanoharness-anthropic";
import { fileStore } from "nanoharness-fs";

const adapter = anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const writer = defineAgent({ name: "writer", adapter, system: "Write exactly one sentence." });
const reviewer = defineAgent({ name: "reviewer", adapter, system: "Reply APPROVED if the sentence is clear and under 25 words, otherwise reply with one fix." });

const graph = createGraph({
  entry: "write",
  edges: { write: "review" },
  maxSteps: 8,
  store: fileStore("./.workflow-data"), // a crash resumes at the node that failed
  id: "demo",
  onStep: ({ step, node }) => console.log(`step ${step}: ${node}`),
  nodes: {
    write: async ({ state }) => ({ state: { draft: (await writer.run(`${state.topic}. ${state.feedback ?? ""}`)).finalText } }),
    review: async ({ state }) => {
      const verdict = (await reviewer.run(state.draft)).finalText;
      return verdict.includes("APPROVED") ? { next: END } : { state: { feedback: verdict }, next: "write" };
    },
  },
});

const { state, status } = await graph.run({ topic: "Describe an owl" }, { fresh: true });
console.log(status, "|", state.draft);
