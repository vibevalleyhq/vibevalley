import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import type { VibeValleyApi } from "@vibevalley/protocol";

import { expect, test, choose } from "./fixtures";

const issue = (api: VibeValleyApi, title: string) => api.issue.create({ title });

const lane = (page: Page, key: string) => page.locator(`[data-testid="lane"][data-key="${key}"]`);
const card = (scope: Page | ReturnType<Page["locator"]>, id: string) => scope.locator(`[data-testid="issue-card"][data-key="${id}"]`);

test("native parent issues show child navigation and can merge without a parent session", async ({ page, api }, testInfo) => {
  const project = await api.project.create({ name: "native-family" });
  const parent = await api.issue.create({ title: "父子工单验收", project: project.name, agent: "docs" });
  await api.issue.split({ id: parent.id, tasks: [{ id: "clock", brief: "写打卡并提交", check: "test -f clock.ts" }] });
  await expect.poll(async () => (await api.issue.get({ id: parent.id })).status).toBe("in_review");
  const child = (await api.issue.history.list()).find((row) => row.issue.parent === parent.id)!.issue;
  await page.goto("/issues");
  await expect(card(lane(page, "waiting"), parent.id)).toBeVisible();
  await card(lane(page, "waiting"), parent.id).click();
  const family = page.getByTestId("issue-family");
  await expect(family).toBeVisible();
  await expect(family.getByTestId("child-issue")).toHaveCount(1);
  await expect(family.getByRole("textbox")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("family.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("family-mobile.png") });
  await family.getByTestId("child-issue").click();
  await expect(page).toHaveURL(new RegExp(`/issues/${child.id}$`, "u"));
  await page.getByTestId("parent-issue").click();
  await expect(family).toBeVisible();
  await family.locator('[data-act="complete"]').click();
  const close = page.getByTestId("close-issue");
  await expect(close).toBeVisible();
  await close.locator('[data-act="complete"]').click();
  await expect.poll(async () => (await api.issue.get({ id: parent.id })).status).toBe("done");
});

test("the placeholder card writes a new issue in a dialog, and the board shows it in todo without a reload", async ({ page, api }) => {
  const title = "add a shortcut to the board";
  await page.goto("/issues");
  await expect(page.getByTestId("link")).toHaveAttribute("data-state", "open");
  await page.getByTestId("issue-new").click();
  const dialog = page.getByTestId("issue-new-dialog");
  await expect(page.getByTestId("issue-new-text")).toBeFocused();
  // Read once it has popped in: mid-way its words are still fading up.
  await dialog.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const { violations } = await new AxeBuilder({ page }).include('[data-testid="issue-new-dialog"]').withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(violations.map((v) => v.id)).toEqual([]);
  await page.getByTestId("issue-new-text").fill(title);
  await page.keyboard.press("ControlOrMeta+Enter");
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await api.issue.list({})).some((i) => i.title === title)).toBe(true);
  const made = (await api.issue.list({})).find((i) => i.title === title)!;
  await expect(card(lane(page, "todo"), made.id)).toBeVisible();
  // With no helper and no project the server refuses the draft, after asking the runtimes (a few seconds); the board stays.
  await expect(page.getByTestId("toast").first()).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/issues$/u);
  await expect(card(lane(page, "todo"), made.id)).toBeVisible();
  // Its own page, and Escape back to the board.
  await card(lane(page, "todo"), made.id).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${made.id}$`, "u"));
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/issues$/u);
});

test("C opens a new issue on the board, but not while a field has the focus", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.getByTestId("issue-new")).toBeVisible();
  await page.getByTestId("issue-search").focus();
  await page.keyboard.press("c");
  await expect(page.getByTestId("issue-new-dialog")).toBeHidden();
  await page.locator("body").click({ position: { x: 600, y: 600 } });
  await page.keyboard.press("c");
  await expect(page.getByTestId("issue-new-text")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("issue-new-dialog")).toBeHidden();
});

test("the list view and its grouping are kept across a reload", async ({ page, api }) => {
  const made = await issue(api, "one in the list");
  await page.goto("/issues");
  const view = page.getByTestId("issue-view");
  await view.locator('[data-key="list"]').click();
  await page.getByTestId("display").click();
  await page.getByTestId("grouping").locator('[data-key="project"]').click();
  const noProject = page.locator('[data-testid="issue-group"][data-key=""]');
  await expect(noProject).toBeVisible();
  await page.reload();
  await expect(view.locator('[data-key="list"]')).toHaveAttribute("aria-pressed", "true");
  await expect(card(noProject, made.id)).toBeVisible();
  await page.getByTestId("display").click();
  await page.getByTestId("display-reset").click();
  await view.locator('[data-key="board"]').click();
  await expect(lane(page, "todo")).toBeVisible();
});

test("an issue opens at its own address and its edits are saved", async ({ page, api }) => {
  const made = await issue(api, "before the title changes");
  await page.goto("/issues");
  await card(lane(page, "todo"), made.id).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${made.id}$`, "u"));
  const detail = page.getByTestId("issue");
  // A new draft starts from one sentence to draft from; the description is written by asking for it.
  await expect(detail.getByTestId("issue-description")).toHaveCount(0);
  await detail.getByTestId("issue-write-own").click();
  await detail.getByTestId("issue-title").fill("after the title changes");
  await detail.getByTestId("issue-description").fill("The login page remembers the last user name.");
  await choose(detail.getByTestId("issue-priority"), "high");
  await detail.getByTestId("issue-save").click();
  await expect(detail.getByTestId("issue-save")).toBeHidden();
  await expect.poll(async () => (await api.issue.get({ id: made.id })).title).toBe("after the title changes");
  const saved = await api.issue.get({ id: made.id });
  expect([saved.description, saved.priority]).toEqual(["The login page remembers the last user name.", "high"]);
  await page.reload();
  await expect(page.getByTestId("issue").getByTestId("issue-title")).toHaveValue("after the title changes");
});

