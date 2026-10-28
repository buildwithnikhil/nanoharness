import type { JSONSchema } from "./types.js";

// Model-supplied keys such as "__proto__" or "toString" must not be mistaken for properties.
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// Pattern matching on a very long string can stall the process, so long strings are refused up front.
const MAX_PATTERN_INPUT = 100_000;

// Unicode mode, so "." matches an emoji as one character; patterns that mode rejects fall back to plain mode.
function regex(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return new RegExp(pattern);
  }
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  if (t === "integer") return Number.isInteger(v);
  return typeOf(v) === t;
}

/** Structural equality for JSON values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((v, i) => deepEqual(v, other[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => has(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** JSON text with object keys in sorted order, so equal values always give equal text. */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

const list = (v: unknown): JSONSchema[] => (Array.isArray(v) ? (v as JSONSchema[]) : []);

/**
 * JSON Schema check covering type, enum, const, required, properties, additionalProperties (false or a schema),
 * items, minimum / maximum / exclusiveMinimum / exclusiveMaximum / multipleOf, minLength / maxLength / pattern,
 * minItems / maxItems / uniqueItems, and allOf / anyOf / oneOf.
 * Other keywords ($ref, format, if/then, patternProperties, ...) are sent to the model but not enforced.
 * Returns an error message or null.
 */
export function validate(value: unknown, schema: JSONSchema, path = "input"): string | null {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      return `${path}: expected ${types.join("|")}, got ${typeOf(value)}`;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
    return `${path}: must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  if (has(schema, "const") && !deepEqual(value, schema.const)) {
    return `${path}: must equal ${JSON.stringify(schema.const)}`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path}: must be >= ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path}: must be <= ${schema.maximum}`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${path}: must be > ${schema.exclusiveMinimum}`;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return `${path}: must be < ${schema.exclusiveMaximum}`;
    if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
      const q = value / schema.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q))) return `${path}: must be a multiple of ${schema.multipleOf}`;
    }
  }
  if (typeof value === "string") {
    // JSON Schema counts characters (code points), not UTF-16 units, so an emoji is one.
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return `${path}: must be at least ${schema.minLength} characters`;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return `${path}: must be at most ${schema.maxLength} characters`;
    if (typeof schema.pattern === "string") {
      if (value.length > MAX_PATTERN_INPUT) return `${path}: too long to check against its pattern`;
      let re: RegExp;
      try {
        re = regex(schema.pattern);
      } catch {
        return `${path}: the schema has an invalid pattern`;
      }
      if (!re.test(value)) return `${path}: must match ${schema.pattern}`;
    }
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JSONSchema>;
    for (const key of schema.required ?? []) {
      if (!has(obj, key)) return `${path}.${key}: required`;
    }
    for (const [key, sub] of Object.entries(props)) {
      if (has(obj, key)) {
        const err = validate(obj[key], sub, `${path}.${key}`);
        if (err) return err;
      }
    }
    const extra = schema.additionalProperties;
    if (extra === false) {
      const k = Object.keys(obj).find((key) => !has(props, key));
      if (k !== undefined) return `${path}.${k}: not allowed`;
    } else if (extra && typeof extra === "object") {
      for (const key of Object.keys(obj)) {
        if (has(props, key)) continue;
        const err = validate(obj[key], extra as JSONSchema, `${path}.${key}`);
        if (err) return err;
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path}: needs at least ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path}: allows at most ${schema.maxItems} items`;
    if (schema.uniqueItems === true && new Set(value.map(canonical)).size !== value.length) return `${path}: items must be unique`;
    if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
      for (let i = 0; i < value.length; i++) {
        const err = validate(value[i], schema.items as JSONSchema, `${path}[${i}]`);
        if (err) return err;
      }
    }
  }
  for (const sub of list(schema.allOf)) {
    const err = validate(value, sub, path);
    if (err) return err;
  }
  const anyOf = list(schema.anyOf);
  if (anyOf.length > 0 && !anyOf.some((sub) => validate(value, sub, path) === null)) return `${path}: does not match any allowed schema`;
  const oneOf = list(schema.oneOf);
  if (oneOf.length > 0) {
    const n = oneOf.filter((sub) => validate(value, sub, path) === null).length;
    if (n !== 1) return `${path}: must match exactly one allowed schema (matched ${n})`;
  }
  return null;
}
