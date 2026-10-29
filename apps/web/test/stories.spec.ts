// The stories' page is static, served from the run's build: no farm server is started.

import AxeBuilder from "@axe-core/playwright";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { expect, test as base } from "./fixtures";

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

const test = base.extend<object, { stories: string }>({
  stories: [
    async ({ farm: _farm }, use) => {
      const root = join(process.env.VIBEVALLEY_TEST_OUT!, "stories");
      const server = createServer((req, res) => {
        const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
        let file = join(root, path);
        if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
        res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
        createReadStream(file).pipe(res);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      server.close();
    },
    { scope: "worker" },
  ],
  baseURL: async ({ stories }, use) => use(stories),
});

// Wide enough for two frames of a page-sized part side by side, with the tree and the arguments.
test.use({ viewport: { width: 1680, height: 1000 } });

const key = (k: string) => `[data-testid="story-link"][data-key="${k}"]`;
const folder = (path: string) => `[data-testid="story-folder"][data-key="${path}"]`;

test("the viewer opens a story from the address, in folders, and keeps the view in it", async ({ page }) => {
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Button:Tones", theme: "dark", w: "400" })}`);
  await expect(page.locator(key("组件/工作台/Button:Tones"))).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("story-frame")).toHaveCount(1);
  await expect(page.getByTestId("story-frame")).toHaveAttribute("data-theme", "dark");

  await expect(page.locator(folder("设计体系"))).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(folder("组件/工作台"))).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(folder("组件/像素"))).toHaveAttribute("aria-expanded", "false");
  await page.locator(folder("组件/像素")).click();
  await expect(page.locator(folder("组件/像素"))).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-testid="story-link"][data-key^="组件/像素/"]').first()).toBeVisible();

  await page.getByTestId("story-theme").locator('[data-value="both"]').click();
  await expect(page.getByTestId("story-frame")).toHaveCount(2);
  await page.locator(key("组件/工作台/Button:Playground")).click();
  await expect(page).toHaveURL(new RegExp(`s=${encodeURIComponent("组件/工作台/Button:Playground")}&theme=both&w=400`));

  const label = page.locator('[data-testid="story-arg"][data-name="label"] input');
  await label.fill("go");
  await expect(page.getByTestId("story-frame").first().locator("button")).toHaveText("go");
  await page.getByTestId("story-reset").click();
  await expect(label).not.toHaveValue("go");

  await page.getByTestId("stories-search").fill("工作台 button tones");
  await expect(page.getByTestId("story-link")).toHaveCount(1);
});

test("a state grid draws every combination, and a forced state looks as the real one does", async ({ page }) => {
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/Button:States", theme: "light", w: "full" })}`);
  const grid = page.getByTestId("story-grid");
  // Four tones down, rest / hover / focus / pressed across.
  await expect(grid.getByTestId("story-cell")).toHaveCount(16);
  const ground = (state: string) =>
    grid
      .locator(`tr:nth-child(1) [data-testid="story-cell"]${state === "rest" ? ":not([data-pseudo])" : `[data-pseudo="${state}"]`} button`)
      .evaluate((b) => getComputedStyle(b).backgroundColor);
  expect(await ground("hover")).not.toBe(await ground("rest"));
  const ring = (state: string) =>
    grid
      .locator(`tr:nth-child(1) [data-testid="story-cell"]${state === "rest" ? ":not([data-pseudo])" : `[data-pseudo="${state}"]`} button`)
      .evaluate((b) => getComputedStyle(b).outlineStyle);
  expect(await ring("focus")).not.toBe(await ring("rest"));

  // The single view takes one state for the whole frame.
  await page.getByTestId("story-mode").locator('[data-value="single"]').click();
  await page.getByTestId("story-state").locator('[data-value="hover"]').click();
  await expect(page.getByTestId("story-frame")).toHaveAttribute("data-pseudo", "hover");
  await expect(page).toHaveURL(/view=single&state=hover/);

  await expect(page.getByTestId("story-a11y")).toHaveAttribute("data-count", "0");
  await page.getByTestId("story-a11y").click();
  await expect(page.getByTestId("story-a11y-panel")).toBeVisible();
});

test("the language comes from the address, before the parts draw", async ({ page }) => {
  await page.goto(`/?${new URLSearchParams({ s: "组件/工作台/ConfirmButton:Delete", theme: "light", lang: "en" })}`);
  await expect(page.locator("html")).toHaveAttribute("data-locale", "en");
  await expect(page.getByTestId("story-lang").locator('[data-value="en"]')).toHaveAttribute("aria-checked", "true");
});

// One test per stories file, so they spread over the workers; the titles are read off the files, as the viewer is not
// loaded here.
const titles = readdirSync(join(import.meta.dirname, "..", "src"), { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".stories.tsx"))
  .map((f) => /title: "([^"]+)"/.exec(readFileSync(join(import.meta.dirname, "..", "src", f), "utf8"))?.[1] ?? f);

for (const title of titles)
  test(`${title}: each story draws in each of its themes with nothing for axe to find`, async ({ page }) => {
    await page.goto("/");
    // A search opens every folder it finds something in.
    await page.getByTestId("stories-search").fill(title);
    const keys = await page.locator(`[data-testid="story-link"][data-key^="${title}:"]`).evaluateAll((links) => links.map((a) => a.getAttribute("data-key")!));
    expect(keys.length, `no stories titled ${title}`).toBeGreaterThan(0);
    const found: string[] = [];
    for (const key of keys) {
      await page.goto(`/?${new URLSearchParams({ s: key, theme: "both", w: "full" })}`);
      await expect(page.getByTestId("story-frame").first()).toBeVisible();
      if (await page.getByTestId("story-error").count()) found.push(`${key}: ${await page.getByTestId("story-error").first().innerText()}`);
      // Measured once things have moved in; a pulse that never ends is not waited for.
      await page.evaluate(() =>
        Promise.all(
          document
            .getAnimations()
            .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
            .map((a) => a.finished.catch(() => undefined)),
        ),
      );
      const { violations } = await new AxeBuilder({ page }).include('[data-testid="story-canvas"]').withTags(["wcag2a", "wcag2aa"]).analyze();
      for (const v of violations)
        found.push(`${key} ${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.any.map((c) => c.message).join(" ")}`).join(", ")}`);
    }
    expect(found).toEqual([]);
  });
