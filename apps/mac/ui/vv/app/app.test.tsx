// The whole workbench on the bridge, the Rust side played by fakeHost:
// the shell, the router and the issues page read from the state frame and
// the answered calls. pictures come from shots.test.tsx (no host handlers on a real host).
import "../polyfill";
import { expect, open, test } from "nsh/test";

import { repos } from "../fixtures/agents";
import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

const shoot = async (app: Awaited<ReturnType<typeof open>>, name: string) => {
  try {
    await app.screenshot(`vv/app/shots/${name}.png`);
  } catch {
    // headless runs draw nothing
  }
};

async function start(options: { scheme?: "light" | "dark"; width?: number; route?: string } = {}) {
  const fake = fakeHost({ state, responses }, { route: options.route ?? "/issues" });
  const app = await open("./main.tsx", {
    width: options.width ?? 1200,
    height: 720,
    colorScheme: options.scheme ?? "light",
    platform: "macos",
    host: fake.options,
  });
  await fake.pump(app);
  return { app, fake };
}

for (const scheme of ["light", "dark"] as const) {
  test(`issues through the bridge, ${scheme}`, async () => {
    const { app, fake } = await start({ scheme });
    const texts = app.texts();
    for (const s of ["工单", "待办", "处理中", "等你看", "已关", "修好登录", "补齐看板的测试"]) expect(texts).toContain(s);
    expect(app.count("id:issue-card")).toBe(7);
    expect(fake.calls.map((c) => c.op)).toContain("issue.history.list");
    expect(app.count("id:rail")).toBe(1);
    await shoot(app, `issues-${scheme}`);
  });
}

test("a new frame moves a card", async () => {
  const { app, fake } = await start();
  const moved = (state.state.issues as { id: string; status: string }[]).map((i) => (i.id === "i23" ? { ...i, status: "canceled" } : i));
  await fake.setState(app, { ...state, state: { ...state.state, issues: moved } });
  expect(app.count("id:issue-card")).toBe(7);
});

test("the rail goes to another place and back", async () => {
  const { app, fake } = await start();
  await app.press("id:place-catalog");
  await fake.pump(app);
  await app.waitUntil(() => app.count("id:catalog-page") === 1);
  await app.press("id:place-issues");
  await fake.pump(app);
  await app.waitUntil(() => app.count("id:issues-page") === 1);
});

test("an issue opens at its address", async () => {
  const { app } = await start({ route: "/issues/i18" });
  expect(app.count("id:issue")).toBe(1);
  expect(app.texts()).toContain("修好登录");
});

test("narrow", async () => {
  const { app } = await start({ width: 560 });
  expect(app.count("id:rail")).toBe(1);
  await shoot(app, "issues-narrow");
});

test("regression: resizing the global shell changes its rail without navigating", async () => {
  const fake = fakeHost({ state, responses }, { route: "/issues", globalShell: true });
  const app = await open("./main.tsx", { width: 1200, height: 720, platform: "macos", host: fake.options });
  await fake.pump(app);
  const routes = fake.acts.filter((a) => a.type === "global_route").length;
  await app.setViewport(600, 600);
  await fake.pump(app);
  expect(fake.acts.filter((a) => a.type === "global_route").length).toBe(routes);
  expect(fake.acts.filter((a) => a.type === "global_rail").at(-1)).toEqual({ type: "global_rail", rail_width: 68 });
});

test("/farm goes to the repo worked in most recently and asks the shell for its farm; /tree asks for the tree", async () => {
  const fake = fakeHost({ state, responses: { ...responses, "repo.list": repos } }, { route: "/farm" });
  const app = await open("./main.tsx", { width: 1200, height: 720, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  await fake.pump(app);
  expect(app.count("id:farm")).toBe(1);
  expect(fake.acts.filter((a) => a.type === "openFarm").at(-1)).toEqual({ type: "openFarm", repo: "vibevalley" });
  const tree = fakeHost({ state, responses }, { route: "/tree" });
  const treeApp = await open("./main.tsx", { width: 1200, height: 720, colorScheme: "light", platform: "macos", host: tree.options });
  await tree.pump(treeApp);
  expect(treeApp.count("id:tree")).toBe(1);
  expect(tree.acts).toContainEqual({ type: "openTree" });
});

test("? opens the shortcut sheet: every place with its keys", async () => {
  const { app } = await start();
  expect(app.count("id:shortcut-place")).toBe(0);
  await app.keyboard.press("shift+/");
  expect(app.count("id:shortcuts")).toBe(1);
  expect(app.count("id:shortcut-place")).toBe(8);
  expect(app.texts()).toContain("⌘");
});
