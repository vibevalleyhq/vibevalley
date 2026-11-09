import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { analyzeSource, type Edge } from "@vibevalley/testkit/source";

import { moduleOf, modules, outside } from "./modules.ts";

const src = import.meta.dirname;
const pending: Readonly<Record<string, string>> = {};

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const rel = (p: string) => relative(src, p).split("\\").join("/");
const rank = (path: string) => modules.findIndex((m) => m === moduleOf(path));
const owners: Readonly<Record<string, string>> = {
  sessions: "Agent Sessions",
  chat: "Collaboration",
  issues: "Issues",
  crons: "Issues",
  progress: "Gamification",
  commits: "Gamification",
  connectors: "Gateway",
};
const reads: Readonly<Record<string, string>> = {
  "mailbox/mailbox.ts -> issues": "Tier 1 issue reservoir checks the issue's stage and assigned agent synchronously without keeping a second copy of the board",
};

const localEdges = (file: string, edges: readonly Edge[]) =>
  edges.flatMap(({ from: spec }) =>
    spec.startsWith("#/") ? [normalize(spec.slice(2))] : spec.startsWith("./") || spec.startsWith("../") ? [rel(normalize(join(dirname(file), spec)))] : [],
  );

function inspect(file: string, text: string) {
  const source = analyzeSource(file, text);
  const local = localEdges(file, source.edges);
  const sessionSnapshot = source.calls("core", "state") && local.includes("session/roster.ts");
  const parts = source.reads("core", "state");
  if (source.calls("core", "session") || sessionSnapshot) parts.push("sessions");
  return { file, from: rel(file), edges: source.edges, local, parts: [...new Set(parts)], sessionSnapshot };
}

// Built inside the first check, so its time includes reading and parsing, not hidden in test collection.
let snapshot: ReturnType<typeof inspect>[] | undefined;
const sources = () =>
  (snapshot ??= files(src)
    .filter((file) => !file.endsWith(".test.ts") && !outside.includes(rel(file).split("/")[0]!))
    .map((file) => inspect(file, readFileSync(file, "utf8"))));

const foreignReads: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  mailbox: { "channel.sql.ts": ["defaultID", "topPlace", "unreadOf"], "channel_member.sql.ts": ["membersOf"], "issue.sql.ts": ["issueExists"] },
  inbox: { "channel_message.sql.ts": ["messageByID", "notificationReceipt", "ownerReadReports"] },
};
const folders = readdirSync(src).filter((name) => statSync(join(src, name)).isDirectory());
const tableModule = (name: string) => {
  const table = name.replace(/\.sql\.ts$/u, "");
  return folders.find((module) => table === module || table.startsWith(`${module}_`));
};
const foreignQueries = (file: string, edges: readonly Edge[]) => {
  const module = rel(file).split("/")[0]!;
  return edges.flatMap((edge) => {
    if (!edge.from.startsWith("#db/")) return [];
    const name = edge.from.split("/").at(-1) ?? "";
    if (name === "types.ts" || tableModule(name) === module) return [];
    const allowed = foreignReads[module]?.[name] ?? [];
    return edge.names.filter((symbol) => !allowed.includes(symbol)).map((symbol) => `${name}:${symbol}`);
  });
};

