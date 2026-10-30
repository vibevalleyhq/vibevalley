// Screenshots of the page on a running server, for acceptance/page.md: each path in VIBEVALLEY_PAGES (comma-separated, default
// the farm and every workbench place) at VIBEVALLEY_SCREEN (WxH, default 1440x900), into apps/web/.screens/<name>.png.
// The server is VIBEVALLEY_SERVER (scripts/verify-server.ts sets it); it must serve the page (--web).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const server = process.env.VIBEVALLEY_SERVER;
if (!server) throw new Error("VIBEVALLEY_SERVER is not set: run this under scripts/verify-server.ts");
const pages = (process.env.VIBEVALLEY_PAGES ?? "/,/issues,/chat,/docs,/agents,/manager,/runtimes,/projects,/catalog,/settings").split(",").filter(Boolean);
const [width, height] = (process.env.VIBEVALLEY_SCREEN ?? "1440x900").split("x").map(Number);
const out = join(import.meta.dirname, "..", ".screens");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: width!, height: height! } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
// The title screen comes once a machine: seen, so the farm itself is drawn.
await page.addInitScript(() => localStorage.setItem("vibevalley.title.seen", "true"));
for (const path of pages) {
  await page.goto(server + path);
  // The state stream stays open, so the network is never idle: give the first frame and the pictures a moment.
  await page.waitForLoadState("load");
  if (path === "/") await page.locator("canvas").first().waitFor();
  await page.waitForTimeout(3000);
  const name = path === "/" ? "farm" : path.replace(/^\//u, "").replace(/[/?=&]/gu, "-");
  const file = join(out, `${name}-${width}x${height}.png`);
  await page.screenshot({ path: file });
  console.log(file);
}
await browser.close();
if (errors.length > 0) {
  console.error("page errors:\n" + errors.join("\n"));
  process.exit(1);
}
