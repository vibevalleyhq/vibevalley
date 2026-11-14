import { join } from "node:path";

import { app } from "electron";

import { savedLocale } from "@vibevalley/home";
import { setLocale } from "@vibevalley/i18n";

import { channelOf, farmHomeOf } from "../base/channel";

export const followSavedLocale = (home: string) => setLocale(savedLocale(home));

interface AppPaths {
  /** The farm's home (VIBEVALLEY_HOME): settings.json, the database, the logs. */
  readonly home: string;
  /** The folder the server runs in: the repository, or the packaged app's server folder. */
  readonly server: string;
  /** What runs the server (server.ts ServerFiles). */
  readonly command: readonly [string, ...string[]];
  /** The built page, served at / on the server's origin; opening.html and the pictures are read from it too. */
  readonly web: string;
  readonly island: string;
  /** Appended to: the server's stdout and stderr. */
  readonly log: string;
  /** The page's pixel font, which the island draws in. */
  readonly font: string;
  readonly dockIcon: string;
  readonly trayIcon: string;
  /** Downloaded updates, one folder a version (update.ts). */
  readonly updates: string;
  /** The login shell's PATH as it said it last (server.ts shellPath). */
  readonly shellPath: string;
  /** Node's compile cache for the server's modules. */
  readonly compileCache: string;
}

/** This app's channel (channel.ts): its version's stage once packaged, dev from the repository. */
export const currentChannel = () => channelOf(app.getVersion(), app.isPackaged);

export const farmHome = () => farmHomeOf(currentChannel(), process.env);

export function appPaths(): AppPaths {
  const repo = join(app.getAppPath(), "..");
  const home = farmHome();
  const web = app.isPackaged ? join(process.resourcesPath, "web") : join(repo, "web", "dist");
  return {
    home,
    server: app.isPackaged ? join(process.resourcesPath, "server") : join(repo, ".."),
    // The Rust server (crates/vibevalley-server); from the repository, cargo's debug build unless VIBEVALLEY_SERVER_BIN names one.
    command: app.isPackaged
      ? [join(process.resourcesPath, "server", "vibevalley-server")]
      : [process.env.VIBEVALLEY_SERVER_BIN ?? join(process.env.CARGO_TARGET_DIR ?? join(repo, "..", "target"), "debug", "vibevalley-server")],
    web,
    island: app.isPackaged ? join(process.resourcesPath, "island", "VibeValleyIsland") : join(repo, "island", ".build", "release", "VibeValleyIsland"),
    log: join(home, "logs", "desktop-server.log"),
    font: join(web, "fonts", "fusion-pixel-12px-proportional-zh_hans.otf"),
    dockIcon: join(web, "icons", "app-256.png"),
    trayIcon: join(web, "pixel", "app-sprout.png"),
    updates: join(app.getPath("userData"), "updates"),
    shellPath: join(app.getPath("userData"), "shell-path"),
    compileCache: join(app.getPath("userData"), "compile-cache"),
  };
}
