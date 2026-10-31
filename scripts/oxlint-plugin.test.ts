import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, expect, it } from "vite-plus/test";

import { refused } from "../vite.config.ts";
import plugin, { catalogOf } from "./oxlint-plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester();
const rule = (name: string) => plugin.rules[name]!;
const page = (path: string) => `/repo/apps/web/src/${path}`;

tester.run("no-wall-clock", rule("no-wall-clock"), {
  valid: ["new Date(0)", "Clock.currentTimeMillis", "time.now()"],
  invalid: [
    { code: "Date.now()", errors: [{ messageId: "wallClock" }] },
    { code: "new Date()", errors: [{ messageId: "wallClock" }] },
    { code: "setTimeout(f, 10)", errors: [{ messageId: "wallClock" }] },
    { code: "setInterval(f, 10)", errors: [{ messageId: "wallClock" }] },
  ],
});

tester.run("no-test-sleep", rule("no-test-sleep"), {
  valid: ["until(() => done)", "TestClock.adjust('1 second')", "other.sleep(10)"],
  invalid: [
    { code: "Effect.sleep('1 second')", errors: [{ messageId: "sleep" }] },
    { code: "page.waitForTimeout(500)", errors: [{ messageId: "sleep" }] },
    { code: "setTimeout(f, 10)", errors: [{ messageId: "sleep" }] },
  ],
});

tester.run("no-comment-divider", rule("no-comment-divider"), {
  valid: ["// The lease outlives the request: a retry finds it.\nlet a = 1;", "/** Docs. */\nlet a = 1;"],
  invalid: [
    { code: "// ── Helpers ──\nlet a = 1;", errors: [{ messageId: "divider" }] },
    { code: "// ----------\nlet a = 1;", errors: [{ messageId: "divider" }] },
    { code: "/* ======== */\nlet a = 1;", errors: [{ messageId: "divider" }] },
  ],
});

tester.run("no-cjk-literal", rule("no-cjk-literal"), {
  valid: ['t("web.issue.title")', "/[，。]/.test(s)", "const a = 'plain'"],
  invalid: [
    { code: "const a = '工单'", errors: [{ messageId: "cjk" }] },
    { code: "const a = `${n} 个`", errors: [{ messageId: "cjk" }] },
    { code: "list.join('、')", errors: [{ messageId: "cjk" }] },
    { code: "const v = <b>你好</b>", filename: "a.tsx", errors: [{ messageId: "cjk" }] },
  ],
});

tester.run("no-hex-color", rule("no-hex-color"), {
  valid: ['const c = "bg-ok-soft text-warn-ink"', 'const c = "shadow-[inset_0_2px_0_var(--color-accent)]"'],
  invalid: [
    { code: 'const c = "bg-[#e3efd2]"', errors: [{ messageId: "hex" }] },
    { code: "const c = `p-2 shadow-[0_1px_2px_#2f1f1326]`", errors: [{ messageId: "hex" }] },
  ],
});

tester.run("no-copy-selector", rule("no-copy-selector"), {
  valid: ["page.getByTestId('issue-card')", "page.getByText(fixtures.title)", "page.getByRole('button', { name: 'Add paging' })"],
  invalid: [
    { code: "page.getByText('完成')", errors: [{ messageId: "copy" }] },
    { code: "expect(row).toHaveText(/待办/)", errors: [{ messageId: "copy" }] },
    { code: "page.getByRole('button', { name: '派活' })", errors: [{ messageId: "copy" }] },
    { code: "rows.filter({ hasText: `完成` })", errors: [{ messageId: "copy" }] },
  ],
});

tester.run("design-tokens", rule("design-tokens"), {
  valid: ['const c = "rounded-lg text-sm duration-180 z-30"'],
  invalid: [
    { code: 'const c = "rounded-[7px]"', errors: [{ messageId: "radius" }] },
    { code: 'const c = "z-[999]"', errors: [{ messageId: "layer" }] },
  ],
});

