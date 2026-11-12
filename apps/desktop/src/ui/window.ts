import { join } from "node:path";

import { app, BrowserWindow, nativeTheme, screen, shell, systemPreferences, WebContentsView } from "electron";

import { filledNear } from "@vibevalley/engine/framing";
import { currentLocale } from "@vibevalley/i18n";
import { farmFraming, type Opening } from "@vibevalley/protocol/host";

import { ground, navigationOf, pagePermission, pageWebPreferences, trafficLights } from "../base/boundary";

/** The smallest window: twice the farm. */
const minSize = { w: farmFraming.picture.w * 2, h: farmFraming.picture.h * 2 };

/** A load the next one replaced fails with ERR_ABORTED (-3): that is no failure. Any other is logged. */
const loaded = (load: Promise<void>) =>
  load.catch((e: unknown) => {
    if (!(typeof e === "object" && e !== null && "errno" in e && e.errno === -3)) console.error("vibevalley: the window could not load its page:", e);
  });

interface OpeningView {
  readonly owner: BrowserWindow;
  readonly view: WebContentsView;
  readonly ready: Promise<void>;
  progress: number;
  ending?: Promise<void>;
}

/** Where a restart into a new version is (main.ts): the cover says it over the window. */
export type UpdateStep = "stopping" | "swapping" | { readonly failed: string };

/** What the cover says of the version it restarts into. */
export interface UpdateCover {
  readonly next: string;
  readonly newFarm: boolean;
  /** The release's page: the way to install it by hand when the restart fails. */
  readonly page: string;
}

