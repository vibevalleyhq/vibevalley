import { homedir } from "node:os";

import { type IpcMainEvent, ipcMain, nativeTheme, Notification, shell, type WebContents } from "electron";

import { type Link, serve } from "@vibevalley/bridge";
import { currentLocale, setLocale } from "@vibevalley/i18n";
import { desktopBridge, type TraySummary, type UpdateState } from "@vibevalley/protocol/host";

import { revealable } from "./boundary";
import type { commandLine } from "./commandLine";
import { setAppMenu } from "./menu";
import { farmHome } from "./paths";
import { probe } from "./probe";
import type { MainWindow } from "./window";

type CommandLineInstaller = ReturnType<typeof commandLine>;

interface HostUpdates {
  readonly state: () => UpdateState;
  readonly check: () => Promise<void>;
  readonly install: () => Promise<void>;
}

const channel = "vibevalley:bridge";

/** Only the page in page() is heard: what another sender says is not. */
const mainLink = (page: () => WebContents | undefined): Link => ({
  send: (m) => page()?.send(channel, m),
  receive: (fn) => {
    const heard = (event: IpcMainEvent, m: unknown) => {
      if (event.sender === page()) fn(m);
    };
    ipcMain.on(channel, heard);
    return () => void ipcMain.off(channel, heard);
  },
});

export function serveHost(o: {
  readonly window: MainWindow;
  readonly tray: (summary: TraySummary) => void;
  readonly updates: HostUpdates;
  /** Install CLI; absent in the app run from the repository, which has no command line of its own to link. */
  readonly commandLine: CommandLineInstaller | undefined;
}) {
  const installer = () => {
    if (!o.commandLine) throw new Error("this app has no command line to install: it runs from the repository");
    return o.commandLine;
  };
  return serve(
    desktopBridge,
    mainLink(() => o.window.current()?.webContents),
    {
      opening: (update) => o.window.progress(update),
      notify: (notice) => {
        probe?.notices.push(notice);
        if (Notification.isSupported()) new Notification({ title: notice.title, body: notice.body }).show();
      },
      // Only a path under the person's home or the farm's, shown in Finder; never opened or run.
      reveal: (path) => {
        if (!revealable(path, [homedir(), farmHome()])) throw new Error(`not shown: ${path} is outside the home folders`);
        shell.showItemInFolder(path);
      },
      // The window's own parts (menus, scroll bars, the title strip) follow the theme the page chose.
      theme: (theme) => {
        nativeTheme.themeSource = theme;
        o.window.repaint();
      },
      locale: (locale) => {
        if (locale === currentLocale()) return;
        setLocale(locale);
        setAppMenu();
      },
      tray: (summary) => {
        if (probe) probe.tray = summary;
        o.tray(summary);
      },
      updateState: () => o.updates.state(),
      updateCheck: () => o.updates.check(),
      updateInstall: () => o.updates.install(),
      cliState: () => installer().state(),
      cliInstall: () => installer().install(),
      cliRemove: () => installer().remove(),
    },
  );
}
