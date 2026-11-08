/* oxlint-disable no-await-in-loop -- Reverse scroll, interruption and resize assertions observe an ordered interaction sequence. */
import { readFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, resolve } from "node:path";

import { expect, test } from "@playwright/test";

let server: Server;
let origin: string;
const root = resolve(import.meta.dirname, "../apps/site/dist/client");
const mime: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

test.beforeAll(async () => {
  server = createServer((request, response) => {
    try {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      const file = resolve(root, `.${path.endsWith("/") ? `${path}index.html` : path}`);
      if (!file.startsWith(`${root}/`) || !statSync(file).isFile()) throw new Error("Missing static output");
      response.setHeader("content-type", mime[extname(file)] ?? "application/octet-stream");
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Static website did not listen");
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeAllConnections();
    });
  }
});

test("production motion survives fast reverse scrolling and resize", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [hour, progress] of [
      ["night", 1],
      ["morning", 0],
      ["evening", 0.64],
      ["day", 0.37],
      ["night", 1],
      ["morning", 0],
    ] as const) {
      await page
        .locator("#top")
        .evaluate(
          (hero, fraction) => scrollTo({ top: hero.getBoundingClientRect().top + scrollY + (hero.clientHeight - innerHeight) * fraction, behavior: "instant" }),
          progress,
        );
      await expect(page.locator("html")).toHaveAttribute("data-scene", hour);
      await expect(page.getByTestId(`hero-hour-${hour}`)).toHaveAttribute("aria-pressed", "true");
    }
    for (const [step, progress] of [
      [3, 0.9],
      [0, 0.15],
      [2, 0.65],
      [1, 0.4],
      [3, 0.9],
      [0, 0.15],
    ] as const) {
      await page
        .getByTestId("how-track")
        .evaluate(
          (track, fraction) =>
            scrollTo({ top: track.getBoundingClientRect().top + scrollY + (track.clientHeight - innerHeight) * fraction, behavior: "instant" }),
          progress,
        );
      await expect(page.getByTestId("how-track")).toHaveAttribute("data-step", String(step));
    }
  }
  expect(errors).toEqual([]);
});

test("production offscreen animations pause and resume without overriding reduced motion", async ({ page, reducedMotion }) => {
  await page.goto(origin, { waitUntil: "networkidle" });
  await page.locator("#features").scrollIntoViewIfNeeded();
  await expect(page.locator("#top")).toHaveAttribute("data-off", "");
  const animated = page.locator("#top");
  const states = () =>
    animated.evaluate((root) =>
      [...root.querySelectorAll("*")]
        .map((element) => getComputedStyle(element))
        .filter((style) => style.animationName !== "none")
        .map((style) => style.animationPlayState),
    );
  const paused = await states();
  expect(paused.length).toBeGreaterThan(0);
  expect(paused.every((state) => state.split(",").every((part) => part.trim() === "paused"))).toBe(true);
  await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
  await expect(page.locator("#top")).not.toHaveAttribute("data-off", "");
  const visible = await states();
  if (reducedMotion === "reduce") expect(visible.every((state) => state.split(",").every((part) => part.trim() === "paused"))).toBe(true);
  else expect(visible.some((state) => state.includes("running"))).toBe(true);
});

test("production modal interruption releases DOM, scroll lock and focus before reopening", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin, { waitUntil: "networkidle" });
  const source = page.getByTestId("screenshot-0");
  for (let attempt = 0; attempt < 3; attempt++) {
    await source.click();
    const dialog = page.getByTestId("screenshot-dialog");
    const mounted = await dialog.elementHandle();
    expect(mounted).not.toBeNull();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(await mounted.evaluate((element) => element.isConnected)).toBe(false);
    await expect(source).toBeFocused();
    await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
  }
  expect(errors).toEqual([]);
});