test("starting an issue with no helper asks for one", async ({ page, api }) => {
  const made = await issue(api, "no helper yet");
  await page.goto("/issues");
  await card(lane(page, "todo"), made.id).dragTo(lane(page, "working"));
  await expect(page.getByTestId("toast").first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/issues/${made.id}$`, "u"));
  await expect(page.getByTestId("issue").getByTestId("issue-start")).toBeDisabled();
  expect((await api.issue.get({ id: made.id })).status).toBe("backlog");
});

test("a todo dragged onto another goes before it", async ({ page, api }) => {
  const first = await issue(api, "order first");
  const second = await issue(api, "order second");
  await page.goto("/issues");
  const todo = lane(page, "todo");
  await card(todo, second.id).dragTo(card(todo, first.id));
  await expect
    .poll(async () => {
      const ids = (await api.issue.history.list()).map((r) => r.issue.id);
      return ids.indexOf(second.id) < ids.indexOf(first.id);
    })
    .toBe(true);
});

test("the search keeps only the cards it matches, and clearing it brings them back", async ({ page, api }) => {
  const apple = await issue(api, "the apple to find");
  const banana = await issue(api, "the banana to hide");
  await page.goto("/issues");
  const todo = lane(page, "todo");
  await expect(card(todo, banana.id)).toBeVisible();
  await page.getByTestId("issue-search").fill("apple");
  await expect(card(todo, apple.id)).toBeVisible();
  await expect(card(todo, banana.id)).toHaveCount(0);
  await page.getByTestId("filter-clear").click();
  await expect(card(todo, banana.id)).toBeVisible();
});

test("the board's filter by project and helper is in the address: a reload and an issue opened and closed keep it", async ({ page, api }) => {
  const kept = await api.project.create({ name: "in-the-address" });
  const inKept = await api.issue.create({ title: "one in the address", project: kept.name });
  const other = await issue(api, "one elsewhere");
  await page.goto("/issues");
  const todo = lane(page, "todo");
  await page.getByTestId("filter-project").click();
  await page.locator(`[role="option"][data-key="${kept.name}"]`).click();
  await expect(page).toHaveURL(/[?&]project=in-the-address/u);
  await page.reload();
  await expect(page.getByTestId("filter-project")).toHaveAttribute("data-value", kept.name);
  await expect(card(todo, inKept.id)).toBeVisible();
  await expect(card(todo, other.id)).toHaveCount(0);
  await card(todo, inKept.id).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${inKept.id}\\?project=in-the-address$`, "u"));
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/\/issues\?project=in-the-address$/u);
  await page.getByTestId("filter-clear").click();
  await expect(page).not.toHaveURL(/project=/u);
  await expect(card(todo, other.id)).toBeVisible();
});

test("a card shows only what differs from its lane, an empty lane is a place to drop, and a filter narrows the board", async ({ page, api }) => {
  const plain = await issue(api, "a plain draft");
  const urgent = await issue(api, "an urgent draft");
  await api.issue.update({ id: urgent.id, priority: "urgent" });
  const kept = await api.project.create({ name: "kept" });
  const inKept = await api.issue.create({ title: "one in kept", project: kept.name });
  await page.goto("/issues");
  const todo = lane(page, "todo");
  // A draft in todo with no helper and no priority: nothing to mark but its being a draft.
  await expect(card(todo, plain.id).getByTestId("card-marks").locator("svg")).toHaveCount(0);
  await expect(card(todo, urgent.id).getByTestId("card-marks").locator("svg").first()).toBeVisible();
  await expect(lane(page, "working").getByTestId("lane-empty")).toBeVisible();
  const working = await lane(page, "working").boundingBox();
  expect(working!.height).toBeLessThan(200);

  await page.getByTestId("filter-project").click();
  await page.locator('[role="option"][data-key="kept"]').click();
  await expect(page.getByTestId("filter-project")).toHaveAttribute("data-value", "kept");
  await expect(card(todo, inKept.id)).toBeVisible();
  await expect(card(todo, plain.id)).toHaveCount(0);
  await page.getByTestId("filter-clear").click();
  await expect(card(todo, plain.id)).toBeVisible();
});
