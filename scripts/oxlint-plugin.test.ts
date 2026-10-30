import { RuleTester } from "vite-plus/lint/plugins-dev";
import { describe, it } from "vite-plus/test";

import plugin from "./oxlint-plugin.ts";

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
    { code: "import { a } from '../base/router';", filename: page("ui/A.tsx") },
    { code: "import { a } from '../issue';", filename: page("features/channel/Chat.tsx") },
    { code: "import { a } from './rules';", filename: page("features/issue/Board.tsx") },
    { code: "import { a } from '../../features/issue';", filename: page("farm/panels/Board.tsx") },
    { code: "import { a } from '../ui/A';", filename: "/repo/apps/server/src/x.ts" },
    { code: "import { a } from '@/base/router';", filename: page("ui/A.tsx") },
    { code: "import { a } from '@/features/issue';", filename: page("farm/panels/Board.tsx") },
  ],
  invalid: [
    { code: "import { a } from '../features/issue';", filename: page("ui/A.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '../../farm/scene';", filename: page("features/issue/Board.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '../issue/rules';", filename: page("features/channel/Chat.tsx"), errors: [{ messageId: "index" }] },
    { code: "export { a } from '../tree/x';", filename: page("farm/a.ts"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '@/features/issue';", filename: page("ui/A.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '@/issue/rules';", filename: page("features/channel/Chat.tsx"), errors: [{ messageId: "layer" }] },
    { code: "import { a } from '@/features/issue/rules';", filename: page("features/channel/Chat.tsx"), errors: [{ messageId: "index" }] },
  ],
});

tester.run("parent-import", rule("parent-import"), {
  valid: [
    { code: "import { a } from './rules';", filename: page("features/issue/Board.tsx") },
    { code: "import { a } from '@/base/router';", filename: page("ui/A.tsx") },
    { code: "import { a } from '../../db/generated/x.ts';", filename: "/repo/apps/server/src/issue/issue.ts" },
    { code: "import { a } from '../x';", filename: "/repo/packages/agent/src/core/loop.ts" },
  ],
  invalid: [
    { code: "import { a } from '../base/router';", filename: page("ui/A.tsx"), errors: [{ messageId: "parent" }] },
    { code: "export * from '../issue/rules.ts';", filename: "/repo/apps/server/src/task/x.ts", errors: [{ messageId: "parent" }] },
    { code: "const m = import('../../ui/A');", filename: page("features/issue/Board.tsx"), errors: [{ messageId: "parent" }] },
  ],
});

tester.run("promise-boundary", rule("promise-boundary"), {
  valid: [
    { code: "const a = Effect.tryPromise(async () => { await x(); });", filename: "/repo/apps/server/src/a.ts" },
    { code: "const a = Effect.tryPromise({ try: async (signal) => f(signal), catch: e });", filename: "/repo/apps/server/src/a.ts" },
    { code: "const a = Effect.promise(async () => g());", filename: "/repo/apps/server/src/a.ts" },
    { code: "const a = () => fetch(u).then((r) => r.text());", filename: "/repo/apps/server/src/a.ts" },
  ],
  invalid: [
    { code: "async function a() {}", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "async" }] },
    { code: "const a = async () => { await b(); };", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "async" }] },
    { code: "const a = Effect.tryPromise(() => run(async () => 1));", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "async" }] },
    { code: "const a = new Promise((r) => r(1));", filename: "/repo/apps/server/src/a.ts", errors: [{ messageId: "promise" }] },
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
