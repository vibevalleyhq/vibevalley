// The desktop app: starts the server (server.ts) and shows the page it serves. The page reaches the machine only
// through the host interface the preload gives it (@vibevalley/host); nothing of Electron or Node reaches it otherwise.

import { BrowserWindow, Menu, Notification, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, shell } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Notice, TraySummary } from "@vibevalley/host";
import { watchForDev } from "./dev";
import { startIsland } from "./island";
import { loginShellPath, type RunningServer, startServer } from "./server";

// In the repository the server is apps/server, the page apps/web/dist and the island apps/island's release build
// (scripts/build.ts); a packaged app has them in its resources (server/, web/, island/).
const files = () => {
  const repo = join(app.getAppPath(), "..");
  const home = process.env.VIBEVALLEY_HOME || join(homedir(), ".vibevalley");
  return {
    server: app.isPackaged ? join(process.resourcesPath, "server") : join(repo, "server"),
    web: app.isPackaged ? join(process.resourcesPath, "web") : join(repo, "web", "dist"),
    island: app.isPackaged ? join(process.resourcesPath, "island", "VibeValleyIsland") : join(repo, "island", ".build", "release", "VibeValleyIsland"),
    log: join(home, "logs", "desktop-server.log"),
  };
};

// What the page asked to show, newest last; the Playwright test reads it (apps/desktop/test).
const notices: Notice[] = [];
(globalThis as { vibevalleyNotices?: Notice[] }).vibevalleyNotices = notices;

/** Where macOS's window buttons sit: centred in the page's 28 px drag strip (preload titleBar). */
const trafficLights = { x: 12, y: 8 };

let server: RunningServer | undefined;
/** The server while it comes up: quitting then waits for it, to stop it rather than leave it running. */
let starting: Promise<RunningServer> | undefined;
let window: BrowserWindow | undefined;

/** The page's ground (apps/web style.css): what the window is painted with between one page and the next. */
const ground = "#2b3320";

/** The one window, made when first asked for. */
function windowNow(): BrowserWindow {
  if (window) return window;
  const made = new BrowserWindow({
    // The farm's proportions, so that it meets the window's edges (apps/web farm/world/framing.ts scales it by whole
    // steps only): three times its 384 × 256, and 3 : 2 however the window is sized.
    width: 1152,
    height: 768,
    useContentSize: true,
    minWidth: 768,
    minHeight: 512,
    title: "VibeValley",
    show: false,
    backgroundColor: ground,
    // The page reaches the top edge; it leaves the strip the host says (preload titleBar) to drag the window by.
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: trafficLights } : {}),
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  made.setAspectRatio(3 / 2);
  // The page stays on the server's origin; any other link opens in the browser.
  made.webContents.setWindowOpenHandler(({ url: to }) => {
    void shell.openExternal(to);
    return { action: "deny" };
  });
  made.webContents.on("will-navigate", (event, to) => {
    const target = new URL(to);
    if (server && target.origin === new URL(server.url).origin) return;
    event.preventDefault();
    if (target.protocol === "http:" || target.protocol === "https:") void shell.openExternal(to);
  });
  made.once("ready-to-show", () => made.show());
  made.on("closed", () => (window = undefined));
  window = made;
  return made;
}

/** A load the next one replaced fails with ERR_ABORTED (-3): that is no failure. Any other is logged. */
const loaded = (load: Promise<void>) =>
  load.catch((e: unknown) => {
    if ((e as { errno?: number }).errno !== -3) console.error("vibevalley: the window could not load its page:", e);
  });

/** The bar while the server comes up (apps/web public/opening.html, from the app's files), or why it did not. */
function opening(problem?: string) {
  void loaded(windowNow().loadFile(join(files().web, "opening.html"), problem ? { query: { problem } } : {}));
}

function open(url: string) {
  void loaded(windowNow().loadURL(url));
}

/** Brings the window up on an issue: what a click on the island's row asks. */
function openIssue(issue: string) {
  if (!server) return;
  open(server.url.replace(/\/$/, "") + "/issues/" + encodeURIComponent(issue));
  const w = windowNow();
  if (w.isMinimized()) w.restore();
  w.show();
  app.focus({ steal: true });
}

