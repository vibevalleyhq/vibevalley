// The farm's HUD and panels (src/farm/hud, src/farm/panels) against a real server: the HUD's parts, the tools by key,
// each panel opened from the HUD and closed with Esc, and sowing an empty plot. Nothing here sends a real coding agent
// out: profiles run "nobody", and the server has no model key.

import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

async function openFarm(page: Page) {
  await page.goto("/");
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

test("a click on an empty plot opens the sowing bag; 先起草 makes the issue in the backlog", async ({ page, api }) => {
  await api.project.create({ body: { name: "farm-hud" } });
  await openFarm(page);
  const canvas = page.getByTestId("village").locator("canvas");
  const box = (await canvas.boundingBox())!;
  const scale = box.width / 384;
  // The top left bed's soil (village.ldtk: Plot 0 stands at 128, 129).
  await page.mouse.click(box.x + 128 * scale, box.y + 117 * scale);
  const sow = page.getByRole("dialog", { name: "播种 · 第 1 块地" });
  await expect(sow).toBeVisible();
  await expect(sow.getByText("种在 farm-hud")).toBeVisible();
  await sow.getByRole("textbox", { name: "工单" }).fill("给打卡页加一个夜间模式");
  await page.screenshot({ path: test.info().outputPath("sow.png") });
  await sow.getByRole("button", { name: "先起草" }).click();
  await expect(page).toHaveURL(/\/issues\/.+/);
  const made = (await api.issue.list()).find((i) => i.title.includes("夜间模式"));
  expect(made?.project).toBe("farm-hud");
  expect(made?.status).toBe("backlog");
});
