import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "tools-fs": "src/tools-fs.ts",
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
});
