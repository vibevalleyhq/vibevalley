import { readFileSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { expect, test as base } from "@playwright/test";
import { createBuilder } from "vite-plus";

import { pages, prerender } from "../../scripts/prerender";

type Output = { url: string };
const test = base.extend<object, { output: Output }>({
  output: [
    async ({ browserName }, use) => {
      expect(browserName).toBe("chromium");
      const root = fileURLToPath(new URL("../../", import.meta.url));
      const cache = resolve(root, ".test/prerender");
      await mkdir(cache, { recursive: true });
      const directory = await mkdtemp(resolve(cache, "build-"));
      const client = resolve(directory, "client");
      const server = createServer((request, response) => {
        try {
          const path = new URL(request.url ?? "/", "http://localhost").pathname;
          const file = resolve(client, `.${path.endsWith("/") ? `${path}index.html` : path}`);
          if (!file.startsWith(`${client}/`) || !statSync(file).isFile()) throw new Error("Missing file");
          response.setHeader("content-type", extname(file) === ".js" ? "text/javascript" : extname(file) === ".css" ? "text/css" : "text/html");
          response.end(readFileSync(file));
        } catch {
          response.writeHead(404).end();
        }
      });
      try {
        const builder = await createBuilder({
          root,
          configFile: resolve(root, "test/prerender/vite.config.ts"),
          publicDir: false,
          logLevel: "warn",
          plugins: [
            {
              name: "fixture-output",
              enforce: "post",
              config: () => ({
                environments: {
                  client: { build: { outDir: client } },
                  ssr: { build: { outDir: resolve(directory, "server") } },
                },
              }),
            },
          ],
        });
        await builder.buildApp();
        const module: { handleRequest: (request: Request) => Promise<Response> } = await import(pathToFileURL(resolve(directory, "server/server.js")).href);
        await prerender(module.handleRequest, client);
        await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("Missing listener address");
        await use({ url: `http://127.0.0.1:${address.port}` });
      } finally {
        if (server.listening) await new Promise<void>((done, reject) => server.close((error) => (error ? reject(error) : done())));
        await rm(directory, { recursive: true, force: true });
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

for (const route of pages) {
  test(`static HTML and extracted CSS work without JavaScript: ${route.path}`, async ({ browser, output }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      const page = await context.newPage();
      const response = await page.goto(output.url + route.path);
      expect(response?.status()).toBe(200);
      await expect(page.getByTestId("top").getByTestId("count")).toHaveText("3");
      await expect(page.getByTestId("bottom").getByTestId("count")).toHaveText("7");
      await expect(page.getByTestId("page")).toHaveCSS("padding", "24px");
      await expect(page.locator("html")).toHaveAttribute("lang", route.path === "/en/" ? "en" : "zh");
      await expect(page.locator("h1")).toHaveText(route.path === "/404.html" ? "Not found" : route.path === "/en/" ? "English home" : "Chinese home");
      const ids = await page.locator("input").evaluateAll((inputs) => inputs.map((input) => input.id));
      expect(new Set(ids).size).toBe(2);
      await expect(page.locator("script[type=module][src]")).toHaveCount(1);
    } finally {
      await context.close();
    }
  });
}

test("regression: one hydration root preserves both visible and offscreen server DOM", async ({ page, output }) => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  await page.route("**/*.js", async (route) => {
    await gate;
    await route.continue();
  });
  try {
    await page.goto(output.url, { waitUntil: "commit" });
    await page.getByTestId("top").waitFor();
    const top = await page.getByTestId("top").elementHandle();
    const bottom = await page.getByTestId("bottom").elementHandle();
    const child = await page.getByTestId("child").elementHandle();
    const ids = await page.locator("input").evaluateAll((inputs) => inputs.map((input) => input.id));
    await page.getByTestId("top").getByTestId("input").fill("before hydration");
    release();
    await expect(page.getByTestId("top")).toHaveAttribute("data-ready", "true");
    await expect(page.getByTestId("bottom")).toHaveAttribute("data-ready", "true");
    expect(await top.evaluate((node) => node === document.querySelector('[data-testid="top"]'))).toBe(true);
    expect(await child.evaluate((node) => node === document.querySelector('[data-testid="child"]'))).toBe(true);
    await expect(page.getByTestId("top").getByTestId("input")).toHaveValue("before hydration");
    expect(await page.locator("input").evaluateAll((inputs) => inputs.map((input) => input.id))).toEqual(ids);
    await page.getByTestId("bottom").scrollIntoViewIfNeeded();
    expect(await bottom.evaluate((node) => node === document.querySelector('[data-testid="bottom"]'))).toBe(true);
    await page.getByTestId("bottom").getByTestId("increment").click();
    await expect(page.getByTestId("bottom").getByTestId("count")).toHaveText("8");
    await expect(page.getByTestId("top").getByTestId("count")).toHaveText("3");
  } finally {
    release();
  }
});

test("conditional children appear, dispose listeners, and remount fresh state", async ({ page, output }) => {
  await page.goto(output.url);
  const top = page.getByTestId("top");
  await expect(top).toHaveAttribute("data-ready", "true");
  const original = await top.elementHandle();
  await expect(page.getByTestId("extra")).toHaveCount(0);
  await top.getByTestId("increment").click();
  await expect(page.getByTestId("extra")).toHaveCount(1);
  await page.evaluate(() => window.dispatchEvent(new Event("probe-ping")));
  await expect(top).toHaveAttribute("data-pings", "1");
  await page.getByTestId("toggle").click();
  await expect(top).toHaveCount(0);
  expect(await original.getAttribute("data-disposed")).toBe("true");
  await page.evaluate(() => window.dispatchEvent(new Event("probe-ping")));
  expect(await original.getAttribute("data-pings")).toBe("1");
  await page.getByTestId("toggle").click();
  await expect(top.getByTestId("count")).toHaveText("3");
});

test("language links load another pre-rendered document", async ({ page, output }) => {
  await page.goto(output.url);
  await page.getByTestId("language").click();
  await expect(page).toHaveURL(output.url + "/en/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByTestId("top")).toHaveAttribute("data-ready", "true");
  await page.getByTestId("top").getByTestId("increment").click();
  await expect(page.getByTestId("top").getByTestId("count")).toHaveText("4");
});
