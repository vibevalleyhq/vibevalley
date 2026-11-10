import { expect, gate, settled, test } from "./fixtures";

test("the opening preserves the user's theme underneath, and stays until the first frame or a while", async ({ page }) => {
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

for (const interrupted of ["pause", "cancel"] as const) {
  test(`regression: a ${interrupted}d cover animation cannot strand the opening`, async ({ page }) => {
    await page.addInitScript((action) => {
      // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted element via apply below.
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (...args) {
        const animation = animate.apply(this, args);
        if (this.id === "opening") animation[action]();
        return animation;
      };
    }, interrupted);
    await page.goto("/issues");
    await expect(page.locator("#opening")).toHaveCount(0);
    await expect(page.getByTestId("desk")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`opening-${interrupted}-released.png`) });
  });
}

test("the delivered opening covers a deep-linked page until it is ready, without replaying its dialog animation", async ({ page, api }) => {
  const issue = await api.issue.create({ title: "an issue to open" });
  await page.goto(`/issues/${issue.id}`);
  await expect(page.getByTestId("desk")).toHaveAttribute("data-place", "issues");
  await expect(page.locator("#opening")).toHaveCount(0);
  const running = await page.evaluate(
    () => document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)).length,
  );
  expect(running).toBe(0);
});

test("simulated opening progress advances smoothly while real work stalls, without claiming completion", async ({ page }) => {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  await page.goto("/opening.html");
  const cover = page.locator("#opening");
  const progress = () => cover.evaluate((node) => Number(node.dataset.displayProgress));
  let previous = await progress();
  expect(previous).toBeGreaterThan(0);
  for (let sample = 0; sample < 5; sample += 1) {
    await page.clock.runFor(100);
    const current = await progress();
    expect(current).toBeGreaterThan(previous);
    previous = current;
  }
  await page.clock.fastForward(300_000);
  expect(await progress()).toBeGreaterThan(previous);
  expect(await progress()).toBeLessThanOrEqual(90);
  await expect(cover).not.toHaveAttribute("data-progress");
  await cover.evaluate((node) => {
    node.dataset.phase = "loading";
    node.dataset.progress = "95";
    node.dispatchEvent(new Event("opening-update"));
  });
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "95");
  await cover.evaluate((node) => {
    node.dataset.progress = "50";
    node.dispatchEvent(new Event("opening-update"));
  });
  await page.clock.runFor(100);
  expect(await progress()).toBe(95);
  await expect(cover).toHaveAttribute("data-progress", "50");
  await cover.evaluate((node) => {
    node.dataset.phase = "ready";
    node.dataset.progress = "100";
    node.dispatchEvent(new Event("opening-update"));
  });
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  await expect(cover).toHaveAttribute("data-mood", "happy");
});

for (const phase of ["waiting", "failed"]) {
  test(`a ${phase} opening freezes simulated progress without showing success`, async ({ page }) => {
    const now = new Date();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(new Date(now.getTime() + 1000));
    await page.goto("/opening.html");
    const cover = page.locator("#opening");
    await page.clock.runFor(1200);
    const before = await cover.getAttribute("data-display-progress");
    await cover.evaluate((node, phase) => {
      node.dataset.phase = phase;
      node.dispatchEvent(new Event("opening-update"));
    }, phase);
    await page.clock.fastForward(300_000);
    await expect(cover).toHaveAttribute("data-display-progress", before!);
    await expect(cover).toHaveAttribute("data-mood", "confused");
    expect(Number(before)).toBeLessThan(100);
    if (phase === "failed") await expect(page.getByRole("progressbar")).toHaveCount(0);
  });
}

test("launch errors use the same localized alert on the existing cover and on direct navigation", async ({ page }) => {
  const why = "server exited (1), log at /tmp/x.log";
  const alerts = [];
  for (const locale of ["zh", "en"]) {
    await page.goto(`/opening.html?locale=${locale}`);
    const cover = page.locator("#opening");
    await cover.evaluate((node, problem) => {
      node.dataset.problem = problem;
      node.dispatchEvent(new Event("opening-update"));
    }, why);
    await expect(page.getByRole("alert")).toContainText(why);
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    await expect(cover).toHaveAttribute("data-mood", "confused");
    expect(Number(await cover.getAttribute("data-display-progress"))).toBeLessThan(100);
    const alert = await page.getByRole("alert").textContent();
    alerts.push(alert);
    await page.goto(`/opening.html?locale=${locale}&problem=${encodeURIComponent(why)}`);
    await expect(page.getByRole("alert")).toHaveText(alert!);
    await expect(page.getByRole("progressbar")).toHaveCount(0);
  }
  expect(alerts[0]).not.toBe(alerts[1]);
});

