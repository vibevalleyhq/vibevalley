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

tester.run("no-test-sleep", rule("no-test-sleep"), {
  valid: ["until(() => done)", "vi.advanceTimersByTimeAsync(1000)", "clock.sleep(10)", "other.sleep(10)"],
  invalid: [
    { code: "import {setTimeout as pause} from 'node:timers/promises'; pause(1)", errors: [{ messageId: "sleep" }] },
    { code: "globalThis.setTimeout(f, 1)", errors: [{ messageId: "sleep" }] },
    { code: "page.waitForTimeout(500)", errors: [{ messageId: "sleep" }] },
    { code: "setTimeout(f, 10)", errors: [{ messageId: "sleep" }] },
  ],
});

tester.run("no-component-interval", rule("no-component-interval"), {
  valid: ["const clock = useNow();", "useInterval(() => tick(), 1000);", "obj.setInterval(f, 1000);"],
  invalid: [
    { code: "const t = setInterval(f, 1000);", errors: [{ messageId: "interval" }] },
    { code: "const t = globalThis.setInterval(f, 1000);", errors: [{ messageId: "interval" }] },
  ],
});

tester.run("no-comment-divider", rule("no-comment-divider"), {
  valid: ["// The lease outlives the request: a retry finds it.\nlet a = 1;", "/** Docs. */\nlet a = 1;"],
  invalid: [
    { code: "// ── Helpers ──\nlet a = 1;", errors: [{ messageId: "divider" }] },
    { code: "// ----------\nlet a = 1;", errors: [{ messageId: "divider" }] },
    { code: "// ---- Section ----\nlet a = 1;", errors: [{ messageId: "divider" }] },
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
    { code: "const v = <View style={{ flex: 1, gap: 8 }} />", filename: "a.tsx", errors: [{ messageId: "fixedStyle" }] },
    { code: "const v = <div style='display: grid' />", filename: "a.tsx", errors: [{ messageId: "fixedStyle" }] },
  ],
});

// Real paths: which package a file is in is read from the package.json files above it.
const inRepo = (path: string) => join(import.meta.dirname, "../..", path);

tester.run("no-cross-package-path", rule("no-cross-package-path"), {
  valid: [
    { code: "import { a } from './api-client.ts';", filename: inRepo("scripts/gen/capabilities.ts") },
    { code: "import { a } from '../base/links.ts';", filename: inRepo("apps/site/src/ui/x.ts") },
    { code: "import { a } from '@vibevalley/protocol/api';", filename: inRepo("scripts/gen/capabilities.ts") },
  ],
  invalid: [
    { code: "import { a } from '../../packages/protocol/src/api.ts';", filename: inRepo("scripts/gen/capabilities.ts"), errors: [{ messageId: "cross" }] },
    { code: "export * from '../../i18n/src/format.ts';", filename: inRepo("packages/protocol/src/x.ts"), errors: [{ messageId: "cross" }] },
    { code: "const m = import('../../../packages/i18n/src/format.ts');", filename: inRepo("apps/mac/ui/app/x.ts"), errors: [{ messageId: "cross" }] },
  ],
});

tester.run("child-process-door", rule("child-process-door"), {
  valid: [{ code: 'import type { ChildProcess } from "node:child_process";', filename: "/repo/apps/site/test/a.ts" }, 'import { join } from "node:path";'],
  invalid: [
    { code: 'import { execFileSync } from "node:child_process";', errors: [{ messageId: "spawn" }] },
    { code: 'import * as cp from "child_process";', errors: [{ messageId: "spawn" }] },
  ],
});

