// Each struct Schema in schema.ts has exactly the keys of its interface in shapes.ts. `Schema.Codec<T.X>` cannot see
// this: an optional key named differently on each side (draft against refining) still compiles, and encoding then
// drops the field from every frame and every state.json read.

import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

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
    if (key?.type !== "Identifier") continue;
    const name = key.name as string;
    keys.push(name);
    const literal = (m.typeAnnotation as TypeNode | null)?.typeAnnotation as TypeNode | undefined;
    if (literal?.type === "TSTypeLiteral") nested.set(name, shapeOf(literal.members as TypeNode[]));
  }
  return { keys, nested, ...(parent ? { parent } : {}), ...(omit ? { omit } : {}) };
}

/** Each exported interface, read from the syntax tree: its own keys, its nested object types, the interface it extends. */
function interfaces(path: string, source: string): Map<string, Shape> {
  const out = new Map<string, Shape>();
  for (const statement of (programOf(path, source).body as TypeNode[] | undefined) ?? []) {
    const d = statement.type === "ExportNamedDeclaration" ? (statement.declaration as TypeNode | null) : undefined;
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

type Ast = { readonly _tag?: string; readonly propertySignatures?: readonly { name: PropertyKey; type: Ast }[]; readonly types?: readonly Ast[] };

/** A struct's AST, through an optional key's union with undefined. */
const objectsOf = (ast: Ast | undefined): Ast | undefined =>
  ast?._tag === "Objects" ? ast : ast?._tag === "Union" ? ast.types?.map(objectsOf).find((a) => a !== undefined) : undefined;

/** Where want and the schema's keys differ, nested object types included, each as path: lacks/extra. */
function differences(at: string, want: readonly string[], nested: Map<string, Shape>, ast: Ast): string[] {
  const have = new Set(ast.propertySignatures!.map((p) => String(p.name)));
  const missing = want.filter((k) => !have.has(k));
  const extra = [...have].filter((k) => !want.includes(k));
  const out = missing.length + extra.length > 0 ? [`${at}: schema lacks [${missing.join(", ")}], has extra [${extra.join(", ")}]`] : [];
  for (const [key, shape] of nested) {
    const inner = objectsOf(ast.propertySignatures!.find((p) => String(p.name) === key)?.type);
    out.push(...(inner ? differences(`${at}.${key}`, shape.keys, shape.nested, inner) : [`${at}.${key}: the schema's is not a struct`]));
  }
  return out;
}

test("every struct Schema has the keys of its shape, nested object types too", () => {
  const path = new URL("./shapes.ts", import.meta.url);
  const shapes = interfaces(path.pathname, readFileSync(path, "utf8"));
  const keysOf = (name: string): string[] => {
    const s = shapes.get(name)!;
    const inherited = s.parent && shapes.has(s.parent) ? keysOf(s.parent).filter((k) => s.omit?.includes(k) !== true) : [];
    return [...inherited, ...s.keys.filter((k) => !inherited.includes(k))];
  };
  const differ: string[] = [];
  let compared = 0;
  for (const [name, schema] of Object.entries(S)) {
    const ast = (schema as { ast?: Ast }).ast;
    if (ast?._tag !== "Objects" || !shapes.has(name)) continue;
    compared++;
    differ.push(...differences(name, keysOf(name), shapes.get(name)!.nested, ast));
  }
  expect(compared).toBeGreaterThan(150);
  expect(differ).toEqual([]);
});
