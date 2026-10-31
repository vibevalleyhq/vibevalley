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
  crons: "Issues",
  progress: "Gamification",
  commits: "Gamification",
  connectors: "Gateway",
};

/** Reads of another module's part that stay, each with why: none. */
const reads: Readonly<Record<string, string>> = {};

describe("the modules", () => {
  it("hold every folder and file under src", () => {
    const tops = readdirSync(src).filter((f) => statSync(join(src, f)).isDirectory() || (f.endsWith(".ts") && !f.endsWith(".test.ts")));
    expect(
      tops.filter((t) => !outside.includes(t) && moduleOf(t) === undefined),
      "a folder or file under src/ belongs to no module, so nothing says what it may import. Fix: move it into the module whose concept it is, or add it to that module's folders in modules.ts. See apps/server/src/modules.ts",
    ).toEqual([]);
  });

  it("import only the modules before them", () => {
    const found: string[] = [];
    for (const file of files(src)) {
      const from = rel(file);
      if (from.endsWith(".test.ts") || outside.includes(from.split("/")[0]!)) continue;
      for (const m of readFileSync(file, "utf8").matchAll(/from\s+"((?:\.{1,2}|@)\/[^"]+)"/gu)) {
        const spec = m[1]!;
        const to = spec.startsWith("@/") ? normalize(spec.slice(2)) : rel(normalize(join(dirname(file), spec)));
        if (moduleOf(to) !== moduleOf(from) && rank(to) > rank(from)) found.push(`${from} -> ${to}`);
      }
    }
    expect(
      found.filter((f) => !(f in pending)),
      "a module imports one after it in modules.ts, so the two lean on each other. Fix: move what both need into the earlier module (or base), or have the later one hand it down as a Stream; a shape they share lives in the module that defines it. See docs/architecture.md",
    ).toEqual([]);
    expect(
      Object.keys(pending).filter((p) => !found.includes(p)),
      "an import listed in pending is gone. Fix: drop it from pending. See apps/server/src/modules.test.ts",
    ).toEqual([]);
  });

  it("keep base pure: it imports nothing else under src", () => {
    const found: string[] = [];
    for (const file of files(join(src, "base"))) {
      const from = rel(file);
      for (const m of readFileSync(file, "utf8").matchAll(/from\s+"((?:\.{1,2}|@)\/[^"]+)"/gu)) {
        const spec = m[1]!;
        const to = spec.startsWith("@/") ? normalize(spec.slice(2)) : rel(normalize(join(dirname(file), spec)));
        if (to.split("/")[0] !== "base") found.push(`${from} -> ${to}`);
      }
    }
    expect(
      found,
      "a file in base imports something else under src, so the pure ground leans on what talks to the outside. Fix: move the file to infra (or the module it serves), or move what it needs down into base. See apps/server/src/modules.ts",
    ).toEqual([]);
  });

  it("read only their own part of the core state", () => {
    const found: string[] = [];
    for (const file of files(src)) {
      const from = rel(file);
      const top = from.split("/")[0]!;
      if (from.endsWith(".test.ts") || outside.includes(top) || top === "core" || top === "projection") continue;
      const text = readFileSync(file, "utf8");
      const parts = [...text.matchAll(/core\.state\(\)\??\.(\w+)/gu)].map((m) => m[1]!);
      if (/core\.session\(/u.test(text)) parts.push("sessions");
      for (const part of new Set(parts)) {
        const owner = owners[part];
        if (owner && owner !== moduleOf(from)?.name) found.push(`${from} -> ${part}`);
      }
    }
    expect(
      found.filter((f) => !(f in reads)),
      "a module reads another's part of the core state, so the owner's rules are skipped. Fix: ask the owning module's service for it (a method or a Stream), and keep core.state() reads to the module that owns the field. See docs/subsystems/core.md",
    ).toEqual([]);
    expect(
      Object.keys(reads).filter((r) => !found.includes(r)),
      "a read listed in reads is gone. Fix: drop it from reads. See apps/server/src/modules.test.ts",
    ).toEqual([]);
  });
});
