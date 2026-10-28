// The whole desktop app: Electron starts the server (apps/server) (a temporary home), the window shows the page it serves, the
// state stream brings an issue made through the API to the board without a reload, and a notice the page sends through
// the host interface reaches the main process. Which calls ring is apps/web/src/features/notice/tray.ts's (its own tests).

import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VibeValleyApi, pathOf } from "@vibevalley/protocol";
import type { Notice } from "@vibevalley/protocol/host";

// The server and the agents it runs read keys from the environment: a test must never reach a real model, voice service or
// chat bot with the owner's keys, nor read the owner's VIBEVALLEY_* settings. HOME is the test's folder too: the coding agents'
// own logins (~/.pi, ~/.claude, …) stay out of reach.
const secret = /KEY|TOKEN|SECRET|CERTIFICATE|PASSWORD|^AGORA_|^VIBEVALLEY_/;
/** Every built-in template but the default orchestrator's (apps/server/src/agent/templates/index.json): what a test farm
 * starts with, as a farm whose agent.starters names them. */
const starters = () =>
  (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "server", "src", "agent", "templates", "index.json"), "utf8")) as string[])
    .filter((id) => id !== "orchestrator")
    .join(",");
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !secret.test(k)));

test("the desktop app shows the live board and sends a notice", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vibevalley-desktop-")));
  const userData = join(dir, "electron");
  const app = await electron.launch({
    // Electron applies this before main.ts requests its single-instance lock; the owner's running app has another profile.
    args: [`--user-data-dir=${userData}`, join(import.meta.dirname, "..")],
    env: { ...cleanEnv(), HOME: dir, VIBEVALLEY_HOME: join(dir, "home"), VIBEVALLEY_WORK_ROOT: join(dir, "work") },
  });
  let server = "";
  try {
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);
    const page = await app.firstWindow();
    // The window opens on the workbench once the server is up; the board is a place of its own.
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/chat$/, { timeout: 45_000 });
    server = new URL(page.url()).origin;
    await page.goto(server + "/issues");
    await expect(page.getByRole("status")).toHaveText("已连上");

    const api = new VibeValleyApi(server);
    await api.issue.create({ title: "桌面版看到我了" });
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
    // The menu bar speaks the farm's language, and follows it when the page loads in another.
    const menu = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items.map((i) => i.label) ?? []);
    expect(await menu()).toContain("编辑");
    await api.setting.update({ locale: "en" });
    await page.reload();
    await expect.poll(menu).toContain("Edit");
    await api.setting.update({ locale: "zh" });
    await page.reload();
    await expect.poll(menu).toContain("编辑");
    // On macOS the window's buttons sit over the rail's top: the rail reaches past the last of them.
    const titleBar = await page.evaluate(() => (window as unknown as { vibevalleyHost: { titleBar: { left: number } | null } }).vibevalleyHost.titleBar);
    if (titleBar) expect((await page.getByRole("navigation", { name: "工作台" }).boundingBox())?.width).toBeGreaterThan(titleBar.left);
    // Between two whole scales the farm would have bars around it: when a resize ends, the window takes the nearest size
    // it fills.
    const resized = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setContentSize(1220, 813);
      w.emit("resized");
      return w.getContentSize();
    });
    expect(resized).toEqual([1152, 768]);

    await page.screenshot({ path: test.info().outputPath("desktop.png") });
  } finally {
    await app.close();
  }
  // Quitting stopped the server it started.
  await expect(fetch(server + pathOf("server.health.get"), { method: "POST" })).rejects.toThrow();
});

