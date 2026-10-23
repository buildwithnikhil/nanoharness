import { promises as fs, realpathSync } from "node:fs";
import path from "node:path";
import { defineTool } from "./tool.js";
import type { Tool } from "./tool.js";

export interface FsToolsOptions {
  /** Every path the model passes is resolved inside this directory. */
  root: string;
  /** Adds write_file. Off by default. */
  allowWrite?: boolean;
}

export function createFsTools(opts: FsToolsOptions): Tool[] {
  const root = realpathSync(path.resolve(opts.root));

  // Resolves symlinks on the deepest existing ancestor so a link cannot point outside root.
  const resolve = (p: string): string => {
    const abs = path.resolve(root, p);
    let probe = abs;
    for (;;) {
      try {
        const real = realpathSync(probe);
        const full = path.join(real, path.relative(probe, abs));
        const rel = path.relative(root, full);
        if (rel.startsWith("..") || path.isAbsolute(rel)) break;
        return full;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    throw new Error(`Path escapes root: ${p}`);
  };

  const tools: Tool[] = [
    defineTool<{ path: string }>({
      name: "read_file",
      description: "Read a UTF-8 text file relative to the project root.",
      schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      run: ({ path: p }) => fs.readFile(resolve(p), "utf8"),
    }),
    defineTool<{ path?: string }>({
      name: "list_dir",
      description: "List entries of a directory relative to the project root. Directories end with /.",
      schema: { type: "object", properties: { path: { type: "string" } } },
      run: async ({ path: p = "." }) => {
        const entries = await fs.readdir(resolve(p), { withFileTypes: true });
        return entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join("\n");
      },
    }),
  ];

  if (opts.allowWrite) {
    tools.push(
      defineTool<{ path: string; content: string }>({
        name: "write_file",
        description: "Write a UTF-8 text file relative to the project root, creating parent directories.",
        schema: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
        run: async ({ path: p, content }) => {
          const target = resolve(p);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, content);
          return `Wrote ${content.length} characters to ${p}`;
        },
      }),
    );
  }

  return tools;
}
