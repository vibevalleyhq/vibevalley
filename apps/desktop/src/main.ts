// The desktop app: starts the server (server.ts) and shows the page it serves. The page reaches the machine only
// through the host interface the preload gives it (@vibevalley/protocol/host); nothing of Electron or Node reaches it otherwise.

import { join } from "node:path";

import { app, dialog, globalShortcut, nativeImage } from "electron";

import { t } from "@vibevalley/i18n";
import { desktopVoiceShortcut } from "@vibevalley/protocol/host";

import { devMode } from "./dev";
import { serveHost } from "./host";
import { startIsland } from "./island";
import { reasonOf } from "./lines";
import { followSavedLocale } from "./locale";
import { setAppMenu } from "./menu";
import { appPaths, farmHome } from "./paths";
import { probe } from "./probe";
import { loginShellPath, serverKeeper } from "./server";
import { menuBar } from "./tray";
import { mainWindow } from "./window";

followSavedLocale(farmHome());

if (!app.requestSingleInstanceLock()) {
  // The one already open is brought to the front (second-instance there); said, so a script that started this one knows.
  console.error("vibevalley: VibeValley is already open; this one quits and brings that window to the front");
  app.quit();
} else {
  app.setName("VibeValley");
  const paths = appPaths();
  let url: () => string | undefined = () => undefined;
  const window = mainWindow({ web: paths.web, server: () => url() });
  const page = serveHost({ window, tray: menuBar(paths.trayIcon, () => window.show()) });
  app.on("second-instance", () => window.show());

  void app.whenReady().then(async () => {
    setAppMenu();
    // A packaged app has its icon (resources/icon.icns); run from the repository, the Dock shows Electron's unless set.
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(paths.dockIcon));
    // The window comes at once, on the bar: reading the login shell's PATH and starting the server take seconds.
    window.opening();
    const path = await loginShellPath(process.env);
    const server = serverKeeper(paths, path ? { ...process.env, PATH: path } : process.env);
    url = server.url;
    // The server gets its time to save before the app goes.
    let stopped = false;
    app.on("before-quit", (event) => {
      if (stopped) return;
      event.preventDefault();
      void server.stop().finally(() => {
        stopped = true;
        app.quit();
      });
    });
    try {
      await server.start();
    } catch (e) {
      // Said in the window in place of the bar; closing it quits. Closed already, the box says it.
      const open = window.current();
      if (!open) {
        dialog.showErrorBox(t("desktop.cannotStart"), reasonOf(e));
        app.exit(1);
        return;
      }
      window.opening(reasonOf(e));
      open.once("closed", () => app.exit(1));
      return;
    }
    window.open();
    const island = startIsland({
      binary: process.platform === "darwin" ? paths.island : undefined,
      font: paths.font,
      server: () => server.url() ?? "",
      open: (issue) => {
        window.open("/issues/" + encodeURIComponent(issue));
        window.show(true);
      },
    });
    if (probe) probe.island = island.probe;
    app.on("will-quit", island.stop);
    if (!app.isPackaged && process.env.VIBEVALLEY_DEV === "1")
      app.on("will-quit", devMode({ web: paths.web, repo: join(app.getAppPath(), "..", ".."), server, window }));
    // Taken by another program: the call button still works.
    globalShortcut.register(desktopVoiceShortcut, () => page.push("voiceShortcut", undefined));
    app.on("activate", () => {
      if (server.url() !== undefined) window.show();
    });
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
