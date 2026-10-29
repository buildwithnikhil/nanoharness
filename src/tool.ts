import type { JSONSchema, Usage } from "./types.js";

/** Counts model calls across a run and every sub-agent it starts. */
export interface Budget {
  used: number;
  max: number;
}

export interface ToolContext {
  signal?: AbortSignal;
  /** Nesting level of the agent run calling this tool (0 for a top-level run). */
  depth?: number;
  /** Lets a tool that runs a model (a sub-agent) charge its token usage to the calling run. */
  addUsage?: (usage: Usage) => void;
  /** The model-call budget shared by the whole agent tree, if one is set. Pass it on to sub-agents. */
  budget?: Budget;
}

export type ParseResult<I> = { ok: true; value: I } | { ok: false; error: string };

export interface Tool<I = any> {
  name: string;
  description: string;
  schema: JSONSchema;
  /** Replaces the built-in schema check, e.g. when a validation library is in use. */
  parse?: (input: unknown) => ParseResult<I>;
  run: (input: I, ctx: ToolContext) => unknown | Promise<unknown>;
}

/** Defines a tool: its name, a description for the model, a JSON Schema for its input, and the function to run. */
export function defineTool<I = Record<string, unknown>>(tool: Tool<I>): Tool<I> {
  return tool;
}
