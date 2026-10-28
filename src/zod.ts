import { z } from "zod";
import type { Tool, ToolContext } from "./tool.js";
import type { JSONSchema } from "./types.js";

export interface ZodToolOptions<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.output<S>, ctx: ToolContext) => unknown | Promise<unknown>;
}

function jsonSchema(schema: z.ZodType): JSONSchema {
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema) as JSONSchema;
  return rest;
}

/** Builds a tool whose JSON Schema and validation both come from a Zod schema. */
export function defineZodTool<S extends z.ZodType>(opts: ZodToolOptions<S>): Tool<z.output<S>> {
  return {
    name: opts.name,
    description: opts.description,
    schema: jsonSchema(opts.schema),
    parse: (input) => {
      const r = opts.schema.safeParse(input);
      return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message };
    },
    run: opts.run,
  };
}
