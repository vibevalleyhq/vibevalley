// What the page may ask of the program around it: the desktop's shell, the phone's, or none in a browser tab. Every host
// gives the whole interface; a capability it lacks is null, and the page draws nothing for it. The page never asks which
// host it is in (it finds its host in apps/web/src/infra/host.ts). What a host carries to another program goes over a
// bridge (@vibevalley/bridge) by one of the contracts here: the desktop's preload to Electron's main (desktopBridge), the
// phone's page to its shell (mobileBridge, whose page end is mobileHost).

import { Schema } from "effect";

import { call, connect, type Link, push } from "@vibevalley/bridge";

import { AgoraGrant as AgoraGrantSchema, Locale as LocaleSchema } from "./schema";
import type { AgoraGrant, Locale } from "./shapes";

export interface Notice {
  readonly title: string;
  readonly body: string;
}
export const Notice: Schema.Codec<Notice> = Schema.Struct({ title: Schema.String, body: Schema.String });

/** The farm at a glance, where the host keeps one (the menu bar's tray): a short title and a line each. */
export interface TraySummary {
  readonly title: string;
  readonly lines: readonly string[];
}
export const TraySummary: Schema.Codec<TraySummary> = Schema.Struct({ title: Schema.String, lines: Schema.Array(Schema.String) });

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

/** Why an update cannot put itself in place: the app runs from its disk image, or where macOS moved it to run it
 * (App Translocation), or from a folder it cannot write; or the release has no build for this Mac. */
export const UpdateManualValues = ["diskImage", "translocated", "readOnly", "noBuild"] as const;
export type UpdateManual = (typeof UpdateManualValues)[number];

/** The desktop's own updates (apps/desktop src/update.ts). version is the running one's; next the release's. newFarm: the
 * release's database is made from another baseline, so the farm starts over (the old one is kept aside), and it is put
 * in place only when the owner says. manual: it cannot put itself in place; page is where to download it by hand. */
export type UpdateState =
  | { readonly _tag: "idle"; readonly version: string }
  | { readonly _tag: "checking"; readonly version: string }
  | { readonly _tag: "downloading"; readonly version: string; readonly next: string; readonly percent: number }
  | { readonly _tag: "ready"; readonly version: string; readonly next: string; readonly notes: readonly string[]; readonly newFarm: boolean }
  | { readonly _tag: "manual"; readonly version: string; readonly next: string; readonly why: UpdateManual; readonly page: string }
  | { readonly _tag: "failed"; readonly version: string; readonly why: string };

export const UpdateState: Schema.Codec<UpdateState> = Schema.Union([
  Schema.TaggedStruct("idle", { version: Schema.String }),
  Schema.TaggedStruct("checking", { version: Schema.String }),
  Schema.TaggedStruct("downloading", { version: Schema.String, next: Schema.String, percent: Schema.Finite }),
  Schema.TaggedStruct("ready", { version: Schema.String, next: Schema.String, notes: Schema.Array(Schema.String), newFarm: Schema.Boolean }),
  Schema.TaggedStruct("manual", { version: Schema.String, next: Schema.String, why: Schema.Literals(UpdateManualValues), page: Schema.String }),
  Schema.TaggedStruct("failed", { version: Schema.String, why: Schema.String }),
]);

/** The host updating itself: watch hears the state now and each change after; install restarts into the new version. */
export interface Updates {
  readonly watch: (fn: (state: UpdateState) => void) => () => void;
  readonly check: () => Promise<void>;
  readonly install: () => Promise<void>;
}

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
  /** The app's own updates; absent where the host is not updated from here (a browser tab, the phone's store app). */
  readonly update?: Updates;
}

/** Light, dark, or as the system is. */
export const ThemeChoiceValues = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof ThemeChoiceValues)[number];
export const ThemeChoice: Schema.Codec<ThemeChoice> = Schema.Literals(ThemeChoiceValues);

// The only way between the page and a shell's own world is a property on window. Each is declared here, once, so what
// reads or sets one needs no cast and names it from this list.
declare global {
  interface Window {
    /** The desktop's preload sets it (contextBridge). */
    vibevalleyHost?: Host;
    /** React Native's WebView sets it in the phone's shell. */
    ReactNativeWebView?: { postMessage(text: string): void };
    /** The page sets it for the phone's shell to call with each message for it (mobileBridge). */
    vibevalleyFromHost?: (message: unknown) => void;
  }
}