tester.run("native-control", rule("native-control"), {
  valid: [
    { code: "const v = <input type='text' />", filename: "a.tsx" },
    { code: "const v = <Select />", filename: "a.tsx" },
  ],
  invalid: [
    { code: "const v = <select />", filename: "a.tsx", errors: [{ messageId: "native" }] },
    { code: "const v = <input type='checkbox' />", filename: "a.tsx", errors: [{ messageId: "native" }] },
    { code: "const v = <input type='range' />", filename: "a.tsx", errors: [{ messageId: "native" }] },
  ],
});

tester.run("page-layers", rule("page-layers"), {
  valid: [
    { code: "import { a } from '../infra/router';", filename: page("ui/A.tsx") },
    { code: "import { a } from '../issue';", filename: page("features/channel/Chat.tsx") },
    { code: "import { a } from './rules';", filename: page("features/issue/Board.tsx") },
    { code: "import { a } from '../../features/issue';", filename: page("farm/panels/Board.tsx") },
    { code: "import { a } from '../ui/A';", filename: "/repo/apps/server/src/x.ts" },
    { code: "import { a } from '@/infra/router';", filename: page("ui/A.tsx") },
    { code: "import { a } from '@/features/issue';", filename: page("farm/panels/Board.tsx") },
    { code: "import { a } from '@/infra/frames';", filename: page("state/atom.ts") },
    { code: "import { a } from '@/base/format';", filename: page("infra/api.ts") },
  ],
  invalid: [
    { code: "import { a } from '../features/issue';", filename: page("ui/A.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '@/infra/api';", filename: page("base/format.ts"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '@/state/atom';", filename: page("infra/frame.ts"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '../../farm/scene';", filename: page("features/issue/Board.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '../issue/rules';", filename: page("features/channel/Chat.tsx"), errors: [{ messageId: "index" }] },
    { code: "export { a } from '../tree/x';", filename: page("farm/a.ts"), errors: [{ messageId: "sibling" }] },
    { code: "import { a } from '@/features/issue';", filename: page("ui/A.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '@/issue/rules';", filename: page("features/channel/Chat.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '@/features/issue/rules';", filename: page("features/channel/Chat.tsx"), errors: [{ messageId: "index" }] },
  ],
});

tester.run("parent-import", rule("parent-import"), {
  valid: [
    { code: "import { a } from './rules';", filename: page("features/issue/Board.tsx") },
    { code: "import { a } from '@/infra/router';", filename: page("ui/A.tsx") },
    { code: "import { a } from '../../db/generated/x.ts';", filename: "/repo/apps/server/src/issue/issue.ts" },
    { code: "import { a } from '../x';", filename: "/repo/packages/agent/src/core/loop.ts" },
  ],
  invalid: [
    {
      code: "import { a } from '../infra/router';",
      filename: page("ui/A.tsx"),
      errors: [{ messageId: "parent" }],
      output: "import { a } from '@/infra/router';",
    },
    {
      code: "export * from '../issue/rules.ts';",
      filename: "/repo/apps/server/src/task/x.ts",
      errors: [{ messageId: "parent" }],
      output: "export * from '@/issue/rules.ts';",
    },
    {
      code: "const m = import('../../ui/A');",
      filename: page("features/issue/Board.tsx"),
      errors: [{ messageId: "parent" }],
      output: "const m = import('@/ui/A');",
    },
  ],
});

tester.run("promise-boundary", rule("promise-boundary"), {
  valid: [
    { code: "const a = Effect.tryPromise(async () => { await x(); });", filename: "/repo/apps/server/src/a.ts" },
    { code: "const a = Effect.tryPromise({ try: async (signal) => f(signal), catch: e });", filename: "/repo/apps/server/src/a.ts" },
    { code: "const a = Effect.promise(async () => g());", filename: "/repo/apps/server/src/a.ts" },
    { code: "const a = () => fetch(u).then((r) => r.text());", filename: "/repo/apps/server/src/a.ts" },
    { code: "const a = Effect.tryPromise({ try: async () => (await f()).text, catch: e });", filename: "/repo/apps/server/src/a.ts" },
  ],
  invalid: [
    { code: "async function a() {}", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "async" }] },
    { code: "const a = async () => { await b(); };", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "async" }] },
    { code: "const a = Effect.tryPromise(() => run(async () => 1));", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "async" }] },
    { code: "const a = new Promise((r) => r(1));", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "promise" }] },
    {
      code: "const a = Effect.tryPromise({ try: async () => { const r = await realpath(d); if (bad(r)) throw e; return await stat(r); }, catch: e });",
      filename: "/repo/apps/server/src/a.ts",
      errors: [{ messageId: "steps" }],
    },
    { code: "const a = Effect.promise(async () => { await a(); await b(); });", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "steps" }] },
  ],
});