export function mainWindow(o: {
  /** apps/web/dist, where opening.html is. */
  readonly web: string;
  /** The page's address once the server is up (the server's own, or in development Vite's, base/devPage.ts): a window made
   * again opens on it, and the page stays on its origin. */
  readonly page: () => string | undefined;
}) {
  let window: BrowserWindow | undefined;
  let cover: OpeningView | undefined;
  let accepting = false;
  let shown = false;

  const dispose = (old: OpeningView) => {
    if (cover === old) cover = undefined;
    if (!old.owner.isDestroyed()) {
      old.owner.contentView.removeChildView(old.view);
      if (old.owner.isFocused()) old.owner.webContents.focus();
    }
    if (!old.view.webContents.isDestroyed()) old.view.webContents.close({ waitForBeforeUnload: false });
  };
  const fit = (current: OpeningView) => {
    const { width, height } = current.owner.getContentBounds();
    current.view.setBounds({ x: 0, y: 0, width, height });
  };
  const opening = (owner: BrowserWindow): OpeningView => {
    if (cover?.owner === owner) return cover;
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    view.setBackgroundColor("#00000000");
    // The cover's one link (the release page, when an update fails) opens in the browser.
    view.webContents.setWindowOpenHandler(({ url: to }) => {
      if (navigationOf(to, undefined) === "browser") void shell.openExternal(to);
      return { action: "deny" };
    });
    view.webContents.on("will-frame-navigate", (event) => event.preventDefault());
    view.webContents.on("will-redirect", (event) => event.preventDefault());
    owner.contentView.addChildView(view);
    const ready = view.webContents.loadFile(join(o.web, "opening.html"), { query: { locale: currentLocale() } }).then(async () => {
      if (view.webContents.isDestroyed()) return;
      await view.webContents.executeJavaScript("document.fonts.ready.then(() => undefined)");
      if (!shown && window === owner && !owner.isDestroyed()) {
        shown = true;
        owner.show();
      }
    });
    const made: OpeningView = { owner, view, ready, progress: 0 };
    cover = made;
    fit(made);
    void loaded(
      ready.catch((error: unknown) => {
        if (cover === made) throw error;
      }),
    );
    return made;
  };
  const paint = async (current: OpeningView, update: Readonly<Record<string, string | number | boolean>>) => {
    await current.ready;
    if (cover !== current || current.view.webContents.isDestroyed()) return;
    await current.view.webContents.executeJavaScript(`{
      const cover = document.getElementById("opening");
      Object.assign(cover.dataset, ${JSON.stringify(update)});
      cover.dispatchEvent(new Event("opening-update"));
    }`);
  };

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
        !pagePermission(permission, origin, o.page(), details.isMainFrame, [details.mediaType ?? "unknown"])
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
        navigationOf(contents.getURL(), o.page()) === "stay" &&
        pagePermission(permission, origin, o.page(), details.isMainFrame, mediaTypes);
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
    // The page stays on its origin; any other link opens in the browser.
    made.webContents.setWindowOpenHandler(({ url: to }) => {
      if (navigationOf(to, undefined) === "browser") void shell.openExternal(to);
      return { action: "deny" };
    });
    made.webContents.on("will-navigate", (event, to) => {
      const where = navigationOf(to, o.page());
      if (where === "stay") return;
      event.preventDefault();
      if (where === "browser") void shell.openExternal(to);
    });
    let navigated = false;
    made.webContents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      accepting = false;
      if (navigated && cover?.owner === made) dispose(cover);
      opening(made);
      navigated = true;
    });
    made.webContents.on("did-navigate", () => (accepting = true));
    made.on("resize", () => {
      if (cover?.owner === made) fit(cover);
    });
    made.on("closed", () => {
      if (cover?.owner === made) dispose(cover);
      if (window === made) {
        window = undefined;
        accepting = false;
      }
    });
    window = made;
    shown = false;
    opening(made);
    return made;
  };
  const now = () => window ?? make();

  return {
    /** The window if it is open; nothing is made. */
    current: () => window,
    /** The bar while the server comes up, or why it did not. */
    opening: (problem?: string) => {
      const current = opening(now());
      if (problem !== undefined) void loaded(paint(current, { phase: "failed", progress: current.progress, problem }));
    },
    /** Over the open window while the app restarts into a new version; nothing when no window is open. */
    updating: (update: UpdateCover, step: UpdateStep): Promise<void> => {
      if (window === undefined) return Promise.resolve();
      const current = opening(window);
      const phase = typeof step === "string" ? step : "updateFailed";
      const progress = step === "swapping" ? 95 : 0;
      return loaded(paint(current, { ...update, phase, progress, ...(typeof step === "string" ? {} : { why: step.failed }) }));
    },
    progress: (update: Opening): Promise<void> => {
      const current = cover;
      if (!current || !accepting) return Promise.resolve();
      if (current.ending) return current.ending;
      const terminal = update.phase === "ready" || update.phase === "waiting" || update.phase === "failed";
      current.progress = update.phase === "ready" ? 100 : Math.max(current.progress, Math.min(99, update.progress));
      const advance = paint(current, { phase: update.phase, progress: current.progress }).catch((error: unknown) => {
        if (cover === current) throw error;
      });
      if (!terminal) return advance;
      current.ending = advance
        .then(async () => {
          if (cover !== current || current.view.webContents.isDestroyed()) return;
          try {
            await current.view.webContents.executeJavaScript(`document.getElementById("opening").animate(
            [{ opacity: 1 }, { opacity: 0 }],
            { duration: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240, fill: "forwards" }
          ).finished.then(() => undefined)`);
          } catch (error) {
            if (cover === current) throw error;
          }
        })
        .finally(() => {
          if (cover === current) dispose(current);
        });
      return current.ending;
    },
    /** A place on the page: "" is its start. */
    open: (path = "") => {
      const page = o.page();
      if (page !== undefined) void loaded(now().loadURL(page + path));
    },
    /** In front, made again if it was closed. steal: from whatever program is in front (a click on the island). */
    show: (steal = false) => {
      const fresh = window === undefined;
      const w = now();
      const page = o.page();
      if (fresh && page !== undefined) void loaded(w.loadURL(page));
      const reveal = () => {
        if (w.isDestroyed()) return;
        if (w.isMinimized()) w.restore();
        w.show();
        w.focus();
        if (steal) app.focus({ steal: true });
      };
      if (cover?.owner === w) void loaded(cover.ready.then(reveal));
      else reveal();
    },
    /** The ground follows the theme the page chose (host.ts). */
    repaint: () => window?.setBackgroundColor(ground(nativeTheme.shouldUseDarkColors)),
  };
}

export type MainWindow = ReturnType<typeof mainWindow>;
