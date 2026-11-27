import { z } from "zod";
// Thin UI bindings over Rust session trajectory projections (`SessionEventPage.trajectory` and `VvCore`), plus i18n copy/tones and `SessionLogs`.

import { t } from "@vibevalley/i18n";
import {
  type LiveEvent,
  type SessionEvent,
  type SessionEventPage,
  type SessionTrajectoryProjection,
  type TrajectoryRunView,
  type TrajectorySummary,
  type TrajectoryWaterfall,
  type TrajectoryWaterfallLane,
  TrajectoryWaterfallLaneValues,
} from "@vibevalley/protocol";
import { oneLine } from "@vibevalley/protocol/rules";
import { SessionTrajectoryProjection as SessionTrajectoryProjectionSchema } from "@vibevalley/protocol/schema";

import { big, tookText } from "../../infra/base/format";
import { coreBridge } from "../../infra/rich";
import { localizeRuntimeError } from "../../infra/runtimeError";
import { mergeSteps, shownEvents, stepLimit } from "../../infra/sessionRuns";

export { mergeSteps, shownEvents };
export type { TrajectorySummary };
export type RunView = TrajectoryRunView;
export type Lane = TrajectoryWaterfallLane;
export const lanes: readonly Lane[] = TrajectoryWaterfallLaneValues;

export interface SessionProjectionState {
  readonly steps: SessionEvent[];
  readonly trajectory?: SessionTrajectoryProjection;
}

const emptySteps: SessionEvent[] = [];
const emptyProjectionState: SessionProjectionState = { steps: emptySteps };
const NumberArraySchema = z.array(z.number());

function groupByRun(steps: readonly SessionEvent[]): Map<string, SessionEvent[]> {
  const byRun = new Map<string, SessionEvent[]>();
  for (const s of steps) {
    if (s.run === undefined) continue;
    let bucket = byRun.get(s.run);
    if (!bucket) {
      bucket = [];
      byRun.set(s.run, bucket);
    }
    bucket.push(s);
  }
  return byRun;
}

function stepsEqual(a: readonly SessionEvent[], b: readonly SessionEvent[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined || y === undefined || x.seq !== y.seq || x.revision !== y.revision) return false;
  }
  return true;
}

/** Projects a full `SessionTrajectoryProjection` from raw events via Rust `VvCore` (used for live/unprojected updates). */
export function projectTrajectory(steps: readonly SessionEvent[], end: number): SessionTrajectoryProjection | undefined {
  const json = coreBridge()?.projectTrajectory?.(JSON.stringify(steps), end);
  if (!json) return undefined;
  const parsed = SessionTrajectoryProjectionSchema.safeParse(JSON.parse(json));
  return parsed.success ? parsed.data : undefined;
}

/** The last top-level thing it said, if any. */
export function answerOf(r: RunView) {
  for (let i = r.steps.length - 1; i >= 0; i--) {
    const s = r.steps.at(i);
    if (s && s.type === "assistant/message" && s.under === undefined) return s;
  }
  return undefined;
}

const allOf = (r: RunView) => (r.asked ? [r.asked, ...r.steps] : r.steps);

/** Splits events into runs via Rust `VvCore`. */
export function runsOf(steps: readonly SessionEvent[]): RunView[] {
  return projectTrajectory(steps, steps.at(-1)?.time ?? 0)?.runs ?? [];
}

interface Span {
  step: SessionEvent;
  ms: number;
}

/** Each step lasts until the next one starts; the last until `end`. */
export function spansOf(r: RunView, end: number): Span[] {
  const all = allOf(r);
  return all.map((s, i) => ({ step: s, ms: Math.max(0, (all[i + 1]?.time ?? end) - s.time) }));
}

/** Per-step durations computed by Rust `VvCore`. */
export function stepDurationsOf(log: readonly SessionEvent[], end: number): Map<number, number> {
  const proj = projectTrajectory(log, end);
  return new Map((proj?.stepDurations ?? []).map((d) => [d.seq, d.durationMs]));
}

export function runMs(r: RunView, end: number) {
  const first = allOf(r).at(0);
  return first ? Math.max(0, end - first.time) : 0;
}

export const lastTime = (r: RunView) => allOf(r).at(-1)?.time;

export function farmToolText(text: string) {
  const m = /^vibevalley__(channel_message_send|channel_message_list|channel_unread_list|session_list)/u.exec(text.trim())?.[1];
  switch (m) {
    case undefined:
      return undefined;
    case "channel_message_send":
      return t("web.session.runs.farm.channel_message_send");
    case "channel_message_list":
      return t("web.session.runs.farm.channel_message_list");
    case "channel_unread_list":
      return t("web.session.runs.farm.channel_unread_list");
    case "session_list":
      return t("web.session.runs.farm.session_list");
    default:
      return t("web.session.runs.farm.other", { tool: m });
  }
}

