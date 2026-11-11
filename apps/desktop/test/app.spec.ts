import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { connect as dial } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { _electron as electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";

import { connect } from "@vibevalley/bridge";
import { socketLink } from "@vibevalley/bridge/socket";
import { controlSocketOf } from "@vibevalley/home";
import { VibeValleyApi, pathOf } from "@vibevalley/protocol";
import { desktopControl } from "@vibevalley/protocol/host";

import type { DesktopProbe } from "../src/infra/probe";

// The server and the agents it runs read keys from the environment.
const secret = /KEY|TOKEN|SECRET|CERTIFICATE|PASSWORD|^AGORA_|^VIBEVALLEY_|^GIT_CONFIG_/u;
/** Every built-in template but the default orchestrator's (apps/server/src/modules/agent/templates/index.json). */
const starters = () =>
  (JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "server", "src", "modules", "agent", "templates", "index.json"), "utf8")) as string[])
    .filter((id) => id !== "orchestrator")
    .join(",");
const cleanEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !secret.test(k))),
  VIBEVALLEY_VOICE_LINE_PORT: "0",
  VIBEVALLEY_LAN_PORT: "0",
});

const mainPage = (app: ElectronApplication) => {
  const serverPage = (page: Page) => /^http:\/\/127\.0\.0\.1:\d+\//u.test(page.url());
  const page = app.windows().find(serverPage);
  return page ? Promise.resolve(page) : app.waitForEvent("window", { predicate: serverPage, timeout: 45_000 });
};

test("the desktop app shows the live board and sends a notice", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vibevalley-desktop-")));
  const userData = join(dir, "electron");
  const app = await electron.launch({
    // Electron applies this before main.ts requests its single-instance lock; the user's running app has another profile.
    args: [`--user-data-dir=${userData}`, join(import.meta.dirname, "..")],
    env: { ...cleanEnv(), HOME: dir, VIBEVALLEY_HOME: join(dir, "home"), VIBEVALLEY_WORK_ROOT: join(dir, "work"), VIBEVALLEY_DESKTOP_PROBE: "1" },
  });
  let server = "";
  try {
    expect(await app.evaluate(({ app }) => app.getPath("userData"))).toBe(userData);
    const page = await mainPage(app);
    // The window opens on the workbench once the server is up; the board is a place of its own.
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/chat$/u, { timeout: 45_000 });
    server = new URL(page.url()).origin;
    await page.goto(server + "/issues");
    await expect(page.getByTestId("link")).toHaveAttribute("data-state", "open");

    const api = new VibeValleyApi(server);
    const seen = await api.issue.create({ title: "the desktop app sees me" });
    await expect(page.locator(`[data-testid="issue-card"][data-key="${seen.id}"]`)).toBeVisible();

    const host = await page.evaluate(async () => {
      const h = window.vibevalleyHost;
      await h?.notify?.({ title: "小吴 做完了", body: "打卡写好了" });
      return h?.name;
    });
    expect(host).toBe("desktop");
    const notices = await app.evaluate(() => globalThis.vibevalleyProbe?.notices ?? []);
    expect(notices).toEqual([{ title: "小吴 做完了", body: "打卡写好了" }]);
    // The page keeps the menu bar's tray to the farm, and has the key that calls the manager from anywhere.
    await expect.poll(() => app.evaluate(() => globalThis.vibevalleyProbe?.tray?.lines ?? [])).toContain("还没开工");
    expect(await page.evaluate(() => window.vibevalleyHost?.voiceShortcut?.accelerator)).toBe("Alt+Shift+Space");
    // The window's own parts follow the theme the page chose (Settings > Appearance).
    await page.evaluate(() => window.vibevalleyHost?.theme?.("dark"));
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
    await page.evaluate(() => window.vibevalleyHost?.theme?.("system"));
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("system");
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
    const titleBar = await page.evaluate(() => window.vibevalleyHost?.titleBar);
    if (titleBar) expect((await page.getByTestId("rail").boundingBox())?.width).toBeGreaterThan(titleBar.left);
    // Between two whole scales the farm would have bars around it: when a resize ends, the window takes the nearest size
    // it fills.
    const resized = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]!;
      w.setContentSize(1220, 813);
      w.emit("resized");
      return w.getContentSize();
    });
    expect(resized).toEqual([1152, 768]);

    // Run from the repository it never checks: the update stays idle.
    await page.goto(server + "/settings/about");
    await expect(page.getByTestId("update-state")).toHaveAttribute("data-state", "idle");
    await expect(page.getByTestId("update-check")).toBeVisible();
    // The command line reaches the app over its socket in the farm's home (`vibevalley app …`, apps/server src/cli/app.ts).
    const socket = dial(controlSocketOf(join(dir, "home")));
    await new Promise<void>((resolve, reject) => socket.once("connect", () => resolve()).once("error", reject));
    const control = connect(desktopControl, socketLink(socket));
    expect(await control.call.status()).toMatchObject({ name: "VibeValley Dev", channel: "dev", server });
    await control.call.open("/settings/general");
    await page.waitForURL(server + "/settings/general");
    socket.destroy();

    await page.screenshot({ path: test.info().outputPath("desktop.png") });
    await page.goto(server + "/farm/");
    await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true");
    await expect(page.getByTestId("rail")).toBeVisible();
    await expect(page.getByTestId("desk")).toHaveCount(0);
    const farm = await page.getByTestId("farm").boundingBox();
    const rail = await page.getByTestId("rail").boundingBox();
    if (!farm || !rail) throw new Error("Farm and navigation must have visible bounds inside Electron");
    expect(farm.x).toBeGreaterThanOrEqual(rail.x + rail.width);
    await page.screenshot({ path: test.info().outputPath("desktop-farm.png") });
  } finally {
    await app.close();
  }
  // Quitting stopped the server it started.
  await expect(fetch(server + pathOf("server.health.get"), { method: "POST" })).rejects.toThrow();
});

