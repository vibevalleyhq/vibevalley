import { existsSync, readdirSync, readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";
import { z } from "zod";

import { programOf } from "@vibevalley/testkit/source";

import * as S from "./schema";

interface TypeNode {
  readonly type: string;
  readonly [key: string]: unknown;
}

interface Shape {
  readonly keys: string[];
  readonly parent?: string;
  /** Keys of the parent left out (`extends Omit<Parent, "a" | "b">`). */
  readonly omit?: readonly string[];
  /** The members whose type is an object type written in place, by key: their own keys are checked too. */
  readonly nested: Map<string, Shape>;
}

/** A member list's keys, and the object types written in place among them. */
function shapeOf(members: readonly TypeNode[], parent?: string, omit?: readonly string[]): Shape {
  const keys: string[] = [];
  const nested = new Map<string, Shape>();
  for (const m of members) {
    const key = m.type === "TSPropertySignature" ? (m.key as TypeNode) : undefined;
    const name = key?.type === "Identifier" ? (key.name as string) : key?.type === "Literal" ? (key.value as string) : undefined;
    if (name === undefined) continue;
    keys.push(name);
    const literal = (m.typeAnnotation as TypeNode | null)?.typeAnnotation as TypeNode | undefined;
    if (literal?.type === "TSTypeLiteral") nested.set(name, shapeOf(literal.members as TypeNode[]));
  }
  return { keys, nested, ...(parent ? { parent } : {}), ...(omit ? { omit } : {}) };
}

/** Each exported interface or object type, read from the syntax tree: its own keys, its nested object types, the interface it extends. */
function interfaces(path: string, source: string): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const statement of (programOf(path, source).body as TypeNode[] | undefined) ?? []) {
    const d = statement.type === "ExportNamedDeclaration" ? (statement.declaration as TypeNode | null) : undefined;
    const literal = d?.type === "TSTypeAliasDeclaration" ? (d.typeAnnotation as TypeNode) : undefined;
    if (literal?.type === "TSTypeLiteral") {
      out.set((d!.id as TypeNode).name as string, shapeOf(literal.members as TypeNode[]));
      continue;
    }
    if (d?.type !== "TSInterfaceDeclaration") continue;
    const heritage = (d.extends as TypeNode[] | undefined)?.[0];
    let parent = (heritage?.expression as TypeNode | undefined)?.name as string | undefined;
    let omit: string[] | undefined;
    if (parent === "Omit") {
      const [base, keys] = ((heritage!.typeArguments as TypeNode | undefined)?.params as TypeNode[] | undefined) ?? [];
      parent = (base?.typeName as TypeNode | undefined)?.name as string | undefined;
      const literals = keys?.type === "TSUnionType" ? (keys.types as TypeNode[]) : keys ? [keys] : [];
      omit = literals.map((l) => ((l.literal as TypeNode | undefined)?.value as string | undefined) ?? "");
    }
    out.set((d.id as TypeNode).name as string, shapeOf((d.body as TypeNode).body as TypeNode[], parent, omit));
  }
  return out;
}

/** A struct's Schema, through an optional key or a null. */
const objectOf = (s: unknown): z.ZodObject | undefined =>
  s instanceof z.ZodObject ? s : s instanceof z.ZodExactOptional || s instanceof z.ZodOptional || s instanceof z.ZodNullable ? objectOf(s.unwrap()) : undefined;

/** Where want and the schema's keys differ, nested object types included, each as path: lacks/extra. */
function differences(at: string, want: readonly string[], nested: Map<string, Shape>, schema: z.ZodObject): string[] {
  const have = new Set(Object.keys(schema.shape));
  const missing = want.filter((k) => !have.has(k));
  const extra = [...have].filter((k) => !want.includes(k));
  const out = missing.length + extra.length > 0 ? [`${at}: schema lacks [${missing.join(", ")}], has extra [${extra.join(", ")}]`] : [];
  for (const [key, shape] of nested) {
    const inner = objectOf(schema.shape[key]);
    out.push(...(inner ? differences(`${at}.${key}`, shape.keys, shape.nested, inner) : [`${at}.${key}: the schema's is not a struct`]));
  }
  return out;
}