const mailboxContracts = new Set(["mailbox/envelope.ts", "mailbox/payload.ts", "mailbox/prompts.ts"]);
const mailboxLeaks = (source: ReturnType<typeof inspect>) => {
  const privateImports = source.local.filter(
    (to) => !source.from.startsWith("mailbox/") && to.startsWith("mailbox/") && to !== "mailbox/mailbox.ts" && !mailboxContracts.has(to),
  );
  if (mailboxContracts.has(source.from)) {
    privateImports.push(...source.local.filter((to) => !to.startsWith("base/") && !mailboxContracts.has(to)));
    privateImports.push(...source.edges.filter((edge) => edge.from.startsWith("#db/")).map((edge) => edge.from));
  }
  return privateImports;
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
    const found = sources().flatMap(({ from, local }) =>
      local.filter((to) => moduleOf(to) !== moduleOf(from) && rank(to) > rank(from)).map((to) => `${from} -> ${to}`),
    );
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
    const found = sources().flatMap(({ file, from, edges }) => foreignQueries(file, edges).map((query) => `${from} -> ${query}`));
    expect(
      found,
      "a module imports another module's table queries, so it writes (or reads beyond what was named) under that module. Fix: call that module's service, or name the read in foreignReads; writes stay with the table's module. See docs/subsystems/foundation.md",
    ).toEqual([]);
  });

  it("regression: namespace imports and foreign writes cannot hide behind a read projection", () => {
    const file = join(src, "mailbox/mailbox.ts");
    const queries = (text: string) => foreignQueries(file, inspect(file, text).edges);
    expect(queries('import { topPlace as route } from "#db/channel.sql.ts";')).toEqual([]);
    expect(queries('import * as q from "#db/channel.sql.ts";')).toEqual(["channel.sql.ts:*"]);
    expect(queries('import { renameChannel } from "#db/channel.sql.ts";')).toEqual(["channel.sql.ts:renameChannel"]);
    expect(queries('export * from "#db/issue_assignment.sql.ts";')).toEqual(["issue_assignment.sql.ts:*"]);
    const ingress = join(src, "ingress/ingress.ts");
    expect(foreignQueries(ingress, inspect(ingress, 'import { recordTrigger } from "#db/mailbox_trigger.sql.ts";').edges)).toEqual([
      "mailbox_trigger.sql.ts:recordTrigger",
    ]);
  });

  it("keep base pure: it imports nothing else under src", () => {
    const base = sources().filter(({ from }) => from.startsWith("base/"));
    const tests = files(join(src, "base"))
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => inspect(file, readFileSync(file, "utf8")));
    const found = [...base, ...tests].flatMap(({ from, local }) => local.filter((to) => to.split("/")[0] !== "base").map((to) => `${from} -> ${to}`));
    expect(
      found,
      "a file in base imports something else under src, so the pure ground leans on what talks to the outside. Fix: move the file to infra (or the module it serves), or move what it needs down into base. See apps/server/src/modules.ts",
    ).toEqual([]);
  });

  it("read only their own part of the core state", () => {
    const found = sources().flatMap(({ from, parts }) => {
      const top = from.split("/")[0];
      if (top === "core" || top === "projection") return [];
      return parts.filter((part) => owners[part] !== undefined && owners[part] !== moduleOf(from)?.name).map((part) => `${from} -> ${part}`);
    });
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
    const readsSessionSnapshot = (text: string) => inspect(file, text).sessionSnapshot;
    expect(readsSessionSnapshot('import { sessionOf } from "#/session/roster.ts"; const state = core.state(); sessionOf(state, id);')).toBe(true);
    expect(readsSessionSnapshot('import { sessionOf } from "../session/roster.ts"; sessionOf(core.state(), id);')).toBe(true);
    expect(readsSessionSnapshot('import { sessionOf } from "#/session/roster.ts"; export const rule = (state, id) => sessionOf(state, id);')).toBe(false);
    expect(readsSessionSnapshot("const state = core.state(); live.sessionOf(id); state.issues.find(item => item.id === id);")).toBe(false);
  });

  it("keep mailbox persistence behind its service, not its shared contracts", () => {
    const found = sources().flatMap((source) => mailboxLeaks(source).map((to) => `${source.from} -> ${to}`));
    expect(
      found,
      "Mailbox storage leaked through an internal import or a shared contract. Fix: call Mailbox; keep payload, envelope and prompts free of storage imports. See docs/subsystems/mailbox.md",
    ).toEqual([]);
  });

  it("regression: a mailbox helper or re-export cannot bypass its service", () => {
    const channel = join(src, "channel/writing.ts");
    expect(mailboxLeaks(inspect(channel, 'import { Mailbox } from "#/mailbox/mailbox.ts";'))).toEqual([]);
    expect(mailboxLeaks(inspect(channel, 'import { triggerOf } from "#/mailbox/payload.ts";'))).toEqual([]);
    expect(mailboxLeaks(inspect(channel, 'export * from "../mailbox/triggers.ts";'))).toEqual(["mailbox/triggers.ts"]);
    expect(mailboxLeaks(inspect(channel, 'const journal = import("#/mailbox/triggers.ts");'))).toEqual(["mailbox/triggers.ts"]);
    const payload = join(src, "mailbox/payload.ts");
    expect(mailboxLeaks(inspect(payload, 'export { triggerJournal } from "./triggers.ts";'))).toEqual(["mailbox/triggers.ts"]);
    expect(mailboxLeaks(inspect(payload, 'import { Db } from "#/infra/db.ts";'))).toEqual(["infra/db.ts"]);
    expect(mailboxLeaks(inspect(payload, 'import * as q from "#db/mailbox_trigger.sql.ts";'))).toEqual(["#db/mailbox_trigger.sql.ts"]);
  });
});