export function spanLabel(step: SessionEvent) {
  switch (step.type) {
    case "user/message":
      return t("web.session.runs.span.heard");
    case "memory/recalled":
      return t("web.session.runs.span.recalled");
    case "assistant/thinking":
      return t("web.session.runs.span.thinking");
    case "assistant/message":
      return t("web.session.runs.span.said");
    case "llm/retry":
      return t("web.session.runs.span.retry");
    case "llm/usage":
      return t("web.session.runs.span.cache");
    case "run/error":
      return t("web.session.runs.span.error");
    case "permission/request":
      return t("web.shell.chat.permissionBadge");
    case "permission/resolved":
      return t("web.shell.chat.toolOk");
    case "interaction/request":
      return t("web.shell.chat.statusWaiting");
    case "interaction/resolved":
      return t("web.shell.chat.interactionAnswered");
    case "run/start":
    case "run/end":
    case "tool/result":
      return "";
    case "tool/call":
      return farmToolText(step.text) ? t("web.session.runs.span.farm") : (step.actionText ?? t("web.session.runs.span.tool"));
  }
}

/** Theme token name for a step's timeline/waterfall colour. */
export function spanTone(step: SessionEvent): string {
  switch (step.type) {
    case "user/message":
      return "wheat";
    case "memory/recalled":
      return "leaf-300";
    case "assistant/thinking":
      return "cream-300";
    case "assistant/message":
      return "leaf-500";
    case "llm/retry":
    case "llm/usage":
    case "permission/request":
    case "interaction/request":
      return "wheat-hover";
    case "permission/resolved":
    case "interaction/resolved":
      return "leaf-300";
    case "run/error":
      return "berry";
    case "run/start":
    case "run/end":
    case "tool/result":
      return "cream-200";
    case "tool/call":
      if (step.ok === false) return "berry";
      switch (step.action ?? "other") {
        case "read_file":
        case "search":
        case "web":
          return "water-500";
        case "edit_file":
          return "leaf-700";
        case "run_command":
          return "bark-600";
        case "wait":
          return "cream-200";
        case "mcp":
        case "other":
          return "bark-400";
      }
  }
}

/** A call's input formatted by Rust `VvCore`. */
export function readableInput(step: SessionEvent): string {
  if (step.input === undefined || step.input.trim() === "") return "";
  return coreBridge()?.readableInput?.(JSON.stringify(step)) ?? step.input.trim();
}

/** Localizes a Rust-collapsed step summary, falling back to `contextUpdate` when scaffolding-only. */
export function localizeCollapsedSummary(rawSummary: string): string {
  const resolved = rawSummary === "" ? t("web.session.trajectory.contextUpdate") : rawSummary;
  return localizeRuntimeError(resolved).text;
}

/** Strips internal orchestrator prompt-injection scaffolding via Rust `VvCore` and localizes runtime errors. */
export function collapsedStepSummary(step: SessionEvent, body: string): string {
  const native = coreBridge()?.collapsedStepSummary;
  if (native !== undefined) {
    return localizeCollapsedSummary(native(step.type, body));
  }
  return localizeRuntimeError(oneLine(body).trim()).text;
}

/** What started a run, as its fold says it: the first word is the issue, later ones are words carried to it. */
export function runTitle(r: RunView, firstAsked: number | undefined, asked?: string) {
  const a = r.asked;
  if (!a) return r.run === undefined ? t("web.session.runs.earlier") : t("web.session.runs.unasked");
  return asked ?? (a.seq === firstAsked ? t("web.session.runs.issue") : t("web.session.runs.told"));
}

/** Folded to `lines` when longer. */
export const isLongText = (text: string, lines: number) => text.length > lines * 60 || text.split("\n").length > lines;

/** The line under a message for the run behind it, or undefined with none to show: an orchestrator's run only when it used tools. */
export function runLabel(steps: SessionEvent[], orchestrator: boolean) {
  const tools = steps.filter((s) => s.type === "tool/call").length;
  if (steps.length === 0 || (orchestrator && tools === 0)) return undefined;
  const first = steps.at(0);
  const last = steps.at(-1);
  const took = orchestrator && first && last && steps.length > 1 ? last.time - first.time : undefined;
  if (took !== undefined && took >= 1000) return t("web.session.runs.thoughtFor", { took: tookText(took), n: tools });
  return tools > 0 ? t("web.session.runs.usedTools", { n: tools }) : t("web.session.runs.process");
}

/** Allocates damped horizontal pixel widths for waterfall runs via Rust `VvCore`. */
export function waterfallWidths(durations: readonly number[], room: number): number[] {
  if (room <= 0 || durations.length === 0) return [];
  const json = coreBridge()?.waterfallWidths?.(JSON.stringify(durations), room);
  if (json !== undefined) {
    const parsed = NumberArraySchema.safeParse(JSON.parse(json));
    if (parsed.success) return parsed.data;
  }
  return durations.map(() => room / durations.length);
}