tester.run("try-promise-catch", rule("try-promise-catch"), {
  valid: [
    {
      code: "const a = Effect.tryPromise({ try: (signal) => fetch(u, { signal }), catch: (e) => new E({ cause: e }) });",
      filename: "/repo/apps/server/src/a.ts",
    },
    { code: "const a = Effect.promise(() => db.close());", filename: "/repo/apps/server/src/a.ts" },
  ],
  invalid: [
    { code: "const a = Effect.tryPromise(() => lookup(host));", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "thunk" }] },
    { code: "const a = Effect.tryPromise(function (signal) { return f(signal); });", filename: "/repo/packages/ai/src/a.ts", errors: [{ messageId: "thunk" }] },
  ],
});

tester.run("db-door", rule("db-door"), {
  valid: [
    { code: "const { run, attemptTx } = yield* Db;", filename: "/repo/apps/server/src/issue/issue.ts" },
    { code: 'import type { SqlClient } from "effect/sql";', filename: "/repo/apps/server/src/issue/merge.ts" },
    { code: 'import { type SqlClient, SqlError } from "effect/sql";', filename: "/repo/apps/server/src/session/session.ts" },
    {
      code: 'import { SqlClient } from "effect/sql";\nconst t = sql.withTransaction(work);',
      filename: "/repo/apps/server/src/infra/db.ts",
    },
  ],
  invalid: [
    { code: 'import { SqlClient } from "effect/sql";', filename: "/repo/apps/server/src/issue/issue.ts", errors: [{ messageId: "client" }] },
    { code: "const t = sql.withTransaction(work);", filename: "/repo/apps/server/src/memory/store.ts", errors: [{ messageId: "transaction" }] },
    { code: 'import * as Sql from "effect/sql";', filename: "/repo/apps/server/src/issue/issue.ts", errors: [{ messageId: "client" }] },
    { code: 'import * as Sql from "effect/sql/SqlClient";', filename: "/repo/apps/server/src/issue/issue.ts", errors: [{ messageId: "client" }] },
  ],
});

tester.run("sync-fs", rule("sync-fs"), {
  valid: ['import { readFile } from "node:fs/promises";', 'import { join } from "node:path";', 'import { constants } from "node:fs";'],
  invalid: [
    { code: 'import { readFileSync, writeFileSync } from "node:fs";', errors: [{ messageId: "sync" }, { messageId: "sync" }] },
    { code: 'import { existsSync } from "fs";', errors: [{ messageId: "sync" }] },
  ],
});

tester.run("dropped-timer", rule("dropped-timer"), {
  valid: [
    "const t = setTimeout(f, 10); onCleanup(() => clearTimeout(t));",
    "later(() => setDone(false), 1200);",
    "const wait = new Promise((done) => setTimeout(done, 10));",
    "e.retry = setTimeout(go, 10);",
  ],
  invalid: [
    { code: "setTimeout(() => setDone(false), 1200);", errors: [{ messageId: "dropped" }] },
    { code: "if (x) setInterval(tick, 100);", errors: [{ messageId: "dropped" }] },
  ],
});

