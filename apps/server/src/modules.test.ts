// The modules' boundary (modules.ts): every folder and file under src/ is part of one module, no module imports one
// after it, and none reads another's part of the core state: it asks that module. A test may use any module; so may the
// test farm (testing/, flows/).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { calls, edgesOf, readsOf } from "@vibevalley/testkit/source";

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
const reads: Readonly<Record<string, string>> = {
  "mailbox/mailbox.ts -> issues": "Tier 1 issue reservoir checks the issue's stage and assigned agent synchronously without keeping a second copy of the board",
};

/** What a file imports from under src, type-only imports too (they tie the modules all the same), as paths from src. */
const localEdges = (file: string, source = readFileSync(file, "utf8")) =>
  edgesOf(file, source).flatMap(({ from: spec }) =>
    spec.startsWith("#/") ? [normalize(spec.slice(2))] : spec.startsWith("./") || spec.startsWith("../") ? [rel(normalize(join(dirname(file), spec)))] : [],
  );

const readsSessionSnapshot = (file: string, source: string) => calls(file, source, "core", "state") && localEdges(file, source).includes("session/roster.ts");

/** The read projections a module takes from another module's tables, by the table's generated file: each a query it
 * only reads with, named, never a whole file. Writes stay with the table's module. */
const foreignReads: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  mailbox: { "channel.sql.ts": ["defaultID", "orchestratorForChannel", "inboxOf"], "issue.sql.ts": ["issueExists"] },
  inbox: { "channel_message.sql.ts": ["messageByID", "notificationReceipt", "ownerReadReports"] },
};

/** The module a table's generated file belongs to: the table's name is <module> or <module>_<concept>. */
const tableModule = (name: string) => {
  const table = name.replace(/\.sql\.ts$/u, "");
  return readdirSync(src).find((m) => table === m || table.startsWith(`${m}_`));
};

const foreignQueries = (file: string, source: string) => {
  const module = rel(file).split("/")[0]!;
  return edgesOf(file, source).flatMap((edge) => {
    if (!edge.from.startsWith("#db/")) return [];
    const name = edge.from.split("/").at(-1) ?? "";
    if (name === "types.ts" || tableModule(name) === module) return [];
    const allowed = foreignReads[module]?.[name] ?? [];
    return edge.names.filter((symbol) => !allowed.includes(symbol)).map((symbol) => `${name}:${symbol}`);
  });
};

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
      for (const to of localEdges(file)) if (moduleOf(to) !== moduleOf(from) && rank(to) > rank(from)) found.push(`${from} -> ${to}`);
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

  it("use only their own tables' queries, besides named read projections", () => {
    const found = files(src)
      .filter((file) => !file.endsWith(".test.ts") && !outside.includes(rel(file).split("/")[0]!))
      .flatMap((file) => foreignQueries(file, readFileSync(file, "utf8")).map((query) => `${rel(file)} -> ${query}`));
    expect(
      found,
      "a module imports another module's table queries, so it writes (or reads beyond what was named) under that module. Fix: call that module's service, or name the read in foreignReads; writes stay with the table's module. See docs/subsystems/foundation.md",
    ).toEqual([]);
  });

  it("regression: namespace imports and foreign writes cannot hide behind a read projection", () => {
    const file = join(src, "mailbox/mailbox.ts");
    expect(foreignQueries(file, 'import { orchestratorForChannel as route } from "#db/channel.sql.ts";')).toEqual([]);
    expect(foreignQueries(file, 'import * as q from "#db/channel.sql.ts";')).toEqual(["channel.sql.ts:*"]);
    expect(foreignQueries(file, 'import { setOrchestrator } from "#db/channel.sql.ts";')).toEqual(["channel.sql.ts:setOrchestrator"]);
    expect(foreignQueries(file, 'export * from "#db/issue_assignment.sql.ts";')).toEqual(["issue_assignment.sql.ts:*"]);
    expect(foreignQueries(join(src, "ingress/ingress.ts"), 'import { recordTrigger } from "#db/mailbox_trigger.sql.ts";')).toEqual([
      "mailbox_trigger.sql.ts:recordTrigger",
    ]);
  });

  it("keep base pure: it imports nothing else under src", () => {
    const found: string[] = [];
    for (const file of files(join(src, "base"))) {
      const from = rel(file);
      for (const to of localEdges(file)) if (to.split("/")[0] !== "base") found.push(`${from} -> ${to}`);
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
      const parts = readsOf(file, text, "core", "state");
      if (calls(file, text, "core", "session")) parts.push("sessions");
      if (readsSessionSnapshot(file, text)) parts.push("sessions");
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

  it("regression: session snapshot helpers cannot hide a service's cross-module read", () => {
    const file = join(src, "issue/issue.ts");
    expect(readsSessionSnapshot(file, 'import { sessionOf } from "#/session/roster.ts"; const state = core.state(); sessionOf(state, id);')).toBe(true);
    expect(readsSessionSnapshot(file, 'import { sessionOf } from "../session/roster.ts"; sessionOf(core.state(), id);')).toBe(true);
    expect(readsSessionSnapshot(file, 'import { sessionOf } from "#/session/roster.ts"; export const rule = (state, id) => sessionOf(state, id);')).toBe(false);
    expect(readsSessionSnapshot(file, "const state = core.state(); live.sessionOf(id); state.issues.find(item => item.id === id);")).toBe(false);
  });
});
