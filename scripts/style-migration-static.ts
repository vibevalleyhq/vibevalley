/* oxlint-disable no-await-in-loop -- A/A captures and lazy-hydration scroll positions must settle serially, without contention from another capture. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { arch, release } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Browser } from "@playwright/test";

import { hash, migrationInputs, migrationOutput, migrationRoot, sourceInputs } from "./style-migration-inputs";
import { comparePixels } from "./style-migration-pixels";

interface Scene {
  id: string;
  entry: "site" | "stories";
  route: string;
  width: number;
}

const scenes: Scene[] = [];
for (const [name, route] of [
  ["zh", "/"],
  ["en", "/en/"],
  ["404", "/404.html"],
])
  for (const width of [1440, 390]) {
    if (name === undefined || route === undefined) throw new Error("Incomplete site scene");
    scenes.push({ id: `site-${name}-${width}`, entry: "site", route, width });
  }
for (const [name, story] of [
  ["button-states", "组件/工作台/Button:States"],
  ["button-tones", "组件/工作台/Button:Tones"],
  ["button-icons", "组件/工作台/Button:With icon"],
  ["field-states", "组件/工作台/Field:States"],
  ["tabs-states", "组件/工作台/Tabs:States"],
])
  for (const theme of ["light", "dark"])
    for (const width of [400, 800]) {
      if (name === undefined || story === undefined) throw new Error("Incomplete story scene");
      scenes.push({ id: `${name}-${theme}-${width}`, entry: "stories", route: `/?${new URLSearchParams({ s: story, theme, w: String(width) })}`, width: 1680 });
    }
const captureOptions = { locale: "en-US", timezoneId: "UTC", deviceScaleFactor: 1, clock: "2026-11-08T12:00:00.000Z", reducedMotion: "reduce" };
const mime: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".avif": "image/avif",
};

function artifacts(root: string) {
  if (!existsSync(resolve(root, "index.html"))) throw new Error(`Missing built entry: ${root}`);
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile())
    .map((file) => {
      const path = resolve(file.parentPath, file.name);
      return { path: relative(root, path), hash: hash(readFileSync(path)) };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

async function serve(root: string) {
  const server = createServer((request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      const file = resolve(root, `.${path.endsWith("/") ? `${path}index.html` : path}`);
      if (!file.startsWith(`${root}${sep}`) || !statSync(file).isFile()) throw new Error("Not a served file");
      response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
      response.setHeader("Cache-Control", "no-store");
      response.end(readFileSync(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing static-server address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done, reject) => {
        server.close((error) => (error === undefined ? done() : reject(error)));
        server.closeAllConnections();
      }),
  };
}

async function capture(browser: Browser, origin: string, scene: Scene, destination: string) {
  const { clock, ...contextOptions } = captureOptions;
  const context = await browser.newContext({ ...contextOptions, reducedMotion: "reduce", viewport: { width: scene.width, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  try {
    await page.clock.setFixedTime(new Date(clock));
    const response = await page.goto(`${origin}${scene.route}`, { waitUntil: "networkidle" });
    if (response?.status() !== 200) throw new Error(`Entry returned ${response?.status()}`);
    if (scene.entry === "site") {
      for (const island of await page.locator("astro-island").all()) {
        await island.evaluate((element) => element.querySelector(":scope > :not(link):not(style):not(script)")?.scrollIntoView({ block: "center" }));
        await page.waitForFunction((element) => element !== null && !element.hasAttribute("ssr"), await island.elementHandle());
      }
      await page.waitForFunction(() => document.querySelectorAll("astro-island[ssr]").length === 0);
    } else await page.getByTestId("story-frame").waitFor({ state: "visible" });
    await page.evaluate(async (entry) => {
      await document.fonts.ready;
      await Promise.all(
        [...document.querySelectorAll<HTMLImageElement>("img[src]")].map((image) => {
          image.loading = "eager";
          return image.decode();
        }),
      );
      if (entry === "site") {
        for (let y = 0; y < document.documentElement.scrollHeight; y += 900) {
          scrollTo(0, y);
          await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
        }
        scrollTo(0, 0);
      }
    }, scene.entry);
    await page.waitForTimeout(1200);
    const target = scene.entry === "site" ? page.locator("body") : page.getByTestId("story-frame");
    const textHash = hash(await target.innerText());
    if (scene.entry === "site") await page.screenshot({ path: destination, fullPage: true, animations: "disabled" });
    else await target.screenshot({ path: destination, animations: "disabled" });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    return { path: destination, hash: hash(readFileSync(destination)), textHash };
  } finally {
    await context.close();
  }
}

const args = parseArgs({ options: { baseline: { type: "string" } } });
if (args.values.baseline === undefined) throw new Error("Fix: pass --baseline <clean original Git worktree>; static evidence is not the full migration gate.");
const baseline = resolve(args.values.baseline);
if (baseline === migrationRoot) throw new Error("The candidate cannot be its own baseline");
if (execFileSync("git", ["status", "--porcelain"], { cwd: baseline, encoding: "utf8" }).trim() !== "") throw new Error("The baseline worktree must be clean");
const beforeInputs = sourceInputs(baseline);
for (const [cwd, command] of [
  [resolve(baseline, "site"), ["run", "build"]],
  [baseline, ["run", "--no-cache", "--filter", "@vibevalley/web", "build:stories"]],
  [migrationRoot, ["run", "--no-cache", "site:build"]],
  [migrationRoot, ["run", "--no-cache", "--filter", "@vibevalley/web", "build:stories"]],
] satisfies [string, string[]][])
  execFileSync("vp", command, { cwd, stdio: "inherit" });
if (sourceInputs(baseline).digest !== beforeInputs.digest) throw new Error("Baseline sources changed while building");
const inputs = migrationInputs();
const roots = {
  before: { site: resolve(baseline, "site/dist"), stories: resolve(baseline, "apps/web/dist-stories") },
  after: { site: resolve(migrationRoot, "apps/site/dist/client"), stories: resolve(migrationRoot, "apps/web/dist-stories") },
};
const outputs = Object.values(roots)
  .flatMap((entries) => Object.values(entries))
  .map((root) => ({ root, artifacts: artifacts(root) }));
const out = resolve(migrationOutput, "static");
await mkdir(out, { recursive: true });
const results: {
  id: string;
  status: "passed" | "failed";
  error?: string;
  stability?: Awaited<ReturnType<typeof comparePixels>>;
  comparison?: Awaited<ReturnType<typeof comparePixels>>;
  textEqual?: boolean;
}[] = [];
const servers: Awaited<ReturnType<typeof serve>>[] = [];
const browser = await chromium.launch();
try {
  const urls = { before: { site: "", stories: "" }, after: { site: "", stories: "" } };
  await Promise.all(
    (["before", "after"] as const).flatMap((side) =>
      (["site", "stories"] as const).map(async (entry) => {
        const server = await serve(roots[side][entry]);
        servers.push(server);
        urls[side][entry] = server.url;
      }),
    ),
  );
  for (const scene of scenes) {
    try {
      const before = await capture(browser, urls.before[scene.entry], scene, resolve(out, `${scene.id}-before.png`));
      const repeat = await capture(browser, urls.before[scene.entry], scene, resolve(out, `${scene.id}-repeat.png`));
      const stability = await comparePixels(before.path, repeat.path, resolve(out, `${scene.id}-unstable.png`));
      if (!stability.passed || before.textHash !== repeat.textHash) {
        results.push({ id: scene.id, status: "failed", stability, error: "Unstable baseline; candidate comparison was not accepted" });
        continue;
      }
      const after = await capture(browser, urls.after[scene.entry], scene, resolve(out, `${scene.id}-after.png`));
      const comparison = await comparePixels(before.path, after.path, resolve(out, `${scene.id}-diff.png`));
      const textEqual = before.textHash === after.textHash;
      results.push({ id: scene.id, stability, comparison, textEqual, status: comparison.passed && textEqual ? "passed" : "failed" });
      console.info(`${scene.id}: ${comparison.changedPixels} changed pixels, text equal: ${textEqual}`);
    } catch (error) {
      results.push({ id: scene.id, status: "failed", error: String(error) });
    }
  }
} finally {
  await browser.close();
  await Promise.all(servers.map((server) => server.close()));
}
const errors: string[] = [];
if (migrationInputs().digest !== inputs.digest || sourceInputs(baseline).digest !== beforeInputs.digest) errors.push("Sources changed during capture");
for (const output of outputs)
  if (hash(JSON.stringify(artifacts(output.root))) !== hash(JSON.stringify(output.artifacts)))
    errors.push(`Build output changed during capture: ${output.root}`);
const status = errors.length === 0 && results.length === scenes.length && results.every((result) => result.status === "passed") ? "passed" : "failed";
await writeFile(
  resolve(migrationOutput, "visual-static.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      scope: "static-site-and-component-frames",
      status,
      inputs,
      baseline: beforeInputs,
      outputs,
      environment: {
        platform: process.platform,
        arch: arch(),
        release: release(),
        browser: browser.version(),
        executableHash: hash(readFileSync(chromium.executablePath())),
        ...captureOptions,
      },
      expected: scenes,
      executed: results,
      skipped: [],
      errors,
      notCovered: ["live-workbench", "farm-and-tree-dom", "desktop-host", "mobile-host", "interactive-website-states"],
    },
    null,
    2,
  )}\n`,
);
console.info(`Static visual evidence: ${status}, ${results.length}/${scenes.length} scenes. This is not aggregate migration acceptance.`);
if (status !== "passed") process.exitCode = 1;