tester.run("child-process-door", rule("child-process-door"), {
  valid: [{ code: 'import type { ChildProcess } from "node:child_process";', filename: "/repo/apps/web/test/a.ts" }, 'import { join } from "node:path";'],
  invalid: [
    { code: 'import { execFileSync } from "node:child_process";', errors: [{ messageId: "spawn" }] },
    { code: 'import * as cp from "child_process";', errors: [{ messageId: "spawn" }] },
  ],
});

tester.run("atom-door", rule("atom-door"), {
  valid: [
    { code: 'import { Atom } from "effect/reactivity";', filename: page("state/atom.ts") },
    { code: 'import { Atom, type AtomRegistry } from "effect/reactivity";', filename: page("state/intent.ts") },
    { code: 'import { Effect } from "effect";', filename: page("features/issue/moves.ts") },
    { code: 'import { Atom } from "effect/reactivity";', filename: "/repo/apps/server/src/core/core.ts" },
  ],
  invalid: [
    { code: 'import { Atom } from "effect/reactivity";', filename: page("features/issue/moves.ts"), errors: [{ messageId: "atom" }] },
    { code: 'import type { AtomRegistry } from "effect/reactivity";', filename: page("farm/store.ts"), errors: [{ messageId: "atom" }] },
    { code: 'import * as Atom from "effect/reactivity/Atom";', filename: page("ui/act.ts"), errors: [{ messageId: "atom" }] },
  ],
});

tester.run("page-store", rule("page-store"), {
  valid: [
    { code: "function Box() { const [open, setOpen] = createSignal(false); }", filename: page("features/channel/Composer.tsx") },
    { code: "const make = () => { const [s, set] = createStore({}); return s; };", filename: page("farm/support.ts") },
    { code: "const shown = defineAtom(false);", filename: page("features/channel/QuickSwitcher.tsx") },
    { code: "class Line { private readonly words = defineAtom(''); }", filename: page("ui/pixel/toasts.ts") },
  ],
  invalid: [
    { code: "const [shown, setShown] = createSignal(false);", filename: page("features/channel/QuickSwitcher.tsx"), errors: [{ messageId: "store" }] },
    { code: "export const [all, setAll] = createStore({ items: [] });", filename: page("farm/store.ts"), errors: [{ messageId: "store" }] },
  ],
});

tester.run("stored-door", rule("stored-door"), {
  valid: [
    { code: "const storage = KeyValueStore.layerStorage(() => localStorage);", filename: page("state/stored.ts") },
    { code: "const look = defineStored('board.look', Look, fallback);", filename: page("features/issue/look.ts") },
    { code: "const o = { localStorage: 1 }; o.localStorage;", filename: page("features/issue/look.ts") },
  ],
  invalid: [
    { code: 'localStorage.getItem("vibevalley.prefs");', filename: page("state/prefs.ts"), errors: [{ messageId: "storage" }] },
    { code: 'window.sessionStorage.setItem("k", "v");', filename: page("farm/store.ts"), errors: [{ messageId: "storage" }] },
    { code: "const s = globalThis.localStorage;", filename: page("ui/pixel/sound.ts"), errors: [{ messageId: "storage" }] },
  ],
});

tester.run("act-door", rule("act-door"), {
  valid: [
    { code: "act.run(() => api.issue.update({ id }));", filename: page("features/issue/IssueDetail.tsx") },
    { code: "void act.run(async () => { const got = await api.skill.create(body); keep(got); });", filename: page("features/runtime/SkillsPage.tsx") },
    { code: "act.run(() => Promise.all(xs.map((x) => api.session.stop({ id: x }))));", filename: page("farm/debug/DebugPanel.tsx") },
    {
      code: "api.channel.message.list({ id }); api.issue.diff.get({ id }); api.channel.previewDelete({ id }); api.memory.recall({ agent });",
      filename: page("features/channel/ChatPage.tsx"),
    },
    { code: "client.issue.update({ id });", filename: page("features/issue/IssueDetail.tsx") },
  ],
  invalid: [
    { code: "api.issue.update({ id, deliver });", filename: page("features/issue/IssueDetail.tsx"), errors: [{ messageId: "act" }] },
    { code: "const run = (f) => f(); run(() => api.cron.delete({ id }));", filename: page("features/channel/Tabs.tsx"), errors: [{ messageId: "act" }] },
    { code: "api.orchestrator.stop({ agent }).catch(() => {});", filename: page("farm/chat/Composer.tsx"), errors: [{ messageId: "act" }] },
  ],
});