for (const end of ["removed", "pagehide"]) {
  test(`opening feedback stops when the cover is ${end}`, async ({ page }) => {
    const now = new Date();
    await page.clock.install({ time: now });
    await page.clock.pauseAt(new Date(now.getTime() + 1000));
    await page.goto("/opening.html");
    await page.clock.runFor(300);
    const cover = await page.locator("#opening").elementHandle();
    const before = await cover.getAttribute("data-display-progress");
    await cover.evaluate((node, end) => {
      if (end === "removed") node.remove();
      else window.dispatchEvent(new Event("pagehide"));
    }, end);
    await page.clock.runFor(1500);
    expect(await cover.getAttribute("data-display-progress")).toBe(before);
  });
}

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
  expect(Number(await cover.getAttribute("data-progress"))).toBeGreaterThan(0);
  expect(Number(await cover.getAttribute("data-progress"))).toBeLessThan(100);
  const result = cover.evaluate((node) => {
    const { promise, resolve } = Promise.withResolvers<{
      phase: string | undefined;
      mood: string | undefined;
      progress: string | undefined;
      displayed: string | undefined;
    }>();
    const observer = new MutationObserver(() => {
      if (node.isConnected) return;
      observer.disconnect();
      resolve({ phase: node.dataset.phase, mood: node.dataset.mood, progress: node.dataset.progress, displayed: node.dataset.displayProgress });
    });
    observer.observe(document.body, { childList: true });
    return promise;
  });
  frame.open();
  await expect(result).resolves.toEqual({ phase: "ready", mood: "happy", progress: "100", displayed: "100" });
});

test("a timed out opening never reports completion", async ({ page }) => {
  await page.route("**/api/v1/state**", () => undefined);
  await page.goto("/issues");
  const result = await page.locator("#opening").evaluate((node) => {
    const { promise, resolve } = Promise.withResolvers<{ phase: string | undefined; progress: string | undefined; displayed: string | undefined }>();
    const observer = new MutationObserver(() => {
      if (node.isConnected) return;
      observer.disconnect();
      resolve({ phase: node.dataset.phase, progress: node.dataset.progress, displayed: node.dataset.displayProgress });
    });
    observer.observe(document.body, { childList: true });
    return promise;
  });
  expect(result.phase).toBe("waiting");
  expect(Number(result.progress)).toBeLessThan(100);
  expect(Number(result.displayed)).toBeGreaterThan(0);
  expect(Number(result.displayed)).toBeLessThan(100);
});

test("regression: an initial REST failure does not celebrate a successful opening", async ({ page }) => {
  const response = gate();
  await page.route("**/api/v1/agent/list", async (route) => {
    await response.opened;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
  });
  await page.goto("/agents/new");
  const result = page.locator("#opening").evaluate((node) => {
    const { promise, resolve } = Promise.withResolvers<{
      phase: string | undefined;
      mood: string | undefined;
      progress: string | undefined;
      displayed: string | undefined;
    }>();
    const observer = new MutationObserver(() => {
      if (node.isConnected) return;
      observer.disconnect();
      resolve({ phase: node.dataset.phase, mood: node.dataset.mood, progress: node.dataset.progress, displayed: node.dataset.displayProgress });
    });
    observer.observe(document.body, { childList: true });
    return promise;
  });
  response.open();
  const final = await result;
  expect(final.phase).toBe("failed");
  expect(final.mood).toBe("confused");
  expect(Number(final.progress)).toBeLessThan(100);
  expect(Number(final.displayed)).toBeLessThan(100);
});

test("reduced motion keeps the sprite still while progress remains available", async ({ page }) => {
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/opening.html");
  const sprite = page.locator("#opening .sprite-position");
  const before = await sprite.boundingBox();
  const progress = Number(await page.getByRole("progressbar").getAttribute("aria-valuenow"));
  await page.clock.runFor(2000);
  expect(Number(await page.getByRole("progressbar").getAttribute("aria-valuenow"))).toBeGreaterThan(progress);
  expect(await sprite.boundingBox()).toEqual(before);
  await expect(page.locator("#opening .sprite")).toHaveCSS("animation-name", "none");
});
