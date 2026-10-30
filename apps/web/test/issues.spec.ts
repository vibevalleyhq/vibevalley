import type { Page } from "@playwright/test";

import type { VibeValleyApi } from "@vibevalley/protocol";

import { expect, test, choose } from "./fixtures";

const issue = (api: VibeValleyApi, title: string) => api.issue.create({ title });

const lane = (page: Page, key: string) => page.locator(`[data-testid="lane"][data-key="${key}"]`);
const card = (scope: Page | ReturnType<Page["locator"]>, id: string) => scope.locator(`[data-testid="issue-card"][data-key="${id}"]`);

test("a quick add shows the new issue in todo without a reload", async ({ page, api }) => {
  const title = "add a shortcut to the board";
  await page.goto("/issues");
  await expect(page.getByTestId("link")).toHaveAttribute("data-state", "open");
  await page.getByTestId("quick-add").fill(title);
  await page.keyboard.press("Enter");
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

test("a card shows only what differs from its lane, an empty lane is a place to drop, and a filter narrows the board", async ({ page, api }) => {
  const plain = await issue(api, "a plain draft");
  const urgent = await issue(api, "an urgent draft");
  await api.issue.update({ id: urgent.id, priority: "urgent" });
  const kept = await api.project.create({ name: "kept" });
  const inKept = await api.issue.create({ title: "one in kept", project: kept.name });
  await page.goto("/issues");
  const todo = lane(page, "todo");
  // A draft in 待办 with no helper and no priority: nothing to mark but its being a draft.
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