tester.run("one-absent", rule("one-absent"), {
  valid: [
    { code: "let a: string | undefined;", filename: "/repo/packages/protocol/src/a.ts" },
    { code: "let a: string | null;", filename: "/repo/packages/protocol/src/a.ts" },
  ],
  invalid: [{ code: "let a: string | null | undefined;", filename: "/repo/packages/protocol/src/a.ts", errors: [{ messageId: "both" }] }],
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

tester.run("ui-layer-boundaries", rule("ui-layer-boundaries"), {
  valid: [
    { code: "import { x } from '../infra/query';", filename: "/repo/apps/mac/ui/design/Face.tsx" },
    { code: "import { Button } from '../../design/Button';", filename: "/repo/apps/mac/ui/features/issue/Board.tsx" },
    { code: "import { api } from '../../infra/api';", filename: "/repo/apps/mac/ui/features/issue/Board.tsx" },
    { code: "import { perform } from '../features/issue/acts';", filename: "/repo/apps/mac/ui/farm/FarmForm.tsx" },
    { code: "import { Root } from '../infra/Root';", filename: "/repo/apps/mac/ui/farm/FarmForm.tsx" },
    { code: "import { mix } from '../design/tone';", filename: "/repo/apps/mac/ui/workspace/Sidebar.tsx" },
    { code: "import { IssuesPage } from '../features/issue/IssuesPage';", filename: "/repo/apps/mac/ui/app/Workbench.tsx" },
    { code: "import { FarmForm } from './farm/FarmForm';\nimport { Sidebar } from './workspace/Sidebar';", filename: "/repo/apps/mac/ui/App.tsx" },
    { code: "import { Root } from '../infra/Root';", filename: "/repo/apps/mac/ui/app/issues.story.tsx" },
    { code: "import { a } from '../../features/foo';", filename: "/repo/apps/mac/ui/design/Foo.test.tsx" },
  ],
  invalid: [
    { code: "import { richNative } from '../../design/rich/native';", filename: "/repo/apps/mac/ui/infra/base/search.ts", errors: [{ messageId: "layer" }] },
    {
      code: "import { orchestratorLooks } from '../../features/orchestrator/looks';",
      filename: "/repo/apps/mac/ui/design/domain/Face.tsx",
      errors: [{ messageId: "layer" }],
    },
    { code: "import { Shell } from '../../app/Shell';", filename: "/repo/apps/mac/ui/features/issue/Board.tsx", errors: [{ messageId: "layer" }] },
    { code: "import { Root } from '../app/Root';", filename: "/repo/apps/mac/ui/farm/FarmForm.tsx", errors: [{ messageId: "layer" }] },
    { code: "import { FarmPhone } from '../farm/FarmPhone';", filename: "/repo/apps/mac/ui/workspace/Sidebar.tsx", errors: [{ messageId: "layer" }] },
    { code: "import { FarmForm } from '../farm/FarmForm';", filename: "/repo/apps/mac/ui/app/Workbench.tsx", errors: [{ messageId: "layer" }] },
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
      const see = / See (\S+)$/u.exec(text)?.[1];
      expect(text, where).toMatch(/\. Fix: .+\. See \S+$/u);
      expect(existsSync(resolve(root, see ?? "")), `${where}: ${see}`).toBe(true);
    }
  });

  it("leaves no-restricted-imports no message of its own outside refused", () => {
    expect(readFileSync(resolve(root, "vite.config.ts"), "utf8")).not.toMatch(/message: ["'`]/u);
  });

  it("names the catalog the file's words belong in", () => {
    expect(catalogOf("/repo/apps/mac/ui/features/issue/views/Board.tsx")).toBe("web.issue");
    expect(catalogOf("/repo/apps/mac/ui/design/pixel/Toast.tsx")).toBe("web.ui.pixel");
    expect(catalogOf("/repo/apps/mac/ui/design/Button.tsx")).toBe("web");
    expect(catalogOf("/repo/apps/mac/ui/app/Shell.tsx")).toBe("web");
    expect(catalogOf("/repo/apps/mac/ui/workspace/Sidebar.tsx")).toBe("web.shell");
    expect(catalogOf("/repo/packages/protocol/src/client.ts")).toBe("shared");
    expect(catalogOf("/repo/apps/site/src/sections/Hero.tsx")).toBe("shared");
  });
});
