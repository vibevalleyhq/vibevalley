import { z } from "zod";
// A session's log by run, the work log's words and colours, the trajectory's waterfall and totals, how steps arriving live merge in (mergeSteps), and the log kept per observed session (SessionLogs).

import { t } from "@vibevalley/i18n";
import type { LiveEvent, SessionEvent } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";
import { jsonString } from "@vibevalley/protocol/schema";

import { big, tookText } from "../../infra/base/format";

/** The steps kept for one session's log in the page. */
const stepLimit = 240;
const emptySteps: SessionEvent[] = [];

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

/** By seq and revision, independent of HTTP/live arrival order; the last stepLimit kept. */
export function mergeSteps(log: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  if (incoming.length === 0) return log;
  if (incoming.length === 1) {
    const s = incoming[0];
    if (s === undefined) return log;
    const last = log.at(-1);
    if (!last) return [s];
    if (s.seq > last.seq) {
      if (log.length >= stepLimit) return [...log.slice(log.length - stepLimit + 1), s];
      return [...log, s];
    }
    if (s.seq === last.seq) {
      if (s.revision <= last.revision) return log;
      const next = log.slice();
      next[next.length - 1] = s;
      return next;
    }
  }
  const bySeq = new Map(log.map((s) => [s.seq, s]));
  for (const s of incoming) {
    const before = bySeq.get(s.seq);
    if (!before || s.revision > before.revision) bySeq.set(s.seq, s);
  }
  const all = [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
  return all.length > stepLimit ? all.slice(all.length - stepLimit) : all;
}

/** A call with its result's output and ok; the results and the run bounds left out (each step carries its run). */
export function shownEvents(log: SessionEvent[]): SessionEvent[] {
  const results = new Map<number, SessionEvent>();
  for (const e of log) if (e.type === "tool/result" && e.call !== undefined) results.set(e.call, e);
  return log.flatMap((e) => {
    const result = e.type === "tool/call" ? results.get(e.seq) : undefined;
    if (result) return [omitUndefined({ ...e, output: result.output, ok: result.ok })];
    if (e.type === "tool/result" || e.type === "run/start" || e.type === "run/end") return [];
    return [e];
  });
}

/** One of the server's runs as the log shows it; the steps it heard after the first are among its steps. */
export interface RunView {
  /** Undefined for steps outside every run (a log whose start was dropped). */
  run?: string;
  /** The first top-level message it heard, when the run opens with one. */
  asked?: SessionEvent;
  steps: SessionEvent[];
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

/** Split where the server's run changes, never at a message: a run that heard several is one view. A sub-agent's
 * steps carry the run of the call they are under. */
export function runsOf(steps: SessionEvent[]): RunView[] {
  const views: RunView[] = [];
  for (const s of steps) {
    let view = views.at(-1);
    if (!view || view.run !== s.run) {
      view = omitUndefined({ run: s.run, steps: [] });
      views.push(view);
    }
    if (!view.asked && view.steps.length === 0 && s.type === "user/message" && s.under === undefined) view.asked = s;
    else view.steps.push(s);
  }
  return views;
}

interface Span {
  step: SessionEvent;
  ms: number;
}

/** Each step lasts until the next one starts. the last until `end` (now, while the run goes on. */
export function spansOf(r: RunView, end: number): Span[] {
  const all = allOf(r);
  return all.map((s, i) => ({ step: s, ms: Math.max(0, (all[i + 1]?.time ?? end) - s.time) }));
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

const CommandInput = jsonString(z.object({ command: z.exactOptional(z.string()) }));
const JsonObjectInput = jsonString(z.record(z.string(), z.unknown()));

/** A call's input as it reads best: a command as `$ …`, JSON indented, anything else as it came. */
export function readableInput(step: SessionEvent) {
  const raw = step.input?.trim() ?? "";
  if (!raw) return "";
  const obj = JsonObjectInput.safeParse(raw);
  if (obj.success) {
    const cmd = CommandInput.safeParse(raw);
    if (cmd.success && cmd.data.command !== undefined) return `$ ${cmd.data.command}`;
    return JSON.stringify(obj.data, null, 2);
  }
  return raw;
}

/** What started a run, as its fold says it: the first word is the issue, later ones are words carried to it. */
export function runTitle(r: RunView, firstAsked: number | undefined, asked?: string) {
  const a = r.asked;
  if (!a) return r.run === undefined ? t("web.session.runs.earlier") : t("web.session.runs.unasked");
  return asked ?? (a.seq === firstAsked ? t("web.session.runs.issue") : t("web.session.runs.told"));
}

/** Folded to `lines` when longer. */
export const isLongText = (text: string, lines: number) => text.length > lines * 60 || text.split("\n").length > lines;

/** The line under a message for the run behind it, or undefined with none to show: a orchestrator's run only when it used tools. */
export function runLabel(steps: SessionEvent[], orchestrator: boolean) {
  const tools = steps.filter((s) => s.type === "tool/call").length;
  if (steps.length === 0 || (orchestrator && tools === 0)) return undefined;
  // The orchestrator's run, folded: how long it thought and what it used.
  const first = steps.at(0);
  const last = steps.at(-1);
  const took = orchestrator && first && last && steps.length > 1 ? last.time - first.time : undefined;
  if (took !== undefined && took >= 1000) return t("web.session.runs.thoughtFor", { took: tookText(took), n: tools });
  return tools > 0 ? t("web.session.runs.usedTools", { n: tools }) : t("web.session.runs.process");
}

export type Lane = "asked" | "model" | "tool";

export const lanes: readonly Lane[] = ["asked", "model", "tool"];

/** A stretch of one lane of the waterfall; `seq` is the shown row it opens. */
interface LaneSpan {
  readonly lane: Lane;
  readonly start: number;
  readonly end: number;
  readonly seq: number;
}

interface Waterfall {
  /** Each run's first and last time: the idle time between runs is not drawn. */
  readonly runs: readonly (readonly [number, number])[];
  readonly spans: readonly LaneSpan[];
}

const WATERFALL_RATIO_THRESHOLD = 8;
const WATERFALL_MIN_RUN_PX = 44;

/** Allocates horizontal pixel widths for waterfall runs; dampens extreme duration ratios so short runs remain legible. */
export function waterfallWidths(durations: readonly number[], room: number): number[] {
  if (room <= 0 || durations.length === 0) return [];
  const safe = durations.map((d) => (Number.isFinite(d) && d > 0 ? d : 0));
  const total = safe.reduce((sum, d) => sum + d, 0);
  if (total <= 0) return safe.map(() => room / safe.length);

  const positive = safe.filter((d) => d > 0);
  const minPos = Math.min(...positive);
  const maxPos = Math.max(...positive);
  if (maxPos / minPos <= WATERFALL_RATIO_THRESHOLD) {
    return safe.map((d) => (room * d) / total);
  }

  const minRunPx = Math.min(WATERFALL_MIN_RUN_PX, room / safe.length);
  const extraRoom = room - positive.length * minRunPx;
  const weights = safe.map((d) => (d > 0 ? Math.sqrt(d) : 0));
  const weightTotal = weights.reduce((sum, w) => sum + w, 0);
  return safe.map((d, i) => (d > 0 ? minRunPx + (extraRoom * (weights[i] ?? 0)) / weightTotal : 0));
}

/** Lanes from the times the log already has. a step's time is when it began. */
export function waterfallOf(log: readonly SessionEvent[], end: number): Waterfall {
  const top = log.filter((e) => e.under === undefined && e.type !== "run/start" && e.type !== "run/end");
  const groups = runsOf(top).map(allOf);
  const runs: [number, number][] = [];
  const spans: LaneSpan[] = [];
  groups.forEach((steps, g) => {
    const first = steps.at(0);
    const last = steps.at(-1);
    if (!first || !last) return;
    const from = first.time;
    const to = g === groups.length - 1 && end > last.time ? end : last.time;
    runs.push([from, to]);
    const calls = new Map<number, number>();
    let waiting = from;
    let open: [number, number] | undefined;
    let prev = from;
    const close = (at: number) => {
      if (open) spans.push({ lane: "model", start: open[0], end: at < open[0] ? open[0] : at, seq: open[1] });
      open = undefined;
    };
    steps.forEach((e, i) => {
      switch (e.type) {
        case "user/message":
          spans.push({ lane: "asked", start: e.time, end: steps[i + 1]?.time ?? to, seq: e.seq });
          waiting = e.time;
          break;
        case "assistant/thinking":
        case "assistant/message":
        case "tool/call":
          open ??= [waiting, e.seq];
          if (e.type === "tool/call") calls.set(e.seq, e.time);
          break;
        case "llm/usage":
          close(e.time);
          waiting = e.time;
          break;
        case "tool/result":
          close(prev);
          if (e.call !== undefined && calls.has(e.call)) {
            spans.push({ lane: "tool", start: calls.get(e.call) ?? e.time, end: e.time, seq: e.call });
            calls.delete(e.call);
          }
          waiting = e.time;
          break;
        case "memory/recalled":
          if (!open) waiting = e.time;
          break;
        case "run/error":
          close(e.time);
          waiting = e.time;
          break;
        case "llm/retry":
        case "permission/request":
        case "permission/resolved":
        case "interaction/request":
        case "interaction/resolved":
        case "run/end":
        case "run/start":
          break;
      }
      prev = e.time;
    });
    close(to);
    for (const [seq, start] of calls) spans.push({ lane: "tool", start, end: to, seq });
  });
  return { runs, spans };
}

export interface TrajectorySummary {
  readonly runs: number;
  readonly steps: number;
  readonly modelMs: number;
  readonly toolMs: number;
  /** The prompt's tokens not read from the cache, as llm/usage counts them. */
  readonly input: number;
  readonly cacheRead: number;
  readonly output: number;
}

/** The footer's numbers: rows other than llm/usage are steps; tokens are every llm/usage's, a sub-agent's too. */
export function summaryOf(log: SessionEvent[], end: number): TrajectorySummary {
  const shown = shownEvents(log);
  const fall = waterfallOf(log, end).spans;
  const sum = (lane: Lane) => fall.filter((s) => s.lane === lane).reduce((n, s) => n + (s.end - s.start), 0);
  let input = 0;
  let cacheRead = 0;
  let output = 0;
  for (const e of log)
    if (e.tokens) {
      input += Math.round(e.tokens.input);
      cacheRead += Math.round(e.tokens.cacheRead);
      output += Math.round(e.tokens.output);
    }
  return {
    runs: runsOf(shown).length,
    steps: shown.filter((e) => e.type !== "llm/usage").length,
    modelMs: sum("model"),
    toolMs: sum("tool"),
    input,
    cacheRead,
    output,
  };
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
  byRun: Map<string, SessionEvent[]>;
  readonly listeners: Set<(steps: SessionEvent[]) => void>;
  readonly runListeners: Map<string, Set<(steps: SessionEvent[]) => void>>;
  reading: { during: SessionEvent[]; again: boolean } | undefined;
}

/** One current log per observed session. Snapshots replace the retained window. */
export class SessionLogs {
  private readonly logs = new Map<string, Log>();
  private stop: (() => void) | undefined;

  private readonly read: (id: string) => Promise<SessionEvent[]>;
  private readonly follow: (event: (e: LiveEvent) => void, connected: () => void) => () => void;
  constructor(read: (id: string) => Promise<SessionEvent[]>, follow: (event: (e: LiveEvent) => void, connected: () => void) => () => void) {
    this.read = read;
    this.follow = follow;
  }

  private ensureLog(id: string): { readonly log: Log; readonly isFirst: boolean } {
    let log = this.logs.get(id);
    const hadSubscribers = log ? log.listeners.size > 0 || log.runListeners.size > 0 : false;
    if (!log) {
      log = { id, steps: [], byRun: new Map(), listeners: new Set(), runListeners: new Map(), reading: undefined };
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
    const { log, isFirst } = this.ensureLog(id);
    log.listeners.add(listener);
    listener(log.steps);
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

  private applyActivity(log: Log, activity: SessionEvent) {
    const prevHead = log.steps[0];
    const nextSteps = mergeSteps(log.steps, [activity]);
    if (stepsEqual(log.steps, nextSteps)) return;
    const evictedHead = log.steps.length >= stepLimit && prevHead !== undefined && nextSteps[0]?.seq !== prevHead.seq;
    log.steps = nextSteps;
    for (const listener of log.listeners) listener(nextSteps);

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

  private publish(log: Log, steps: SessionEvent[]) {
    if (stepsEqual(log.steps, steps)) return;
    log.steps = steps;
    for (const listener of log.listeners) listener(steps);
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
      const snapshot = await this.read(log.id);
      if (this.logs.get(log.id) === log) this.publish(log, mergeSteps(snapshot, reading.during));
    } catch (e) {
      // The query retries a failed read. Keep the received steps.
      if (!(e instanceof Error)) throw e;
    } finally {
      log.reading = undefined;
      if (reading.again && this.logs.get(log.id) === log) void this.refresh(log);
    }
  }
}
