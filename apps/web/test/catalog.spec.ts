import { expect, settled, test } from "./fixtures";

test("the drawings are on shelves, and one opens large with its frames and how to draw it again", async ({ page }) => {
  await page.goto("/catalog");
  const kinds = page.getByRole("navigation", { name: "分类" });
  await expect(kinds.getByRole("button", { name: /^全部 \d+$/ })).toBeVisible();
  await kinds.getByRole("button", { name: /^语言/ }).click();
  await expect(page.getByRole("button", { name: "lang-go" })).toBeVisible();
  await expect(page.getByRole("button", { name: "plot-empty" })).toBeHidden();
  await kinds.getByRole("button", { name: /^全部/ }).click();
  await page.getByLabel("找素材").fill("熊");
  await page.getByRole("button", { name: "bear-farmer-down-1" }).click();
  await expect(page).toHaveURL(/\/catalog\/bear-farmer-down-1$/);
  await expect(page.getByRole("heading", { name: "bear-farmer-down-1" })).toBeVisible();
  await expect(page.getByText(/^\d+ 帧$/)).toBeVisible();
  await expect(page.getByText("design/pixel/gen.sh char-bear")).toBeVisible();
  await page.getByRole("button", { name: "停" }).click();
  await expect(page.getByRole("button", { name: "播放" })).toBeVisible();
});

test("the pointers and the sounds", async ({ page }) => {
  await page.goto("/catalog/cursors");
  await expect(page.getByRole("tab", { name: "指针" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText(/^指针 · \d+$/)).toBeVisible();
  await expect(page.getByText("hand-grab")).toBeVisible();
  await page.getByRole("tab", { name: "音效" }).click();
  await expect(page).toHaveURL(/\/catalog\/sounds$/);
  await expect(page.getByRole("button", { name: /^播放 / }).first()).toBeVisible();
  await page.getByLabel("找素材").fill("coin");
  await expect(page.getByRole("button", { name: /^播放 / })).not.toHaveCount(0);
});

test("a place the page does not know goes to the workbench", async ({ page }) => {
  await page.goto("/nowhere-at-all");
  await expect(page).toHaveURL(/\/chat$/);
});

test("图鉴 as it looks", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/catalog/fox-rain-down");
  await expect(page.getByRole("heading", { name: "fox-rain-down" })).toBeVisible();
  await settled(page);
  await page.screenshot({ path: test.info().outputPath("catalog.png") });
});

test("the kit shelf draws the tokens and atoms in both themes, from the stylesheet itself", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/catalog/kit");
  await expect(page.getByRole("tab", { name: "界面" })).toHaveAttribute("aria-selected", "true");
  const light = page.getByTestId("kit-light");
  const dark = page.getByTestId("kit-dark");
  await expect(light.getByRole("heading", { name: "浅色" })).toBeVisible();
  await expect(dark.getByRole("heading", { name: "深色" })).toBeVisible();
  await settled(page);
  await page.screenshot({ path: test.info().outputPath("kit.png") });
  const ground = (pane: typeof light) => pane.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await ground(light)).not.toBe(await ground(dark));
  // The motion curves are read from the stylesheet, so each one draws.
  await expect(light.getByTestId("ease")).toHaveCount(4);
  await light.getByRole("button", { name: "删除档案" }).click();
  await expect(light.getByText("删了就找不回来。")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(light.getByText("删了就找不回来。")).toBeHidden();
  await expect(page.getByTestId("kit-pixel").getByRole("button", { name: "primary" })).toBeVisible();
  await page.setViewportSize({ width: 400, height: 900 });
  await page.screenshot({ path: test.info().outputPath("kit-narrow.png") });
});
