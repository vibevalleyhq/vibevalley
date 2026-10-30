import { expect, test } from "./fixtures";

// The memory tree's memories are made up (src/tree/mock.ts) until the server sums them up.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

test("the farm's tree button opens the tree, and its farm button comes back", async ({ page }) => {
  await page.goto("/farm/");
  await page.getByTestId("hud-tree").click();
  await expect(page).toHaveURL(/\/tree$/u);
  await expect(page.getByTestId("tree-panel")).toBeVisible();
  await page.getByTestId("tree-home").click();
  await expect(page).toHaveURL(/\/farm$/u);
});

test("the tree's counts follow a helper's filter, the slider goes back in time, and the sky opens and closes, without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The tree grows and the sky rises with the page's clock: moved through, not waited out.
  await page.clock.install();
  await page.goto("/tree");
  await expect(page.getByTestId("memory-scene")).toBeVisible();
  const counts = page.getByTestId("memory-counts");
  const all = (await counts.textContent()) ?? "";
  await page.clock.runFor(2500);

  // A helper's filter narrows the counts, and clearing it brings them back.
  await page.getByTestId("tree-by-helper").click();
  await page.getByRole("option").nth(1).click();
  await expect(counts).not.toHaveText(all);
  await page.getByTestId("tree-by-helper").click();
  await page.locator('[role="option"][data-key=""]').click();
  await expect(counts).toHaveText(all);

  const seeds = page.getByTestId("tree-sow");
  const before = await seeds.count();
  if (before > 0) {
    await seeds.first().click();
    await expect(seeds).toHaveCount(before - 1);
  }

  const until = page.getByTestId("tree-until");
  await expect(until).toHaveAttribute("data-now", "");
  await page.getByRole("slider").fill("0.15");
  await expect(until).not.toHaveAttribute("data-now");
  await page.getByRole("slider").fill("1");

  await page.getByTestId("tree-sky").click();
  await page.clock.runFor(2200);
  await expect(page.getByTestId("tree-panel")).toHaveCount(0);
  await page.getByTestId("tree-back").click();
  await expect(page.getByTestId("tree-panel")).toBeVisible();
  expect(errors).toEqual([]);
});
