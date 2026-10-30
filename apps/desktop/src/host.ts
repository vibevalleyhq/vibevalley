// Main's end of the page's host (@vibevalley/protocol/host's desktopBridge): what the preload asks for, done here.

import { nativeTheme, Notification, shell } from "electron";

import { serve } from "@vibevalley/bridge";
import { currentLocale, setLocale } from "@vibevalley/i18n";
import { desktopBridge, type TraySummary, type UpdateState } from "@vibevalley/protocol/host";

import { mainLink } from "./bridge";
import { setAppMenu } from "./menu";
import { probe } from "./probe";
import type { MainWindow } from "./window";

export interface HostUpdates {
  readonly state: () => UpdateState;
  readonly check: () => Promise<void>;
  readonly install: () => Promise<void>;
}

export function serveHost(o: { readonly window: MainWindow; readonly tray: (summary: TraySummary) => void; readonly updates: HostUpdates }) {
  return serve(
    desktopBridge,
    mainLink(() => o.window.current()?.webContents),
    {
      notify: (notice) => {
        probe?.notices.push(notice);
        if (Notification.isSupported()) new Notification({ title: notice.title, body: notice.body }).show();
      },
      // Only a path on this machine (the contract takes an absolute one), shown in Finder; never opened or run.
      reveal: (path) => shell.showItemInFolder(path),
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
    },
  );
}
