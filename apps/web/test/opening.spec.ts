import { expect, test } from "./fixtures";

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

test("the delivered opening covers a deep-linked page until it is ready, without replaying its dialog animation", async ({ page, api }) => {
  const html = await (await page.request.get("/issues")).text();
  expect(html).toContain('id="opening"');
  expect(html).not.toContain("<!-- opening -->");
  const issue = await api.issue.create({ title: "an issue to open" });
  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByTestId("desk")).toHaveAttribute("data-place", "issues");
  await expect(page.locator("#opening")).toHaveCount(0);
  const running = await page.evaluate(
    () => document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)).length,
  );
  expect(running).toBe(0);
});

test("the opening has indeterminate progress and reduced motion, or a launch error in place of its bar", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/opening.html");
  await expect(page.locator("#opening")).toHaveAttribute("data-look", "desk");
  await expect(page.getByRole("progressbar")).toBeVisible();
  await expect(page.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
  await expect(page.locator("#opening .fill")).toHaveCSS("animation-name", "none");
  expect(await page.locator("#opening .face").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  const why = "server exited (1), log at /tmp/x.log";
  await page.goto("/opening.html?problem=" + encodeURIComponent(why));
  await expect(page.getByRole("alert")).toContainText(why);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});
