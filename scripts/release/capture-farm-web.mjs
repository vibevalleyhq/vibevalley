import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(new URL("../../apps/site/package.json", import.meta.url));
const { chromium } = require("@playwright/test");
const [origin, route, scenarios, output] = process.argv.slice(2);
const cases = JSON.parse(await readFile(scenarios, "utf8"));
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
try {
  for (const { name, width, height, dpr, tod, clock, motion } of cases) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, locale: "zh-CN", colorScheme: "dark" });
    if (motion !== undefined) {
      await context.addInitScript((inputs) => {
        window.__vvMotion = { ...inputs, advanced: 0 };
      }, motion);
    }
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await context.route("**/*", (request) => {
      const target = new URL(request.request().url());
      if (["http:", "https:"].includes(target.protocol) && target.origin !== origin) {
        errors.push(`External request: ${target.origin}`);
        return request.abort();
      }
      return request.continue();
    });
    await page.goto(`${origin}${route}?tod=${tod}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      ({ clock, repo }) => {
        const village = document.querySelector('[data-testid="village"]');
        return (
          village?.getAttribute("data-ready") === "true" &&
          village.querySelector("canvas") &&
          !document.getElementById("opening") &&
          document.querySelector('[data-testid="farm-clock"]')?.textContent === clock &&
          document.querySelector('[data-testid="repo-sign"]')?.textContent?.includes(repo)
        );
      },
      { clock, repo: decodeURIComponent(route.split("/").at(-1)) },
      { timeout: 30000 },
    );
    if (motion !== undefined) {
      await page.waitForFunction(() => window.__vvMotion.advanced === window.__vvMotion.ticks, undefined, { timeout: 30_000 });
      await page.evaluate(() => {
        const elapsed = (window.__vvMotion.ticks * 1000) / 60;
        for (const animation of document.getAnimations()) {
          animation.pause();
          if (animation.animationName === "hop") animation.currentTime = elapsed;
        }
      });
    }
    await page.evaluate(() => document.fonts.ready);
    const layout = await page.evaluate(() => {
      function bounds(selector) {
        const boxes = [...document.querySelectorAll(selector)].map((node) => node.getBoundingClientRect()).filter((box) => box.width > 0 && box.height > 0);
        if (boxes.length === 0) throw new Error(`Missing farm element: ${selector}`);
        const x = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.left))));
        const y = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.top))));
        const right = Math.min(innerWidth, Math.ceil(Math.max(...boxes.map((box) => box.right))));
        const bottom = Math.min(innerHeight, Math.ceil(Math.max(...boxes.map((box) => box.bottom))));
        return [x, y, right - x, bottom - y];
      }
      return {
        route: location.pathname,
        viewport: [innerWidth, innerHeight],
        dpr: devicePixelRatio,
        canvas: bounds('[data-testid="village"] canvas'),
        clock: document.querySelector('[data-testid="farm-clock"]').textContent,
        regions: {
          navigation: bounds('[data-testid="rail"]'),
          toolbar: bounds('[data-testid^="tool-"]'),
          clock: bounds('[data-testid="farm-clock"]'),
          "repo-sign": bounds('[data-testid="repo-sign"]'),
          friends: bounds('[data-testid="friends-toggle"]'),
          "shop-sign": bounds('.pixel-shade:has(img[src$="/icon-shop.png"])'),
        },
      };
    });
    for (const suffix of ["", "-repeat"]) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: join(output, `web-${name}${suffix}.png`) });
    }
    await writeFile(
      join(output, `web-${name}.json`),
      JSON.stringify(
        { ...layout, motion: motion !== undefined ? await page.evaluate(() => window.__vvMotion) : undefined, errors, browser: browser.version() },
        null,
        2,
      ),
    );
    if (errors.length > 0) throw new Error(errors.join("\n"));
    await context.close();
  }
} finally {
  await browser.close();
}
