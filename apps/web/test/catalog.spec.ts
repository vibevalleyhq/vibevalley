import { expect, test } from "./fixtures";

// Which pictures a shelf or a search keeps, and a picture's frames, are rules.test.ts's; here the page's wiring.
test("a shelf and a search narrow the pictures, and one opens at its own address and plays", async ({ page }) => {
  await page.goto("/catalog");
  const shelves = page.getByTestId("catalog-shelves");
  await shelves.locator('[data-key="langs"]').click();
  await expect(page.locator('[data-testid="picture"][data-key="lang-go"]')).toBeVisible();
  await expect(page.locator('[data-testid="picture"][data-key="plot-empty"]')).toBeHidden();
  await shelves.locator('[data-key="all"]').click();
  await page.getByTestId("catalog-search").fill("bear");
  await page.locator('[data-testid="picture"][data-key="bear-farmer-down-1"]').click();
  await expect(page).toHaveURL(/\/catalog\/bear-farmer-down-1$/);
  const detail = page.getByTestId("picture-detail");
  await expect(detail).toHaveAttribute("data-key", "bear-farmer-down-1");
  const play = detail.getByTestId("play");
  await expect(play).toHaveAttribute("aria-pressed", "true");
  await play.click();
  await expect(play).toHaveAttribute("aria-pressed", "false");
});

test("the pointers and the sounds have shelves of their own", async ({ page }) => {
  await page.goto("/catalog/cursors");
  await expect(page.locator('[role="tab"][data-key="cursors"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid="cursor"][data-key="hand-grab"]')).toBeVisible();
  await page.locator('[role="tab"][data-key="sounds"]').click();
  await expect(page).toHaveURL(/\/catalog\/sounds$/);
  await page.getByTestId("catalog-search").fill("coin");
  await expect(page.getByTestId("sound")).not.toHaveCount(0);
});

test("a place the page does not know goes to the workbench", async ({ page }) => {
  await page.goto("/nowhere-at-all");
  await expect(page).toHaveURL(/\/chat$/);
});

test("the kit shelf draws the tokens and atoms in both themes, from the stylesheet itself", async ({ page }) => {
  await page.goto("/catalog/kit");
  await expect(page.locator('[role="tab"][data-key="kit"]')).toHaveAttribute("aria-selected", "true");
  const light = page.getByTestId("kit-light");
  const dark = page.getByTestId("kit-dark");
  await expect(light).toHaveAttribute("data-theme", "light");
  await expect(dark).toHaveAttribute("data-theme", "dark");
  const ground = (pane: typeof light) => pane.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(await ground(light)).not.toBe(await ground(dark));
  // The motion curves are read off the classes the pages use, so each one draws.
  await expect(light.getByTestId("ease")).toHaveCount(4);
  await light.getByTestId("kit-confirm").click();
  await expect(light.getByTestId("kit-confirm-sure")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(light.getByTestId("kit-confirm-sure")).toBeHidden();
  await expect(page.getByTestId("kit-pixel").locator('button[data-key="primary"]')).toBeEnabled();
});