test("regression: desktop media permissions allow virtual devices and release a refused visual session without offering screen capture", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vibevalley-desktop-media-")));
  const app = await electron.launch({
    args: [`--user-data-dir=${join(dir, "electron")}`, "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", join(import.meta.dirname, "..")],
    env: { ...cleanEnv(), HOME: dir, VIBEVALLEY_HOME: join(dir, "home"), VIBEVALLEY_WORK_ROOT: join(dir, "work") },
  });
  let server = "";
  try {
    const page = await mainPage(app);
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\/chat$/u, { timeout: 45_000 });
    server = new URL(page.url()).origin;
    expect(await page.evaluate(() => window.vibevalleyHost?.name)).toBe("desktop");
    await page.addInitScript(() => {
      const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await acquire(constraints);
        document.documentElement.dataset.captureOpened = String(Number(document.documentElement.dataset.captureOpened ?? 0) + 1);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            if (track.readyState === "ended") return;
            stop();
            document.documentElement.dataset.captureState = track.readyState;
            document.documentElement.dataset.captureStopped = String(Number(document.documentElement.dataset.captureStopped ?? 0) + 1);
          };
        }
        return stream;
      };
    });
    await page.goto(server + "/settings/moss");
    await expect(page.getByTestId("vision-start")).toBeEnabled();
    await page.getByTestId("vision-line").getByTestId("visual-source").click();
    await expect(page.locator('[role="option"][data-key="screen"]')).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByTestId("vision-start").click();
    await expect(page.locator("html")).toHaveAttribute("data-capture-opened", "1");
    await expect(page.getByTestId("vision-line")).toHaveAttribute("data-state", "error");
    await expect(page.locator("html")).toHaveAttribute("data-capture-stopped", "1");
    await expect(page.locator("html")).toHaveAttribute("data-capture-state", "ended");
    const microphone = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const tracks = stream.getTracks();
      const before = tracks.map((track) => ({ kind: track.kind, state: track.readyState }));
      for (const track of tracks) track.stop();
      return { before, after: tracks.map((track) => ({ kind: track.kind, state: track.readyState })) };
    });
    expect(microphone).toEqual({ before: [{ kind: "audio", state: "live" }], after: [{ kind: "audio", state: "ended" }] });
    await expect(page.locator("html")).toHaveAttribute("data-capture-stopped", "2");
    await page.screenshot({ path: test.info().outputPath("desktop-moss-media.png") });
  } finally {
    await app.close();
  }
  await expect(fetch(server + pathOf("server.health.get"), { method: "POST" })).rejects.toThrow();
});

