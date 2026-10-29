// What the page may ask of the program around it: the desktop's shell, the phone's, or none in a browser tab. Every host
// gives the whole interface; a capability it lacks is null, and the page draws nothing for it. The page never asks which
// host it is in (it finds its host in apps/web/src/base/host.ts). The phone's host is over its WebView's bridge: the page posts
// a call as JSON and the shell answers it by id, the call's events come back the same way; mobileHost is the page's end of
// it, and the shell (apps/mobile) the other.

import type { AgoraGrant, Locale } from "./shapes";

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

/** What a call hears: the orchestrator's arrival and leaving, its captions, both sides' levels (0..100), a trouble, and
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
/** grant: the server's for the call (voice.session). */
export type Rtc = (grant: AgoraGrant, events: RtcEvents) => Promise<RtcLine>;

/** The farm's picture in art pixels (apps/web/public/village.ldtk) and how much of it may be cut off on each side when it
 * is scaled by a whole number: the page frames the farm by it, and the desktop keeps its window at a size the farm fills. */
export const farmFraming = { picture: { w: 384, h: 256 }, cut: { across: 0.05, down: 0.08 } } as const;

export interface Host {
  /** For logs and the about box only. */
  readonly name: "desktop" | "mobile" | "browser";
  /** A system notification; absent where there are none. */
  readonly notify?: (notice: Notice) => Promise<void>;
  /** The tray's title and lines; absent where there is no tray. */
  readonly tray?: (summary: TraySummary) => Promise<void>;
  /** The key that starts and ends a call to the orchestrator from anywhere; absent where there is none. */
  readonly voiceShortcut?: Shortcut;
  /** A call the host carries itself (the phone's, which goes on with the screen locked); absent: the page joins with
   * Agora's web SDK. */
  readonly rtc?: Rtc;
  /** The window has no title bar of its own and the page reaches its top edge: top is the strip the window is dragged
   * by, left what its buttons (macOS's traffic lights) take at the strip's start; absent: the window has its own. */
  readonly titleBar?: { readonly top: number; readonly left: number };
  /** Told the language the page speaks when it loads, so the host's own words (the tray's menu, the island, its dialogs)
   * match; absent where the host says nothing of its own. */
  readonly locale?: (locale: Locale) => void;
  /** Shows a file or folder on this machine in the system's file manager; absent where the host cannot. */
  readonly reveal?: (path: string) => void;
  /** Told the theme the page chose, so the host's own parts (menus, scroll bars, the title strip) follow; absent where the
   * host draws nothing of its own. */
  readonly theme?: (theme: ThemeChoice) => void;
}

/** Light, dark, or as the system is. */
export const ThemeChoiceValues = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof ThemeChoiceValues)[number];

/** The property a host's preload (or injected script) sets on window. */
export const hostKey = "vibevalleyHost";

/** What the page asks of the shell; each is answered once by its id. */
export type ToNative =
  | { readonly id: number; readonly call: "notify"; readonly notice: Notice }
  | { readonly id: number; readonly call: "rtc.join"; readonly line: number; readonly grant: AgoraGrant }
  | { readonly id: number; readonly call: "rtc.mute"; readonly line: number; readonly on: boolean }
  | { readonly id: number; readonly call: "rtc.renew"; readonly line: number; readonly token: string }
  | { readonly id: number; readonly call: "rtc.leave"; readonly line: number };

/** The shell's answers, and the call's events. */
export type FromNative =
  | { readonly id: number; readonly ok: true }
  | { readonly id: number; readonly ok: false; readonly error: string }
  | { readonly event: "rtc.joined"; readonly line: number }
  | { readonly event: "rtc.left"; readonly line: number }
  | { readonly event: "rtc.stream"; readonly line: number; readonly text: string }
  | { readonly event: "rtc.levels"; readonly line: number; readonly mine: number; readonly theirs: number }
  | { readonly event: "rtc.problem"; readonly line: number; readonly text: string }
  | { readonly event: "rtc.expiring"; readonly line: number };

/** The function on window the shell calls with each FromNative. */
export const fromNativeKey = "vibevalleyFromHost";

type Question = ToNative extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

/** Only the current line delivers events; older handles keep their own identity for late cleanup. */
export function mobileHost(post: (m: ToNative) => void) {
  let next = 1;
  const waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  let active: { line: number; events: RtcEvents } | undefined;
  const ask = (m: Question) =>
    new Promise<void>((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject });
      post({ ...m, id });
    });
  const host: Host = {
    name: "mobile",
    notify: (notice) => ask({ call: "notify", notice: { title: notice.title, body: notice.body } }),
    // The phone's shell speaks the phone's language (apps/mobile words.ts).
    // Files on the phone are not the farm's; the phone's status bar follows the system's theme.
    rtc: async (grant, on) => {
      const line = next;
      active = { line, events: on };
      const detach = () => {
        if (active?.line === line) active = undefined;
      };
      try {
        await ask({ call: "rtc.join", line, grant: { appId: grant.appId, channel: grant.channel, uid: grant.uid, token: grant.token } });
      } catch (e) {
        detach();
        throw e;
      }
      return {
        mute: (on) => ask({ call: "rtc.mute", line, on }),
        renew: (token) => ask({ call: "rtc.renew", line, token }),
        leave: () => {
          detach();
          return ask({ call: "rtc.leave", line });
        },
      } satisfies RtcLine;
    },
  };
  const receive = (m: FromNative) => {
    if ("id" in m) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.ok) w?.resolve();
      else w?.reject(new Error(m.error));
      return;
    }
    if (active?.line !== m.line) return;
    const events = active.events;
    switch (m.event) {
      case "rtc.joined":
        return events.joined();
      case "rtc.left":
        return events.left();
      case "rtc.stream":
        return events.stream(m.text);
      case "rtc.levels":
        return events.levels(m.mine, m.theirs);
      case "rtc.problem":
        return events.problem(m.text);
      case "rtc.expiring":
        return events.expiring();
      default:
        return m satisfies never;
    }
  };
  return { host, receive };
}
