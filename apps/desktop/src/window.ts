import { join } from "node:path";

import { app, BrowserWindow, nativeTheme, screen, shell, systemPreferences } from "electron";

import { filledNear } from "@vibevalley/engine/framing";
import { currentLocale } from "@vibevalley/i18n";
import { farmFraming } from "@vibevalley/protocol/host";

import { ground, navigationOf, pagePermission, pageWebPreferences, trafficLights } from "./boundary";

/** The smallest window: twice the farm. */
const minSize = { w: farmFraming.picture.w * 2, h: farmFraming.picture.h * 2 };

/** A load the next one replaced fails with ERR_ABORTED (-3): that is no failure. Any other is logged. */
const loaded = (load: Promise<void>) =>
  load.catch((e: unknown) => {
    if (!(typeof e === "object" && e !== null && "errno" in e && e.errno === -3)) console.error("vibevalley: the window could not load its page:", e);
  });

export function mainWindow(o: {
  /** apps/web/dist, where opening.html is. */
  readonly web: string;
  /** The server's address once it is up: a window made again opens on it, and the page stays on its origin. */
  readonly server: () => string | undefined;
}) {
  let window: BrowserWindow | undefined;
  /** The bar's load. */
  let bar: Promise<void> = Promise.resolve();

  const make = (): BrowserWindow => {
    const made = new BrowserWindow({
      // The farm's proportions, so that it meets the window's edges (farmFraming.
      width: farmFraming.picture.w * 3,
      height: farmFraming.picture.h * 3,
      useContentSize: true,
      minWidth: minSize.w,
      minHeight: minSize.h,
      title: "VibeValley",
      show: false,
      backgroundColor: ground(nativeTheme.shouldUseDarkColors),
      // The page reaches the top edge; it leaves the strip the host says (chrome.ts titleBar) to drag the window by.
      ...(process.platform === "darwin" ? { titleBarStyle: "hidden" as const, trafficLightPosition: trafficLights } : {}),
      webPreferences: pageWebPreferences(join(__dirname, "preload.cjs")),
    });
    made.webContents.session.setPermissionCheckHandler((contents, permission, origin, details) => {
      if (
        contents !== made.webContents ||
        made.isDestroyed() ||
        !pagePermission(permission, origin, o.server(), details.isMainFrame, [details.mediaType ?? "unknown"])
      )
        return false;
      if (permission !== "media" || process.platform !== "darwin") return true;
      return systemPreferences.getMediaAccessStatus(details.mediaType === "video" ? "camera" : "microphone") === "granted";
    });
    made.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
      const origin = "securityOrigin" in details ? (details.securityOrigin ?? details.requestingUrl) : details.requestingUrl;
      const allowed = () =>
        contents === made.webContents &&
        !made.isDestroyed() &&
        !contents.isDestroyed() &&
        navigationOf(contents.getURL(), o.server()) === "stay" &&
        pagePermission(permission, origin, o.server(), details.isMainFrame, mediaTypes);
      if (!allowed()) return callback(false);
      if (permission !== "media" || process.platform !== "darwin") return callback(true);
      // Check is not consent: only the explicit device request may open an OS prompt.
      const ask = async () => {
        for (const type of mediaTypes)
          if (!allowed() || !(await systemPreferences.askForMediaAccess(type === "video" ? "camera" : "microphone"))) return callback(false);
        callback(allowed());
      };
      void ask().catch(() => callback(false));
    });
    made.setAspectRatio(3 / 2);
    // A size between two whole scales leaves bars around the farm: once a resize ends, the window takes the nearest size the farm fills.
    made.on("resized", () => {
      if (made.isFullScreen() || made.isMaximized()) return;
      const [w = 0, h = 0] = made.getContentSize();
      const area = screen.getDisplayMatching(made.getBounds()).workAreaSize;
      const to = filledNear({ w, h }, farmFraming.picture, farmFraming.cut, minSize, { w: area.width, h: area.height });
      if (to.w !== w || to.h !== h) made.setContentSize(to.w, to.h, true);
    });
    // The page stays on the server's origin; any other link opens in the browser.
    made.webContents.setWindowOpenHandler(({ url: to }) => {
      if (navigationOf(to, undefined) === "browser") void shell.openExternal(to);
      return { action: "deny" };
    });
    made.webContents.on("will-navigate", (event, to) => {
      const where = navigationOf(to, o.server());
      if (where === "stay") return;
      event.preventDefault();
      if (where === "browser") void shell.openExternal(to);
    });
    made.once("ready-to-show", () => made.show());
    made.on("closed", () => (window = undefined));
    window = made;
    return made;
  };
  const now = () => window ?? make();

  return {
    /** The window if it is open; nothing is made. */
    current: () => window,
    /** The bar while the server comes up, or why it did not. */
    opening: (problem?: string) => {
      const load = () => loaded(now().loadFile(join(o.web, "opening.html"), { query: { locale: currentLocale(), ...(problem ? { problem } : {}) } }));
      bar = problem ? bar.then(load) : load();
    },
    /** A place on the server's page: "" is its start. */
    open: (path = "") => {
      const server = o.server();
      if (server !== undefined) void loaded(now().loadURL(server + path));
    },
    /** In front, made again if it was closed. steal: from whatever program is in front (a click on the island). */
    show: (steal = false) => {
      const fresh = window === undefined;
      const w = now();
      const server = o.server();
      if (fresh && server !== undefined) void loaded(w.loadURL(server));
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      if (steal) app.focus({ steal: true });
    },
    /** The ground follows the theme the page chose (host.ts). */
    repaint: () => window?.setBackgroundColor(ground(nativeTheme.shouldUseDarkColors)),
  };
}

export type MainWindow = ReturnType<typeof mainWindow>;