ipcMain.handle("host:notify", (_event, notice: Notice) => {
  notices.push(notice);
  if (Notification.isSupported()) new Notification({ title: notice.title, body: notice.body }).show();
});

// The farm at a glance in the menu bar: the page says what (Follow.tsx); a click on a line brings the window up.
let tray: Tray | undefined;
ipcMain.handle("host:tray", (_event, summary: TraySummary) => {
  (globalThis as { vibevalleyTray?: TraySummary }).vibevalleyTray = summary;
  if (!tray) {
    const icon = nativeImage.createFromPath(join(files().web, "pixel", "app-sprout.png")).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip("VibeValley");
  }
  if (process.platform === "darwin") tray.setTitle(summary.title);
  const show = () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  };
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...summary.lines.map((label) => ({ label, click: show })),
      { type: "separator" },
      { label: "打开农场", click: show },
      { label: "退出", role: "quit" },
    ]),
  );
});

/** Starts and ends a call to the orchestrator while another program is in front (the page's voiceShortcut). */
const voiceShortcut = "Alt+Shift+Space";

if (!app.requestSingleInstanceLock()) {
  // The one already open is brought to the front (second-instance there); said, so a script that started this one knows.
  console.error("vibevalley: VibeValley is already open; this one quits and brings that window to the front");
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.setName("VibeValley");
  void app.whenReady().then(async () => {
    // A packaged app has its icon (resources/icon.icns); run from the repository, the Dock shows Electron's unless set.
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(join(files().web, "icons", "app-256.png")));
    // The window comes at once, on the bar: reading the login shell's PATH and starting the server take seconds.
    opening();
    const path = await loginShellPath(process.env);
    const env = path ? { ...process.env, PATH: path } : process.env;
    try {
      starting = startServer(files(), env);
      server = await starting;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      // Said in the window in place of the bar; closing it quits. Closed already, the box says it.
      if (!window) {
        dialog.showErrorBox("VibeValley 起不来", why);
        app.exit(1);
        return;
      }
      opening(why);
      window.once("closed", () => app.exit(1));
      return;
    } finally {
      starting = undefined;
    }
    open(server.url);
    const island = startIsland({
      binary: process.platform === "darwin" ? files().island : undefined,
      font: join(files().web, "fonts", "fusion-pixel-12px-proportional-zh_hans.otf"),
      server: () => server?.url ?? "",
      open: openIssue,
    });
    app.on("will-quit", island.stop);
    if (!app.isPackaged && process.env.VIBEVALLEY_DEV === "1") {
      const stopWatching = watchForDev({
        web: files().web,
        repo: join(app.getAppPath(), "..", ".."),
        reloadPage: () => {
          console.log("vibevalley dev: the page was built again, reloading");
          window?.webContents.reloadIgnoringCache();
        },
        restartServer: async () => {
          const was = server;
          if (!was) return;
          const url = new URL(was.url);
          const at = window ? new URL(window.webContents.getURL()) : undefined;
          console.log("vibevalley dev: the server's code changed, starting it again");
          await was.stop();
          server = await startServer(files(), env, Number(url.port));
          void window?.loadURL(server.url.replace(/\/$/, "") + (at ? at.pathname + at.search : "/"));
        },
      });
      app.on("will-quit", stopWatching);
    }
    // Taken by another program: the call button still works.
    globalShortcut.register(voiceShortcut, () => window?.webContents.send("host:voice-shortcut"));
    app.on("activate", () => {
      if (!window && server) open(server.url);
    });
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  // The server gets its time to save before the app goes.
  let stopped = false;
  app.on("before-quit", (event) => {
    if (stopped || (!server && !starting)) return;
    event.preventDefault();
    const coming = starting;
    void (async () => (server ?? (await coming?.catch(() => undefined)))?.stop())().finally(() => {
      stopped = true;
      app.quit();
    });
  });
}
