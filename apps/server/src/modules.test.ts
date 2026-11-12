import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { analyzeSource, type Edge } from "@vibevalley/testkit/source";

import { conceptOf, containers, moduleOf, modules, outside, unitOf } from "./modules.ts";

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
const users: Readonly<Record<string, string>> = {
  sessions: "Agent Sessions",
  chat: "Collaboration",
  issues: "Issues",
  crons: "Issues",
  progress: "Gamification",
  commits: "Gamification",
  connectors: "Gateway",
  machines: "Agent Sessions",
};
const reads: Readonly<Record<string, string>> = {
  "modules/session/mailbox.ts -> issues":
    "Tier 1 issue reservoir checks the issue's stage and assigned agent synchronously without keeping a second copy of the board",
};

const localEdges = (file: string, edges: readonly Edge[]) =>
  edges.flatMap(({ from: spec }) =>
    spec.startsWith("#/") ? [normalize(spec.slice(2))] : spec.startsWith("./") || spec.startsWith("../") ? [rel(normalize(join(dirname(file), spec)))] : [],
  );

/** The services a module is handed (DepsOf: `readonly session: Session`), each by its deps key. */
const depsOf = (text: string) =>
  [...text.matchAll(/interface \w*Deps\b[^{]*\{([^}]*)\}/gu)].flatMap((m) => [...(m[1] ?? "").matchAll(/readonly (\w+)\??:/gu)].map((k) => k[1] ?? ""));

/** The unit a deps key names: the module or gateway of that name. */
const unitOfKey = (key: string) => [`modules/${key}`, `gateway/${key}`].find((unit) => moduleOf(unit) !== undefined);

function inspect(file: string, unread: string) {
  // A service reads the core state off its deps as well as off a const it took from them: both are core.state().
  const text = unread.replaceAll(/\bdeps\.core\b/gu, "core");
  const source = analyzeSource(file, text);
  const local = localEdges(file, source.edges);
  const sessionSnapshot = source.calls("core", "state") && local.includes("modules/session/roster.ts");
  const parts = source.reads("core", "state");
  if (source.calls("core", "session") || sessionSnapshot) parts.push("sessions");
  return { file, from: rel(file), edges: source.edges, local, parts: [...new Set(parts)], sessionSnapshot, deps: depsOf(text) };
}

// Built inside the first check, so its time includes reading and parsing, not hidden in test collection.
let snapshot: ReturnType<typeof inspect>[] | undefined;
const sources = () =>
  (snapshot ??= files(src)
    .filter((file) => !file.endsWith(".test.ts") && !outside.includes(rel(file).split("/")[0]!))
    .map((file) => inspect(file, readFileSync(file, "utf8"))));

const foreignReads: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  session: { "issue.sql.ts": ["issueExists"] },
  inbox: { "channel_message.sql.ts": ["messageByID", "notificationReceipt", "userReadReports"] },
};
const folders = containers.flatMap((c) => readdirSync(join(src, c)).filter((name) => statSync(join(src, c, name)).isDirectory()));
const tableModule = (name: string) => {
  const table = name.replace(/\.sql\.ts$/u, "");
  return folders.find((module) => table === module || table.startsWith(`${module}_`));
};
const foreignQueries = (file: string, edges: readonly Edge[]) => {
  const module = conceptOf(rel(file));
  return edges.flatMap((edge) => {
    if (!edge.from.startsWith("#db/")) return [];
    const name = edge.from.split("/").at(-1) ?? "";
    if (name === "types.ts" || tableModule(name) === module) return [];
    const allowed = foreignReads[module]?.[name] ?? [];
    return edge.names.filter((symbol) => !allowed.includes(symbol)).map((symbol) => `${name}:${symbol}`);
  });
};

/** The deliveries' machinery inside session: other modules reach it through mailbox.ts's types and session.ts. */
const deliveryFiles = new Set([
  "modules/session/brakes.ts",
  "modules/session/deliveries.ts",
  "modules/session/pump.ts",
  "modules/session/routing.ts",
  "modules/session/triggers.ts",
  "modules/session/work.ts",
]);
const mailboxContracts = new Set([
  "modules/session/envelope.ts",
  "modules/session/payload.ts",
  "modules/session/prompts.ts",
  "modules/session/schema.ts",
  "modules/session/shapes.ts",
]);
const mailboxLeaks = (source: ReturnType<typeof inspect>) => {
  const privateImports = source.local.filter((to) => !source.from.startsWith("modules/session/") && deliveryFiles.has(to));
  if (mailboxContracts.has(source.from)) {
    // A contract may lean on the modules before session (a workplace's shape), never on session's storage or the infra.
    privateImports.push(
      ...source.local.filter((to) => (to.startsWith("modules/session/") && !mailboxContracts.has(to)) || to.startsWith("infra/") || to.startsWith("core/")),
    );
    privateImports.push(...source.edges.filter((edge) => edge.from.startsWith("#db/")).map((edge) => edge.from));
  }
  return privateImports;
};

