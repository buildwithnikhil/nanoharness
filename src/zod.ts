import { z } from "zod";
import type { Tool, ToolContext } from "./tool.js";
import type { JSONSchema } from "./types.js";

export interface ZodToolOptions<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  run: (input: z.output<S>, ctx: ToolContext) => unknown | Promise<unknown>;
}

// The model supplies input, so the schema it sees describes the input side (a field with a default is optional).
function jsonSchema(schema: z.ZodType, name: string): JSONSchema {
  if (typeof z.toJSONSchema !== "function") {
    throw new Error(`defineZodTool "${name}": needs zod 4 or later (z.toJSONSchema is missing; zod 3 is not supported)`);
  }
  const { $schema: _omit, ...rest } = z.toJSONSchema(schema, { io: "input" }) as JSONSchema;
  if (rest.type !== "object") {
    throw new Error(`defineZodTool "${name}": the schema must be a z.object(...), because tool input has to be a JSON object`);
  }
  return rest;
}

/** Builds a tool whose JSON Schema and validation both come from a Zod schema. */
export function defineZodTool<S extends z.ZodType>(opts: ZodToolOptions<S>): Tool<z.output<S>> {
  return {
    name: opts.name,
    description: opts.description,
    schema: jsonSchema(opts.schema, opts.name),
    parse: (input) => {
      const r = opts.schema.safeParse(input);
      return r.success ? { ok: true, value: r.data } : { ok: false, error: r.error.message };
    },
    run: opts.run,
  };
}
