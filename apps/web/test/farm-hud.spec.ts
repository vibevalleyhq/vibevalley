// The farm's HUD and panels (src/farm/hud, src/farm/panels) against a real server: the HUD's parts, the tools by key,
// each panel opened from the HUD and closed with Esc, and sowing an empty plot. Nothing here sends a real coding agent
// out: profiles run "nobody", and the server has no model key.

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

test("the HUD shows the farm's level and the tools, and a number key picks a tool", async ({ page }) => {
  await openFarm(page);
  await expect(page.getByRole("button", { name: "任务与成就" })).toContainText("Lv.1");
  const tools = page.getByRole("toolbar", { name: "农具" });
  await expect(tools.getByRole("button")).toHaveCount(6);
  await expect(tools.getByRole("button", { name: /^手/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("2");
  await expect(tools.getByRole("button", { name: /^浇水/ })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: test.info().outputPath("hud.png") });
});

test("each panel opens from the HUD and Esc closes it", async ({ page }) => {
  await openFarm(page);
  await page.getByRole("button", { name: "任务与成就" }).click();
  const tasks = page.getByRole("dialog", { name: "任务与成就" });
  await expect(tasks).toBeVisible();
  await expect(tasks.getByText(/新手任务 \d+\/\d+/)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("achievements.png") });
  await page.keyboard.press("Escape");
  await expect(tasks).toHaveCount(0);

  await page.getByRole("button", { name: "换管家的样子" }).click();
  const looks = page.getByRole("dialog", { name: "管家和宠物" });
  await looks.getByRole("button", { name: /包工头/ }).click();
  await expect(looks.getByRole("button", { name: /包工头/ })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(looks).toHaveCount(0);

  await page.getByRole("button", { name: "菜单（Esc）" }).click();
  const menu = page.getByRole("dialog", { name: "菜单" });
  await menu.getByRole("button", { name: "继续" }).click();
  await expect(menu).toHaveCount(0);
});

test("a project's farm names it on the sign; an empty plot sows in it, and 草稿 makes the issue in the backlog", async ({ page, api }) => {
  await api.project.create({ name: "farm-hud" });
  await openFarm(page, "farm-hud");
  // The farm is the project's: its sign says so, and goes back to the map.
  await expect(page.getByRole("button", { name: "项目牌：farm-hud" })).toBeVisible();
  const canvas = page.getByTestId("village").locator("canvas");
  const box = (await canvas.boundingBox())!;
  const scale = box.width / 384;
  // The top left bed's soil (village.ldtk: Plot 0 stands at 128, 129).
  await page.mouse.click(box.x + 128 * scale, box.y + 117 * scale);
  const sow = page.getByRole("dialog", { name: "播种 · 第 1 块地" });
  await expect(sow).toBeVisible();
  await expect(sow.getByText("种在 farm-hud")).toBeVisible();
  // 常见的活: one kind at a time behind its tab.
  const kinds = sow.getByRole("tablist", { name: "常见的活" });
  await kinds.getByRole("tab", { name: "测试" }).click();
  await expect(sow.getByRole("tabpanel", { name: "测试" }).getByRole("button", { name: "给最近改的地方补测试" })).toBeVisible();
  await expect(sow.getByRole("button", { name: "修编译报错" })).toHaveCount(0);
  await expect(sow.getByLabel("筛种子")).toHaveCount(0);
  // Focused, a field shows it on its box only: no second ring inside (style.css keeps :focus-visible in the base layer).
  const words = sow.getByRole("textbox", { name: "工单" });
  await words.focus();
  await page.keyboard.type("x");
  await expect(words).toHaveCSS("outline-style", "none");
  await page.keyboard.press("Backspace");
  await sow.getByRole("textbox", { name: "工单" }).fill("给打卡页加一个夜间模式");
  await page.screenshot({ path: test.info().outputPath("sow.png") });
  await expect(sow.getByRole("button", { name: "开始" })).toBeVisible();
  await sow.getByRole("button", { name: "草稿" }).click();
  await expect(page).toHaveURL(/\/issues\/.+/);
  const made = (await api.issue.list()).find((i) => i.title.includes("夜间模式"));
  expect(made?.project).toBe("farm-hud");
  expect(made?.status).toBe("backlog");
  await page.goto("/farm/farm-hud");
  await page.getByRole("button", { name: "项目牌：farm-hud" }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test("/ opens the farm entered last, and a farm with no project sends sowing to the map", async ({ page, api }) => {
  await api.project.create({ name: "farm-home" });
  // A device that never entered a farm still lands on one: 回农场 never strands it on the map.
  await page.goto("/");
  await expect(page).toHaveURL(/\/farm\/.+/);
  await openFarm(page, "farm-home");
  await page.goto("/");
  await expect(page).toHaveURL(/\/farm\/farm-home$/);
  await openFarm(page);
  const canvas = page.getByTestId("village").locator("canvas");
  const box = (await canvas.boundingBox())!;
  const scale = box.width / 384;
  await page.mouse.click(box.x + 128 * scale, box.y + 117 * scale);
  const sow = page.getByRole("dialog", { name: "播种 · 第 1 块地" });
  await expect(sow.getByText("这座农场不是哪个项目的")).toBeVisible();
  await sow.getByRole("button", { name: "去地图" }).click();
  await expect(page).toHaveURL(/\/projects$/);
});

test("the helpers open side by side, and a click elsewhere folds them and a helper's card", async ({ page }) => {
  await openFarm(page);
  const group = page.getByRole("group", { name: "帮工" });
  await group.getByRole("button", { name: "帮工", exact: true }).click();
  const friends = group.getByRole("button", { name: /，/ });
  await expect(friends.nth(1)).toBeVisible();
  // In a row, not stacked under the narrow button.
  const [a, b] = [await friends.nth(0).boundingBox(), await friends.nth(1).boundingBox()];
  expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
  expect(b!.x).toBeGreaterThan(a!.x);

  await friends.nth(0).click();
  const card = group.getByRole("dialog");
  await expect(card).toBeVisible();
  await page.mouse.click(720, 300);
  await expect(card).toHaveCount(0);
  await expect(friends).toHaveCount(0);
});
