import { expect, settled, test } from "./fixtures";

test("a new plot is opened, shows on the map and opens its deed", async ({ page }) => {
  const name = `patch-${Date.now() % 100000}`;
  await page.goto("/projects");
  await page.getByRole("button", { name: "新增项目" }).click();
  const dialog = page.getByRole("dialog", { name: "新增项目" });
  await dialog.getByRole("button", { name: "开一块新地" }).click();
  await dialog.getByLabel("项目名").fill("../bad name");
  await dialog.getByRole("button", { name: "创建项目" }).click();
  await expect(dialog.getByRole("alert")).toContainText("项目名");
  await dialog.getByLabel("项目名").fill(name);
  await dialog.getByRole("button", { name: "创建项目" }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${name}$`));
  await expect(page.getByRole("heading", { name, exact: true }).first()).toBeVisible();
  await expect(page.getByText("开垦于")).toBeVisible();
  await expect(page.getByText("种了什么")).toBeVisible();
  await expect(page.getByText("耕作日历")).toBeVisible();

  await page
    .getByRole("region", { name: "项目列表" })
    .getByRole("link", { name: /^全部/ })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText(/\d+ 座岛 · \d+ 座有人 · 在做 \d+\/\d+ 张/)).toBeVisible();
  await expect(page.getByRole("button", { name: `${name}：在干 0/3` })).toBeVisible();
  // 进岛: into the project's own farm, its sign saying whose.
  await page.getByRole("button", { name: `进${name}的农场` }).click();
  await expect(page).toHaveURL(new RegExp(`/farm/${name}$`));
  await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
  await expect(page.getByRole("button", { name: `项目牌：${name}` })).toBeAttached();
});

test("the GitHub address names the project until the name is typed", async ({ page }) => {
  await page.goto("/projects");
  await page.getByRole("button", { name: "新增项目" }).click();
  const dialog = page.getByRole("dialog", { name: "新增项目" });
  await dialog.getByLabel("GitHub 地址").fill("https://github.com/botiverse/raft-source");
  await expect(dialog.getByLabel("项目名")).toHaveValue("raft-source");
  await dialog.getByLabel("项目名").fill("mine");
  await dialog.getByLabel("GitHub 地址").fill("https://github.com/botiverse/other");
  await expect(dialog.getByLabel("项目名")).toHaveValue("mine");
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
});

test("项目 as it looks", async ({ page, api }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await api.project.create({ name: `look-${Date.now() % 100000}` }).catch(() => undefined);
  await page.goto("/projects");
  await expect(page.getByText(/\d+ 座岛 · /)).toBeVisible();
  await settled(page);
  await page.screenshot({ path: test.info().outputPath("map.png") });
});
