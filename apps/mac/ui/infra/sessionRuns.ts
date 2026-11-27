import { z } from "zod";

import type { ChatTelemetry, EventTokens, SessionEvent, ToolTarget } from "@vibevalley/protocol";
import {
  ChatTelemetry as ChatTelemetrySchema,
  jsonString,
  SessionEvent as SessionEventSchema,
  ToolTarget as ToolTargetSchema,
} from "@vibevalley/protocol/schema";

import { coreBridge } from "./rich";

export type { ChatTelemetry, ToolTarget };

/** The steps kept for one session's log in the page. */
export const stepLimit = 240;

const EventArraySchema = z.array(SessionEventSchema);
const EventArrayJsonSchema = jsonString(EventArraySchema);
const ShownEventsJsonSchema = jsonString(z.object({ shown: EventArraySchema }));
const ToolTargetJsonSchema = jsonString(ToolTargetSchema);
const TelemetryWrapJsonSchema = jsonString(z.object({ telemetry: ChatTelemetrySchema }));

const emptyChatTelemetry = (defaultWindow = 200_000): ChatTelemetry => ({
  cachedRead: 0,
  uncachedInput: 0,
  totalInput: 0,
  output: 0,
  reasoning: 0,
  contextUsed: 0,
  contextWindow: defaultWindow,
  contextPct: 0,
  cacheHitPct: 0,
  turns: 0,
  toolCount: 0,
  hasData: false,
});

/** Merges incoming steps by `(seq, revision)` via Rust `VvCore`, capping to `limit` when set. */
export function mergeSteps(
  log: SessionEvent[],
  incoming: readonly SessionEvent[],
  options?: { readonly limit?: number | null; readonly replaceSameRevision?: boolean },
): SessionEvent[] {
  if (incoming.length === 0) return log;
  const limit = options?.limit === undefined ? stepLimit : options.limit;
  const replaceSameRevision = options?.replaceSameRevision ?? false;
  const json = coreBridge()?.mergeSteps?.(JSON.stringify(log), JSON.stringify(incoming), limit, replaceSameRevision);
  if (json !== undefined) {
    const parsed = EventArrayJsonSchema.safeParse(json);
    if (parsed.success) return parsed.data;
  }
  const combined = [...log, ...incoming];
  return limit !== null && combined.length > limit ? combined.slice(combined.length - limit) : combined;
}

/** Folds `tool/result` onto its matching `tool/call` and drops hidden step types via Rust `VvCore`. */
export function shownEvents(log: readonly SessionEvent[]): SessionEvent[] {
  const json = coreBridge()?.projectTrajectory?.(JSON.stringify(log), log.at(-1)?.time ?? 0);
  if (!json) return [];
  const parsed = ShownEventsJsonSchema.safeParse(json);
  return parsed.success ? parsed.data.shown : [];
}

/** Extracts the target file path, line number, and diff capability from a tool step via Rust `VvCore`. */
export function extractToolTarget(step: Pick<SessionEvent, "action" | "tool" | "input" | "text">): ToolTarget | undefined {
  const json = coreBridge()?.extractToolTarget?.(
    JSON.stringify({
      seq: 0,
      revision: 0,
      time: 0,
      type: "tool/call",
      ...step,
    }),
  );
  if (!json) return undefined;
  const parsed = ToolTargetJsonSchema.safeParse(json);
  return parsed.success ? parsed.data : undefined;
}

/** Aggregates token usage, context fill, turns, and tool counts across a session's steps via Rust `VvCore`. */
export function computeTelemetry(steps: readonly SessionEvent[], latestTokens?: EventTokens, defaultWindow = 200_000): ChatTelemetry {
  const json = coreBridge()?.projectChatSession?.(JSON.stringify(steps), latestTokens !== undefined ? JSON.stringify(latestTokens) : null, defaultWindow);
  if (!json) return emptyChatTelemetry(defaultWindow);
  const parsed = TelemetryWrapJsonSchema.safeParse(json);
  return parsed.success ? parsed.data.telemetry : emptyChatTelemetry(defaultWindow);
}

/** Formats a token count compactly (e.g. `62.4k`, `1M`). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/u, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return String(Math.round(n));
}
