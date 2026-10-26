// The bar a window starts on (public/opening.html): index.html carries the same one until the page is up, and the
// desktop app shows it with the reason when the server could not start.
import { expect, test } from "./fixtures";

test("the page starts on the bar and drops it once it is up", async ({ page }) => {
  const html = await (await page.request.get("/issues")).text();
  expect(html).toContain('id="opening"');
  expect(html).not.toContain("<!-- opening -->");
  await page.goto("/issues");
  await expect(page.getByRole("heading", { name: "工单" })).toBeVisible();
  await expect(page.locator("#opening")).toHaveCount(0);
});

test("the opening page walks its bar, or says why the farm did not start", async ({ page }) => {
  await page.goto("/opening.html");
  await expect(page.getByRole("progressbar", { name: "叫醒农场" })).toBeVisible();
  await expect(page.getByText("叫醒农场……")).toBeVisible();
  await page.goto("/opening.html?problem=" + encodeURIComponent("服务端退出了（1），日志在 /tmp/x.log"));
  await expect(page.getByText("农场起不来：服务端退出了（1），日志在 /tmp/x.log")).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("problem.png") });
});
