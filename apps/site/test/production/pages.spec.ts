import { readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test as base } from "@playwright/test";

import { COMMANDS } from "../../src/lib/links";

const types: Readonly<Record<string, string>> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
const test = base.extend<object, { website: string }>({
  website: [
    async ({ browserName }, use) => {
      expect(browserName).toBe("chromium");
      const root = fileURLToPath(new URL("../../dist/client", import.meta.url));
      const server = createServer((request, response) => {
        try {
          const path = new URL(request.url ?? "/", "http://localhost").pathname;
          const file = resolve(root, `.${path.endsWith("/") ? `${path}index.html` : path}`);
          if (!file.startsWith(`${root}/`) || !statSync(file).isFile()) throw new Error("Missing website output");
          response.setHeader("content-type", types[extname(file)] ?? "application/octet-stream");
          response.end(readFileSync(file));
        } catch {
          response.writeHead(404).end();
        }
      });
      try {
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing listener address");
        await use(`http://127.0.0.1:${address.port}`);
      } finally {
        if (server.listening) await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
      }
    },
    { scope: "worker" },
  ],
  page: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") errors.push(message.text());
    });
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await use(page);
    expect(errors).toEqual([]);
  },
});

for (const path of ["/", "/en/", "/404.html"]) {
  test(`production static HTML and initial CSS without JavaScript: ${path}`, async ({ browser, viewport, website }) => {
    const context = await browser.newContext({ javaScriptEnabled: false, ...(viewport ? { viewport } : {}) });
    try {
      const page = await context.newPage();
      const response = await page.goto(website + path);
      expect(response?.status()).toBe(200);
      await expect(page.locator("html")).toHaveAttribute("lang", path === "/en/" ? "en" : "zh-CN");
      await expect(page.locator("h1")).toBeVisible();
      await expect(page.locator("h1")).toHaveCSS("font-family", /Fusion Pixel/u);
      await expect(page.locator("script[type=module][src]")).toHaveCount(1);
      if (path === "/404.html") {
        await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
      } else {
        await expect(page.locator("#features")).toBeVisible();
        await expect(page.locator("#start")).toBeVisible();
        const width = await page.evaluate(() => innerWidth);
        await expect(page.locator("#features")).toHaveCSS("padding-left", `${Math.min(64, Math.max(16, width * 0.05))}px`);
        await expect(page.locator("#features-title")).toHaveCSS("margin-bottom", "36px");
        expect(await page.locator("#features-title").evaluate((element) => getComputedStyle(element, "::before").backgroundColor)).toBe("rgb(229, 169, 60)");
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://vibevalley.dev${path}`);
        await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
          "content",
          `https://vibevalley.dev/gen/card-${path === "/" ? "zh-CN" : "en"}.jpg`,
        );
        await expect(page.locator('link[rel="alternate"][hreflang]')).toHaveCount(3);
      }
      expect(
        await page.evaluate(async () => {
          await document.fonts.ready;
          return document.fonts.check('16px "Fusion Pixel"');
        }),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
}

test("regression: production hydration preserves top and offscreen DOM", async ({ page, website }) => {
  let release!: () => void;
  const ready = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/*.js", async (route) => {
    await ready;
    await route.continue();
  });
  try {
    await page.goto(website, { waitUntil: "commit" });
    await page.locator("#features").waitFor();
    const heading = await page.locator("h1").elementHandle();
    const feature = await page.locator("#features").elementHandle();
    release();
    await page.waitForLoadState("networkidle");
    expect(await heading.evaluate((element) => element === document.querySelector("h1"))).toBe(true);
    expect(await feature.evaluate((element) => element === document.querySelector("#features"))).toBe(true);
    await page.getByTestId("screenshot-0").click();
    await expect(page.getByTestId("screenshot-dialog")).toBeVisible();
    expect(await feature.evaluate((element) => element.isConnected)).toBe(true);
  } finally {
    release();
  }
});

test("screenshot dialog traps focus, restores scrolling and survives interruption", async ({ page, website }) => {
  await page.goto(website, { waitUntil: "networkidle" });
  const source = page.getByTestId("screenshot-0");
  const dialog = page.getByTestId("screenshot-dialog");
  const close = page.getByTestId("screenshot-close");
  await source.click();
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  await expect(page.locator("html")).toHaveCSS("overflow", "hidden");
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(source).toBeFocused();
  await expect(page.locator("html")).not.toHaveCSS("overflow", "hidden");
  await source.click();
  await expect(dialog).toBeVisible();
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(source).toBeFocused();
});

test("copy confirmation returns to idle and can be used again", async ({ context, page, website }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: website });
  await page.goto(website, { waitUntil: "networkidle" });
  const button = page.getByTestId("copy-commands");
  await button.click();
  await expect(button).toHaveAttribute("data-copied", "true");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COMMANDS.join("\n"));
  await expect(button).toHaveAttribute("data-copied", "false");
  await button.click();
  await expect(button).toHaveAttribute("data-copied", "true");
});

test("hour controls select the scene and offscreen animations pause", async ({ page, website }) => {
  await page.goto(website, { waitUntil: "networkidle" });
  for (const hour of ["day", "evening", "night", "morning"]) {
    await page.getByTestId(`hero-hour-${hour}`).click();
    await expect(page.locator("html")).toHaveAttribute("data-scene", hour);
    await expect(page.getByTestId(`hero-hour-${hour}`)).toHaveAttribute("aria-pressed", "true");
  }
  await page.locator("#features").scrollIntoViewIfNeeded();
  await expect(page.locator("#top")).toHaveAttribute("data-off", "");
});

test("scroll narrative reaches every step after viewport resize", async ({ page, website }) => {
  await page.goto(website, { waitUntil: "networkidle" });
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [index, progress] of [0.15, 0.4, 0.65, 0.9].entries()) {
      await page.getByTestId("how-track").evaluate((element, fraction) => {
        scrollTo({ top: element.getBoundingClientRect().top + scrollY + (element.clientHeight - innerHeight) * fraction, behavior: "instant" });
      }, progress);
      await expect(page.getByTestId("how-track")).toHaveAttribute("data-step", String(index));
    }
  }
});

test("language links perform full-document navigation", async ({ page, website }) => {
  await page.goto(website, { waitUntil: "networkidle" });
  const before = await page.locator("h1").elementHandle();
  await page.locator('header a[hreflang="en"]').click();
  await expect(page).toHaveURL(`${website}/en/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  expect(before).not.toBeNull();
  await page.locator('header a[hreflang="zh-CN"]').click();
  await expect(page).toHaveURL(`${website}/`);
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
});
