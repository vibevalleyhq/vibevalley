import { z } from "zod";

import { BizCode } from "@vibevalley/protocol/api";

import type { TagTone } from "../../design/Tag";
import { hostApi } from "../../infra/bridge";

export interface AttachedRemoteVdp {
  readonly label: string;
  readonly port: number;
  readonly wsUrl: string;
  readonly token: string;
  readonly channel?: string | undefined;
  readonly pid?: number | undefined;
  readonly home?: string | undefined;
}

const VdpTargetSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  url: z.exactOptional(z.string()),
  attached: z.exactOptional(z.boolean()),
});

export type RemoteTarget = z.infer<typeof VdpTargetSchema>;

export const TargetListResultSchema = z.object({
  targets: z.array(VdpTargetSchema),
});

export const PageMetricsSchema = z.object({
  width: z.number(),
  height: z.number(),
  scaleFactor: z.exactOptional(z.number()),
  themeDark: z.exactOptional(z.boolean()),
  lastFrameMs: z.exactOptional(z.number()),
});

export type RemoteMetrics = z.infer<typeof PageMetricsSchema>;

export const ScreenshotResultSchema = z.object({
  mime: z.string(),
  data: z.string(),
  width: z.number(),
  height: z.number(),
});

export type RemoteScreenshot = z.infer<typeof ScreenshotResultSchema>;

const UiBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const UiNodeSchema = z.object({
  testId: z.exactOptional(z.string()),
  role: z.exactOptional(z.string()),
  text: z.exactOptional(z.string()),
  route: z.exactOptional(z.string()),
  bounds: z.exactOptional(UiBoundsSchema),
  pressable: z.exactOptional(z.boolean()),
});

export type RemoteUiNode = z.infer<typeof UiNodeSchema>;

export const UiQueryResultSchema = z.object({
  view: z.exactOptional(z.string()),
  route: z.exactOptional(z.string()),
  count: z.exactOptional(z.number()),
  nodes: z.array(UiNodeSchema),
});

const BufferedEventSchema = z.object({
  id: z.number(),
  event: z.object({
    method: z.string(),
    params: z.unknown(),
  }),
});

export const LogEntriesResultSchema = z.object({
  entries: z.array(BufferedEventSchema),
  latestId: z.exactOptional(z.number()),
});

export interface RemoteLogRow {
  readonly key: string;
  readonly level: string;
  readonly source: string;
  readonly message: string;
  readonly time: number;
}

export function targetTone(kind: string): TagTone {
  switch (kind) {
    case "shell":
      return "ok";
    case "view":
      return "info";
    case "webview":
    case "diorama":
      return "wait";
    default:
      return "neutral";
  }
}

export function logTone(level: string): TagTone {
  const lower = level.toLowerCase();
  if (lower === "error" || lower === "fatal") return "bad";
  if (lower === "warn" || lower === "warning") return "wait";
  if (lower === "info") return "info";
  return "neutral";
}

const ShellStateInfoSchema = z.object({
  route: z.exactOptional(z.string()),
  theme_dark: z.exactOptional(z.boolean()),
});

export const LogEventParamsSchema = z.object({
  level: z.exactOptional(z.string()),
  source: z.exactOptional(z.string()),
  view: z.exactOptional(z.string()),
  message: z.exactOptional(z.string()),
  frameMs: z.exactOptional(z.number()),
  timestamp: z.exactOptional(z.number()),
});

export function extractShellRoute(state: unknown): string {
  const parsed = ShellStateInfoSchema.safeParse(state);
  if (!parsed.success) return "—";
  return parsed.data.route !== undefined && parsed.data.route.length > 0 ? parsed.data.route : "—";
}

export function extractShellDark(state: unknown): boolean | undefined {
  const parsed = ShellStateInfoSchema.safeParse(state);
  return parsed.success ? parsed.data.theme_dark : undefined;
}

export async function invokeRemoteVdp(
  conn: AttachedRemoteVdp,
  method: string,
  params: unknown = {},
): Promise<{ ok: true; data: unknown } | { ok: false; message: string }> {
  const env = await hostApi.vdpCall({
    wsUrl: conn.wsUrl,
    port: conn.port,
    token: conn.token,
    method,
    params,
  });
  if (env.bizCode !== BizCode.Ok) {
    return { ok: false, message: env.message || `VDP ${method} failed` };
  }
  return { ok: true, data: env.data };
}
