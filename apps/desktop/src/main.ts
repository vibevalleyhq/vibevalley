// The desktop app: starts the server (server.ts) and shows the page it serves. The page reaches the machine only
// through the host interface the preload gives it (@vibevalley/host); nothing of Electron or Node reaches it otherwise.

import { BrowserWindow, Menu, Notification, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, shell } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Notice, TraySummary } from "@vibevalley/host";
import { watchForDev } from "./dev";
import { loginShellPath, type RunningServer, startServer } from "./server";

// In the repository the server is apps/server and the page apps/web/dist; a packaged app has both in its resources
// (server/, web/).
const files = () => {
  const repo = join(app.getAppPath(), "..");
  const home = process.env.VIBEVALLEY_HOME || join(homedir(), ".vibevalley");
  return {
    server: app.isPackaged ? join(process.resourcesPath, "server") : join(repo, "server"),
    web: app.isPackaged ? join(process.resourcesPath, "web") : join(repo, "web", "dist"),
    log: join(home, "logs", "desktop-server.log"),
  };
};

// What the page asked to show, newest last; the Playwright test reads it (apps/desktop/test).
const notices: Notice[] = [];
(globalThis as { vibevalleyNotices?: Notice[] }).vibevalleyNotices = notices;

/** Where macOS's window buttons sit: centred in the page's 28 px drag strip (preload titleBar). */
const trafficLights = { x: 12, y: 8 };

let server: RunningServer | undefined;
let window: BrowserWindow | undefined;

function open(url: string) {
  window = new BrowserWindow({
    // The farm's proportions, so that it meets the window's edges (apps/web farm/world/framing.ts scales it by whole
    // steps only): three times its 384 × 256, and 3 : 2 however the window is sized.
    width: 1152,
    height: 768,
    useContentSize: true,
    minWidth: 768,
    minHeight: 512,
    title: "VibeValley",
    show: false,
    // The page reaches the top edge; it leaves the strip the host says (preload titleBar) to drag the window by.
    ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: trafficLights } : {}),
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  window.setAspectRatio(3 / 2);
  const origin = new URL(url).origin;
  // The page stays on the server's origin; any other link opens in the browser.
  window.webContents.setWindowOpenHandler(({ url: to }) => {
    void shell.openExternal(to);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, to) => {
    if (new URL(to).origin !== origin) {
      event.preventDefault();
      void shell.openExternal(to);
    }
  });
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => (window = undefined));
  void window.loadURL(url);
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

/** Starts and ends a call to the assistant while another program is in front (the page's voiceShortcut). */
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
    const path = await loginShellPath(process.env);
    const env = path ? { ...process.env, PATH: path } : process.env;
    try {
      server = await startServer(files(), env);
    } catch (e) {
      dialog.showErrorBox("VibeValley 起不来", e instanceof Error ? e.message : String(e));
      app.exit(1);
      return;
    }
    open(server.url);
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
    if (stopped || !server) return;
    event.preventDefault();
    void server.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  });
}
