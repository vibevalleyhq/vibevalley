import { host } from "nsh";
import { z } from "zod";

import type { InboxItem as InboxItemType } from "@vibevalley/protocol";
import { MotionChoice, type MotionChoice as MotionChoiceType } from "@vibevalley/protocol/host";
import { InboxItem } from "@vibevalley/protocol/schema";

export type HostLocale = "en" | "zh";
export type HostConnectionMode = "embedded" | "remote";

export interface HostParams {
  readonly view?: string | undefined;
  readonly locale: HostLocale;
  readonly motion?: MotionChoiceType | undefined;
  readonly route?: string | undefined;
  readonly role?: string | undefined;
  readonly pixelDir?: string | undefined;
  readonly globalShell: boolean;
  readonly connectionMode?: HostConnectionMode | undefined;
}

export interface ChatPaneParams {
  readonly tabId: number;
  readonly cwd: string;
  readonly repo?: string | undefined;
  readonly sessionId: string;
  readonly runtime: string;
  readonly title?: string | undefined;
}

export interface FarmFormParams {
  readonly repo: string;
  readonly station: number;
  readonly session?: string | undefined;
  readonly issue?: string | undefined;
  readonly kind: string;
}

export interface FarmCalls {
  readonly open: boolean;
  readonly narrow: boolean;
  readonly ringing: InboxItemType | null;
  readonly missed: InboxItemType[];
  readonly log: { readonly call: InboxItemType; readonly answered: boolean }[];
}

export interface FarmPhoneParams {
  readonly unfolded: boolean;
  readonly calls: FarmCalls;
}

export interface DevToolsParams {
  readonly detached: boolean;
}

const optString = z.string().optional().catch(undefined);
const localeSchema = z.enum(["en", "zh"]).catch("zh");
const motionSchema = MotionChoice.optional().catch(undefined);
const connectionModeSchema = z.enum(["embedded", "remote"]).optional().catch(undefined);

const hostParamsSchema = z.object({
  view: optString,
  locale: localeSchema,
  motion: motionSchema,
  route: optString,
  role: optString,
  pixelDir: optString,
  globalShell: z.boolean().catch(false),
  connectionMode: connectionModeSchema,
});

const chatPaneParamsSchema = z.object({
  tabId: z.number().catch(0),
  cwd: z.string().catch(""),
  repo: optString,
  sessionId: z.string().catch(""),
  runtime: z.string().min(1).catch("antigravity"),
  title: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0)
    .optional()
    .catch(undefined),
});

const farmFormParamsSchema = z.object({
  repo: z.string().catch(""),
  station: z.union([z.number(), z.string()]).transform(Number).catch(Number.NaN),
  session: optString,
  issue: optString,
  kind: z.string().catch(""),
});

const emptyCalls: FarmCalls = { open: false, narrow: false, ringing: null, missed: [], log: [] };

export const farmCallsSchema = z.object({
  open: z.boolean(),
  narrow: z.boolean(),
  ringing: InboxItem.nullable(),
  missed: z.array(InboxItem),
  log: z.array(z.object({ call: InboxItem, answered: z.boolean() })),
});

const farmPhoneParamsSchema = z.object({
  unfolded: z.boolean().catch(false),
  calls: farmCallsSchema.catch(emptyCalls),
});

const devToolsParamsSchema = z.object({
  detached: z.boolean().catch(false),
});

function rawParams(): Record<string, unknown> {
  return typeof host.params === "object" && host.params !== null ? host.params : {};
}

export function readHostParams(): HostParams {
  return hostParamsSchema.parse(rawParams());
}

export function readHostLocale(): HostLocale {
  return localeSchema.parse(rawParams().locale);
}

export function readHostMotion(): MotionChoiceType | undefined {
  return motionSchema.parse(rawParams().motion);
}

export function readConnectionMode(): HostConnectionMode | undefined {
  return connectionModeSchema.parse(rawParams().connectionMode);
}

export function readHostViewName(): string {
  return z.string().catch("stories").parse(rawParams().view);
}

export function hasHostView(): boolean {
  return (
    host.available() &&
    z
      .unknown()
      .refine((v) => v !== undefined)
      .safeParse(rawParams().view).success
  );
}

export function readChatPaneParams(): ChatPaneParams {
  return chatPaneParamsSchema.parse(rawParams());
}

export function readFarmFormParams(): FarmFormParams {
  return farmFormParamsSchema.parse(rawParams());
}

export function readFarmPhoneParams(): FarmPhoneParams {
  return farmPhoneParamsSchema.parse(rawParams());
}

export function readDevToolsParams(): DevToolsParams {
  return devToolsParamsSchema.parse(rawParams());
}
