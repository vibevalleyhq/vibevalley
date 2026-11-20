// Pictures of the issue pages (issues.story.tsx: the workbench with the
// issue pages' own cases): run with `--target gpui` (the host VibeValley
// renders with) or `--target macos`; headless it only checks the pages
// came up. `then` presses its way to a dialog or a view first.
import "../polyfill";
import { expect, open, test } from "nsh/test";

type App = Awaited<ReturnType<typeof open>>;
type Shot = { name: string; route?: string; session?: string; scheme: "light" | "dark"; width: number; ready: string; after?: (app: App) => Promise<void> };

const steps = async (app: App) => {
  await app.press("id:issue-steps-fold");
  await app.wait(300);
};

const shots: Shot[] = [
  { name: "issue-working-light", route: "/issues/i32", scheme: "light", width: 1200, ready: "id:issue", after: steps },
  { name: "issue-working-dark", route: "/issues/i32", scheme: "dark", width: 1200, ready: "id:issue", after: steps },
  { name: "issue-working-narrow", route: "/issues/i32", scheme: "light", width: 560, ready: "id:issue" },
  { name: "issue-review-light", route: "/issues/i31", scheme: "light", width: 1200, ready: "id:issue" },
  { name: "issue-asking-dark", route: "/issues/i33", scheme: "dark", width: 1200, ready: "id:issue" },
  { name: "issue-todo-light", route: "/issues/i22", scheme: "light", width: 1200, ready: "id:issue" },
  { name: "issue-draft-dark", route: "/issues/i21", scheme: "dark", width: 1200, ready: "id:issue" },
  { name: "issue-family-light", route: "/issues/i40", scheme: "light", width: 1200, ready: "id:issue-family" },
  { name: "issue-family-narrow", route: "/issues/i40", scheme: "dark", width: 560, ready: "id:issue-family" },
  { name: "issue-list-light", route: "/issues", scheme: "light", width: 1200, ready: "id:issues-page", after: (app) => app.press("id:issue-view-list") },
  { name: "issue-list-dark", route: "/issues", scheme: "dark", width: 1200, ready: "id:issues-page", after: (app) => app.press("id:issue-view-list") },
  { name: "issue-list-narrow", route: "/issues", scheme: "light", width: 560, ready: "id:issues-page", after: (app) => app.press("id:issue-view-list") },
  {
    name: "issue-display-light",
    route: "/issues",
    scheme: "light",
    width: 1200,
    ready: "id:issues-page",
    after: async (app) => {
      await app.press("id:issue-view-list");
      await app.press("id:display");
    },
  },
  { name: "issue-new-light", route: "/issues", scheme: "light", width: 1200, ready: "id:issues-page", after: (app) => app.press("id:issue-new") },
  { name: "issue-new-dark", route: "/issues", scheme: "dark", width: 1200, ready: "id:issues-page", after: (app) => app.press("id:issue-new") },
  { name: "issue-close-light", route: "/issues/i31", scheme: "light", width: 1200, ready: "id:issue", after: (app) => app.press("id:act-close") },
  { name: "issue-close-review-light", route: "/issues/i31", scheme: "light", width: 1200, ready: "id:issue", after: (app) => app.press("id:act-complete") },
  { name: "issue-close-review-dark", route: "/issues/i31", scheme: "dark", width: 1200, ready: "id:issue", after: (app) => app.press("id:act-complete") },
  ...(["light", "dark"] as const).map((scheme) => ({
    name: `issue-close-patch-${scheme}`,
    route: "/issues/i31",
    scheme,
    width: 1200,
    ready: "id:issue",
    after: async (app: Parameters<NonNullable<(typeof shots)[number]["after"]>>[0]) => {
      await app.press("id:act-complete");
      await app.wait(500);
      await app.press("label:apps/web/src/base/session.ts");
    },
  })),
  { name: "orchestrator-trajectory-light", route: "/orchestrator/trajectory", scheme: "light", width: 1200, ready: "id:orchestrator-page" },
  { name: "session-worklog-light", session: "worklog", scheme: "light", width: 900, ready: "id:session-story" },
  { name: "session-worklog-dark", session: "worklog", scheme: "dark", width: 900, ready: "id:session-story" },
  { name: "session-trajectory-light", session: "trajectory", scheme: "light", width: 1000, ready: "id:trajectory" },
  { name: "session-trajectory-dark", session: "trajectory", scheme: "dark", width: 1000, ready: "id:trajectory" },
];

for (const s of shots) {
  test(s.name, async () => {
    const params: Record<string, string> = {};
    if (s.route) params.route = s.route;
    if (s.session) params.session = s.session;
    const app = await open("./issues.story.tsx", { width: s.width, height: 800, colorScheme: s.scheme, platform: "macos", host: { params } });
    await app.waitFor(s.ready);
    expect(app.count(s.ready)).toBeGreaterThan(0);
    await s.after?.(app);
    await app.wait(200);
    try {
      await app.screenshot(`vv/app/shots/${s.name}.png`);
    } catch (e) {
      // headless runs draw nothing; on a host, say why there is no picture
      console.log(`no picture of ${s.name}: ${String(e)}`);
    }
  });
}
