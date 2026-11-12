import { homedir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { app, dialog, globalShortcut, nativeImage } from "electron";

import { t } from "@vibevalley/i18n";
import { desktopVoiceShortcut } from "@vibevalley/protocol/host";

import { channels, serverEnvOf } from "./base/channel";
import { devPageOf } from "./base/devPage";
import { reasonOf } from "./base/lines";
import { commandLine } from "./infra/commandLine";
import { serveControl } from "./infra/control";
import { startIsland } from "./infra/island";
import { claimMachine, releaseMachine } from "./infra/machine";
import { appPaths, currentChannel, farmHome, followSavedLocale } from "./infra/paths";
import { probe } from "./infra/probe";
import { shellPath, type ServerKeeper, serverKeeper } from "./infra/server";
import { type Updater, updater } from "./infra/update";
import { devMode } from "./ui/dev";
import { serveHost } from "./ui/host";
import { menuBar, setAppMenu } from "./ui/menu";
import { mainWindow } from "./ui/window";

/** The least time the update cover shows its first step. */
const coverAtLeastMs = 800;

// Each channel is its own app: its name, and so its userData and single-instance lock, before anything reads them. A
// --user-data-dir given (the tests) wins.
const channel = channels[currentChannel()];
app.setName(channel.name);
if (!app.commandLine.hasSwitch("user-data-dir")) app.setPath("userData", join(app.getPath("appData"), channel.name));
followSavedLocale(farmHome());

if (!app.requestSingleInstanceLock()) {
  // The one already open is brought to the front (second-instance there); said, so a script that started this one knows.
  console.error(`vibevalley: ${channel.name} is already open; this one quits and brings that window to the front`);
  app.quit();
} else {
  const paths = appPaths();
  // Only `vp run desktop:dev` says one; a packaged app never reads it.
  const dev = !app.isPackaged && process.env.VIBEVALLEY_DEV === "1" ? devPageOf(process.env) : undefined;
  let server: ServerKeeper | undefined;
  let updates: Updater | undefined;
  // The server gets its time to save before the app goes; then is the moment an update is put in place.
  let stopped = false;
  const quitAfterSave = async (then: () => void) => {
    await server?.stop();
    stopped = true;
    then();
    app.quit();
  };
  app.on("before-quit", (event) => {
    if (stopped) return;
    event.preventDefault();
    void quitAfterSave(() => updates?.installOnQuit());
  });

  // The server needs nothing of Electron's: started here, it comes up while Electron gets ready and opens the window.
  const starting = shellPath(paths.shellPath, process.env).then(async ({ path }) => {
    const keeper = serverKeeper(paths, serverEnvOf(currentChannel(), path ? { ...process.env, PATH: path } : process.env));
    server = keeper;
    return keeper.start(dev?.serverPort).then(
      () => ({ keeper }) as const,
      (e: unknown) => ({ failed: e }) as const,
    );
  });

  const window = mainWindow({
    web: paths.web,
    page: () => {
      const url = server?.url();
      return url === undefined ? undefined : (dev?.page ?? url);
    },
  });
  const hostUpdates = {
    state: () => updates?.state() ?? { _tag: "idle" as const, version: app.getVersion() },
    check: async () => updates?.check(),
    // Said over the window step by step (window.ts updating), so the restart is not a window that just vanishes.
    install: async () => {
      const ready = updates?.state();
      if (!updates || ready?._tag !== "ready") return;
      const cover = { next: ready.next, newFarm: ready.newFarm, page: ready.page };
      await window.updating(cover, "stopping");
      // Long enough to read: the server may stop at once.
      await Promise.all([server?.stop(), Effect.runPromise(Effect.sleep(coverAtLeastMs))]);
      stopped = true;
      await window.updating(cover, "swapping");
      let failed: string | undefined;
      try {
        if (!updates.installNow()) failed = t("desktop.updateGone");
      } catch (e) {
        failed = reasonOf(e);
      }
      // The server is stopped either way: the window keeps the cover, with the release page, until the app is quit.
      if (failed !== undefined) return window.updating(cover, { failed });
      app.quit();
    },
  };
  const page = serveHost({
    window,
    tray: menuBar(paths.trayIcon, () => window.show()),
    updates: hostUpdates,
    // Only a packaged app has a launcher of its own (scripts/package.ts).
    commandLine: app.isPackaged
      ? commandLine({
          command: channel.command,
          launcher: join(process.resourcesPath, "bin", channel.command),
          bin: join(homedir(), ".local", "bin"),
          keptPath: paths.shellPath,
        })
      : undefined,
  });
  // The command line's way in (`vibevalley app …`); answered at once, so `app open` and doctor's look at the app work while the server starts.
  const stopControl = serveControl(paths.home, {
    status: () => {
      const url = server?.url();
      return { name: channel.name, version: app.getVersion(), channel: currentChannel(), ...(url === undefined ? {} : { server: url }) };
    },
    open: (path) => {
      window.open(path);
      window.show(true);
    },
    // Answered first, then gone: the command line hears that it was told.
    quit: () => void setImmediate(() => app.quit()),
    restart: () =>
      void setImmediate(() => {
        app.relaunch();
        app.quit();
      }),
    updateState: hostUpdates.state,
    updateCheck: hostUpdates.check,
    updateInstall: hostUpdates.install,
  });
  app.on("will-quit", stopControl);
  // The Mac's one shortcut and island: the channel opened first has them.
  const machine = claimMachine(channel.name);
  app.on("will-quit", () => releaseMachine());
  app.on("second-instance", () => window.show());

  void app.whenReady().then(async () => {
    setAppMenu();
    // A packaged app has its icon (resources/icon.icns); run from the repository, the Dock shows Electron's unless set.
    if (process.platform === "darwin" && !app.isPackaged) app.dock?.setIcon(nativeImage.createFromPath(paths.dockIcon));
    // The window comes at once, on the bar, while the server finishes starting.
    window.opening();
    const started = await starting;
    if ("failed" in started) {
      // Said in the window in place of the bar. closing it quits.
      const open = window.current();
      if (!open) {
        dialog.showErrorBox(t("desktop.cannotStart"), reasonOf(started.failed));
        app.exit(1);
        return;
      }
      window.opening(reasonOf(started.failed));
      open.once("closed", () => app.exit(1));
      return;
    }
    const { keeper } = started;
    window.open();
    const island = startIsland({
      binary: process.platform === "darwin" && machine.mine ? paths.island : undefined,
      font: paths.font,
      server: () => keeper.url() ?? "",
      open: (issue) => {
        window.open("/issues/" + encodeURIComponent(issue));
        window.show(true);
      },
    });
    if (probe) probe.island = island.probe;
    app.on("will-quit", island.stop);
    if (!app.isPackaged && process.env.VIBEVALLEY_DEV === "1")
      app.on("will-quit", devMode({ repo: join(app.getAppPath(), "..", ".."), server: keeper, window }));
    // Only a packaged app of a released stage updates itself.
    const stage = currentChannel();
    if (app.isPackaged && stage !== "dev") {
      updates = updater({
        version: app.getVersion(),
        arch: process.arch,
        exe: app.getPath("exe"),
        home: paths.home,
        dir: paths.updates,
        feed: process.env.VIBEVALLEY_UPDATE_FEED || undefined,
        stage,
        heard: (state) => page.push("update", state),
      });
      updates.start();
      app.on("will-quit", updates.stop);
    }
    // Taken by another program or held by the channel opened first: the call button still works.
    if (machine.mine) globalShortcut.register(desktopVoiceShortcut, () => page.push("voiceShortcut", undefined));
    app.on("activate", () => {
      if (keeper.url() !== undefined) window.show();
    });
  });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
