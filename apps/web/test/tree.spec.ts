import { expect, test } from "./fixtures";

// The memory tree's memories are made up (src/tree/mock.ts) until the server sums them up.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
});

test("the farm's 记忆树 button opens the tree, and 回农场 comes back", async ({ page }) => {
  await page.goto("/farm/");
  await page.getByRole("button", { name: /记忆树/ }).click();
  await expect(page).toHaveURL(/\/tree$/);
  await expect(page.getByRole("heading", { name: "农场的记忆树" })).toBeVisible();
  await page.getByRole("button", { name: "回农场" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("the tree shows its counts, grows back with the slider, and turns into the sky, without errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The tree grows and the sky rises with the page's clock: moved through, not waited out.
  await page.clock.install();
  await page.goto("/tree");
  await expect(page.getByTestId("memory-scene")).toBeVisible();
  const counts = page.getByTestId("memory-counts");
  await expect(counts).toContainText("186");
  await expect(counts).toContainText("42");
  // Grown to its size after opening.
  await page.clock.runFor(2500);
  await page.screenshot({ path: "test-results/tree.png" });

  // A helper's filter narrows the counts.
  await page.getByRole("button", { name: "只看哪个帮工的" }).click();
  await page.getByRole("option", { name: "阿郑" }).click();
  await expect(counts).not.toContainText("186");
  await page.getByRole("button", { name: "只看哪个帮工的" }).click();
  await page.getByRole("option", { name: "全部帮工" }).click();

  const seeds = page.getByRole("button", { name: "播种" });
  const before = await seeds.count();
  if (before > 0) {
    await seeds.first().click();
    await expect(seeds).toHaveCount(before - 1);
  }

  // Back in time the tree is young again.
  await page.getByRole("slider").fill("0.15");
  await expect(page.getByText(/^第 \d+ 天$/)).toBeVisible();
  await page.clock.runFor(2000);
  await page.screenshot({ path: "test-results/tree-young.png" });
  await page.getByRole("slider").fill("1");

  await page.getByRole("button", { name: "抬头看星空" }).click();
  await page.clock.runFor(700);
  await page.screenshot({ path: "test-results/tree-rising.png" });
  await page.clock.runFor(1500);
  await page.screenshot({ path: "test-results/tree-sky.png" });
  await page.getByRole("button", { name: "回到树下" }).click();
  await expect(page.getByRole("heading", { name: "农场的记忆树" })).toBeVisible();
  expect(errors).toEqual([]);
});
