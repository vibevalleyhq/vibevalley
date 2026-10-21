// The desktop app: starts the server (server.ts) and shows the page it serves. The page reaches the machine only
// through the host interface the preload gives it (@vibevalley/host); nothing of Electron or Node reaches it otherwise.

import { BrowserWindow, Menu, Notification, Tray, app, dialog, globalShortcut, ipcMain, nativeImage, shell } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Notice, TraySummary } from "@vibevalley/host";
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

let server: RunningServer | undefined;
let window: BrowserWindow | undefined;

function open(url: string) {
  window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: "VibeValley",
    show: false,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
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

/** Starts and ends a call to the manager while another program is in front (the page's voiceShortcut). */
const voiceShortcut = "Alt+Shift+Space";

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.setName("VibeValley");
  void app.whenReady().then(async () => {
    try {
      const path = await loginShellPath(process.env);
      server = await startServer(files(), path ? { ...process.env, PATH: path } : process.env);
    } catch (e) {
      dialog.showErrorBox("VibeValley 起不来", e instanceof Error ? e.message : String(e));
      app.exit(1);
      return;
    }
    open(server.url);
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
