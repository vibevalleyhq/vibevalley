// protocol is the contract: a rule here is one the page runs too. A rule only the server runs belongs to its module in
// apps/server/src, so every export here is imported outside the server, or used by one that is.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

const root = join(import.meta.dirname, "../../../..");
const here = import.meta.dirname;
/** What runs beside the server: the page and the shells around it. */
const outside = ["apps/web/src", "apps/web/test", "apps/mobile/src", "apps/desktop/src", "packages/engine/src"];

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((f) => {
    const p = join(dir, f);
    if (f === "node_modules") return [];
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/u.test(f) ? [p] : [];
  });
}

test("every rule here is one the page uses", () => {
  const rules = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "index.ts");
  const bodies = new Map(rules.map((f) => [f, readFileSync(join(here, f), "utf8")]));
  const used = new Set<string>();
  for (const p of outside.flatMap((d) => files(join(root, d)))) {
    for (const m of readFileSync(p, "utf8").matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@vibevalley\/protocol\/rules"/gu))
      for (const n of m[1]!.split(",")) used.add(n.replace("type ", "").trim());
  }
  const unused: string[] = [];
  for (const [f, body] of bodies) {
    for (const m of body.matchAll(/^export (?:const|function|class|type|interface) (\w+)/gmu)) {
      const name = m[1]!;
      // Used by another rule here: its own declaration aside.
      const rest = [...bodies].map(([g, b]) => (g === f ? b.replace(m[0], "") : b)).join("\n");
      if (!used.has(name) && !new RegExp(`\\b${name}\\b`, "u").test(rest)) unused.push(`${f}: ${name}`);
    }
  }
  expect(unused).toEqual([]);
});
