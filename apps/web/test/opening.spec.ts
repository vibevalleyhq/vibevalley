import { expect, gate, settled, test } from "./fixtures";

test("the opening preserves the owner's theme underneath, and stays until the first frame or a while", async ({ page }) => {
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
  expect(await page.locator("#opening .scene").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator("#opening")).toHaveAttribute("data-mood", "sleepy");
  const why = "server exited (1), log at /tmp/x.log";
  await page.goto("/opening.html?problem=" + encodeURIComponent(why));
  await expect(page.getByRole("alert")).toContainText(why);
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.locator("#opening")).toHaveAttribute("data-mood", "confused");
});

for (const [scene, hour] of [
  ["morning", 7],
  ["day", 12],
  ["night", 21],
] as const) {
  test(`the ${scene} opening loads its artwork with separate text at desktop and phone widths`, async ({ page }) => {
    await page.clock.setFixedTime(new Date(2026, 10, 7, hour));
    for (const width of [1152, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 768 });
      await page.goto("/opening.html");
      await expect(page.locator("#opening")).toHaveAttribute("data-scene", scene);
      await expect(page.locator("#opening .scene")).toHaveJSProperty("naturalWidth", 1672);
      await expect(page.locator("#opening .brand")).toBeVisible();
      const brand = await page.locator("#opening .brand").boundingBox();
      expect(brand?.y).toBeGreaterThan((width === 390 ? 844 : 768) / 2);
      await settled(page);
      await page.screenshot({ path: test.info().outputPath(`${scene}-${width}.png`) });
    }
  });
}

test("a failed farm map releases the opening so its error remains visible", async ({ page }) => {
  await page.route("**/village.ldtk", (route) => route.fulfill({ status: 500, body: "unavailable" }));
  await page.goto("/farm");
  await expect(page.locator("#opening")).toHaveCount(0);
  await expect(page.getByTestId("village-error")).toBeVisible();
});

test("opening progress follows the first frame and completes with a happy sprite", async ({ page }) => {
  const frame = gate();
  await page.route("**/api/v1/state**", async (route) => {
    await frame.opened;
    await route.continue();
  });
  await page.goto("/issues");
  const cover = page.locator("#opening");
  await expect(cover).toHaveAttribute("data-phase", "connecting");
  await expect(cover).toHaveAttribute("data-progress", "10");
  await expect(cover).toHaveAttribute("data-mood", "working");
  const result = cover.evaluate(
    (node) =>
      new Promise<{ phase: string | undefined; mood: string | undefined; progress: string | undefined }>((done) => {
        const observer = new MutationObserver(() => {
          if (node.isConnected) return;
          observer.disconnect();
          done({ phase: node.dataset.phase, mood: node.dataset.mood, progress: node.dataset.progress });
        });
        observer.observe(document.body, { childList: true });
      }),
  );
  frame.open();
  await expect(result).resolves.toEqual({ phase: "ready", mood: "happy", progress: "100" });
});

test("a timed out opening never reports completion", async ({ page }) => {
  await page.route("**/api/v1/state**", () => undefined);
  await page.goto("/issues");
  const result = await page.locator("#opening").evaluate(
    (node) =>
      new Promise<{ phase: string | undefined; progress: string | undefined }>((done) => {
        const observer = new MutationObserver(() => {
          if (node.isConnected) return;
          observer.disconnect();
          done({ phase: node.dataset.phase, progress: node.dataset.progress });
        });
        observer.observe(document.body, { childList: true });
      }),
  );
  expect(result).toEqual({ phase: "waiting", progress: "10" });
});

test("regression: an initial REST failure does not celebrate a successful opening", async ({ page }) => {
  const response = gate();
  await page.route("**/api/v1/agent/list", async (route) => {
    await response.opened;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
  });
  await page.goto("/agents/new");
  const result = page.locator("#opening").evaluate(
    (node) =>
      new Promise<{ phase: string | undefined; mood: string | undefined; progress: string | undefined }>((done) => {
        const observer = new MutationObserver(() => {
          if (node.isConnected) return;
          observer.disconnect();
          done({ phase: node.dataset.phase, mood: node.dataset.mood, progress: node.dataset.progress });
        });
        observer.observe(document.body, { childList: true });
      }),
  );
  response.open();
  const final = await result;
  expect(final.phase).toBe("failed");
  expect(final.mood).toBe("confused");
  expect(Number(final.progress)).toBeLessThan(100);
});

test("the sprite respects reduced motion and the opening name follows the locale", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const locale of ["zh", "en"]) {
    await page.goto(`/opening.html?locale=${locale}`);
    await expect(page.locator("#opening .sprite")).toHaveCSS("animation-name", "none");
    expect(await page.locator("#opening .brand").textContent()).toBe(locale === "zh" ? "码农谷物语" : "VibeValley");
  }
});