test("regression: one native opening survives the server handoff and each document releases it only when ready", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vibevalley-desktop-")));
  const app = await electron.launch({
    args: [`--user-data-dir=${join(dir, "electron")}`, join(import.meta.dirname, "..")],
    env: { ...cleanEnv(), HOME: dir, VIBEVALLEY_HOME: join(dir, "home"), VIBEVALLEY_WORK_ROOT: join(dir, "work") },
  });
  try {
    const trace = await app.evaluateHandle(async ({ app, BrowserWindow, WebContentsView }) => {
      await app.whenReady();
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error("The app window is missing");
      const initial = window.contentView.children.find((child) => child instanceof WebContentsView);
      if (!(initial instanceof WebContentsView)) throw new Error("The initial native cover is missing");
      let entry: (() => void) | undefined;
      let map: (() => void) | undefined;
      const state: { entryHeld: boolean; mapHeld: boolean; loads: number[]; destroyed: number[]; samples: string[] } = {
        entryHeld: false,
        mapHeld: false,
        loads: [],
        destroyed: [],
        samples: [],
      };
      let entered = false;
      window.webContents.session.webRequest.onBeforeRequest({ urls: ["http://127.0.0.1/*"] }, (details, callback) => {
        if (details.resourceType === "mainFrame" && !entered) {
          state.entryHeld = true;
          entry = () => callback({ redirectURL: new URL("/farm/", details.url).href });
        } else if (new URL(details.url).pathname === "/village.ldtk") {
          state.mapHeld = true;
          map = () => callback({});
        } else callback({});
      });
      const watch = (contents: typeof initial.webContents) => {
        const id = contents.id;
        contents.on("console-message", (event) => {
          if (event.message.startsWith("opening-trace|")) state.samples.push(event.message);
        });
        contents.once("destroyed", () => state.destroyed.push(id));
        const loaded = () => {
          if (!contents.getURL().includes("/opening.html")) return;
          state.loads.push(contents.id);
          void contents.executeJavaScript(`{
            const cover = document.getElementById("opening");
            const sample = () => console.debug("opening-trace|${contents.id}|" + cover.dataset.phase + "|" + (cover.dataset.progress ?? 0));
            cover.addEventListener("opening-update", sample);
            sample();
          }`);
        };
        contents.on("did-finish-load", loaded);
        if (!contents.isLoadingMainFrame()) loaded();
      };
      watch(initial.webContents);
      app.on("web-contents-created", (_event, contents) => watch(contents));
      return {
        state,
        initial: initial.webContents.id,
        releaseEntry: () => {
          entered = true;
          if (!entry) throw new Error("The initial document request has not arrived");
          entry();
        },
        releaseMap: () => {
          if (!map) throw new Error("The map request has not arrived");
          map();
        },
        refresh: async () => {
          await window.webContents.session.clearCache();
          map = undefined;
          state.mapHeld = false;
        },
      };
    });
    const native = () =>
      app.evaluate(({ BrowserWindow, WebContentsView }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return (
          window?.contentView.children
            .filter((child) => child instanceof WebContentsView)
            .map((view) => ({
              id: view.webContents.id,
              bounds: view.getBounds(),
            })) ?? []
        );
      });
    await expect.poll(() => trace.evaluate((trace) => trace.state.entryHeld), { timeout: 45_000 }).toBe(true);
    const initial = await trace.evaluate((trace) => trace.initial);
    expect((await native()).map((view) => view.id)).toEqual([initial]);
    await expect.poll(() => trace.evaluate((trace) => trace.state.loads)).toEqual([initial]);
    await trace.evaluate((trace) => trace.releaseEntry());
    const page = await mainPage(app);
    await page.waitForURL(/\/farm\/$/u);
    await expect.poll(() => trace.evaluate((trace) => trace.state.mapHeld)).toBe(true);
    await expect(page.locator('[data-opening="pending"]')).toBeAttached();
    expect((await native()).map((view) => view.id)).toEqual([initial]);
    await expect(page.locator("#opening")).toBeHidden();
    await page.evaluate(async () => {
      await window.vibevalleyHost?.opening?.({ phase: "loading", progress: 80 });
      await window.vibevalleyHost?.opening?.({ phase: "reading", progress: 20 });
    });
    const held = await trace.evaluate((trace) => trace.state.samples);
    const progress = held.map((sample) => Number(sample.split("|")[3]));
    expect(progress.at(-1)).toBeGreaterThanOrEqual(80);
    expect(progress).toEqual(progress.toSorted((a, b) => a - b));
    expect(progress.every((value) => value < 100)).toBe(true);
    expect(await trace.evaluate((trace) => trace.state.destroyed)).not.toContain(initial);
    await trace.evaluate((trace) => trace.releaseMap());
    await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true");
    await expect.poll(native).toEqual([]);
    await expect.poll(() => trace.evaluate((trace) => trace.state.destroyed)).toContain(initial);
    expect(await trace.evaluate((trace) => trace.state.samples)).toContain(`opening-trace|${initial}|ready|100`);

    await page.evaluate(() => history.pushState(null, "", "#opening-regression"));
    expect(await native()).toEqual([]);
    expect(await trace.evaluate((trace) => trace.state.loads)).toEqual([initial]);
    await trace.evaluate((trace) => trace.refresh());
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect.poll(() => trace.evaluate((trace) => trace.state.mapHeld)).toBe(true);
    const refreshed = await native();
    expect(refreshed).toHaveLength(1);
    const next = refreshed[0]?.id;
    if (next === undefined) throw new Error("The refreshed native cover is missing");
    expect(next).not.toBe(initial);
    await expect.poll(() => trace.evaluate((trace) => trace.state.loads)).toEqual([initial, next]);
    expect(await trace.evaluate((trace) => trace.state.destroyed)).not.toContain(next);
    await trace.evaluate((trace) => trace.releaseMap());
    await expect(page.getByTestId("village")).toHaveAttribute("data-ready", "true");
    await expect.poll(native).toEqual([]);
    await expect.poll(() => trace.evaluate((trace) => trace.state.destroyed)).toEqual([initial, next]);
    await expect(page.getByTestId("rail")).toBeVisible();
    const observed = await trace.evaluate((trace) => trace.state);
    for (const id of [initial, next]) {
      const progress = observed.samples.filter((sample) => sample.startsWith(`opening-trace|${id}|`)).map((sample) => Number(sample.split("|")[3]));
      expect(progress).toEqual(progress.toSorted((a, b) => a - b));
      expect(progress.at(-1)).toBe(100);
    }
    writeFileSync(test.info().outputPath("native-opening.json"), JSON.stringify(observed, null, 2));
  } finally {
    await app.close();
  }
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
    await app.firstWindow();
    const opening = () =>
      app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const view = window?.contentView.children.find((child) => child instanceof WebContentsView);
        if (!(view instanceof WebContentsView)) return null;
        return {
          id: view.webContents.id,
          url: view.webContents.getURL(),
          main: window?.webContents.getURL(),
          visible: window?.isVisible(),
          ...(await view.webContents.executeJavaScript(`({
          problem: document.querySelector("#opening")?.dataset.problem,
          alert: !!document.querySelector('[role="alert"]'),
          bars: document.querySelectorAll('[role="progressbar"]').length,
          scene: document.querySelector("#opening .scene")?.naturalWidth
        })`)),
        };
      });
    await expect.poll(opening).toMatchObject({ alert: true, bars: 0, scene: 1672, visible: true });
    const failed = await opening();
    expect(failed?.problem).toBeTruthy();
    expect(failed?.url).toMatch(/\/opening\.html\?locale=/u);
    expect(failed?.main).not.toContain("opening.html");
    const image = await app.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find((child) => child instanceof WebContentsView);
      if (!(view instanceof WebContentsView)) throw new Error("The native failure cover is missing");
      return (await view.webContents.capturePage()).toPNG().toString("base64");
    });
    writeFileSync(test.info().outputPath("opening-failure.png"), Buffer.from(image, "base64"));
  } finally {
    writeFileSync(test.info().outputPath("electron.log"), said.join(""));
    await app.close();
  }
});