tester.run("failure-tone", rule("failure-tone"), {
  valid: [
    { code: 'toast(reasonOf(e), "bad");', filename: page("features/lan/LanPage.tsx") },
    { code: 'toast(t("web.channel.more.copied"));', filename: page("features/channel/MessageParts.tsx") },
    { code: "toasts.add({ type: ToastType.error, title, description: reasonOf(e) });", filename: page("farm/issue/IssueView.tsx") },
    { code: "toasts.add({ type: ToastType.info, title: said });", filename: page("farm/chat/Composer.tsx") },
  ],
  invalid: [
    { code: "toast(reasonOf(e));", filename: page("features/lan/LanPage.tsx"), errors: [{ messageId: "tone" }] },
    { code: 'toast(t("x", { why: reasonOf(e) }), "info");', filename: page("features/lan/LanPage.tsx"), errors: [{ messageId: "tone" }] },
    {
      code: "toasts.add({ type: ToastType.warn, title, description: reasonOf(e) });",
      filename: page("farm/issue/IssueView.tsx"),
      errors: [{ messageId: "tone" }],
    },
    { code: "toasts.add({ title, description: reasonOf(e) });", filename: page("farm/panels/Panels.tsx"), errors: [{ messageId: "tone" }] },
  ],
});

tester.run("one-absent", rule("one-absent"), {
  valid: [
    { code: "let a: string | undefined;", filename: "/repo/apps/server/src/a.ts" },
    { code: "let a: string | null;", filename: "/repo/apps/server/src/a.ts" },
  ],
  invalid: [{ code: "let a: string | null | undefined;", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "both" }] }],
});

tester.run("global-doors", rule("global-doors"), {
  valid: [
    "window.vibevalleyHost?.notify",
    "globalThis.vibevalleyProbe = probe",
    { code: "const isOwn = (n: globalThis.Node) => n", filename: "a.ts" },
    "Object.assign(target, { a: 1 })",
    { code: "declare global { interface Window { x?: number } }\nexport {};", options: [{ door: true }], filename: "a.ts" },
  ],
  invalid: [
    { code: "(window as unknown as { ran?: number }).ran", filename: "a.ts", errors: [{ messageId: "cast" }] },
    { code: "const g = globalThis as Record<string, unknown>", filename: "a.ts", errors: [{ messageId: "cast" }] },
    { code: "Object.assign(globalThis, { vibevalleyNotices: notices })", errors: [{ messageId: "assign" }] },
    { code: "Object.defineProperty(window, 'x', { value: 1 })", errors: [{ messageId: "assign" }] },
    { code: "declare global { interface Window { x?: number } }\nexport {};", filename: "a.ts", errors: [{ messageId: "declare" }] },
  ],
});

tester.run("no-instanceof-tagged", rule("no-instanceof-tagged"), {
  valid: [
    "if (e instanceof Error) f(e.message)",
    "if (e instanceof TypeError) f()",
    "if (e instanceof TemplateProblem) f()",
    'const isMerge = Predicate.isTagged(e, "MergeFailure")',
    "class Plain extends Error {}\nif (e instanceof Plain) f()",
  ],
  invalid: [
    { code: "const a = e instanceof MergeFailure ? e : wrap(e)", errors: [{ messageId: "tagged" }] },
    { code: "if (e instanceof SqlError.SqlError) f()", errors: [{ messageId: "tagged" }] },
    { code: "if (e instanceof Refused) f()", errors: [{ messageId: "tagged" }] },
    {
      code: 'if (e instanceof Busy) f()\nexport class Busy extends Data.TaggedError("Busy")<{ readonly message: string }> {}',
      filename: "a.ts",
      errors: [{ messageId: "tagged" }],
    },
  ],
});

