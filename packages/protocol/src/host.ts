import { z } from "zod";

import type { Codec } from "./codec";
import type { Locale } from "./shapes";

export interface Notice {
  readonly title: string;
  readonly body: string;
}

export interface TraySummary {
  readonly title: string;
  readonly lines: readonly string[];
}

const UpdateManualValues = ["diskImage", "translocated", "readOnly", "noBuild"] as const;
export type UpdateManual = (typeof UpdateManualValues)[number];

const UpdateFailureKindValues = ["network", "rateLimit", "integrity", "signature", "permission", "install", "unknown"] as const;
export type UpdateFailureKind = (typeof UpdateFailureKindValues)[number];

export type UpdateState =
  | { readonly _tag: "disabled"; readonly version: string }
  | { readonly _tag: "idle"; readonly version: string; readonly checkedAt?: number }
  | { readonly _tag: "checking"; readonly version: string }
  | {
      readonly _tag: "downloading";
      readonly version: string;
      readonly next: string;
      readonly percent: number;
      readonly downloadedBytes?: number;
      readonly totalBytes?: number;
      readonly speedBps?: number;
    }
  | { readonly _tag: "verifying"; readonly version: string; readonly next: string }
  | {
      readonly _tag: "ready";
      readonly version: string;
      readonly next: string;
      readonly notes: readonly string[];
      readonly newFarm: boolean;
      readonly page: string;
    }
  | { readonly _tag: "installing"; readonly version: string; readonly next: string }
  | { readonly _tag: "manual"; readonly version: string; readonly next: string; readonly why: UpdateManual; readonly page: string }
  | {
      readonly _tag: "failed";
      readonly version: string;
      readonly why: string;
      readonly kind?: UpdateFailureKind;
      readonly page?: string;
    };

export const UpdateState: Codec<UpdateState> = z.discriminatedUnion("_tag", [
  z.object({ _tag: z.literal("disabled"), version: z.string() }),
  z.object({ _tag: z.literal("idle"), version: z.string(), checkedAt: z.exactOptional(z.number()) }),
  z.object({ _tag: z.literal("checking"), version: z.string() }),
  z.object({
    _tag: z.literal("downloading"),
    version: z.string(),
    next: z.string(),
    percent: z.number(),
    downloadedBytes: z.exactOptional(z.number()),
    totalBytes: z.exactOptional(z.number()),
    speedBps: z.exactOptional(z.number()),
  }),
  z.object({ _tag: z.literal("verifying"), version: z.string(), next: z.string() }),
  z.object({ _tag: z.literal("ready"), version: z.string(), next: z.string(), notes: z.array(z.string()), newFarm: z.boolean(), page: z.string() }),
  z.object({ _tag: z.literal("installing"), version: z.string(), next: z.string() }),
  z.object({ _tag: z.literal("manual"), version: z.string(), next: z.string(), why: z.enum(UpdateManualValues), page: z.string() }),
  z.object({
    _tag: z.literal("failed"),
    version: z.string(),
    why: z.string(),
    kind: z.exactOptional(z.enum(UpdateFailureKindValues)),
    page: z.exactOptional(z.string()),
  }),
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

export interface NoteAppletInfo {
  readonly noteId: string;
  readonly noteType: string;
  readonly appName: string;
  readonly bundleId: string;
  readonly bundlePath: string;
  readonly alwaysOnTop: boolean;
  readonly installed: boolean;
}

export const NoteAppletInfo = z.object({
  noteId: z.string(),
  noteType: z.string(),
  appName: z.string(),
  bundleId: z.string(),
  bundlePath: z.string(),
  alwaysOnTop: z.boolean(),
  installed: z.boolean(),
}) satisfies Codec<NoteAppletInfo>;

export interface AppletInstallInput {
  readonly noteId: string;
  readonly noteType: string;
  readonly appName: string;
  readonly alwaysOnTop: boolean;
}

export const AppletInstallInput = z.object({
  noteId: z.string(),
  noteType: z.string(),
  appName: z.string(),
  alwaysOnTop: z.boolean(),
}) satisfies Codec<AppletInstallInput>;

export interface AppletRemoveResult {
  readonly removed: boolean;
}

export const AppletRemoveResult = z.object({
  removed: z.boolean(),
}) satisfies Codec<AppletRemoveResult>;

export interface AppletOpenResult {
  readonly opened: boolean;
}

export const AppletOpenResult = z.object({
  opened: z.boolean(),
}) satisfies Codec<AppletOpenResult>;

export interface NoteApplets {
  readonly list: () => Promise<readonly NoteAppletInfo[]>;
  readonly install: (input: AppletInstallInput) => Promise<NoteAppletInfo>;
  readonly uninstall: (noteId: string) => Promise<AppletRemoveResult>;
  readonly open: (noteId: string) => Promise<AppletOpenResult>;
}

export interface HostCapturedImage {
  readonly mime: string;
  readonly data: string;
  readonly width: number;
  readonly height: number;
}

export const HostCapturedImage = z.object({
  mime: z.string(),
  data: z.string(),
  width: z.number(),
  height: z.number(),
}) satisfies Codec<HostCapturedImage>;

export interface HostCaptureWebViewOptions {
  readonly width?: number;
  readonly height?: number;
}

export interface Opening {
  readonly phase: "connecting" | "reading" | "loading" | "ready" | "waiting" | "failed";
  readonly progress: number;
}

export const ThemeChoiceValues = ["light", "dark", "system"] as const;
export type ThemeChoice = (typeof ThemeChoiceValues)[number];
export const ThemeChoice = z.enum(ThemeChoiceValues) satisfies Codec<ThemeChoice>;

export const MotionChoiceValues = ["off", "on", "system"] as const;
export type MotionChoice = (typeof MotionChoiceValues)[number];
export const MotionChoice = z.enum(MotionChoiceValues) satisfies Codec<MotionChoice>;

export interface Host {
  readonly name: "desktop" | "browser";
  readonly notify?: (notice: Notice) => Promise<void>;
  readonly tray?: (summary: TraySummary) => Promise<void>;
  readonly locale?: (locale: Locale) => void;
  readonly reveal?: (path: string) => void;
  readonly theme?: (theme: ThemeChoice) => void;
  readonly motion?: (choice: MotionChoice) => void;
  /** Terminal phases uncover the page. */
  readonly opening?: (opening: Opening) => Promise<void>;
  readonly update?: Updates;
  readonly commandLine?: CommandLine;
  readonly applet?: NoteApplets;
  readonly captureWebView?: (options?: HostCaptureWebViewOptions) => Promise<HostCapturedImage | null>;
}

declare global {
  interface Window {
    vibevalleyHost?: Host;
  }
}
