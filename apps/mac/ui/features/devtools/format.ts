import { z } from "zod";

import { t } from "@vibevalley/i18n";
import {
  type DebugTimelineEvent,
  type DebugTimelineLane,
  type DebugTrajectoryKind,
  type EventTokens,
  SliceKindValues,
  VibeValleyApiError,
} from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { DebugTimelineLane as DebugTimelineLaneSchema } from "@vibevalley/protocol/schema";

import type { TagTone } from "../../design/Tag";

export type DevToolsTab = "overview" | "routes" | "timeline" | "trajectory" | "state" | "lab";

export type TimelineLaneFilter = "all" | DebugTimelineLane;

export const DEVTOOLS_TABS: readonly DevToolsTab[] = ["overview", "routes", "timeline", "trajectory", "state", "lab"];

export const TIMELINE_LANES: readonly TimelineLaneFilter[] = ["all", ...DebugTimelineLaneSchema.options];

export const QUICK_ROUTES: readonly string[] = ["/issues", "/chat", "/repos", "/workspace", "/library", "/agents", "/farm", "/settings"];

export const SLICE_NAMES = SliceKindValues;

export const LATENCY_PRESETS_MS: readonly number[] = [0, 300, 1000];

export const DISCONNECT_TOPICS: readonly string[] = ["slice:board", "slice:sessions", "slice:collab", "channel.follow"];

const routeTabSchema = z.object({
  id: z.number().optional(),
  title: z.string().optional(),
  kind: z.string().optional(),
  active: z.boolean().optional(),
  running: z.boolean().optional(),
  runningState: z.string().optional(),
});

const routeProjectSchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
  path: z.string().optional(),
  active: z.boolean().optional(),
  branch: z.string().optional(),
  tabs: z.array(routeTabSchema).optional(),
});

const routeStateSchema = z.object({
  current: z.string().optional(),
  nativeWorkspace: z.boolean().optional(),
  panel: z.string().optional(),
  inspectorOpen: z.boolean().optional(),
  projects: z.array(routeProjectSchema).optional(),
});

export type RouteStateInfo = z.infer<typeof routeStateSchema>;

export function parseRouteState(raw: unknown): RouteStateInfo | undefined {
  const parsed = routeStateSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const v = parsed.data;
  if (
    v.current === undefined &&
    v.nativeWorkspace === undefined &&
    v.panel === undefined &&
    v.inspectorOpen === undefined &&
    (v.projects === undefined || v.projects.length === 0)
  ) {
    return undefined;
  }
  return v;
}

export function isDisabledError(err: unknown): boolean {
  if (!(err instanceof VibeValleyApiError)) return false;
  return err.bizCode === BizCode.Forbidden || err.bizCode === BizCode.Refused || err.tag === "Forbidden";
}

export function laneLabel(lane: TimelineLaneFilter): string {
  switch (lane) {
    case "all":
      return t("web.devtools.lanes.all");
    case "core_apply":
      return t("web.devtools.lanes.coreApply");
    case "bridge_rpc":
      return t("web.devtools.lanes.bridgeRpc");
    case "oar_wire":
      return t("web.devtools.lanes.oarWire");
    case "gpui_frame":
      return t("web.devtools.lanes.gpuiFrame");
  }
}

export function laneTone(lane: DebugTimelineLane): TagTone {
  switch (lane) {
    case "core_apply":
      return "ok";
    case "bridge_rpc":
      return "info";
    case "oar_wire":
      return "wait";
    case "gpui_frame":
      return "neutral";
  }
}

export function trajectoryKindLabel(kind: DebugTrajectoryKind): string {
  switch (kind) {
    case "issue_session":
      return t("web.devtools.trajectory.kind.issueSession");
    case "workspace_chat":
      return t("web.devtools.trajectory.kind.workspaceChat");
    case "orchestrator":
      return t("web.devtools.trajectory.kind.orchestrator");
  }
}

export function trajectoryKindTone(kind: DebugTrajectoryKind): TagTone {
  switch (kind) {
    case "issue_session":
      return "info";
    case "workspace_chat":
      return "ok";
    case "orchestrator":
      return "wait";
  }
}

export function isSlowEvent(event: DebugTimelineEvent): boolean {
  return event.slow === true || (event.durationUs !== undefined && event.durationUs >= 16_000);
}

export function slowBadgeTone(event: DebugTimelineEvent): TagTone {
  if (event.durationUs !== undefined && event.durationUs >= 50_000) return "bad";
  return "wait";
}

function totalTokens(tokens: EventTokens): number {
  return tokens.input + tokens.cacheRead + tokens.output + (tokens.cacheWrite ?? 0) + (tokens.reasoning ?? 0);
}

export function formatTokenCompact(tokens: EventTokens): string {
  const total = totalTokens(tokens);
  if (total >= 1000) return `${(total / 1000).toFixed(1)}k`;
  return String(total);
}

export function formatTokenBreakdown(tokens: EventTokens): readonly string[] {
  const parts: string[] = [`in:${tokens.input}`, `cacheR:${tokens.cacheRead}`];
  if (tokens.cacheWrite !== undefined && tokens.cacheWrite > 0) parts.push(`cacheW:${tokens.cacheWrite}`);
  if (tokens.reasoning !== undefined && tokens.reasoning > 0) parts.push(`reason:${tokens.reasoning}`);
  parts.push(`out:${tokens.output}`);
  if (tokens.contextUsed !== undefined && tokens.contextWindow !== undefined && tokens.contextWindow > 0) {
    const pct = Math.min(100, Math.round((tokens.contextUsed / tokens.contextWindow) * 100));
    parts.push(`ctx:${pct}%`);
  }
  return parts;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatFrameMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return `${ms.toFixed(1)} ms`;
}

export function formatDurationMs(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function formatJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
