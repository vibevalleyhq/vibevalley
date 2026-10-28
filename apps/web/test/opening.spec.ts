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

test("the workbench's cover is its own ground in the owner's theme, and stays until the first frame or a while", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: "dark" })));
  // No frame comes: the cover holds, then lets the page show as it is.
  await page.route("**/api/v1/state**", () => undefined);
  await page.goto("/issues");
  const cover = page.locator("#opening");
  await expect(cover).toHaveAttribute("data-look", "desk");
  await expect(cover).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  // Mounted underneath, still covered.
  await expect(page.getByTestId("desk")).toBeAttached();
  await expect(cover).toHaveCount(1);
  await expect(cover).toHaveCount(0, { timeout: 3000 });
});

test("a dialog the address opens is there when the cover goes, not coming in again", async ({ page, api }) => {
  const issue = await api.issue.create({ title: "an issue to open" });
  await page.goto(`/issues/${issue.id}`);
  await expect(page.locator("#opening")).toHaveCount(0);
  const running = await page.evaluate(
    () => document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)).length,
  );
  expect(running).toBe(0);
});

test("the farm's cover is the village's bar, handed to the farm at once", async ({ page }) => {
  const html = await (await page.request.get("/farm")).text();
  expect(html).toContain('id="opening"');
  await page.goto("/farm");
  await expect(page.locator("#opening")).toHaveCount(0);
  await page.goto("/opening.html");
  await expect(page.locator("#opening")).toHaveAttribute("data-look", "desk");
});

test("the opening page walks its bar, or says why the farm did not start in place of it", async ({ page }) => {
  await page.goto("/opening.html");
  await expect(page.getByRole("progressbar")).toBeVisible();
  const why = "server exited (1), log at /tmp/x.log";
  await page.goto("/opening.html?problem=" + encodeURIComponent(why));
  await expect(page.getByRole("alert")).toContainText(why);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});
