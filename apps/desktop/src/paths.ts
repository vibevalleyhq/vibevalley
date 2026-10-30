// Where the desktop app finds what it runs and keeps. In the repository the server is apps/server, the page
// apps/web/dist and the island apps/island's release build (scripts/build.ts); a packaged app has them in its resources
// (server/, web/, island/).

import { homedir } from "node:os";
import { join } from "node:path";

import { app } from "electron";

export interface AppPaths {
  /** The farm's home (VIBEVALLEY_HOME): settings.json, the database, the logs. */
  readonly home: string;
  /** apps/server: src/main.ts and its node_modules. */
  readonly server: string;
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
}

export const farmHome = () => process.env.VIBEVALLEY_HOME || join(homedir(), ".vibevalley");

export function appPaths(): AppPaths {
  const repo = join(app.getAppPath(), "..");
  const home = farmHome();
  const web = app.isPackaged ? join(process.resourcesPath, "web") : join(repo, "web", "dist");
  return {
    home,
    server: app.isPackaged ? join(process.resourcesPath, "server") : join(repo, "server"),
    web,
    island: app.isPackaged ? join(process.resourcesPath, "island", "VibeValleyIsland") : join(repo, "island", ".build", "release", "VibeValleyIsland"),
    log: join(home, "logs", "desktop-server.log"),
    font: join(web, "fonts", "fusion-pixel-12px-proportional-zh_hans.otf"),
    dockIcon: join(web, "icons", "app-256.png"),
    trayIcon: join(web, "pixel", "app-sprout.png"),
    updates: join(app.getPath("userData"), "updates"),
  };
}
