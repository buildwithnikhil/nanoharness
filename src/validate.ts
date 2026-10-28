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
 * Minimal JSON Schema check: type, enum, required, properties, additionalProperties: false, items,
 * minimum/maximum, minLength/maxLength, pattern and minItems/maxItems.
 * Other keywords are sent to the model but not enforced. Returns an error message or null.
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
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path}: must be >= ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path}: must be <= ${schema.maximum}`;
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${path}: must be at least ${schema.minLength} characters`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path}: must be at most ${schema.maxLength} characters`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return `${path}: must match ${schema.pattern}`;
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    if (schema.additionalProperties === false) {
      const extra = Object.keys(obj).find((k) => !(k in (schema.properties ?? {})));
      if (extra !== undefined) return `${path}.${extra}: not allowed`;
    }
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
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path}: needs at least ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path}: allows at most ${schema.maxItems} items`;
  }
  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      const err = validate(value[i], schema.items, `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}