/** Waterfall runs and spans computed by Rust `VvCore`. */
export function waterfallOf(log: readonly SessionEvent[], end: number): TrajectoryWaterfall {
  return projectTrajectory(log, end)?.waterfall ?? { runs: [], spans: [] };
}

/** Trajectory summary totals computed by Rust `VvCore`. */
export function summaryOf(log: readonly SessionEvent[], end: number): TrajectorySummary {
  return (
    projectTrajectory(log, end)?.summary ?? {
      runs: 0,
      steps: 0,
      modelMs: 0,
      toolMs: 0,
      input: 0,
      cacheRead: 0,
      output: 0,
    }
  );
}

/** null with no usage recorded. */
export const cacheHit = (s: TrajectorySummary) => (s.input + s.cacheRead > 0 ? s.cacheRead / (s.input + s.cacheRead) : undefined);

/** Under ten seconds to a tenth. */
export const secondsText = (ms: number) => (ms < 10000 ? t("web.base.time.tenths", { s: (ms / 1000).toFixed(1) }) : tookText(ms));

export const tokensText = (n: number) => (n < 10000 ? `${n}` : big(n, 1));

/** The part after an MCP server's prefix: `mcp__vibevalley__channel_message_send` is channel_message_send. */
function toolName(tool: string) {
  const at = tool.lastIndexOf("__");
  return at >= 0 && at + 2 < tool.length ? tool.slice(at + 2) : tool;
}

/** The trajectory's tag for a step; `asked` names what began a run. */
export function tagOf(step: SessionEvent, asked?: string, issue = false): string {
  const sub = step.under !== undefined;
  switch (step.type) {
    case "user/message":
      return sub ? t("web.session.runs.subagentGot") : (asked ?? (issue ? t("web.session.runs.issue") : t("web.session.runs.told")));
    case "memory/recalled":
      return t("web.session.runs.span.recalled");
    case "assistant/thinking":
      return sub ? t("web.session.runs.tag.subagentThought") : t("web.session.runs.tag.thought");
    case "assistant/message":
      return sub ? t("web.session.runs.tag.subagentSaid") : t("web.session.runs.tag.said");
    case "llm/retry":
      return t("web.session.runs.span.retry");
    case "llm/usage":
      return t("web.session.runs.tag.usage");
    case "run/error":
      return t("web.session.runs.span.error");
    case "permission/request":
      return t("web.shell.chat.permissionBadge");
    case "permission/resolved":
      return t("web.shell.chat.toolOk");
    case "interaction/request":
      return t("web.shell.chat.statusWaiting");
    case "interaction/resolved":
      return t("web.shell.chat.interactionAnswered");
    case "tool/call":
      if (farmToolText(step.text) !== undefined) return t("web.session.runs.span.farm");
      return step.tool ? toolName(step.tool) : spanLabel(step);
    case "run/start":
    case "run/end":
    case "tool/result":
      return "";
  }
}

interface Log {
  readonly id: string;
  steps: SessionEvent[];
  trajectory: SessionTrajectoryProjection | undefined;
  byRun: Map<string, SessionEvent[]>;
  readonly listeners: Set<(state: SessionProjectionState) => void>;
  readonly runListeners: Map<string, Set<(steps: SessionEvent[]) => void>>;
  reading: { during: SessionEvent[]; again: boolean } | undefined;
}

/** One current log per observed session. Server-projected trajectories are retained until invalidated by live deltas. */
export class SessionLogs {
  private readonly logs = new Map<string, Log>();
  private stop: (() => void) | undefined;

  private readonly read: (id: string) => Promise<SessionEvent[] | SessionEventPage>;
  private readonly follow: (event: (e: LiveEvent) => void, connected: () => void) => () => void;
  constructor(read: (id: string) => Promise<SessionEvent[] | SessionEventPage>, follow: (event: (e: LiveEvent) => void, connected: () => void) => () => void) {
    this.read = read;
    this.follow = follow;
  }

  private ensureLog(id: string): { readonly log: Log; readonly isFirst: boolean } {
    let log = this.logs.get(id);
    const hadSubscribers = log ? log.listeners.size > 0 || log.runListeners.size > 0 : false;
    if (!log) {
      log = { id, steps: [], trajectory: undefined, byRun: new Map(), listeners: new Set(), runListeners: new Map(), reading: undefined };
      this.logs.set(id, log);
    }
    return { log, isFirst: !hadSubscribers };
  }

  private ensureFollow() {
    this.stop ??= this.follow(
      (event) => {
        if (event.type !== "event") return;
        const current = this.logs.get(event.id);
        if (!current) return;
        if (current.reading) current.reading.during = mergeSteps(current.reading.during, [event.activity]);
        this.applyActivity(current, event.activity);
      },
      () => {
        for (const current of this.logs.values()) void this.refresh(current);
      },
    );
  }

