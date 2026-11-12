import { z } from "zod";

import { call, connect, type Link, push } from "@vibevalley/bridge";

import type { Codec } from "./codec";
import { AgoraGrant as AgoraGrantSchema, Locale as LocaleSchema } from "./schema";
import type { AgoraGrant, Locale } from "./shapes";

export interface Notice {
  readonly title: string;
  readonly body: string;
}
export const Notice = z.object({ title: z.string(), body: z.string() }) satisfies Codec<Notice>;

export interface TraySummary {
  readonly title: string;
  readonly lines: readonly string[];
}
export const TraySummary: Codec<TraySummary> = z.object({ title: z.string(), lines: z.array(z.string()) }) satisfies Codec<TraySummary>;

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
  | {
      readonly _tag: "ready";
      readonly version: string;
      readonly next: string;
      readonly notes: readonly string[];
      readonly newFarm: boolean;
      readonly page: string;
    }
  | { readonly _tag: "manual"; readonly version: string; readonly next: string; readonly why: UpdateManual; readonly page: string }
  | { readonly _tag: "failed"; readonly version: string; readonly why: string };

export const UpdateState: Codec<UpdateState> = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("idle"), version: z.string() }),
  z.object({ _tag: z.literal("checking"), version: z.string() }),
  z.object({ _tag: z.literal("downloading"), version: z.string(), next: z.string(), percent: z.number() }),
  z.object({ _tag: z.literal("ready"), version: z.string(), next: z.string(), notes: z.array(z.string()), newFarm: z.boolean(), page: z.string() }),
  z.object({ _tag: z.literal("manual"), version: z.string(), next: z.string(), why: z.enum(UpdateManualValues), page: z.string() }),
  z.object({ _tag: z.literal("failed"), version: z.string(), why: z.string() }),
]) satisfies Codec<UpdateState>;

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

export const CommandLineState = z.object({
  command: z.string(),
  link: z.string(),
  installed: z.boolean(),
  onPath: z.boolean(),
  taken: z.boolean(),
}) satisfies Codec<CommandLineState>;

interface CommandLine {
  readonly state: () => Promise<CommandLineState>;
  readonly install: () => Promise<CommandLineState>;
  readonly remove: () => Promise<CommandLineState>;
}

export interface Opening {
  readonly phase: "connecting" | "reading" | "loading" | "ready" | "waiting" | "failed";
  readonly progress: number;
}

export const Opening = z.object({
  phase: z.enum(["connecting", "reading", "loading", "ready", "waiting", "failed"]),
  progress: z.number().min(0).max(100),
}) satisfies Codec<Opening>;

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
export const ThemeChoice = z.enum(ThemeChoiceValues) satisfies Codec<ThemeChoice>;

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
  notify: call({ input: Notice, output: z.void() }),
  tray: call({ input: TraySummary, output: z.void() }),
  locale: call({ input: LocaleSchema, output: z.void() }),
  reveal: call({ input: z.string().regex(/^\/[^\0]*$/u), output: z.void() }),
  theme: call({ input: ThemeChoice, output: z.void() }),
  opening: call({ input: Opening, output: z.void() }),
  updateState: call({ input: z.void(), output: UpdateState }),
  // Unbounded: blocks while downloading an update.
  updateCheck: call({ input: z.void(), output: z.void(), timeoutMs: Infinity }),
  updateInstall: call({ input: z.void(), output: z.void(), timeoutMs: Infinity }),
  cliState: call({ input: z.void(), output: CommandLineState }),
  cliInstall: call({ input: z.void(), output: CommandLineState }),
  cliRemove: call({ input: z.void(), output: CommandLineState }),
  voiceShortcut: push(z.void()),
  update: push(UpdateState),
};

const DesktopStatus = z.object({
  name: z.string(),
  version: z.string(),
  channel: z.string(),
  server: z.exactOptional(z.string()),
});

export const desktopControl = {
  status: call({ input: z.void(), output: DesktopStatus }),
  open: call({ input: z.string().regex(/^\/[^\0]*$/u), output: z.void() }),
  quit: call({ input: z.void(), output: z.void() }),
  restart: call({ input: z.void(), output: z.void() }),
  updateState: call({ input: z.void(), output: UpdateState }),
  updateCheck: call({ input: z.void(), output: z.void(), timeoutMs: Infinity }),
  updateInstall: call({ input: z.void(), output: z.void(), timeoutMs: Infinity }),
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

const Line = { line: z.number() };

export const mobileBridge = {
  // First call awaits OS notification permission prompt.
  notify: call({ input: Notice, output: z.void(), timeoutMs: Infinity }),
  rtcJoin: call({ input: z.object({ ...Line, grant: AgoraGrantSchema }), output: z.void(), timeoutMs: 60_000 }),
  rtcMute: call({ input: z.object({ ...Line, on: z.boolean() }), output: z.void() }),
  rtcRenew: call({ input: z.object({ ...Line, token: z.string() }), output: z.void() }),
  rtcLeave: call({ input: z.object(Line), output: z.void() }),
  rtcJoined: push(z.object(Line)),
  rtcLeft: push(z.object(Line)),
  rtcStream: push(z.object({ ...Line, text: z.string() })),
  rtcLevels: push(z.object({ ...Line, mine: z.number(), theirs: z.number() })),
  rtcProblem: push(z.object({ ...Line, text: z.string() })),
  rtcExpiring: push(z.object(Line)),
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
