import { expect, test } from "./fixtures";

test("the rail lists every place, the farm at the top, and marks where you are", async ({ page }) => {
  await page.goto("/issues");
  await expect(page.getByRole("status")).toHaveText("已连上");
  const nav = page.getByRole("navigation", { name: "工作台" });
  await expect(nav.getByRole("link", { name: "回农场" }).first()).toHaveAttribute("href", "/");
  for (const label of ["聊天", "工单", "文档", "帮工", "农具", "项目", "图鉴", "设置"])
    await expect(nav.getByRole("link", { name: new RegExp(`^${label} · `) })).toBeVisible();
  await expect(nav.getByRole("link", { name: /^工单 · / })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "工单" })).toBeVisible();
  // The server is the worker's: an earlier test may have left the orchestrator at work.
  await expect(page.getByRole("link", { name: /^(没开工|开工中 · \d+ 个在干活)$/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("rail.png") });
});

test("every place opens under its own head", async ({ page }) => {
  await page.goto("/issues");
  for (const [label, path] of [
    ["文档", "/docs"],
    ["帮工", "/agents"],
    ["农具", "/runtimes"],
    ["项目", "/projects"],
    ["图鉴", "/catalog"],
  ] as const) {
    await page
      .getByRole("navigation", { name: "工作台" })
      .getByRole("link", { name: new RegExp(`^${label} · `) })
      .click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole("heading", { name: label, level: 1 }).first()).toBeVisible();
  }
});

test("the chat has no head: the rail is all", async ({ page }) => {
  await page.goto("/chat");
  await expect(page.getByRole("link", { name: /^聊天 · / })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("link", { name: /没开工|开工中/ })).toHaveCount(0);
});