tester.run("no-object-guard", rule("no-object-guard"), {
  valid: [
    "const ok = Predicate.isObject(x)",
    'const ok = typeof x === "string" && x !== ""',
    'const ok = typeof x === "object" && y !== null',
    "const ok = x !== null && x !== undefined",
  ],
  invalid: [
    { code: 'const ok = typeof x === "object" && x !== null', errors: [{ messageId: "guard" }] },
    { code: 'const ok = x !== null && typeof x === "object"', errors: [{ messageId: "guard" }] },
    { code: 'const ok = typeof v.a === "object" && v.a !== null && !Array.isArray(v.a)', errors: [{ messageId: "guard" }] },
    { code: 'const ok = ready && typeof x === "object" && x != null', errors: [{ messageId: "guard" }] },
    { code: 'const ok = typeof (x) === "object" && (x) !== null', errors: [{ messageId: "guard" }] },
    { code: 'const ok = typeof x === "object" && ( x ) !== null', errors: [{ messageId: "guard" }] },
  ],
});

tester.run("service-method-names", rule("service-method-names"), {
  valid: [
    'Issue.of({ create: Effect.fn("Issue.create")(function* (req) { return yield* add(req); }) })',
    "Core.of({ apply: Effect.fnUntraced(function* (fact) { yield* fold(fact); }) })",
    'const list = Effect.fn("Cron.list")(function* () { return []; });\nCron.of({ list })',
    "Core.of({ state: () => state, follow: (id) => Stream.fromPubSub(events), events: Stream.empty, owner: Effect.map(sub, f) })",
    "Lan.of({ answer: (id) => lookup(id), me: () => Effect.runSync(read) })",
    "GitError.of(code, stderr)",
    "const call = (x) => x;\nGame.of({ want: (s) => call(s) })",
    'const blocks = { submit: Effect.fn("Artifact.submit")(function* (b) { return b; }) };\nArtifact.of({ submit: blocks.submit })',
  ],
  invalid: [
    { code: "Core.of({ open: () => Effect.suspend(() => go) })", errors: [{ messageId: "unnamed", data: { service: "Core", method: "open" } }] },
    { code: "Game.of({ count: () => projects.contributions(e).pipe(Effect.map(total)) })", errors: [{ messageId: "unnamed" }] },
    { code: "Notice.of({ say(text) { if (!text) return Effect.void; return Effect.log(text); } })", errors: [{ messageId: "unnamed" }] },
    {
      code: "const apply = (f) => Effect.sync(() => f);\nCore.of({ apply, setCommits: (c) => apply(c) })",
      errors: [{ messageId: "unnamed" }, { messageId: "unnamed" }],
    },
    {
      code: 'const changesOf = Effect.fn("Session.changesOf")(function* (id) { return id; });\nSession.of({ changes: changesOf })',
      errors: [{ messageId: "name" }],
    },
    { code: "Connector.of({ login: (id) => bridge(id)?.login() ?? Effect.succeed(off(id)) })", errors: [{ messageId: "unnamed" }] },
    { code: "const locked = (e) => lock.withPermits(1)(e);\nChannel.of({ pin: (id) => locked(pinning(id)) })", errors: [{ messageId: "unnamed" }] },
    {
      code: "Task.of({ act: Effect.fn(function* (id) { return id; }) })",
      errors: [{ messageId: "name", data: { service: "Task", method: "act", given: "nothing" } }],
    },
    {
      code: 'const blocks = { submit: Effect.fn("BlockStore.submit")(function* (b) { return b; }) };\nArtifact.of({ submit: blocks.submit })',
      errors: [{ messageId: "name", data: { service: "Artifact", method: "submit", given: '"BlockStore.submit"' } }],
    },
    {
      code: "const blocks = { submit: (b) => Effect.succeed(b) };\nArtifact.of({ submit: blocks.submit })",
      errors: [{ messageId: "unnamed" }],
    },
  ],
});

