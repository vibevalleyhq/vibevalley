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
