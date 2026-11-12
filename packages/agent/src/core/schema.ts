import { z } from "zod";

import { isRecord, jsonText } from "../base/json.ts";

export type JsonSchema = Readonly<Record<string, unknown>>;

/** An object's parameters in the shape the model has always been shown: no properties is an open object. */
export function objectSchema(properties: Record<string, JsonSchema> = {}, ...required: string[]): JsonSchema {
  if (Object.keys(properties).length === 0) return { type: "object", properties: {} };
  return { type: "object", properties, additionalProperties: true, ...(required.length > 0 ? { required } : {}) };
}

/** An object Schema's JSON Schema in objectSchema's shape and key order. The bytes lead every request, so a change here changes the prompt. */
export function parametersOf(parameters: z.ZodObject): JsonSchema {
  return Object.keys(parameters.shape).length === 0 ? objectSchema() : shaped(z.toJSONSchema(parameters, { io: "input" }));
}

const propertiesOf = (schema: JsonSchema): Record<string, JsonSchema> =>
  isRecord(schema.properties) ? Object.fromEntries(Object.entries(schema.properties).filter((e): e is [string, JsonSchema] => isRecord(e[1]))) : {};
const requiredOf = (schema: JsonSchema): string[] => (Array.isArray(schema.required) ? schema.required.filter((k): k is string => typeof k === "string") : []);

function shaped(node: JsonSchema): JsonSchema {
  if (Array.isArray(node.anyOf) && node.anyOf.some((n: JsonSchema) => n.type === "number")) return { type: "number" };
  // One literal comes as a union of one.
  if (Array.isArray(node.anyOf) && node.anyOf.length === 1 && isRecord(node.anyOf[0])) return shaped(node.anyOf[0]);
  switch (node.type) {
    case "object": {
      const out = Object.fromEntries(Object.entries(propertiesOf(node)).map(([name, p]) => [name, shaped(p)]));
      return objectSchema(out, ...requiredOf(node));
    }
    case "array":
      return { type: "array", items: shaped(isRecord(node.items) ? node.items : {}) };
    case "string":
      // One literal is Zod's const: shown as an enum of one.
      return Array.isArray(node.enum)
        ? { type: "string", enum: node.enum }
        : node.const !== undefined
          ? { type: "string", enum: [node.const] }
          : { type: "string" };
    case "integer":
    case "number":
    case "boolean":
      return { type: node.type };
    default:
      throw new Error(`a tool parameter the model is not shown: ${jsonText(node)}`);
  }
}

/** A model's arguments as pi-ai's validateToolArguments leaves them before checking. a required string's null is ""). */
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
    if (isRecord(items)) for (const v of value) dropOptionalNulls(v, items);
    return;
  }
  if (!isRecord(value) || !isRecord(schema.properties)) return;
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
      return isRecord(value);
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
  if (types.includes("object") && matches(next, "object") && isRecord(next)) {
    const object = next;
    for (const [key, p] of Object.entries(propertiesOf(schema))) if (key in object) object[key] = coerce(object[key], p);
  }
  const items = schema.items;
  if (types.includes("array") && Array.isArray(next) && isRecord(items)) {
    for (let i = 0; i < next.length; i++) next[i] = coerce(next[i], items);
  }
  return next;
}