  private dropIfIdle(id: string, log: Log) {
    if (log.listeners.size > 0 || log.runListeners.size > 0) return;
    this.logs.delete(id);
    if (this.logs.size === 0) {
      this.stop?.();
      this.stop = undefined;
    }
  }

  subscribe(id: string, listener: (steps: SessionEvent[]) => void): () => void {
    return this.subscribeProjection(id, (state) => listener(state.steps));
  }

  subscribeProjection(id: string, listener: (state: SessionProjectionState) => void): () => void {
    const { log, isFirst } = this.ensureLog(id);
    log.listeners.add(listener);
    listener(log.trajectory ? { steps: log.steps, trajectory: log.trajectory } : { steps: log.steps });
    this.ensureFollow();
    if (isFirst) void this.refresh(log);
    return () => {
      log.listeners.delete(listener);
      this.dropIfIdle(id, log);
    };
  }

  subscribeRun(id: string, run: string, listener: (steps: SessionEvent[]) => void): () => void {
    const { log, isFirst } = this.ensureLog(id);
    let set = log.runListeners.get(run);
    if (!set) {
      set = new Set();
      log.runListeners.set(run, set);
    }
    set.add(listener);
    listener(log.byRun.get(run) ?? emptySteps);
    this.ensureFollow();
    if (isFirst) void this.refresh(log);
    return () => {
      const listeners = log.runListeners.get(run);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) log.runListeners.delete(run);
      }
      this.dropIfIdle(id, log);
    };
  }

  private notifyListeners(log: Log) {
    const state: SessionProjectionState = log.trajectory ? { steps: log.steps, trajectory: log.trajectory } : { steps: log.steps };
    for (const listener of log.listeners) listener(state);
  }

  private applyActivity(log: Log, activity: SessionEvent) {
    const prevHead = log.steps[0];
    const nextSteps = mergeSteps(log.steps, [activity]);
    if (stepsEqual(log.steps, nextSteps)) return;
    const evictedHead = log.steps.length >= stepLimit && prevHead !== undefined && nextSteps[0]?.seq !== prevHead.seq;
    log.steps = nextSteps;
    log.trajectory = projectTrajectory(nextSteps, nextSteps.at(-1)?.time ?? 0);
    this.notifyListeners(log);

    if (log.runListeners.size === 0) {
      log.byRun = groupByRun(nextSteps);
      return;
    }
    if (!evictedHead && activity.run !== undefined) {
      const prevSlice = log.byRun.get(activity.run) ?? emptySteps;
      const nextSlice = mergeSteps(prevSlice, [activity]);
      if (!stepsEqual(prevSlice, nextSlice)) {
        log.byRun.set(activity.run, nextSlice);
        const set = log.runListeners.get(activity.run);
        if (set) for (const listener of set) listener(nextSlice);
      }
      return;
    }
    this.reconcileByRun(log, nextSteps);
  }

  private reconcileByRun(log: Log, nextSteps: SessionEvent[]) {
    const nextByRun = groupByRun(nextSteps);
    for (const [run, set] of log.runListeners) {
      const prevSlice = log.byRun.get(run) ?? emptySteps;
      const nextSlice = nextByRun.get(run) ?? emptySteps;
      if (!stepsEqual(prevSlice, nextSlice)) {
        for (const listener of set) listener(nextSlice);
      }
    }
    log.byRun = nextByRun;
  }

  private publish(log: Log, steps: SessionEvent[], trajectory: SessionTrajectoryProjection | undefined) {
    if (stepsEqual(log.steps, steps) && log.trajectory === trajectory) return;
    log.steps = steps;
    log.trajectory = trajectory;
    this.notifyListeners(log);
    this.reconcileByRun(log, steps);
  }

  private async refresh(log: Log): Promise<void> {
    if (log.reading) {
      log.reading.again = true;
      return;
    }
    const reading: NonNullable<Log["reading"]> = { during: [], again: false };
    log.reading = reading;
    try {
      const page = await this.read(log.id);
      if (this.logs.get(log.id) !== log) return;
      const snapshot = Array.isArray(page) ? page : page.events;
      const merged = mergeSteps(snapshot, reading.during);
      const trajectory = !Array.isArray(page) && reading.during.length === 0 ? page.trajectory : projectTrajectory(merged, merged.at(-1)?.time ?? 0);
      this.publish(log, merged, trajectory);
    } catch (e) {
      // The query retries a failed read. Keep the received steps.
      if (!(e instanceof Error)) throw e;
    } finally {
      log.reading = undefined;
      if (reading.again && this.logs.get(log.id) === log) void this.refresh(log);
    }
  }
}

export { emptyProjectionState };