test("every struct Schema has the keys of its shape, nested object types too", () => {
  // Each concept's shapes (the ones written from the Rust contract and the few kept here), read as one: an interface may
  // extend one in another concept.
  const files = readdirSync(new URL("./", import.meta.url), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => [`./${d.name}/shapes.gen.ts`, `./${d.name}/shapes.ts`].map((f) => new URL(f, import.meta.url)))
    .filter((f) => existsSync(f));
  const shapes = new Map(files.flatMap((f) => [...interfaces(f.pathname, readFileSync(f, "utf8"))]));
  const keysOf = (name: string): string[] => {
    const s = shapes.get(name)!;
    const inherited = s.parent && shapes.has(s.parent) ? keysOf(s.parent).filter((k) => s.omit?.includes(k) !== true) : [];
    return [...inherited, ...s.keys.filter((k) => !inherited.includes(k))];
  };
  const differ: string[] = [];
  let compared = 0;
  for (const [name, schema] of Object.entries(S)) {
    if (!(schema instanceof z.ZodObject) || !shapes.has(name)) continue;
    compared++;
    differ.push(...differences(name, keysOf(name), shapes.get(name)!.nested, schema));
  }
  expect(compared).toBeGreaterThan(150);
  expect(differ).toEqual([]);
});

test("a length counted in code points is told to a model's JSON Schema, and an emoji is one character", () => {
  const prompt = S.MediaImageRequest.shape.prompt;
  expect(z.toJSONSchema(prompt, { io: "input" })).toMatchObject({ type: "string", minLength: 1, maxLength: 4000 });
  expect(prompt.safeParse("😀".repeat(4000)).success).toBe(true);
  expect(prompt.safeParse("a".repeat(4001)).success).toBe(false);
});

test("SliceBundle parses every exported Rust scenario fixture", () => {
  const scenariosDir = new URL("../../../apps/mac/ui/fixtures/scenarios/", import.meta.url);
  const dirs = readdirSync(scenariosDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .toSorted();
  expect(dirs).toEqual(["dense", "edge", "empty", "extreme", "minimal", "typical"]);
  for (const name of dirs) {
    const raw: unknown = JSON.parse(readFileSync(new URL(`./${name}/state.json`, scenariosDir), "utf8"));
    const bundle = S.SliceBundle.parse(raw);
    expect(bundle.seq).toBeGreaterThanOrEqual(0);
    expect(bundle.board.seq).toBe(bundle.seq);
    expect(bundle.sessions.seq).toBe(bundle.seq);
    expect(bundle.collab.seq).toBe(bundle.seq);
    expect(bundle.inbox.seq).toBe(bundle.seq);
    expect(bundle.ops.seq).toBe(bundle.seq);
    expect(bundle.farm.seq).toBe(bundle.seq);
  }
});

test("Host frame and action codecs parse every Rust golden sample", () => {
  const raw = JSON.parse(readFileSync(new URL("../../../crates/protocol/golden/schema/host.json", import.meta.url), "utf8")) as Record<
    string,
    readonly unknown[]
  >;
  const schemas = new Map<string, z.ZodType>();
  for (const [k, v] of Object.entries(S)) if (v instanceof z.ZodType) schemas.set(k, v);
  let checked = 0;
  for (const [name, samples] of Object.entries(raw)) {
    const codec = schemas.get(name);
    expect(codec, `missing schema export ${name}`).toBeDefined();
    for (const sample of samples) {
      codec!.parse(sample);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(25);
});

test("DebugKit codecs parse every Rust golden sample", () => {
  const raw = JSON.parse(readFileSync(new URL("../../../crates/protocol/golden/schema/debug.json", import.meta.url), "utf8")) as Record<
    string,
    readonly unknown[]
  >;
  const schemas = new Map<string, z.ZodType>();
  for (const [k, v] of Object.entries(S)) if (v instanceof z.ZodType) schemas.set(k, v);
  let checked = 0;
  for (const [name, samples] of Object.entries(raw)) {
    const codec = schemas.get(name);
    expect(codec, `missing schema export ${name}`).toBeDefined();
    for (const sample of samples) {
      codec!.parse(sample);
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(20);
});
