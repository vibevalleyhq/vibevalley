import { Schema } from "effect";

import { call, connect, type Link, push } from "@vibevalley/bridge";

import { AgoraGrant as AgoraGrantSchema, Locale as LocaleSchema } from "./schema";
import type { AgoraGrant, Locale } from "./shapes";

export interface Notice {
  readonly title: string;
  readonly body: string;
}
export const Notice: Schema.Codec<Notice> = Schema.Struct({ title: Schema.String, body: Schema.String });

export interface TraySummary {
  readonly title: string;
  readonly lines: readonly string[];
}
export const TraySummary: Schema.Codec<TraySummary> = Schema.Struct({ title: Schema.String, lines: Schema.Array(Schema.String) });

export interface Shortcut {
  /** Electron accelerator notation (e.g. `Alt+Shift+Space`). */
  readonly accelerator: string;
  readonly on: (fn: () => void) => () => void;
}

export interface RtcEvents {
  readonly joined: () => void;
  readonly left: () => void;
  readonly stream: (text: string) => void;
  /** Audio levels are `0..100`. */
  readonly levels: (mine: number, theirs: number) => void;
  readonly problem: (text: string) => void;
  readonly expiring: () => void;
}

export interface RtcLine {
  readonly mute: (on: boolean) => Promise<void>;
  readonly renew: (token: string) => Promise<void>;
  readonly leave: () => Promise<void>;
}

export type Rtc = (grant: AgoraGrant, events: RtcEvents) => Promise<RtcLine>;

/** Art-pixel dimensions and max fractional crop per edge when integer-scaled. */
export const farmFraming = { picture: { w: 384, h: 256 }, cut: { across: 0.05, down: 0.08 } } as const;

const UpdateManualValues = ["diskImage", "translocated", "readOnly", "noBuild"] as const;
export type UpdateManual = (typeof UpdateManualValues)[number];

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

export interface Updates {
  readonly watch: (fn: (state: UpdateState) => void) => () => void;
  readonly check: () => Promise<void>;
  readonly install: () => Promise<void>;
}

export interface CommandLineState {
  readonly command: string;
  readonly link: string;
  readonly installed: boolean;
  readonly onPath: boolean;
  readonly taken: boolean;
}

export const CommandLineState: Schema.Codec<CommandLineState> = Schema.Struct({
  command: Schema.String,
  link: Schema.String,
  installed: Schema.Boolean,
  onPath: Schema.Boolean,
  taken: Schema.Boolean,
});

interface CommandLine {
  readonly state: () => Promise<CommandLineState>;
  readonly install: () => Promise<CommandLineState>;
  readonly remove: () => Promise<CommandLineState>;
}

export interface Opening {
  readonly phase: "connecting" | "reading" | "loading" | "ready" | "waiting" | "failed";
  readonly progress: number;
}

export const Opening: Schema.Codec<Opening> = Schema.Struct({
  phase: Schema.Literals(["connecting", "reading", "loading", "ready", "waiting", "failed"]),
  progress: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
});

export interface Host {
  readonly name: "desktop" | "mobile" | "browser";
  readonly notify?: (notice: Notice) => Promise<void>;
  readonly tray?: (summary: TraySummary) => Promise<void>;
  readonly voiceShortcut?: Shortcut;
  /** Native RTC transport that survives screen lock; omit to fall back to Agora Web SDK. */
  readonly rtc?: Rtc;
  /** Inset for frameless windows; omit when the OS draws the title bar. */
  readonly titleBar?: { readonly top: number; readonly left: number };
  readonly locale?: (locale: Locale) => void;
  readonly reveal?: (path: string) => void;
  readonly theme?: (theme: ThemeChoice) => void;
  /** Terminal phases uncover the page. */
  readonly opening?: (opening: Opening) => Promise<void>;
  readonly update?: Updates;
  readonly commandLine?: CommandLine;
}

export const ThemeChoiceValues = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof ThemeChoiceValues)[number];
export const ThemeChoice: Schema.Codec<ThemeChoice> = Schema.Literals(ThemeChoiceValues);

declare global {
  interface Window {
    vibevalleyHost?: Host;
    ReactNativeWebView?: { postMessage(text: string): void };
    vibevalleyFromHost?: (message: unknown) => void;
  }
}

export const hostKey = "vibevalleyHost" satisfies keyof Window;

export const desktopVoiceShortcut = "Alt+Shift+Space";

export const desktopBridge = {
  notify: call({ input: Notice, output: Schema.Void }),
  tray: call({ input: TraySummary, output: Schema.Void }),
  locale: call({ input: LocaleSchema, output: Schema.Void }),
  reveal: call({ input: Schema.String.check(Schema.isPattern(/^\/[^\0]*$/u)), output: Schema.Void }),
  theme: call({ input: ThemeChoice, output: Schema.Void }),
  opening: call({ input: Opening, output: Schema.Void }),
  updateState: call({ input: Schema.Void, output: UpdateState }),
  // Unbounded: blocks while downloading an update.
  updateCheck: call({ input: Schema.Void, output: Schema.Void, timeoutMs: Infinity }),
  updateInstall: call({ input: Schema.Void, output: Schema.Void, timeoutMs: Infinity }),
  cliState: call({ input: Schema.Void, output: CommandLineState }),
  cliInstall: call({ input: Schema.Void, output: CommandLineState }),
  cliRemove: call({ input: Schema.Void, output: CommandLineState }),
  voiceShortcut: push(Schema.Void),
  update: push(UpdateState),
};

const DesktopStatus = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  channel: Schema.String,
  server: Schema.optionalKey(Schema.String),
});

export const desktopControl = {
  status: call({ input: Schema.Void, output: DesktopStatus }),
  open: call({ input: Schema.String.check(Schema.isPattern(/^\/[^\0]*$/u)), output: Schema.Void }),
  quit: call({ input: Schema.Void, output: Schema.Void }),
  restart: call({ input: Schema.Void, output: Schema.Void }),
  updateState: call({ input: Schema.Void, output: UpdateState }),
  updateCheck: call({ input: Schema.Void, output: Schema.Void, timeoutMs: Infinity }),
  updateInstall: call({ input: Schema.Void, output: Schema.Void, timeoutMs: Infinity }),
};

/** Exhaustive map forcing every new `desktopBridge` member to declare whether CLI control may invoke it. */
export const desktopReach: Readonly<Record<keyof typeof desktopBridge, "control" | "page">> = {
  notify: "page",
  tray: "page",
  locale: "page",
  reveal: "page",
  theme: "page",
  opening: "page",
  updateState: "control",
  updateCheck: "control",
  updateInstall: "control",
  cliState: "page",
  cliInstall: "page",
  cliRemove: "page",
  voiceShortcut: "page",
  update: "page",
};

const Line = { line: Schema.Finite };

export const mobileBridge = {
  // First call awaits OS notification permission prompt.
  notify: call({ input: Notice, output: Schema.Void, timeoutMs: Infinity }),
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

export const fromNativeKey = "vibevalleyFromHost" satisfies keyof Window;

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
