// The issue pages through the bridge (fakeHost plays the Rust side): an
// issue at work with its steps, one to review and its close dialog, one
// asking, a todo, a family, the list view, the display menu, the new issue
// sheet and the keys. Pictures: issues.shots.test.tsx.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import { withIssues } from "../fixtures/issues";
import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

const fixture = withIssues({ state, responses });

async function start(route = "/issues", width = 1200) {
  const fake = fakeHost(fixture, { route });
  const app = await open("./main.tsx", { width, height: 800, colorScheme: "light", platform: "macos", host: fake.options });
  await fake.pump(app);
  return { app, fake };
}

const ops = (fake: Awaited<ReturnType<typeof start>>["fake"]) => fake.calls.map((c) => c.op);

test("an issue at work: requirement, criteria, acts, its story and steps", async () => {
  const { app, fake } = await start("/issues/i32");
  expect(app.count("id:issue")).toBe(1);
  const texts = app.texts();
  for (const s of ["设置页按用途分组", "设置按四组排", "#32"]) expect(texts).toContain(s);
  expect(app.count("id:issue-requirement")).toBe(1);
  expect(app.count("id:criterion")).toBe(3);
  expect(app.count("id:act-tell")).toBe(1);
  expect(app.count("id:act-stop")).toBe(1);
  expect(app.count("id:milestone")).toBe(4);
  expect(ops(fake)).toContain("issue.timeline.get");
  // The steps are read when they are unfolded.
  expect(ops(fake)).not.toContain("session.event.list");
  await app.press("id:issue-steps-fold");
  await fake.pump(app);
  expect(ops(fake)).toContain("session.event.list");
  expect(app.count("id:issue-steps")).toBe(1);
  expect(app.texts()).toContain("vp test run src/base/session.test.ts");
});

test("tell opens a box under the acts", async () => {
  const { app } = await start("/issues/i32");
  await app.press("id:act-tell");
  expect(app.count("id:issue-tell")).toBe(1);
});

test("an issue to review: complete opens the close dialog on its changes", async () => {
  const { app, fake } = await start("/issues/i31");
  expect(app.count("id:criterion-tick")).toBe(3);
  expect(app.texts()).toContain("只测了过期前后各一秒");
  await app.press("id:act-complete");
  await fake.pump(app);
  expect(app.count("id:close-issue")).toBe(1);
  expect(app.count("id:changes-review")).toBe(1);
  expect(app.count("id:changed-file")).toBe(3);
  await app.press("label:apps/web/src/base/session.ts");
  expect(app.count("id:patch")).toBe(1);
});

test("closing an issue asks first", async () => {
  const { app } = await start("/issues/i31");
  await app.press("id:act-close");
  expect(app.count("id:close-issue")).toBe(1);
  expect(app.count("id:review-changes")).toBe(1);
  await app.press("id:close-never");
  expect(app.count("id:close-issue")).toBe(0);
});

test("an asking issue: an option is the answer", async () => {
  const { app, fake } = await start("/issues/i33");
  expect(app.count("id:issue-ask")).toBe(1);
  expect(app.count("id:answer-option")).toBe(2);
  await app.press("text:回登录页");
  await fake.pump(app);
  expect(fake.calls.some((c) => c.op === "issue.comment.create")).toBe(true);
});

test("a todo opens as its draft", async () => {
  const { app } = await start("/issues/i22");
  expect(app.value("id:issue-title")).toBe("看板拖拽的手感");
  expect(app.count("id:issue-remove")).toBe(1);
  expect(app.count("id:issue-unqueue")).toBe(1);
});

test("a draft in the backlog talks first", async () => {
  const { app } = await start("/issues/i21");
  expect(app.count("id:issue-talk")).toBe(1);
  expect(app.count("id:issue-start")).toBe(1);
  await app.press("id:issue-write-own");
  expect(app.count("id:issue-description")).toBe(1);
});

test("a family lists its children, each opens", async () => {
  const { app, fake } = await start("/issues/i40");
  expect(app.count("id:issue-family")).toBe(1);
  expect(app.count("id:child-issue")).toBe(2);
  await app.press("label:记住我");
  await fake.pump(app);
  expect(app.value("id:issue-title")).toBe("记住我");
});

test("back to the board, by its link and by Escape", async () => {
  const { app, fake } = await start("/issues/i32");
  await app.press("id:issue-close");
  await fake.pump(app);
  expect(app.count("id:issue")).toBe(0);
  expect(app.count("id:lane-todo")).toBe(1);
  await app.press("label:设置页按用途分组");
  await fake.pump(app);
  expect(app.count("id:issue")).toBe(1);
  await app.keyboard.press("escape");
  await fake.pump(app);
  expect(app.count("id:issue")).toBe(0);
});

test("the list view groups the issues by status", async () => {
  const { app } = await start();
  await app.press("id:issue-view-list");
  expect(app.count("id:issue-list")).toBe(1);
  expect(app.count("id:issue-group")).toBe(4);
  expect(app.count("id:issue-card")).toBe(13);
  await app.press("id:display");
  expect(app.count("id:display-menu")).toBe(1);
  await app.press("id:grouping-repo");
  expect(app.count("id:display-reset")).toBe(1);
});

test("a new issue from the board, by its card and by C", async () => {
  const { app, fake } = await start();
  await app.press("id:issue-new");
  expect(app.count("id:issue-new-dialog")).toBe(1);
  expect(app.enabled("id:issue-new-keep")).toBe(false);
  await app.type("id:issue-new-text", "登录页加一个忘记密码");
  await app.press("id:issue-new-keep");
  await fake.pump(app);
  expect(app.count("id:issue-new-dialog")).toBe(0);
  expect(ops(fake)).toContain("issue.create");
});

test("C writes a new issue on the board, not on an issue", async () => {
  const { app, fake } = await start();
  await app.keyboard.press("c");
  expect(app.count("id:issue-new-dialog")).toBe(1);
  await app.press("id:issue-new-dialog-never");
  await app.press("label:设置页按用途分组");
  await fake.pump(app);
  await app.keyboard.press("c");
  expect(app.count("id:issue-new-dialog")).toBe(0);
});

test("dragging a todo with its helper and repo into the working lane starts it; onto another todo places it before", async () => {
  const { app, fake } = await start();
  await app.dragAndHold("text:看板拖拽的手感", { x: 270, y: 0 });
  expect(app.count("id:drag-ghost")).toBe(1);
  await app.drop();
  await fake.pump(app);
  expect(app.count("id:drag-ghost")).toBe(0);
  const moved = fake.calls.filter((c) => c.op.startsWith("issue.") && JSON.stringify(c.payload).includes("i22"));
  expect(moved.length).toBeGreaterThan(0);
  await app.drag("text:灵动岛的动画", { x: 0, y: -60 });
  await fake.pump(app);
  const placed = fake.calls.find((c) => c.op === "issue.update" && (c.payload as { before?: string }).before !== undefined);
  expect(placed?.payload).toMatchObject({ id: "i23" });
});
