// The farm's HUD and panels (src/farm/hud, src/farm/panels) against a real server: the tools by key, each panel opened
// from the HUD and closed with Esc, and sowing an empty plot. Nothing here sends a real coding agent out: profiles run
// "nobody", and the server has no model key.

import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

/** A project's farm, or the farm of the sessions without one. */
async function openFarm(page: Page, project = "") {
  await page.goto(`/farm/${project}`);
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 20_000 });
}

/** The top left bed's soil (village.ldtk: Plot 0 stands at 128, 129). */
async function clickFirstPlot(page: Page) {
  const box = (await page.getByTestId("village").locator("canvas").boundingBox())!;
  const scale = box.width / 384;
  await page.mouse.click(box.x + 128 * scale, box.y + 117 * scale);
}

test("the hand is held first, and a number key picks a tool", async ({ page }) => {
  await openFarm(page);
  const tools = page.getByRole("toolbar");
  await expect(tools.getByRole("button")).toHaveCount(6);
  await expect(page.getByTestId("tool-hand")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("2");
  await expect(page.getByTestId("tool-water")).toHaveAttribute("aria-pressed", "true");
});

test("each panel opens from the HUD and Esc closes it", async ({ page }) => {
  await openFarm(page);
  await page.getByTestId("hud-graphs").click();
  const tasks = page.getByTestId("graphs");
  await expect(tasks).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(tasks).toHaveCount(0);

  await page.getByTestId("hud-orchestrator").click();
  const looks = page.getByTestId("orchestrator");
  await looks.locator('[data-key="foreman"]').click();
  await expect(looks.locator('[data-key="foreman"]')).toHaveAttribute("aria-pressed", "true");
  await looks.locator('[data-key="farmer"]').click();
  await expect(looks.locator('[data-key="farmer"]')).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(looks).toHaveCount(0);

  await page.getByTestId("hud-menu").click();
  const menu = page.getByTestId("menu");
  await menu.getByTestId("menu-resume").click();
  await expect(menu).toHaveCount(0);
});

test("a project's farm names it on the sign; an empty plot sows in it, and a draft makes the issue in the backlog", async ({ page, api }) => {
  await api.project.create({ name: "farm-hud" });
  await openFarm(page, "farm-hud");
  await expect(page.getByTestId("project-sign")).toHaveAttribute("data-key", "farm-hud");
  await clickFirstPlot(page);
  const sow = page.getByTestId("sow");
  await expect(sow.getByTestId("sow-form")).toHaveAttribute("data-project", "farm-hud");
  // One kind of seed at a time, behind its tab.
  await sow.locator('[role="tab"][data-key="test"]').click();
  await expect(sow.locator('[data-testid="seed"][data-key="recent"]')).toBeVisible();
  await expect(sow.locator('[data-testid="seed"][data-key="build-errors"]')).toHaveCount(0);
  // Focused, a field shows it on its box only: no second ring inside (style.css keeps :focus-visible in the base layer).
  const words = sow.getByRole("textbox");
  await words.focus();
  await page.keyboard.type("x");
  await expect(words).toHaveCSS("outline-style", "none");
  await words.fill("add a night mode to the clock-in page");
  await expect(sow.getByTestId("sow-start")).toBeEnabled();
  await sow.getByTestId("sow-draft").click();
  await expect(page).toHaveURL(/\/issues\/.+/u);
  const made = (await api.issue.list({})).find((i) => i.title.includes("night mode"));
  expect([made?.project, made?.status]).toEqual(["farm-hud", "backlog"]);
  await page.goto("/farm/farm-hud");
  await page.getByTestId("project-sign").click();
  await expect(page).toHaveURL(/\/projects$/u);
});

test("/farm opens the farm entered last, and a farm with no project sends sowing to the map", async ({ page, api }) => {
  await api.project.create({ name: "farm-home" });
  // A device that never entered a farm still lands on one: going back to the farm never strands it on the map.
  await page.goto("/farm");
  await expect(page).toHaveURL(/\/farm\/.+/u);
  await openFarm(page, "farm-home");
  await page.goto("/farm");
  await expect(page).toHaveURL(/\/farm\/farm-home$/u);
  await openFarm(page);
  await clickFirstPlot(page);
  const sow = page.getByTestId("sow");
  await expect(sow.getByTestId("sow-homeless")).toBeVisible();
  await sow.getByTestId("sow-to-map").click();
  await expect(page).toHaveURL(/\/projects$/u);
});

test("the helpers open, and a click elsewhere folds them and a helper's card", async ({ page }) => {
  await openFarm(page);
  const friends = page.getByTestId("friends");
  await friends.getByTestId("friends-toggle").click();
  const helpers = friends.getByTestId("friend");
  await expect(helpers.nth(1)).toBeVisible();
  await helpers.nth(0).getByTestId("friend-open").click();
  const card = friends.getByTestId("friend-card");
  await expect(card).toBeVisible();
  await page.mouse.click(720, 300);
  await expect(card).toHaveCount(0);
  await expect(helpers).toHaveCount(0);
});
