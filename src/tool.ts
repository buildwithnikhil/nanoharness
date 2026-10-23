import type { JSONSchema } from "./types.js";

export interface ToolContext {
  signal?: AbortSignal;
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

export function defineTool<I = Record<string, unknown>>(tool: Tool<I>): Tool<I> {
  return tool;
}
