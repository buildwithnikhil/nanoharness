import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    zod: "src/zod.ts",
    agents: "src/agents.ts",
    graph: "src/graph.ts",
    store: "src/store.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  target: "node18",
  external: ["zod"],
  // One shared chunk for CJS as for ESM, so module state (such as the in-process lock queue) exists once.
  splitting: true,
});
