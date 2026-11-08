/* oxlint-disable no-await-in-loop -- A/A captures and lazy-hydration scroll positions must settle serially, without contention from another capture. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { arch, release } from "node:os";
import { extname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { chromium, type Browser, type Page } from "@playwright/test";

import { buildEvidence, originalRevision, type FileEvidence } from "./style-migration-evidence";
import { hash, migrationInputs, migrationOutput, migrationRoot, sourceInputs } from "./style-migration-inputs";
import { comparePixels } from "./style-migration-pixels";
import { staticScenes as scenes, type Scene } from "./style-migration-scenes";

const viewerFiles = ["apps/web/test/migration/index.html", "apps/web/test/migration/viewer.tsx", "apps/web/test/migration/vite.config.ts"];
const captureOptions = { locale: "en-US", timezoneId: "UTC", deviceScaleFactor: 1, clock: "2026-11-08T12:00:00.000Z", reducedMotion: "reduce" };
const normalMotionCapture = { hydrationMs: 1000, scrollFrameMs: 32, settleMs: 5000, animationMs: 1200, nativePlaybackRate: 0 };
const browserArgs = ["--disable-skia-runtime-opts", "--disable-partial-raster", "--num-raster-threads=1", "--force-color-profile=srgb"];
const mediaPath = "scripts/testdata/style-migration/attachment.mp4";
const mediaFixture = readFileSync(resolve(migrationRoot, mediaPath));
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

function filesUnder(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile())
    .map((file) => {
      const path = resolve(file.parentPath, file.name);
      return { path: relative(root, path), hash: hash(readFileSync(path)) };
    })
    .toSorted((a, b) => a.path.localeCompare(b.path));
}

function artifacts(root: string) {
  if (!existsSync(resolve(root, "index.html"))) throw new Error(`Missing built entry: ${root}`);
  return filesUnder(root);
}

async function serve(root: string) {
  const server = createServer((request, response) => {
    try {
      const path = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
      if (path === "/api/v1/attachment/a2") {
        response.setHeader("Content-Type", "video/mp4");
        response.setHeader("Content-Length", mediaFixture.length);
        response.setHeader("Cache-Control", "no-store");
        response.end(mediaFixture);
        return;
      }
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

async function createPaintBarrier(page: Page) {
  const session = await page.context().newCDPSession(page);
  const { frameTree } = await session.send("Page.getFrameTree");
  const { executionContextId } = await session.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "migration-paint" });
  // The main world's clock is paused; native scroll/visibility delivery still needs real rendering frames.
  return () =>
    session.send("Runtime.evaluate", {
      contextId: executionContextId,
      expression:
        "(() => { const { promise, resolve } = Promise.withResolvers(); requestAnimationFrame(() => requestAnimationFrame(resolve)); return promise; })()",
      awaitPromise: true,
    });
}

async function capture(browser: Browser, origin: string, scene: Scene, destination: string) {
  const { clock, ...contextOptions } = captureOptions;
  const normalMotion = scene.entry === "site" && scene.reducedMotion === "no-preference";
  const context = await browser.newContext({
    ...contextOptions,
    reducedMotion: scene.reducedMotion ?? "reduce",
    viewport: { width: scene.width, height: 1000 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  try {
    if (normalMotion) {
      // Playwright's clock controls JS, not Chromium's native animation timeline.
      const nativeClock = await context.newCDPSession(page);
      await nativeClock.send("Animation.enable");
      await nativeClock.send("Animation.setPlaybackRate", { playbackRate: normalMotionCapture.nativePlaybackRate });
      await page.clock.install({ time: new Date(clock) });
      await page.clock.pauseAt(new Date(Date.parse(clock) + normalMotionCapture.hydrationMs));
    }
    await page.clock.setFixedTime(new Date(clock));
    const response = await page.goto(`${origin}${scene.route}`, { waitUntil: "networkidle" });
    if (response?.status() !== 200) throw new Error(`Entry returned ${response?.status()}`);
    if ((await page.evaluate(() => document.compatMode)) !== "CSS1Compat") throw new Error("Comparison entry must render in HTML standards mode");
    const paint = normalMotion ? await createPaintBarrier(page) : undefined;
    const settle = async (milliseconds: number) => {
      if (paint === undefined) await page.waitForTimeout(milliseconds);
      else {
        await paint();
        await page.clock.runFor(milliseconds);
        await paint();
      }
    };
    if (normalMotion) await page.clock.runFor(normalMotionCapture.hydrationMs);
    if (scene.entry === "site") {
      if (normalMotion) {
        // Eager and island hydration must encounter the same reveal boundaries.
        for (const section of await page.locator("header, section[id]").all()) {
          await section.evaluate((element) => scrollTo({ top: element.getBoundingClientRect().top + scrollY - innerHeight + 1, behavior: "instant" }));
          await page.waitForFunction(
            (element) => element !== null && element.closest("astro-island")?.hasAttribute("ssr") !== true,
            await section.elementHandle(),
            { polling: 50 },
          );
          await settle(normalMotionCapture.scrollFrameMs);
        }
      } else {
        for (const island of await page.locator("astro-island").all()) {
          await island.evaluate((element) => element.querySelector(":scope > :not(link):not(style):not(script)")?.scrollIntoView({ block: "center" }));
          await page.waitForFunction((element) => element !== null && !element.hasAttribute("ssr"), await island.elementHandle(), { polling: 50 });
        }
      }
      await page.waitForFunction(() => document.querySelectorAll("astro-island[ssr]").length === 0, undefined, { polling: 50 });
    } else await page.getByTestId("story-frame").waitFor({ state: "visible" });
    if (scene.entry === "viewer") {
      switch (scene.viewerState) {
        case "input":
          await page.locator('[data-testid="story-arg"][data-name="count"]').getByRole("spinbutton").fill("5");
          break;
        case "hover":
          await page.locator('[data-testid="story-link"][data-key="Viewer/Controls:Inputs"]').hover();
          break;
        case "rest":
          break;
        default:
          throw new Error("Missing viewer interaction state");
      }
    }
    const popupRole = scene.popup === "select" ? "listbox" : scene.popup === "menu" ? "menu" : "tooltip";
    if (scene.popup !== undefined) {
      const frame = page.getByTestId("story-frame");
      switch (scene.popup) {
        case "select":
          await frame.getByRole("combobox").click();
          break;
        case "menu":
          await frame.locator('button[aria-haspopup="menu"]').click();
          break;
        case "tooltip":
          await frame.locator('span[tabindex="0"]').first().focus();
          break;
      }
      await page.getByRole(popupRole).waitFor({ state: "visible" });
    }
    await page.evaluate(
      async ({ entry, controlled }) => {
        await document.fonts.ready;
        await Promise.all(
          [...document.querySelectorAll<HTMLImageElement>("img[src]")].map((image) => {
            image.loading = "eager";
            return image.decode();
          }),
        );
        for (const video of document.querySelectorAll<HTMLVideoElement>("video[src]")) {
          if (video.error !== null) throw new Error(`Media fixture failed: ${video.currentSrc}`);
          if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            video.preload = "auto";
            video.load();
          }
        }
        if (entry === "site" && !controlled) {
          for (let y = 0; y < document.documentElement.scrollHeight; y += 900) {
            scrollTo(0, y);
            await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
          }
          scrollTo(0, 0);
        }
      },
      { entry: scene.entry, controlled: normalMotion },
    );
    if (normalMotion) {
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < height; y += 900) {
        await page.evaluate((top) => scrollTo({ top, behavior: "instant" }), y);
        await settle(normalMotionCapture.scrollFrameMs);
      }
      await page.evaluate(() => scrollTo({ top: 0, behavior: "instant" }));
    }
    await page.waitForFunction(
      () => [...document.querySelectorAll<HTMLVideoElement>("video[src]")].every((video) => video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA),
      undefined,
      { polling: 50 },
    );
    await settle(1200);
    if (scene.hour !== undefined) {
      const index = ["morning", "day", "evening", "night"].indexOf(scene.hour);
      const button = page.locator('#top [role="group"] button').nth(index);
      await button.click();
      if (normalMotion)
        await page.waitForFunction(
          (progress) => {
            const hero = document.getElementById("top");
            return hero !== null && scrollY === Math.round(progress * (hero.offsetHeight - innerHeight));
          },
          { morning: 0, day: 0.37, evening: 0.64, night: 1 }[scene.hour],
          { polling: 50 },
        );
      await settle(normalMotion ? normalMotionCapture.settleMs : 1200);
      await page.waitForFunction((hour) => document.documentElement.dataset.scene === hour, scene.hour, { polling: 50 });
    }
    if (scene.link !== undefined) {
      const link = page.locator(scene.link === "primary" ? '#top a[href="https://github.com/vibevalleyhq/vibevalley"]' : '#top a[href="#how"]');
      switch (scene.linkState) {
        case "hover":
          await link.hover();
          break;
        case "active":
          await link.hover();
          await page.mouse.down();
          break;
        case "focus":
          await page.keyboard.press("Tab");
          await link.focus();
          break;
        default:
          throw new Error("Missing site link interaction state");
      }
      await page.waitForTimeout(1200);
    }
    if (scene.entry === "viewer")
      await page.waitForFunction(() => {
        const count = document.querySelector('[data-testid="story-a11y"]')?.getAttribute("data-count");
        return count !== undefined && count !== null && count !== "";
      });
    const target =
      scene.entry === "site" || scene.entry === "viewer"
        ? page.locator("body")
        : scene.popup !== undefined
          ? page.getByRole(popupRole)
          : page.getByTestId("story-frame");
    const textHash = hash(await target.innerText());
    if (normalMotion) {
      await page.evaluate(async (time) => {
        const animations = document.getAnimations();
        for (const animation of animations) {
          if (animation instanceof CSSAnimation) {
            animation.pause();
            animation.currentTime = time;
          } else if (
            animation instanceof CSSTransition ||
            (animation.timeline instanceof DocumentTimeline &&
              animation.playState === "running" &&
              animation.effect?.getComputedTiming().iterations !== Infinity)
          )
            animation.finish();
        }
        await Promise.all(animations.map((animation) => animation.ready));
      }, normalMotionCapture.animationMs);
      await paint?.();
    }
    if (scene.entry === "site") await page.screenshot({ path: destination, fullPage: true, animations: normalMotion ? "allow" : "disabled" });
    else if (scene.popup !== undefined) {
      const box = await target.boundingBox();
      if (box === null) throw new Error("Missing popup geometry");
      await page.screenshot({
        path: destination,
        animations: "disabled",
        clip: { x: box.x - 32, y: box.y - 32, width: box.width + 64, height: box.height + 64 },
      });
    } else await target.screenshot({ path: destination, animations: "disabled" });
    if (errors.length > 0) throw new Error(errors.join("\n"));
    return { path: destination, hash: hash(readFileSync(destination)), textHash };
  } finally {
    await context.close();
  }
}

const args = parseArgs({ options: { baseline: { type: "string" } } });
await rm(resolve(migrationOutput, "visual-static.json"), { force: true });
if (args.values.baseline === undefined) throw new Error("Fix: pass --baseline <clean original Git worktree>; static evidence is not the full migration gate.");
const baseline = resolve(args.values.baseline);
if (baseline === migrationRoot) throw new Error("The candidate cannot be its own baseline");
if (execFileSync("git", ["status", "--porcelain"], { cwd: baseline, encoding: "utf8" }).trim() !== "") throw new Error("The baseline worktree must be clean");
const beforeInputs = sourceInputs(baseline);
if (beforeInputs.revision !== originalRevision) throw new Error(`Fix: use the approved original baseline ${originalRevision}, not a rewritten reference.`);
for (const [cwd, command] of [
  [resolve(baseline, "site"), ["run", "build"]],
  [baseline, ["run", "--no-cache", "--filter", "@vibevalley/web", "build:stories"]],
  [migrationRoot, ["run", "--no-cache", "site:build"]],
  [migrationRoot, ["run", "--no-cache", "--filter", "@vibevalley/web", "build:stories"]],
] satisfies [string, string[]][])
  execFileSync("vp", command, { cwd, stdio: "inherit" });
if (sourceInputs(baseline).digest !== beforeInputs.digest) throw new Error("Baseline sources changed while building");
const viewerRuntime = ["solid-js", "@solidjs/web"].map((name) => {
  const before = filesUnder(resolve(baseline, "apps/web/node_modules", name));
  const files = filesUnder(resolve(migrationRoot, "apps/web/node_modules", name));
  if (hash(JSON.stringify(before)) !== hash(JSON.stringify(files))) throw new Error(`Viewer fixture runtime differs from the original: ${name}`);
  return { name, files };
});
const roots = {
  before: { site: resolve(baseline, "site/dist"), stories: resolve(baseline, "apps/web/dist-stories"), viewer: resolve(migrationOutput, "viewer-before") },
  after: {
    site: resolve(migrationRoot, "apps/site/dist/client"),
    stories: resolve(migrationRoot, "apps/web/dist-stories"),
    viewer: resolve(migrationOutput, "viewer-after"),
  },
};
for (const [host, output] of [
  [baseline, roots.before.viewer],
  [migrationRoot, roots.after.viewer],
] as const)
  execFileSync("vp", ["build", "--config", "test/migration/vite.config.ts"], {
    cwd: resolve(migrationRoot, "apps/web"),
    stdio: "inherit",
    env: {
      ...process.env,
      VIBEVALLEY_MIGRATION_HOST: host,
      VIBEVALLEY_MIGRATION_OUTPUT: output,
      VIBEVALLEY_MIGRATION_LEGACY_PLUGIN:
        host === baseline ? createRequire(resolve(baseline, "apps/web/package.json")).resolve("@tailwindcss/vite") : undefined,
    },
  });
if (sourceInputs(baseline).digest !== beforeInputs.digest) throw new Error("Baseline sources changed while building the viewer fixture");
const inputs = migrationInputs();
const builds = buildEvidence();
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
  visual?: { before: FileEvidence; repeat: FileEvidence; after: FileEvidence };
  evidence?: FileEvidence[];
}[] = [];
const servers: Awaited<ReturnType<typeof serve>>[] = [];
const browser = await chromium.launch({ args: browserArgs });
try {
  const urls = { before: { site: "", stories: "", viewer: "" }, after: { site: "", stories: "", viewer: "" } };
  await Promise.all(
    (["before", "after"] as const).flatMap((side) =>
      (["site", "stories", "viewer"] as const).map(async (entry) => {
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
      results.push({
        id: scene.id,
        stability,
        comparison,
        textEqual,
        visual: { before, repeat, after },
        evidence: [before, repeat, after],
        status: comparison.passed && textEqual ? "passed" : "failed",
      });
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
      kind: "static",
      createdAt: new Date().toISOString(),
      builds,
      scope: "static-site-component-frames-and-viewer-fixture",
      status,
      inputs,
      baseline: beforeInputs,
      outputs,
      fixtures: [
        { path: mediaPath, route: "/api/v1/attachment/a2", hash: hash(mediaFixture) },
        ...viewerFiles.map((path) => ({ path, hash: hash(readFileSync(resolve(migrationRoot, path))) })),
      ],
      viewerRuntime,
      environment: {
        browserArgs,
        platform: process.platform,
        arch: arch(),
        release: release(),
        browser: browser.version(),
        executableHash: hash(readFileSync(chromium.executablePath())),
        ...captureOptions,
        normalMotionCapture,
      },
      expected: scenes.map((scene) => scene.id),
      scenarios: scenes,
      executed: results,
      skipped: [],
      errors,
      notCovered: ["live-workbench", "farm-and-tree-dom", "desktop-host", "mobile-host", "website-behavior"],
    },
    null,
    2,
  )}\n`,
);
console.info(`Static visual evidence: ${status}, ${results.length}/${scenes.length} scenes. This is not aggregate migration acceptance.`);
if (status !== "passed") process.exitCode = 1;
