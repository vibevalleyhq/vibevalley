import { homedir } from "node:os";

import { type IpcMainEvent, ipcMain, nativeTheme, Notification, shell, type WebContents } from "electron";

import { type Link, serve } from "@vibevalley/bridge";
import { currentLocale, setLocale } from "@vibevalley/i18n";
import { desktopBridge, type TraySummary, type UpdateState } from "@vibevalley/protocol/host";

import { revealable } from "../base/boundary";
import type { commandLine } from "../infra/commandLine";
import { farmHome } from "../infra/paths";
import { probe } from "../infra/probe";
import { startTerminals } from "../infra/terminal";
import { setAppMenu } from "./menu";
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
  readonly pty: {
    readonly binary: string | undefined;
    readonly env: () => NodeJS.ProcessEnv;
    readonly roots: () => readonly string[];
  };
}) {
  const installer = () => {
    if (!o.commandLine) throw new Error("this app has no command line to install: it runs from the repository");
    return o.commandLine;
  };
  let pushData: Parameters<typeof startTerminals>[0]["onData"] | undefined;
  let pushExit: Parameters<typeof startTerminals>[0]["onExit"] | undefined;
  const terminals = startTerminals({
    binary: o.pty.binary,
    env: o.pty.env,
    roots: o.pty.roots,
    onData: (event) => pushData?.(event),
    onExit: (event) => pushExit?.(event),
  });
  const served = serve(
    desktopBridge,
    mainLink(() => o.window.current()?.webContents),
    {
      opening: (update) => o.window.progress(update),
      framing: (mode) => o.window.framing(mode),
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
      ptySpawn: (input) => terminals.spawn(input),
      ptyWrite: (input) => terminals.write(input),
      ptyResize: (input) => terminals.resize(input),
      ptyKill: (id) => terminals.kill(id),
      ptyInspect: (id) => terminals.inspect(id),
    },
  );
  pushData = (event) => served.push("ptyData", event);
  pushExit = (event) => served.push("ptyExit", event);
  return {
    ...served,
    stopTerminals: () => terminals.stop(),
  };
}