// The island's half that runs everywhere: the main process reads the state stream itself and keeps the glance it sends the native helper (apps/island, macOS only.
test("the island follows the issues in flight and opens one", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vibevalley-desktop-")));
  const app = await electron.launch({
    args: [`--user-data-dir=${join(dir, "electron")}`, join(import.meta.dirname, "..")],
    // The server's pi is the scripted helper (apps/server src/testing/worker.ts): an issue can really be worked.
    env: {
      ...cleanEnv(),
      HOME: dir,
      VIBEVALLEY_HOME: join(dir, "home"),
      VIBEVALLEY_WORK_ROOT: join(dir, "work"),
      VIBEVALLEY_TEST_RUNTIMES: "1",
      VIBEVALLEY_AGENT_STARTERS: starters(),
      VIBEVALLEY_DESKTOP_PROBE: "1",
    },
  });
  const probe = (): Promise<DesktopProbe["island"]> => app.evaluate(() => globalThis.vibevalleyProbe?.island);
  try {
    const page = await mainPage(app);
    await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//u, { timeout: 45_000 });
    const api = new VibeValleyApi(new URL(page.url()).origin);
    await expect.poll(async () => (await probe())?.glance).toEqual({ working: 0, waiting: 0, strip: { working: "没在干", waiting: "0 等你" }, rows: [] });
    // Built on macOS by scripts/build.ts; elsewhere there is no helper.
    expect((await probe())?.helper).toBe(process.platform === "darwin");

    const fox = await api.agent.create(scripted);
    const repo = await api.repo.create({ name: "clock" });
    // The scripted helper asks with options when its job says ask-first: the issue waits on the user.
    const made = await api.issue.create({ title: "打卡页先问清楚，给选项", repo: repo.name, agent: fox.id });
    await api.issue.status.update({ id: made.id, status: "todo" });
    await expect
      .poll(async () => (await probe())?.glance?.rows.map((r) => [r.issue, r.tone, r.doing]), { timeout: 20_000 })
      .toEqual([[made.id, "waiting", "等你回答"]]);
    expect((await probe())?.glance?.waiting).toBe(1);

    await app.evaluate((_, id) => globalThis.vibevalleyProbe?.island?.open(id), made.id);
    await page.waitForURL(new RegExp(`/issues/${made.id}$`, "u"));
    await expect(page.getByTestId("issue")).toBeVisible();
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
  look: {
    orchestrator: null,
    species: "fox" as const,
    outfit: "farmer" as const,
    build: "biped" as const,
    head: "rounded" as const,
    body: "",
    trim: "",
    hat: "",
    eye: "",
  },
};