const server = "/repo/apps/server/src/a.ts";

tester.run("singular-service", rule("singular-service"), {
  valid: [
    { code: 'class Issue extends Context.Service<Issue, { list: () => number }>()("vibevalley/Issue") {}', filename: server },
    { code: 'class Progress extends Context.Service<Progress, {}>()("vibevalley/Progress") {}', filename: server },
    { code: 'class SyncStatus extends Context.Service<SyncStatus, {}>()("vibevalley/SyncStatus") {}', filename: server },
    { code: "class Issues extends Data.Class {}", filename: server },
  ],
  invalid: [
    {
      code: 'class Issues extends Context.Service<Issues, {}>()("vibevalley/Issue") {}',
      filename: server,
      errors: [{ messageId: "plural", data: { name: "Issues", singular: "Issue" } }],
    },
    {
      code: 'export class Memories extends Context.Service<Memories, {}>()("vibevalley/Memory") {}',
      filename: server,
      errors: [{ messageId: "plural", data: { name: "Memories", singular: "Memory" } }],
    },
  ],
});

tester.run("protocol-namespace", rule("protocol-namespace"), {
  valid: [
    { code: 'import type * as T from "@vibevalley/protocol";', filename: server },
    { code: 'import { type IssueStatus, ownerId } from "@vibevalley/protocol";', filename: server },
    { code: 'import { Issue } from "@/issue/issue.ts";', filename: server },
    { code: 'import * as S from "@vibevalley/protocol/schema";', filename: server },
  ],
  invalid: [
    { code: 'import type { Issue } from "@vibevalley/protocol";', filename: server, errors: [{ messageId: "named", data: { name: "Issue" } }] },
    {
      code: 'import { type Session as Run, ownerId, type Channel } from "@vibevalley/protocol";',
      filename: server,
      errors: [
        { messageId: "named", data: { name: "Session" } },
        { messageId: "named", data: { name: "Channel" } },
      ],
    },
  ],
});

const root = resolve(import.meta.dirname, "..");

describe("what a rule says", () => {
  const messages = [
    ...Object.entries(plugin.rules).flatMap(([name, r]) => Object.entries(r.meta?.messages ?? {}).map(([id, text]) => ({ where: `${name}/${id}`, text }))),
    ...Object.entries(refused).map(([id, text]) => ({ where: `no-restricted-imports/${id}`, text })),
  ];

  it("says what is wrong, how to fix it, and a file here that shows it", () => {
    for (const { where, text } of messages) {
      // A path the rule fills in names one file per value: apps/{{app}}/tsconfig.json is apps/web's and apps/server's.
      const see = / See (\S+)$/u.exec(text)?.[1]?.replaceAll("{{app}}", "web");
      expect(text, where).toMatch(/\. Fix: .+\. See \S+$/u);
      expect(existsSync(resolve(root, see ?? "")), `${where}: ${see}`).toBe(true);
    }
  });

  it("leaves no-restricted-imports no message of its own outside refused", () => {
    expect(readFileSync(resolve(root, "vite.config.ts"), "utf8")).not.toMatch(/message: ["'`]/u);
  });

  it("names the catalog the file's words belong in", () => {
    expect(catalogOf("/repo/apps/server/src/issue/issue.ts")).toBe("server.issue");
    expect(catalogOf("/repo/apps/web/src/features/issue/Board.tsx")).toBe("web.issue");
    expect(catalogOf("/repo/apps/web/src/farm/phone/screens.tsx")).toBe("web.farm.phone");
    expect(catalogOf("/repo/apps/web/src/farm/hud/Hud.tsx")).toBe("web.farm");
    expect(catalogOf("/repo/apps/server/src/flows/farm.ts")).toBe("server");
    expect(catalogOf("/repo/packages/agent/src/brain.ts")).toBe("shared");
  });
});
