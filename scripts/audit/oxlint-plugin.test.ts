import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, expect, it } from "vite-plus/test";

import { refused } from "../../vite.config.ts";
import plugin, { catalogOf } from "./oxlint-plugin.ts";

RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester();
const rule = (name: string) => plugin.rules[name]!;
const page = (path: string) => `/repo/apps/web/src/${path}`;

tester.run("no-wall-clock", rule("no-wall-clock"), {
  valid: ["new Date(0)", "clock.now()", "time.now()", "function f(Date) { Date.now() }", "const timers = {setTimeout() {}}; timers.setTimeout()"],
  invalid: [
    { code: "globalThis.Date.now()", errors: [{ messageId: "wallClock" }] },
    { code: "import * as timers from 'node:timers'; timers.setTimeout(f, 1)", errors: [{ messageId: "wallClock" }] },
    { code: "import {setTimeout as delay} from 'node:timers'; delay(f, 1)", errors: [{ messageId: "wallClock" }] },
    { code: "Date.now()", errors: [{ messageId: "wallClock" }] },
    { code: "new Date()", errors: [{ messageId: "wallClock" }] },
    { code: "setTimeout(f, 10)", errors: [{ messageId: "wallClock" }] },
    { code: "setInterval(f, 10)", errors: [{ messageId: "wallClock" }] },
  ],
});

