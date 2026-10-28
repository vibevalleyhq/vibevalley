// The bar a window starts on (public/opening.html): index.html carries the same one until the page is up, and the
// desktop app shows it with the reason when the server could not start.
import { expect, test } from "./fixtures";

test("the page starts on the bar and drops it once it is up", async ({ page }) => {
  const html = await (await page.request.get("/issues")).text();
  expect(html).toContain('id="opening"');
  expect(html).not.toContain("<!-- opening -->");
  await page.goto("/issues");
  await expect(page.getByTestId("desk")).toHaveAttribute("data-place", "issues");
  await expect(page.locator("#opening")).toHaveCount(0);
});

test("the opening page walks its bar, or says why the farm did not start in place of it", async ({ page }) => {
  await page.goto("/opening.html");
  await expect(page.getByRole("progressbar")).toBeVisible();
  const why = "server exited (1), log at /tmp/x.log";
  await page.goto("/opening.html?problem=" + encodeURIComponent(why));
  await expect(page.getByRole("alert")).toContainText(why);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});
