import { type FromNative, fromNativeKey, mobileHost } from "./mobile";

export * from "./mobile";

// What the page may ask of the program around it. Every host (desktop/, mobile/, a plain browser) gives the whole
// interface; a capability it lacks is null, and the page draws nothing for it. The page never questions which host it is in.

export interface Notice {
  title: string;
  body: string;
}

/** The farm at a glance, where the host keeps one (the menu bar's tray): a short title and a line each. */
export interface TraySummary {
  title: string;
  lines: string[];
}

/** A key the host hears while another program is in front. */
export interface Shortcut {
  /** In Electron's accelerator notation (Alt+Shift+Space). */
  readonly accelerator: string;
  /** Calls `fn` each time it is pressed; returns how to stop. */
  readonly on: (fn: () => void) => () => void;
}

/** Who to join a call as: the server's grant (voice.session). */
export interface RtcGrant {
  readonly appId: string;
  readonly channel: string;
  readonly uid: string;
  readonly token: string;
}

/** What a call hears: the manager's arrival and leaving, its captions, both sides' levels (0..100), a trouble, and
 * that the token is about to run out. */
export interface RtcEvents {
  readonly joined: () => void;
  readonly left: () => void;
  readonly stream: (text: string) => void;
  readonly levels: (mine: number, theirs: number) => void;
  readonly problem: (text: string) => void;
  readonly expiring: () => void;
}

/** One call's line: joined with the grant, the microphone published with echo cancellation and noise suppression. */
export interface RtcLine {
  readonly mute: (on: boolean) => Promise<void>;
  readonly renew: (token: string) => Promise<void>;
  readonly leave: () => Promise<void>;
}

/** Joins a call; it fails with why (no microphone, Agora said no). */
export type Rtc = (grant: RtcGrant, events: RtcEvents) => Promise<RtcLine>;

export interface Host {
  /** For logs and the about box only. */
  readonly name: "desktop" | "mobile" | "browser";
  /** A system notification; null where there are none. */
  readonly notify: ((notice: Notice) => Promise<void>) | null;
  /** The tray's title and lines; null where there is no tray. */
  readonly tray: ((summary: TraySummary) => Promise<void>) | null;
  /** The key that starts and ends a call to the manager from anywhere; null where there is none. */
  readonly voiceShortcut: Shortcut | null;
  /** A call the host carries itself (the phone's, which goes on with the screen locked); null: the page joins with
   * Agora's web SDK. */
  readonly rtc: Rtc | null;
  /** The window has no title bar of its own and the page reaches its top edge: top is the strip the window is dragged
   * by, left what its buttons (macOS's traffic lights) take at the strip's start; null: the window has its own. */
  readonly titleBar: { readonly top: number; readonly left: number } | null;
}

/** The property a host's preload (or injected script) sets on window. */
export const hostKey = "vibevalleyHost";

/** A browser tab: no host around the page. */
export const browserHost: Host = { name: "browser", notify: null, tray: null, voiceShortcut: null, rtc: null, titleBar: null };

let phone: Host | undefined;

/** The desktop's preload sets hostKey; the phone's WebView brings ReactNativeWebView, and its host is built here, over
 * the bridge (mobile.ts). */
export function currentHost(): Host {
  const g = globalThis as Record<string, unknown>;
  const given = g[hostKey] as Host | undefined;
  if (given) return given;
  const native = g.ReactNativeWebView as { postMessage(text: string): void } | undefined;
  if (!native) return browserHost;
  if (!phone) {
    const bridge = mobileHost((m) => native.postMessage(JSON.stringify(m)));
    g[fromNativeKey] = (m: FromNative) => bridge.receive(m);
    phone = bridge.host;
  }
  return phone;
}
