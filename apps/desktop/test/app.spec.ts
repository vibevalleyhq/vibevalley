// The whole desktop app: Electron starts the server (apps/server) (a temporary home), the window shows the page it serves, the
// state stream brings an issue made through the API to the board without a reload, and a notice the page sends through
// the host interface reaches the main process. Which calls ring is apps/web/src/rules/notice.ts's (its own tests).

import { _electron as electron, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VibeValleyApi } from "@vibevalley/protocol";
import type { Notice } from "@vibevalley/host";

// The server and the agents it runs read keys from the environment: a test must never reach a real model, voice service or
// chat bot with the owner's keys, nor read the owner's VIBEVALLEY_* settings. HOME is the test's folder too: the coding agents'
// own logins (~/.pi, ~/.claude, …) stay out of reach.
const secret = /KEY|TOKEN|SECRET|CERTIFICATE|PASSWORD|^AGORA_|^VIBEVALLEY_/;
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !secret.test(k)));

/** Another VibeValley holds the single-instance lock (this repo's Electron on the app folder, as desktop:dev runs it, or
 * the packaged app): the one launched here would quit at once, "closed" being all Playwright could say. */
function openAlready(): string | undefined {
  const app = join(import.meta.dirname, "..");
  const repo = join(app, "..", "..");
  const pattern = `^${repo}/node_modules/.*/MacOS/Electron (\\.|${app})$|VibeValley\\.app/Contents/MacOS/VibeValley$`;
  try {
    return execFileSync("pgrep", ["-fl", pattern], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

test("the desktop app shows the live board and sends a notice", async () => {
  const open = openAlready();
  if (open) throw new Error(`VibeValley is already open (pnpm run desktop:dev?); close it first, only one may run:\n${open}`);
  const dir = mkdtempSync(join(tmpdir(), "vibevalley-desktop-"));
  const app = await electron.launch({
    args: [join(import.meta.dirname, "..")],
    env: { ...cleanEnv(), HOME: dir, VIBEVALLEY_HOME: join(dir, "home"), VIBEVALLEY_WORK_ROOT: join(dir, "work") },
  });
  const page = await app.firstWindow();
  // The window opens on the farm once the server is up; the board is a place of its own.
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
  const server = new URL(page.url()).origin;
  await page.goto(server + "/issues");
  await expect(page.getByRole("status")).toHaveText("已连上");

  const api = new VibeValleyApi(server);
  await api.issue.create({ body: { title: "桌面版看到我了" } });
  await expect(page.getByText("桌面版看到我了")).toBeVisible();

  const host = await page.evaluate(async () => {
    const h = (window as unknown as { vibevalleyHost: { name: string; notify: (n: Notice) => Promise<void> } }).vibevalleyHost;
    await h.notify({ title: "小吴 做完了", body: "打卡写好了" });
    return h.name;
  });
  expect(host).toBe("desktop");
  const notices = await app.evaluate(() => (globalThis as { vibevalleyNotices?: Notice[] }).vibevalleyNotices ?? []);
  expect(notices).toEqual([{ title: "小吴 做完了", body: "打卡写好了" }]);
  // The page keeps the menu bar's tray to the farm, and has the key that calls the manager from anywhere.
  await expect.poll(() => app.evaluate(() => (globalThis as { vibevalleyTray?: { lines: string[] } }).vibevalleyTray?.lines ?? [])).toContain("还没开工");
  expect(
    await page.evaluate(
      () => (window as unknown as { vibevalleyHost: { voiceShortcut: { accelerator: string } | null } }).vibevalleyHost.voiceShortcut?.accelerator,
    ),
  ).toBe("Alt+Shift+Space");

  await page.screenshot({ path: test.info().outputPath("desktop.png") });
  await app.close();
  // Quitting stopped the server it started.
  await expect(fetch(server + "/api/health")).rejects.toThrow();
});
