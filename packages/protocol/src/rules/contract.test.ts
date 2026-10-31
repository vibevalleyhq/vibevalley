// protocol is the contract: a rule here is one the page runs too. A rule only the server runs belongs to its module in
// apps/server/src, so every export here is imported outside the server, or used by one that is.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { edgesOf, exportsOf } from "@vibevalley/testkit/source";

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
  for (const p of outside.flatMap((d) => files(join(root, d))))
    for (const e of edgesOf(p, readFileSync(p, "utf8"))) if (e.from === "@vibevalley/protocol/rules") for (const n of e.names) used.add(n);
  // Used by another rule here: imported from its file.
  for (const [f, body] of bodies)
    for (const e of edgesOf(f, body))
      if (e.from.startsWith("./") && e.from.replace(/^\.\//u, "").replace(/\.ts$/u, "") !== f.replace(/\.ts$/u, "")) for (const n of e.names) used.add(n);
  const unused: string[] = [];
  for (const [f, body] of bodies) {
    const own = exportsOf(f, body);
    for (const name of own) {
      // Or used by its own file, beside its declaration.
      const here = [...body.matchAll(new RegExp(`\\b${name}\\b`, "gu"))].length;
      if (!used.has(name) && here < 2) unused.push(`${f}: ${name}`);
    }
  }
  expect(
    unused,
    "packages/protocol/src/rules holds only what the page and the server both run. Fix: a rule only the server runs moves into the module that owns it in apps/server/src, and its conclusion goes into the frame. See docs/subsystems/foundation.md",
  ).toEqual([]);
});
