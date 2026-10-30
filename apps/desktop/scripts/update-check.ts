// The steps and what they prove: acceptance desktop-update.md. The farm's home and Electron's user data are temporary;
// the owner's app and ~/.vibevalley are not touched.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron } from "@playwright/test";

const desktop = join(import.meta.dirname, "..");
const dist = join(desktop, "dist");
const work = mkdtempSync(join(tmpdir(), "vibevalley-update-check-"));
const installed = join(work, "Applications", "VibeValley.app");
const say = (line: string) => console.log(`update-check: ${line}`);

const pack = (version: string) => {
  say(`packaging ${version}`);
  execFileSync("vpx", ["scripts/package.ts"], { cwd: desktop, stdio: "inherit", env: { ...process.env, VIBEVALLEY_VERSION: version } });
};
const versionOf = () =>
  execFileSync("plutil", ["-extract", "CFBundleShortVersionString", "raw", join(installed, "Contents", "Info.plist")], { encoding: "utf8" }).trim();

pack("0.0.1");
mkdirSync(join(work, "Applications"));
execFileSync("ditto", [join(dist, `mac-${process.arch}`, "VibeValley.app"), installed]);
pack("0.0.2");
const zip = `VibeValley-0.0.2-${process.arch}.zip`;
for (const feed of ["good", "bad"]) {
  mkdirSync(join(work, feed));
  copyFileSync(join(dist, zip), join(work, feed, zip));
}
copyFileSync(join(dist, "release.json"), join(work, "good", "release.json"));
const release: unknown = JSON.parse(readFileSync(join(dist, "release.json"), "utf8"));
writeFileSync(join(work, "bad", "release.json"), JSON.stringify(release).replace(/"sha512":"[0-9a-f]+"/u, `"sha512":"${"0".repeat(128)}"`));

const files = createServer((req, res) => {
  try {
    res.end(readFileSync(join(work, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname))));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
await new Promise<void>((resolve) => files.listen(0, "127.0.0.1", resolve));
const address = files.address();
const feed = (name: string) => `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}/${name}/release.json`;

async function run(feedUrl: string) {
  const dir = mkdtempSync(join(work, "run-"));
  const app = await electron.launch({
    executablePath: join(installed, "Contents", "MacOS", "VibeValley"),
    args: [`--user-data-dir=${join(dir, "electron")}`],
    env: { ...process.env, VIBEVALLEY_HOME: join(dir, "home"), VIBEVALLEY_UPDATE_FEED: feedUrl },
  });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//u, { timeout: 90_000 });
    await page.goto(new URL(page.url()).origin + "/settings/about");
    const state = page.getByTestId("update-state");
    await page.waitForFunction(
      () => ["ready", "failed", "manual", "idle"].includes(document.querySelector('[data-testid="update-state"]')?.getAttribute("data-state") ?? ""),
      undefined,
      { timeout: 300_000 },
    );
    const settled = {
      state: (await state.getAttribute("data-state")) ?? "",
      text: (await state.textContent()) ?? "",
      version: await app.evaluate(({ app }) => app.getVersion()),
    };
    await app.evaluate(({ app }) => app.quit());
    return settled;
  } finally {
    await app.close().catch(() => undefined);
  }
}

const results: Record<string, unknown> = { work };
try {
  results.wrongHash = await run(feed("bad"));
  results.afterWrongHash = versionOf();
  results.update = await run(feed("good"));
  // The swap waits for the app's process to go, then moves the folders: a moment after quitting.
  const deadline = Date.now() + 30_000;
  while (versionOf() !== "0.0.2" && Date.now() < deadline) execFileSync("sleep", ["0.5"]);
  results.afterUpdate = versionOf();
  results.reopened = await run(feed("good"));
} finally {
  files.close();
}
say(JSON.stringify(results, null, 2));
const ok =
  JSON.stringify(results.wrongHash).includes('"state":"failed"') &&
  results.afterWrongHash === "0.0.1" &&
  JSON.stringify(results.update).includes('"state":"ready"') &&
  results.afterUpdate === "0.0.2" &&
  JSON.stringify(results.reopened).includes('"version":"0.0.2"') &&
  JSON.stringify(results.reopened).includes('"state":"idle"');
say(ok ? "passed" : "FAILED");
process.exit(ok ? 0 : 1);
