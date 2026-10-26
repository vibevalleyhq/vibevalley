// The modules' boundary (modules.ts): every folder and file under src/ is part of one module, no module imports one
// after it, and none reads another's part of the core state: it asks that module. A test may use any module; so may the
// test farm (testing/, flows/).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { moduleOf, modules, outside } from "./modules.ts";

const src = import.meta.dirname;

/** Imports that still go the wrong way, each with the step of the proposal that removes it; a new one fails, and so does one
 * that is gone and still listed. */
const pending: Readonly<Record<string, string>> = {};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const rel = (p: string) => relative(src, p).split("\\").join("/");
const rank = (path: string) => modules.findIndex((m) => m === moduleOf(path));

/** Whose part of the core state each field is; the call and the orchestrator's state are the core's own. */
const owners: Readonly<Record<string, string>> = {
  sessions: "Agent Sessions",
  chat: "Collaboration",
  issues: "Issues",
  recurrences: "Issues",
  progress: "Gamification",
  commits: "Gamification",
  connectors: "Gateway",
};

/** Reads of another module's part that stay, each with why: none. */
const reads: Readonly<Record<string, string>> = {};

describe("the modules", () => {
  it("hold every folder and file under src", () => {
    const tops = readdirSync(src).filter((f) => statSync(join(src, f)).isDirectory() || (f.endsWith(".ts") && !f.endsWith(".test.ts")));
    expect(tops.filter((t) => !outside.includes(t) && moduleOf(t) === undefined)).toEqual([]);
  });

  it("import only the modules before them", () => {
    const found: string[] = [];
    for (const file of files(src)) {
      const from = rel(file);
      if (from.endsWith(".test.ts") || outside.includes(from.split("/")[0]!)) continue;
      for (const m of readFileSync(file, "utf8").matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
        const to = rel(normalize(join(dirname(file), m[1]!)));
        if (moduleOf(to) !== moduleOf(from) && rank(to) > rank(from)) found.push(`${from} -> ${to}`);
      }
    }
    expect(found.filter((f) => !(f in pending))).toEqual([]);
    expect(Object.keys(pending).filter((p) => !found.includes(p))).toEqual([]);
  });

  it("read only their own part of the core state", () => {
    const found: string[] = [];
    for (const file of files(src)) {
      const from = rel(file);
      const top = from.split("/")[0]!;
      if (from.endsWith(".test.ts") || outside.includes(top) || top === "core" || top === "projection") continue;
      const text = readFileSync(file, "utf8");
      const parts = [...text.matchAll(/core\.state\(\)\??\.(\w+)/g)].map((m) => m[1]!);
      if (/core\.session\(/.test(text)) parts.push("sessions");
      for (const part of new Set(parts)) {
        const owner = owners[part];
        if (owner && owner !== moduleOf(from)?.name) found.push(`${from} -> ${part}`);
      }
    }
    expect(found.filter((f) => !(f in reads))).toEqual([]);
    expect(Object.keys(reads).filter((r) => !found.includes(r))).toEqual([]);
  });
});