/** What a file of the chat leans on beyond the platform and the chat itself: another business module, or another's table. */
const chatLeaks = (source: ReturnType<typeof inspect>) => [
  ...source.local.filter((to) => unitOf(to) !== "modules/channel" && moduleOf(to)?.name !== "Platform"),
  ...source.edges.filter((edge) => edge.from.startsWith("#db/") && tableModule(edge.from.split("/").at(-1) ?? "") !== "channel").map((edge) => edge.from),
];

describe("the modules", () => {
  it("hold every folder and file under src, with domain slices under modules/ and protocol doors under gateway/", () => {
    const tops = readdirSync(src).filter((f) => statSync(join(src, f)).isDirectory() || (f.endsWith(".ts") && !f.endsWith(".test.ts")));
    const unownedTops = tops.filter((t) => !outside.includes(t) && !(containers as readonly string[]).includes(t) && moduleOf(t) === undefined);
    const unownedUnits = containers.flatMap((c) =>
      readdirSync(join(src, c))
        .map((sub) => `${c}/${sub}`)
        .filter((unit) => moduleOf(unit) === undefined),
    );
    expect(
      [...unownedTops, ...unownedUnits],
      "a folder or file under src/ belongs to no module, so nothing says what it may import. Fix: place domain concepts under src/modules/<concept> and ingress adapters under src/gateway/<adapter>, and register the unit in modules.ts. See apps/server/src/modules.ts",
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

  it("are handed only the services of the modules before them", () => {
    const found = sources().flatMap(({ from, deps }) =>
      deps.flatMap((key) => {
        const unit = unitOfKey(key);
        return unit !== undefined && moduleOf(unit) !== moduleOf(from) && rank(unit) > rank(from) ? [`${from} -> ${key}`] : [];
      }),
    );
    expect(
      found,
      "a module's deps name the service of a module after it in modules.ts, so services.ts cannot build it first. Fix: move what both need into the earlier module, or have the later one hand it down (a Subscription the earlier one offers). See docs/architecture.md",
    ).toEqual([]);
  });

  it("regression: a deps interface names its services by key", () => {
    const file = join(src, "modules/repo/repo.ts");
    expect(
      inspect(file, "export interface RepoDeps {\n  readonly config: ServerConfig;\n  readonly issue: Issue;\n  readonly session?: Session;\n}").deps,
    ).toEqual(["config", "issue", "session"]);
    expect(inspect(file, "const issues = deps.core.state().issues;").parts).toEqual(["issues"]);
  });

  it("use only their own tables' queries, besides named read projections", () => {
    const found = sources().flatMap(({ file, from, edges }) => foreignQueries(file, edges).map((query) => `${from} -> ${query}`));
    expect(
      found,
      "a module imports another module's table queries, so it writes (or reads beyond what was named) under that module. Fix: call that module's service, or name the read in foreignReads; writes stay with the table's module. See docs/subsystems/foundation.md",
    ).toEqual([]);
  });

  it("regression: namespace imports and foreign writes cannot hide behind a read projection", () => {
    const file = join(src, "modules/session/mailbox.ts");
    const queries = (text: string) => foreignQueries(file, inspect(file, text).edges);
    expect(queries('import { issueExists as known } from "#db/issue.sql.ts";')).toEqual([]);
    expect(queries('import { topPlace as route } from "#db/channel.sql.ts";')).toEqual(["channel.sql.ts:topPlace"]);
    expect(queries('import * as q from "#db/channel.sql.ts";')).toEqual(["channel.sql.ts:*"]);
    expect(queries('import { renameChannel } from "#db/channel.sql.ts";')).toEqual(["channel.sql.ts:renameChannel"]);
    expect(queries('export * from "#db/issue_assignment.sql.ts";')).toEqual(["issue_assignment.sql.ts:*"]);
    const github = join(src, "modules/issue/github.ts");
    expect(foreignQueries(github, inspect(github, 'import { recordTrigger } from "#db/session_trigger.sql.ts";').edges)).toEqual([
      "session_trigger.sql.ts:recordTrigger",
    ]);
  });

  it("keep the chat on the platform alone: modules/channel imports no other business module, its tests included", () => {
    const tests = files(join(src, "modules/channel"))
      .filter((file) => file.endsWith(".test.ts"))
      .map((file) => inspect(file, readFileSync(file, "utf8")));
    const found = [...sources().filter(({ from }) => from.startsWith("modules/channel/")), ...tests].flatMap((source) =>
      chatLeaks(source).map((to) => `${source.from} -> ${to}`),
    );
    expect(
      found,
      "the chat imports a business module (or another module's table), so it leans on the layers above it again. Fix: pass the fact in as data (a seat, an observer's answer), or move the code that needs that module into modules/watch. See docs/subsystems/channel.md",
    ).toEqual([]);
  });

  it("regression: the chat's check sees a business import, a re-export and another module's table, and lets the platform through", () => {
    const file = join(src, "modules/channel/writing.ts");
    const leaks = (text: string) => chatLeaks(inspect(file, text));
    expect(leaks('import type { Session } from "#/modules/session/session.ts";')).toEqual(["modules/session/session.ts"]);
    expect(leaks('export { profileId } from "../watch/watch.ts";')).toEqual(["modules/watch/watch.ts"]);
    expect(leaks('import type { Agent } from "#/modules/agent/agent.ts";')).toEqual(["modules/agent/agent.ts"]);
    expect(leaks('import * as qd from "#db/session_delivery.sql.ts";')).toEqual(["#db/session_delivery.sql.ts"]);
    expect(
      leaks(
        'import type { Db } from "#/infra/db.ts";\nimport type { Attachment } from "#/modules/attachment/attachment.ts";\nimport { metaOf } from "./meta.ts";\nimport * as qm from "#db/channel_message.sql.ts";',
      ),
    ).toEqual([]);
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
      if (from.startsWith("core/") || from.startsWith("gateway/projection/")) return [];
      return parts.filter((part) => users[part] !== undefined && users[part] !== moduleOf(from)?.name).map((part) => `${from} -> ${part}`);
    });
    expect(
      found.filter((f) => !(f in reads)),
      "a module reads another's part of the core state, so the user's rules are skipped. Fix: ask the owning module's service for it (a method or a Stream), and keep core.state() reads to the module that owns the field. See docs/subsystems/core.md",
    ).toEqual([]);
    expect(
      Object.keys(reads).filter((r) => !found.includes(r)),
      "a read listed in reads is gone. Fix: drop it from reads. See apps/server/src/modules.test.ts",
    ).toEqual([]);
  });

  it("regression: session snapshot helpers cannot hide a service's cross-module read", () => {
    const file = join(src, "modules/issue/issue.ts");
    const readsSessionSnapshot = (text: string) => inspect(file, text).sessionSnapshot;
    expect(readsSessionSnapshot('import { sessionOf } from "#/modules/session/roster.ts"; const state = core.state(); sessionOf(state, id);')).toBe(true);
    expect(readsSessionSnapshot('import { sessionOf } from "../session/roster.ts"; sessionOf(core.state(), id);')).toBe(true);
    expect(readsSessionSnapshot('import { sessionOf } from "#/modules/session/roster.ts"; export const rule = (state, id) => sessionOf(state, id);')).toBe(
      false,
    );
    expect(readsSessionSnapshot("const state = core.state(); live.sessionOf(id); state.issues.find(item => item.id === id);")).toBe(false);
  });

  it("keep mailbox persistence behind its service, not its shared contracts", () => {
    const found = sources().flatMap((source) => mailboxLeaks(source).map((to) => `${source.from} -> ${to}`));
    expect(
      found,
      "Mailbox storage leaked through an internal import or a shared contract. Fix: call Mailbox; keep payload, envelope and prompts free of storage imports. See docs/subsystems/session.md",
    ).toEqual([]);
  });

  it("reach a session module's inside only from tests", () => {
    const found = sources()
      .filter(({ from, file }) => from !== "modules/session/session.ts" && /\binsideOf\b/u.test(readFileSync(file, "utf8")))
      .map(({ from }) => from);
    expect(
      found,
      "a module reaches past Session into its parts (insideOf), so the narrow interface does not hold. Fix: use a member of Session, or add the one the module needs. See docs/subsystems/session.md",
    ).toEqual([]);
  });

  it("regression: a mailbox helper or re-export cannot bypass its service", () => {
    const channel = join(src, "modules/channel/writing.ts");
    expect(mailboxLeaks(inspect(channel, 'import { Mailbox } from "#/modules/session/mailbox.ts";'))).toEqual([]);
    expect(mailboxLeaks(inspect(channel, 'import { triggerOf } from "#/modules/session/payload.ts";'))).toEqual([]);
    expect(mailboxLeaks(inspect(channel, 'export * from "../session/triggers.ts";'))).toEqual(["modules/session/triggers.ts"]);
    expect(mailboxLeaks(inspect(channel, 'const journal = import("#/modules/session/triggers.ts");'))).toEqual(["modules/session/triggers.ts"]);
    const payload = join(src, "modules/session/payload.ts");
    expect(mailboxLeaks(inspect(payload, 'export { triggerJournal } from "./triggers.ts";'))).toEqual(["modules/session/triggers.ts"]);
    expect(mailboxLeaks(inspect(payload, 'import { Db } from "#/infra/db.ts";'))).toEqual(["infra/db.ts"]);
    expect(mailboxLeaks(inspect(payload, 'import * as q from "#db/session_trigger.sql.ts";')).toSorted()).toEqual(["#db/session_trigger.sql.ts"]);
  });
});
