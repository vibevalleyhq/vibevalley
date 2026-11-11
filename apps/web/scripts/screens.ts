import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium } from "@playwright/test";

const server = process.env.VIBEVALLEY_SERVER;
if (!server) throw new Error("VIBEVALLEY_SERVER is not set: run this under scripts/verify-server.ts");
const pages = (process.env.VIBEVALLEY_PAGES ?? "/farm,/issues,/chat,/library,/artifacts,/agents,/orchestrator,/runtimes,/repos,/catalog,/settings")
  .split(",")
  .filter(Boolean);
const [width = 1440, height = 900] = (process.env.VIBEVALLEY_SCREEN ?? "1440x900").split("x").map(Number);
const out = join(import.meta.dirname, "..", ".screens");
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height } });
const errors: string[] = [];
page.on("pageerror", (e) => errors.push(e.message));
for (const path of pages) {
  /* oxlint-disable eslint/no-await-in-loop -- one page, shown one path at a time */
  await page.goto(server + path);
  // The state stream stays open, so the network is never idle: give the first frame and the pictures a moment.
  await page.waitForLoadState("load");
  if (path === "/farm") await page.locator("canvas").first().waitFor();
  await page.waitForTimeout(3000);
  const name = path.replace(/^\//u, "").replace(/[/?=&]/gu, "-");
  const file = join(out, `${name}-${width}x${height}.png`);
  await page.screenshot({ path: file });
  /* oxlint-enable eslint/no-await-in-loop */
  console.log(file);
}
await browser.close();
if (errors.length > 0) {
  console.error("page errors:\n" + errors.join("\n"));
  process.exit(1);
}
