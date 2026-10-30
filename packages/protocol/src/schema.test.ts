// Each struct Schema in schema.ts has exactly the keys of its interface in shapes.ts. `Schema.Codec<T.X>` cannot see
// this: an optional key named differently on each side (draft against refining) still compiles, and encoding then
// drops the field from every frame and every state.json read.

import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import * as S from "./schema";

/** Each exported interface's own keys (two-space indented members), and the interface it extends, if any. */
function interfaces(source: string): Map<string, { keys: string[]; parent?: string }> {
  const out = new Map<string, { keys: string[]; parent?: string }>();
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = /^export interface (\w+)(?:<[^>]*>)?(?: extends (\w+))? \{/u.exec(lines[i]!);
    if (!head) continue;
    const keys: string[] = [];
    for (i++; i < lines.length && lines[i] !== "}"; i++) {
      const member = /^ {2}(?:readonly )?(\w+)\??:/u.exec(lines[i]!);
      if (member) keys.push(member[1]!);
    }
    out.set(head[1]!, { keys, ...(head[2] ? { parent: head[2] } : {}) });
  }
  return out;
}

test("every struct Schema has the keys of its shape", () => {
  const shapes = interfaces(readFileSync(new URL("./shapes.ts", import.meta.url), "utf8"));
  const keysOf = (name: string): string[] => {
    const s = shapes.get(name)!;
    return [...(s.parent && shapes.has(s.parent) ? keysOf(s.parent) : []), ...s.keys];
  };
  const differ: string[] = [];
  let compared = 0;
  for (const [name, schema] of Object.entries(S)) {
    const ast = (schema as { ast?: { _tag?: string; propertySignatures?: readonly { name: PropertyKey }[] } }).ast;
    if (ast?._tag !== "Objects" || !shapes.has(name)) continue;
    compared++;
    const want = new Set(keysOf(name));
    const have = new Set(ast.propertySignatures!.map((p) => String(p.name)));
    const missing = [...want].filter((k) => !have.has(k));
    const extra = [...have].filter((k) => !want.has(k));
    if (missing.length + extra.length > 0) differ.push(`${name}: schema lacks [${missing.join(", ")}], has extra [${extra.join(", ")}]`);
  }
  expect(compared).toBeGreaterThan(150);
  expect(differ).toEqual([]);
});