test("the window opens on the bar at once, and says there why the server could not start", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vibevalley-desktop-")));
  // A file where the farm's home should be: the server cannot start in it.
  const home = join(dir, "home");
  writeFileSync(home, "");
  const app = await electron.launch({
    args: [`--user-data-dir=${join(dir, "electron")}`, join(import.meta.dirname, "..")],
    env: { ...cleanEnv(), HOME: dir, VIBEVALLEY_HOME: home, VIBEVALLEY_WORK_ROOT: join(dir, "work") },
  });
  // What the main process says, kept with the results (CI uploads them): this case fails before any page can.
  const said: string[] = [];
  for (const out of [app.process().stdout, app.process().stderr]) out?.on("data", (d) => said.push(String(d)));
  try {
    const page = await app.firstWindow();
    await expect(page).toHaveURL(/\/opening\.html\?.*\bproblem=/);
    await expect(page.getByText(/^农场起不来：/)).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveCount(0);
    // The window shows on its first ready-to-show, which may come after the page is drawn hidden: wait for it.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([true]);
    await page.screenshot({ path: test.info().outputPath("problem.png") });
  } finally {
    writeFileSync(test.info().outputPath("electron.log"), said.join(""));
    await app.close();
  }
});

// The island's half that runs everywhere: the main process reads the state stream itself and keeps the glance it sends
// the native helper (apps/island, macOS only; its own tests are Swift's). A click on a row brings the window to the issue.
test("the island follows the issues in flight and opens one", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vibevalley-desktop-")));
  const app = await electron.launch({
    args: [`--user-data-dir=${join(dir, "electron")}`, join(import.meta.dirname, "..")],
    // The server's pi is the scripted helper (apps/server src/testing/helper.ts): an issue can really be worked.
    env: {
      ...cleanEnv(),
      HOME: dir,
      VIBEVALLEY_HOME: join(dir, "home"),
      VIBEVALLEY_WORK_ROOT: join(dir, "work"),
      VIBEVALLEY_TEST_RUNTIMES: "1",
      VIBEVALLEY_AGENT_STARTERS: starters(),
    },
  });
  type Probe = {
    glance?: { working: number; waiting: number; strip: { working: string; waiting: string }; rows: { issue: string; tone: string; doing: string }[] };
    helper: boolean;
  };
  const probe = () => app.evaluate(() => (globalThis as { vibevalleyIsland?: Probe }).vibevalleyIsland);
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 45_000 });
    const api = new VibeValleyApi(new URL(page.url()).origin);
    await expect.poll(async () => (await probe())?.glance).toEqual({ working: 0, waiting: 0, strip: { working: "没在干", waiting: "0 等你" }, rows: [] });
    // Built on macOS by scripts/build.ts; elsewhere there is no helper.
    expect((await probe())?.helper).toBe(process.platform === "darwin");

    const fox = await api.agent.create(scripted);
    const project = await api.project.create({ name: "clock" });
    // The scripted helper asks with options when its job says 先问清楚: the issue waits on the owner.
    const made = await api.issue.create({ title: "打卡页先问清楚，给选项", project: project.name, assignee: fox.id });
    await api.issue.status.update({ id: made.id, status: "todo" });
    await expect
      .poll(async () => (await probe())?.glance?.rows.map((r) => [r.issue, r.tone, r.doing]), { timeout: 20_000 })
      .toEqual([[made.id, "waiting", "等你回答"]]);
    expect((await probe())?.glance?.waiting).toBe(1);

    await app.evaluate((_, id) => (globalThis as { vibevalleyIsland?: { open: (issue: string) => void } }).vibevalleyIsland?.open(id), made.id);
    await page.waitForURL(new RegExp(`/issues/${made.id}$`));
    await expect(page.getByRole("dialog", { name: "工单" })).toBeVisible();
  } finally {
    await app.close();
  }
});

const scripted = {
  id: "",
  name: "阿狐",
  role: "worker" as const,
  duty: "",
  enabled: true,
  runtime: "pi",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append" as const,
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: true,
  tags: [],
  look: { species: "fox" as const, outfit: "farmer" as const, build: "biped" as const, head: "rounded" as const, body: "", trim: "", hat: "", eye: "" },
};
