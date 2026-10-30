// A tool's parameters, from its Schema to the JSON Schema the model is shown, and a model's arguments back to what the
// Schema reads, as pi-ai's validateToolArguments makes them (testdata/arguments.jsonl.gz).

import { Schema, Predicate } from "effect";

export type JsonSchema = Readonly<Record<string, unknown>>;

/** An object's parameters in the shape the model has always been shown (brain/tool.ts's objectSchema): no properties
 * is an open object; otherwise any property is let through and the required ones are listed. */
export function objectSchema(properties: Record<string, JsonSchema> = {}, ...required: string[]): JsonSchema {
  if (Object.keys(properties).length === 0) return { type: "object", properties: {} };
  return { type: "object", properties, additionalProperties: true, ...(required.length > 0 ? { required } : {}) };
}

/** A Struct's JSON Schema in objectSchema's shape and key order: integers without the safe bounds Schema adds, numbers
 * without the non-finite strings, enums as strings. The bytes lead every request, so a change here changes the prompt. */
export function parametersOf(parameters: Schema.Struct<Schema.Struct.Fields>): JsonSchema {
  return Object.keys(parameters.fields).length === 0 ? objectSchema() : shaped(Schema.toJsonSchemaDocument(parameters).schema);
}

/** A nested schema: an object, not a tuple's array of them. */
const isSchema = (v: unknown): v is JsonSchema => typeof v === "object" && v !== null && !Array.isArray(v);

/** A JSON object whose fields can be set: an argument being coerced. */
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const propertiesOf = (schema: JsonSchema): Record<string, JsonSchema> =>
  isSchema(schema.properties) ? Object.fromEntries(Object.entries(schema.properties).filter((e): e is [string, JsonSchema] => isSchema(e[1]))) : {};
const requiredOf = (schema: JsonSchema): string[] => (Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);

function shaped(node: JsonSchema): JsonSchema {
  if (Array.isArray(node.anyOf) && node.anyOf.some((n: JsonSchema) => n.type === "number")) return { type: "number" };
  // One literal comes as a union of one.
  if (Array.isArray(node.anyOf) && node.anyOf.length === 1 && isSchema(node.anyOf[0])) return shaped(node.anyOf[0]);
  switch (node.type) {
    case "object": {
      const out = Object.fromEntries(Object.entries(propertiesOf(node)).map(([name, p]) => [name, shaped(p)]));
      return objectSchema(out, ...requiredOf(node));
    }
    case "array":
      return { type: "array", items: shaped(isSchema(node.items) ? node.items : {}) };
    case "string":
      return Array.isArray(node.enum) ? { type: "string", enum: node.enum } : { type: "string" };
    case "integer":
    case "number":
    case "boolean":
      return { type: node.type };
    default:
      throw new Error(`a tool parameter the model is not shown: ${JSON.stringify(node)}`);
  }
}

/** A model's arguments as pi-ai's validateToolArguments leaves them before checking: a null on an optional field the
 * schema does not allow null for is no field, and a value of another JSON type becomes the schema's where it reads as
 * one ("10" for 10, true for 1, 3 for "3", "true" or 1 for true; a required string's null is ""). */
export function coerceArguments(args: unknown, schema: JsonSchema): unknown {
  const copy: unknown = structuredClone(args);
  dropOptionalNulls(copy, schema);
  return coerce(copy, schema);
}

const typesOf = (schema: JsonSchema): string[] =>
  typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === "string") : [];

function dropOptionalNulls(value: unknown, schema: JsonSchema): void {
  if (Array.isArray(value)) {
    const items = schema.items;
    if (isSchema(items)) for (const v of value) dropOptionalNulls(v, items);
    return;
  }
  if (!isObject(value) || !isSchema(schema.properties)) return;
  const object = value;
  const required = new Set(requiredOf(schema));
  for (const [key, p] of Object.entries(propertiesOf(schema))) {
    if (!(key in object)) continue;
    if (object[key] === null && !required.has(key) && !typesOf(p).includes("null")) delete object[key];
    else dropOptionalNulls(object[key], p);
  }
}

function matches(value: unknown, type: string): boolean {
  switch (type) {
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "string":
      return typeof value === "string";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return Predicate.isObject(value);
    default:
      return false;
  }
}

function primitive(value: unknown, type: string): unknown {
  switch (type) {
    case "number":
    case "integer": {
      if (value === null) return 0;
      if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        if (type === "number" ? Number.isFinite(n) : Number.isInteger(n)) return n;
      }
      if (typeof value === "boolean") return value ? 1 : 0;
      return value;
    }
    case "boolean":
      if (value === null) return false;
      if (value === "true" || value === 1) return true;
      if (value === "false" || value === 0) return false;
      return value;
    case "string":
      if (value === null) return "";
      return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
    case "null":
      return value === "" || value === 0 || value === false ? null : value;
    default:
      return value;
  }
}

function coerce(value: unknown, schema: JsonSchema): unknown {
  let next = value;
  const types = typesOf(schema);
  if (types.length > 0 && !(types.length > 1 && types.some((t) => matches(next, t))))
    for (const t of types) {
      const candidate = primitive(next, t);
      if (candidate !== next) {
        next = candidate;
        break;
      }
    }
  if (types.includes("object") && matches(next, "object") && isObject(next)) {
    const object = next;
    for (const [key, p] of Object.entries(propertiesOf(schema))) if (key in object) object[key] = coerce(object[key], p);
  }
  const items = schema.items;
  if (types.includes("array") && Array.isArray(next) && isSchema(items)) {
    for (let i = 0; i < next.length; i++) next[i] = coerce(next[i], items);
  }
  return next;
}

/** A model's arguments for a tool as pi-ai's validateToolArguments takes them: coerced, or refused in its words, a line
 * a problem and then the arguments as they came (the model reads it, and its next call goes by it). */
export function toolArguments(name: string, args: unknown, schema: JsonSchema): { readonly ok: unknown } | { readonly refused: string } {
  const coerced = coerceArguments(args, schema);
  const problems = problemsOf(coerced, schema, "");
  if (problems.length === 0) return { ok: coerced };
  return {
    refused: `Validation failed for tool "${name}":\n${problems.map((p) => `  - ${p}`).join("\n")}\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`,
  };
}

const at = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

/** TypeBox's messages, for the JSON Schema parametersOf writes: types, required properties, enums, nested. */
function problemsOf(value: unknown, schema: JsonSchema, path: string): string[] {
  const types = typesOf(schema);
  if (types.length > 0 && !types.some((t) => matches(value, t))) return [`${path || "root"}: must be ${types.join(",")}`];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return [`${path || "root"}: must be equal to one of the allowed values`];
  if (matches(value, "object") && isObject(value) && isSchema(schema.properties)) {
    const object = value;
    const missing = requiredOf(schema).filter((k) => !(k in object));
    if (missing.length > 0) return [`${at(path, missing[0]!)}: must have required properties ${missing.join(", ")}`];
    return Object.entries(propertiesOf(schema)).flatMap(([k, p]) => (k in object ? problemsOf(object[k], p, at(path, k)) : []));
  }
  const items = schema.items;
  if (Array.isArray(value) && isSchema(items)) return value.flatMap((v, i) => problemsOf(v, items, at(path, i)));
  return [];
}