/** The property a host's preload sets on window. */
export const hostKey = "vibevalleyHost" satisfies keyof Window;

/** The key the desktop hears while another program is in front, in Electron's accelerator notation: main registers it,
 * the page shows it (Host.voiceShortcut). */
export const desktopVoiceShortcut = "Alt+Shift+Space";

/** The desktop's preload asks Electron's main (apps/desktop). reveal takes only a path on this machine. */
export const desktopBridge = {
  notify: call({ input: Notice, output: Schema.Void }),
  tray: call({ input: TraySummary, output: Schema.Void }),
  locale: call({ input: LocaleSchema, output: Schema.Void }),
  reveal: call({ input: Schema.String.check(Schema.isPattern(/^\/[^\0]*$/u)), output: Schema.Void }),
  theme: call({ input: ThemeChoice, output: Schema.Void }),
  updateState: call({ input: Schema.Void, output: UpdateState }),
  // Both wait for a download.
  updateCheck: call({ input: Schema.Void, output: Schema.Void, timeoutMs: Infinity }),
  updateInstall: call({ input: Schema.Void, output: Schema.Void, timeoutMs: Infinity }),
  voiceShortcut: push(Schema.Void),
  update: push(UpdateState),
};

const Line = { line: Schema.Finite };

/** The phone's page asks its shell (apps/mobile); a call's events come back as pushes, each with the line it is for. */
export const mobileBridge = {
  // The first one asks the person for permission.
  notify: call({ input: Notice, output: Schema.Void, timeoutMs: Infinity }),
  // Joining goes over the network to Agora.
  rtcJoin: call({ input: Schema.Struct({ ...Line, grant: AgoraGrantSchema }), output: Schema.Void, timeoutMs: 60_000 }),
  rtcMute: call({ input: Schema.Struct({ ...Line, on: Schema.Boolean }), output: Schema.Void }),
  rtcRenew: call({ input: Schema.Struct({ ...Line, token: Schema.String }), output: Schema.Void }),
  rtcLeave: call({ input: Schema.Struct(Line), output: Schema.Void }),
  rtcJoined: push(Schema.Struct(Line)),
  rtcLeft: push(Schema.Struct(Line)),
  rtcStream: push(Schema.Struct({ ...Line, text: Schema.String })),
  rtcLevels: push(Schema.Struct({ ...Line, mine: Schema.Finite, theirs: Schema.Finite })),
  rtcProblem: push(Schema.Struct({ ...Line, text: Schema.String })),
  rtcExpiring: push(Schema.Struct(Line)),
};

/** The function on window the phone's shell calls with each message for the page. */
export const fromNativeKey = "vibevalleyFromHost" satisfies keyof Window;

/** The phone's host over its bridge. Only the current line hears its events; an older one keeps its own line for a late
 * leave. */
export function mobileHost(link: Link): Host {
  const native = connect(mobileBridge, link);
  let next = 1;
  let active: { line: number; events: RtcEvents } | undefined;
  const to = (line: number) => (active?.line === line ? active.events : undefined);
  native.on("rtcJoined", ({ line }) => to(line)?.joined());
  native.on("rtcLeft", ({ line }) => to(line)?.left());
  native.on("rtcStream", ({ line, text }) => to(line)?.stream(text));
  native.on("rtcLevels", ({ line, mine, theirs }) => to(line)?.levels(mine, theirs));
  native.on("rtcProblem", ({ line, text }) => to(line)?.problem(text));
  native.on("rtcExpiring", ({ line }) => to(line)?.expiring());
  return {
    name: "mobile",
    notify: (notice) => native.call.notify(notice),
    // The phone's shell speaks the phone's language (apps/mobile words.ts).
    // Files on the phone are not the farm's; the phone's status bar follows the system's theme.
    rtc: async (grant, on) => {
      const line = next++;
      active = { line, events: on };
      const detach = () => {
        if (active?.line === line) active = undefined;
      };
      try {
        await native.call.rtcJoin({ line, grant });
      } catch (e) {
        detach();
        throw e;
      }
      return {
        mute: (on) => native.call.rtcMute({ line, on }),
        renew: (token) => native.call.rtcRenew({ line, token }),
        leave: () => {
          detach();
          return native.call.rtcLeave({ line });
        },
      } satisfies RtcLine;
    },
  };
}