tester.run("no-test-sleep", rule("no-test-sleep"), {
  valid: ["until(() => done)", "vi.advanceTimersByTimeAsync(1000)", "clock.sleep(10)", "other.sleep(10)"],
  invalid: [
    { code: "import {setTimeout as pause} from 'node:timers/promises'; pause(1)", errors: [{ messageId: "sleep" }] },
    { code: "globalThis.setTimeout(f, 1)", errors: [{ messageId: "sleep" }] },
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
  valid: ['t("web.issue.title")', "/[，。]/.test(s)", "const a = 'plain'", String.raw`const typed = ["[", "\u3010"]`],
  invalid: [
    { code: "const a = '工单'", errors: [{ messageId: "cjk" }] },
    { code: "const a = `${n} 个`", errors: [{ messageId: "cjk" }] },
    { code: "list.join('、')", errors: [{ messageId: "cjk" }] },
    { code: "const v = <b>你好</b>", filename: "a.tsx", errors: [{ messageId: "cjk" }] },
  ],
});

tester.run("no-hex-color", rule("no-hex-color"), {
  valid: [
    { code: "const v = <div style={{ color: 'var(--color-ink)', 'box-shadow': 'inset 0 2px 0 var(--color-accent)' }} />", filename: "a.tsx" },
    { code: "const v = <div style={{ content: '\"#abc\"', 'background-image': 'url(/art.svg#abc)' }} />", filename: "a.tsx" },
    "const data = {color: '#abc'}; const note = 'see #abc';",
    { code: "const v = <div class='bg-page text-muted border-line bg-wheat/25 bg-[url(/a.svg#abc)]' />", filename: "a.tsx" },
    { code: "const v = <div title='#abc' data-tone='#abc' />", filename: "a.tsx" },
  ],
  invalid: [
    { code: "const v = <div style={{ color: '#e3efd2' }} />", filename: "a.tsx", errors: [{ messageId: "hex" }] },
    { code: "const v = <div style={{ '--accent': '#abc' }} />", filename: "a.tsx", errors: [{ messageId: "hex" }] },
    {
      code: "const v = <span style={{ background: active ? '#74a046' : 'var(--color-page)' }} />",
      filename: "a.tsx",
      errors: [{ messageId: "hex" }],
    },
    {
      code: "const v = <div style={{ 'box-shadow': `2px 2px 0 0 #3a2a1899` }} />",
      filename: "a.tsx",
      errors: [{ messageId: "hex" }],
    },
    { code: "const v = <div class='flex bg-[#abc]' />", filename: "a.tsx", errors: [{ messageId: "hexClass" }] },
    { code: "const tones = { plain: 'hover:text-[#abcdef]' };", errors: [{ messageId: "hexClass" }] },
    { code: "const v = <div class={cx('p-2', `shadow-[0_1px_#000a]`)} />", filename: "a.tsx", errors: [{ messageId: "hexClass" }] },
    { code: "const v = <div class='[border-color:#abc]' />", filename: "a.tsx", errors: [{ messageId: "hexClass" }] },
  ],
});

tester.run("style-attrs", rule("style-attrs"), {
  valid: [
    { code: "const v = <div class='flex gap-2' />", filename: "a.tsx" },
    { code: "const v = <div class={['flex', open() && 'bg-hover', props.class]} />", filename: "a.tsx" },
    { code: "const v = <div style={{ width: `${percent()}%` }} />", filename: "a.tsx" },
    { code: "const v = <div style={{ '--x': `${x}px`, display: 'grid' }} />", filename: "a.tsx" },
    { code: "const v = <div style={props.style} />", filename: "a.tsx" },
    { code: "const v = <Button style={{ 'margin-left': '12px' }} />", filename: "a.tsx" },
  ],
  invalid: [
    { code: "const v = <div className='card' />", filename: "a.tsx", errors: [{ messageId: "classAttr" }] },
    { code: "const v = <div classList={{ open: true }} />", filename: "a.tsx", errors: [{ messageId: "classAttr" }] },
    { code: "const v = <div style={{ 'margin-left': '12px' }} />", filename: "a.tsx", errors: [{ messageId: "fixedStyle" }] },
    { code: "const v = <div style={{ height: 48, color: `red` }} />", filename: "a.tsx", errors: [{ messageId: "fixedStyle" }] },
    { code: "const v = <div style='display: grid' />", filename: "a.tsx", errors: [{ messageId: "fixedStyle" }] },
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
  valid: [
    {
      code: "const v = <div style={{ 'border-radius': 'var(--radius-lg)', 'font-size': 'var(--text-sm)', 'transition-duration': '180ms', 'z-index': 30 }} />",
      filename: "a.tsx",
    },
    { code: "const v = <div style={{ width: `${width()}px`, height: '37px', top: '-13px', translate: `${x}px 0` }} />", filename: "a.tsx" },
    "const data = {fontSize: 37}; const note = 'rounded 7px';",
    {
      code: "const v = <div class='rounded-md text-sm leading-xs p-1.25 gap-2.5 z-30 duration-120 ease-out shadow-float disabled:opacity-50 w-[37px] h-[calc(100%-2px)] text-[var(--text-sm)] p-[var(--gutter)] data-[state=open]:bg-hover rounded-full text-ink' />",
      filename: "a.tsx",
    },
    { code: "const v = <div style={{ 'border-radius': `${r}px` }} />", filename: "a.tsx" },
  ],
  invalid: [
    { code: "const v = <div style={{ 'border-radius': '7px' }} />", filename: "a.tsx", errors: [{ messageId: "radius" }] },
    { code: "const v = <div style={{ zIndex: '-999' }} />", filename: "a.tsx", errors: [{ messageId: "layer" }] },
    { code: "const v = <div style={{ 'font-size': active ? 'var(--text-sm)' : '17px' }} />", filename: "a.tsx", errors: [{ messageId: "type" }] },
    { code: "const v = <div style={{ 'transition-duration': '150ms' }} />", filename: "a.tsx", errors: [{ messageId: "motion" }] },
    { code: "const v = <div style={{ 'box-shadow': '0 1px 2px black' }} />", filename: "a.tsx", errors: [{ messageId: "shadow" }] },
    { code: "const v = <div style={{ 'transition-timing-function': 'linear' }} />", filename: "a.tsx", errors: [{ messageId: "motion" }] },
    { code: "const v = <div class='flex text-[13px]' />", filename: "a.tsx", errors: [{ messageId: "typeClass" }] },
    { code: "const v = <div class='sm:leading-[17px]' />", filename: "a.tsx", errors: [{ messageId: "typeClass" }] },
    { code: "const v = <div class='p-[7px]' />", filename: "a.tsx", errors: [{ messageId: "spacingClass" }] },
    { code: "const v = <div class='hover:-mt-[3px]' />", filename: "a.tsx", errors: [{ messageId: "spacingClass" }] },
    { code: "const v = <div class='[padding-left:7px]' />", filename: "a.tsx", errors: [{ messageId: "spacingClass" }] },
    { code: "const tones = { card: 'rounded-[5px]' };", errors: [{ messageId: "radiusClass" }] },
    { code: "const v = <div class={`z-15 ${x}`} />", filename: "a.tsx", errors: [{ messageId: "layerClass" }] },
    { code: "const v = <div class='z-[999]' />", filename: "a.tsx", errors: [{ messageId: "layerClass" }] },
    { code: "const v = <div class='duration-150' />", filename: "a.tsx", errors: [{ messageId: "motionClass" }] },
    { code: "const v = <div class='ease-[cubic-bezier(0.1,0,0,1)]' />", filename: "a.tsx", errors: [{ messageId: "motionClass" }] },
    { code: "const v = <div class='shadow-[0_1px_2px_black]' />", filename: "a.tsx", errors: [{ messageId: "shadowClass" }] },
    { code: "const v = <button class='disabled:opacity-40' />", filename: "a.tsx", errors: [{ messageId: "disabledClass" }] },
    { code: "const v = <div class='[font-size:13px]' />", filename: "a.tsx", errors: [{ messageId: "typeClass" }] },
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
    { code: "import { a } from '#/infra/router';", filename: page("ui/A.tsx") },
    { code: "import { a } from '#/features/issue';", filename: page("farm/panels/Board.tsx") },
    { code: "import { a } from '#/infra/frame';", filename: page("state/atom.ts") },
    { code: "import { a } from '#/base/format';", filename: page("infra/api.ts") },
  ],
  invalid: [
    { code: "import { a } from '../features/issue';", filename: page("ui/A.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '#/infra/api';", filename: page("base/format.ts"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '#/state/atom';", filename: page("infra/frame.ts"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '../../farm/scene';", filename: page("features/issue/Board.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '../issue/rules';", filename: page("features/channel/Chat.tsx"), errors: [{ messageId: "index" }] },
    { code: "export { a } from '../tree/x';", filename: page("farm/a.ts"), errors: [{ messageId: "sibling" }] },
    { code: "import { a } from '#/features/issue';", filename: page("ui/A.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '#/issue/rules';", filename: page("features/channel/Chat.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '#/features/issue/rules';", filename: page("features/channel/Chat.tsx"), errors: [{ messageId: "index" }] },
  ],
});

tester.run("parent-import", rule("parent-import"), {
  valid: [
    { code: "import { a } from './rules';", filename: page("features/issue/Board.tsx") },
    { code: "import { a } from '#/infra/router';", filename: page("ui/A.tsx") },
    { code: "import { a } from '../../../db/x.ts';", filename: "/repo/apps/server/src/modules/issue/issue.ts" },
    { code: "import { a } from '../x';", filename: "/repo/packages/agent/src/core/loop.ts" },
  ],
  invalid: [
    {
      code: "import { a } from '../../db/generated/x.sql.ts';",
      filename: "/repo/apps/server/src/issue/issue.ts",
      errors: [{ messageId: "parent" }],
      output: "import { a } from '#db/x.sql.ts';",
    },
    {
      code: "import { a } from '../infra/router';",
      filename: page("ui/A.tsx"),
      errors: [{ messageId: "parent" }],
      output: "import { a } from '#/infra/router';",
    },
    {
      code: "export * from '../issue/rules.ts';",
      filename: "/repo/apps/server/src/task/x.ts",
      errors: [{ messageId: "parent" }],
      output: "export * from '#/issue/rules.ts';",
    },
    {
      code: "const m = import('../../ui/A');",
      filename: page("features/issue/Board.tsx"),
      errors: [{ messageId: "parent" }],
      output: "const m = import('#/ui/A');",
    },
  ],
});

// Real paths: which package a file is in is read from the package.json files above it.
const inRepo = (path: string) => join(import.meta.dirname, "../..", path);

tester.run("no-cross-package-path", rule("no-cross-package-path"), {
  valid: [
    { code: "import { a } from './api-client.ts';", filename: inRepo("scripts/gen/capabilities.ts") },
    { code: "import { a } from '../infra/lease.ts';", filename: inRepo("apps/server/src/chat/chat.ts") },
    { code: "import { a } from '@vibevalley/protocol/api';", filename: inRepo("scripts/gen/capabilities.ts") },
  ],
  invalid: [
    { code: "import { a } from '../../packages/protocol/src/api.ts';", filename: inRepo("scripts/gen/capabilities.ts"), errors: [{ messageId: "cross" }] },
    { code: "export * from '../../server/src/assets.ts';", filename: inRepo("apps/desktop/scripts/package.ts"), errors: [{ messageId: "cross" }] },
    { code: "const m = import('../../../packages/i18n/src/format.ts');", filename: inRepo("apps/web/src/base/x.ts"), errors: [{ messageId: "cross" }] },
  ],
});

tester.run("db-door", rule("db-door"), {
  valid: [
    { code: 'import { getIssue } from "#/db/generated/issue.sql.ts";', filename: "/repo/apps/server/src/modules/issue/issue.ts" },
    { code: 'import { type Db, SqlError } from "#/infra/db.ts";', filename: "/repo/apps/server/src/modules/session/session.ts" },
    { code: 'import { PGlite } from "@electric-sql/pglite";\nimport pg from "pg";', filename: "/repo/apps/server/src/infra/db.ts" },
    { code: 'import { pgliteSomething } from "pglite-adjacent";', filename: "/repo/apps/server/src/modules/issue/issue.ts" },
  ],
  invalid: [
    { code: 'import pg from "pg";', filename: "/repo/apps/server/src/modules/issue/issue.ts", errors: [{ messageId: "driver", data: { source: "pg" } }] },
    { code: 'import type { PoolClient } from "pg";', filename: "/repo/apps/server/src/modules/memory/store.ts", errors: [{ messageId: "driver" }] },
    { code: 'import { PGlite } from "@electric-sql/pglite";', filename: "/repo/apps/server/src/infra/baseline.ts", errors: [{ messageId: "driver" }] },
    {
      code: 'import { vector } from "@electric-sql/pglite/vector";',
      filename: "/repo/apps/server/src/modules/memory/memory.ts",
      errors: [{ messageId: "driver" }],
    },
    { code: 'export * from "pg";', filename: "/repo/apps/server/src/base/sql.ts", errors: [{ messageId: "driver" }] },
    { code: 'const pg = await import("pg");', filename: "/repo/apps/server/src/main.ts", errors: [{ messageId: "driver" }] },
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
    { code: "act.attempt(() => api.skill.create(body));", filename: page("features/runtime/SkillsPage.tsx") },
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
    { code: "attempt(() => api.skill.create(body));", filename: page("features/runtime/SkillsPage.tsx"), errors: [{ messageId: "act" }] },
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

const server = "/repo/apps/server/src/a.ts";

tester.run("singular-service", rule("singular-service"), {
  valid: [
    { code: "export interface Issue {}\nexport async function makeIssue() {}", filename: "/repo/apps/server/src/modules/issue/issue.ts" },
    { code: "export type Channel = {};\nexport async function makeChannel() {}", filename: "/repo/apps/server/src/modules/channel/channel.ts" },
    { code: "export interface Core {}\nexport function makeCore() {}", filename: "/repo/apps/server/src/core/core.ts" },
    { code: "export interface Lan {}\nexport async function makeLan() {}", filename: "/repo/apps/server/src/gateway/lan/lan.ts" },
    { code: "export interface Progress {}\nexport async function makeProgress() {}", filename: "/repo/apps/server/src/modules/progress/progress.ts" },
    { code: "export function makeSources() {}", filename: "/repo/apps/server/src/modules/memory/sources.ts" },
    { code: "export function makeThings() {}", filename: "/repo/apps/server/src/infra/infra.ts" },
  ],
  invalid: [
    {
      code: "export interface Issues {}\nexport async function makeIssues() {}",
      filename: "/repo/apps/server/src/modules/issues/issues.ts",
      errors: [{ messageId: "plural", data: { folder: "issues", singular: "issue", Singular: "Issue" } }],
    },
    {
      code: "export interface Memory {}\nexport async function makeMemories() {}",
      filename: "/repo/apps/server/src/modules/memory/memory.ts",
      errors: [{ messageId: "factory", data: { name: "makeMemories", folder: "memory", Service: "Memory" } }],
    },
    {
      code: "export async function makeGame() {}",
      filename: "/repo/apps/server/src/modules/game/game.ts",
      errors: [{ messageId: "missing", data: { folder: "game", Service: "Game" } }],
    },
  ],
});

tester.run("protocol-namespace", rule("protocol-namespace"), {
  valid: [
    { code: 'import type * as T from "@vibevalley/protocol";', filename: server },
    { code: 'import { type IssueStatus, userId } from "@vibevalley/protocol";', filename: server },
    { code: 'import { Issue } from "#/issue/issue.ts";', filename: server },
    { code: 'import * as S from "@vibevalley/protocol/schema";', filename: server },
  ],
  invalid: [
    { code: 'import type { Issue } from "@vibevalley/protocol";', filename: server, errors: [{ messageId: "named", data: { name: "Issue" } }] },
    {
      code: 'import { type Session as Run, userId, type Channel } from "@vibevalley/protocol";',
      filename: server,
      errors: [
        { messageId: "named", data: { name: "Session" } },
        { messageId: "named", data: { name: "Channel" } },
      ],
    },
  ],
});

const root = resolve(import.meta.dirname, "../..");

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
    expect(catalogOf("/repo/apps/web/src/features/issue/views/Board.tsx")).toBe("web.issue");
    expect(catalogOf("/repo/apps/server/src/gateway/lan/lan.ts")).toBe("server.lan");
    expect(catalogOf("/repo/apps/web/src/farm/phone/screens.tsx")).toBe("web.farm.phone");
    expect(catalogOf("/repo/apps/web/src/farm/hud/Hud.tsx")).toBe("web.farm");
    expect(catalogOf("/repo/apps/server/src/flows/farm.ts")).toBe("server");
    expect(catalogOf("/repo/packages/agent/src/brain.ts")).toBe("shared");
  });
});
