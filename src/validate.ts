import type { JSONSchema } from "./types.js";

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  if (t === "integer") return Number.isInteger(v);
  return typeOf(v) === t;
}

/**
 * Minimal JSON Schema check: type, required, properties, enum, items.
 * Unknown keywords are ignored. Returns an error message or null.
 */
export function validate(value: unknown, schema: JSONSchema, path = "input"): string | null {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      return `${path}: expected ${types.join("|")}, got ${typeOf(value)}`;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) return `${path}.${key}: required`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        const err = validate(obj[key], sub, `${path}.${key}`);
        if (err) return err;
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validate(value[i], schema.items, `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}
