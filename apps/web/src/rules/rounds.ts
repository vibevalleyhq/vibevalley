// A session's log by round (shownEvents, roundsOf, spansOf, roundMs), the work log's words and colours, the trajectory's
// waterfall and totals, and how steps arriving live merge in (mergeSteps).

import type { SessionEvent } from "@vibevalley/protocol";
import { tookText } from "./time";

/** The steps kept for one session's log in the page. */
export const stepLimit = 240;

/** By seq, the newer copy of a step winning; the last stepLimit kept. */
export function mergeSteps(log: SessionEvent[], incoming: SessionEvent[]) {
  const bySeq = new Map(log.map((s) => [s.seq, s]));
  for (const s of incoming) bySeq.set(s.seq, s);
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return all.length > stepLimit ? all.slice(all.length - stepLimit) : all;
}

/** A call with its result's output and ok; the results and the run bounds left out (a run is where the rounds split). */
export function shownEvents(log: SessionEvent[]): SessionEvent[] {
  const results = new Map<number, SessionEvent>();
  for (const e of log) if (e.type === "tool/result" && e.call !== undefined) results.set(e.call, e);
  return log.flatMap((e) => {
    const result = e.type === "tool/call" ? results.get(e.seq) : undefined;
    if (result) return [{ ...e, output: result.output, ok: result.ok }];
    if (e.type === "tool/result" || e.type === "run/start" || e.type === "run/end") return [];
    return [e];
  });
}

export interface Round {
  /** Undefined for steps before the first word (a log whose start was dropped). */
  asked?: SessionEvent;
  steps: SessionEvent[];
}

/** The last top-level thing it said, if any. */
export function answerOf(r: Round) {
  for (let i = r.steps.length - 1; i >= 0; i--) {
    const s = r.steps[i]!;
    if (s.type === "assistant/message" && s.under === undefined) return s;
  }
  return undefined;
}

const allOf = (r: Round) => (r.asked ? [r.asked, ...r.steps] : r.steps);

/** A sub-agent's told steps are part of the call. */
export function roundsOf(steps: SessionEvent[]): Round[] {
  const rounds: Round[] = [];
  let asked: SessionEvent | undefined;
  let current: SessionEvent[] = [];
  for (const s of steps) {
    if (s.type === "user/message" && s.under === undefined) {
      if (asked || current.length) rounds.push({ asked, steps: current });
      asked = s;
      current = [];
    } else current.push(s);
  }
  if (asked || current.length) rounds.push({ asked, steps: current });
  return rounds;
}

export interface Span {
  step: SessionEvent;
  ms: number;
}

/** Each step lasts until the next one starts; the last until `end` (now, while the round goes on; else its own start). */
export function spansOf(r: Round, end: number): Span[] {
  const all = allOf(r);
  return all.map((s, i) => ({ step: s, ms: Math.max(0, (i + 1 < all.length ? all[i + 1]!.time : end) - s.time) }));
}

export function roundMs(r: Round, end: number) {
  const first = allOf(r)[0];
  return first ? Math.max(0, end - first.time) : 0;
}

export const lastTime = (r: Round) => allOf(r).at(-1)?.time;

export function farmToolText(text: string) {
  const m = /^vibevalley__(channel_say|channel_read|channel_inbox|session_list)/.exec(text.trim())?.[1];
  switch (m) {
    case undefined:
      return undefined;
    case "channel_say":
      return "在田头说话";
    case "channel_read":
      return "读田头的消息";
    case "channel_inbox":
      return "看有没有找它的话";
    case "session_list":
      return "看田头上都有谁";
    default:
      return `田头：${m}`;
  }
}

export function spanLabel(step: SessionEvent) {
  switch (step.type) {
    case "user/message":
      return "收到";
    case "memory/recalled":
      return "想起";
    case "assistant/thinking":
      return "思考";
    case "assistant/message":
      return "说";
    case "llm/retry":
      return "重试";
    case "llm/usage":
      return "缓存";
    case "run/error":
      return "出错";
    case "run/start":
    case "run/end":
    case "tool/result":
      return "";
    case "tool/call":
      return farmToolText(step.text) ? "田头" : (step.actionText ?? "工具");
  }
}

/** The palette's colours. */
export function spanColor(step: SessionEvent) {
  switch (step.type) {
    case "user/message":
      return "#e5a93c";
    case "memory/recalled":
      return "#b4cb7c";
    case "assistant/thinking":
      return "#c8a46e";
    case "assistant/message":
      return "#74a046";
    case "llm/retry":
    case "llm/usage":
      return "#efb84e";
    case "run/error":
      return "#c84a3a";
    case "run/start":
    case "run/end":
    case "tool/result":
      return "#e2c995";
    case "tool/call":
      if (step.ok === false) return "#c84a3a";
      switch (step.action ?? "other") {
        case "read_file":
        case "search":
        case "web":
          return "#4f8fbd";
        case "edit_file":
          return "#3f6427";
        case "run_command":
          return "#67482d";
        case "wait":
          return "#e2c995";
        case "mcp":
        case "other":
          return "#9b7550";
      }
  }
}

/** A call's input as it reads best: a command as `$ …`, JSON indented, anything else as it came. */
export function readableInput(step: SessionEvent) {
  const raw = step.input?.trim() ?? "";
  if (!raw) return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const command = (parsed as { command?: unknown }).command;
      if (!Array.isArray(parsed) && typeof command === "string") return `$ ${command}`;
      return JSON.stringify(parsed, null, 2);
    }
  } catch {
    // Not JSON (or clipped): shown as it came.
  }
  return raw;
}

/** What started a round, as its fold says it: the first word is the issue, later ones are words carried to it. */
export function roundLabel(r: Round, firstAsked: number | undefined, asked?: string) {
  const a = r.asked;
  if (!a) return "更早的步骤";
  if (a.under !== undefined) return "帮手接到";
  return asked ?? (a.seq === firstAsked ? "工单" : "带话");
}

/** Folded to `lines` when longer. */
export const isLongText = (text: string, lines: number) => text.length > lines * 60 || text.split("\n").length > lines;

/** The line under a message for the run behind it, or undefined with none to show: a orchestrator's run only when it used tools. */
export function turnLabel(steps: SessionEvent[], orchestrator: boolean) {
  const tools = steps.filter((s) => s.type === "tool/call").length;
  if (steps.length === 0 || (orchestrator && tools === 0)) return undefined;
  return tools > 0 ? `用了 ${tools} 个工具` : "这一轮的干活过程";
}

export type Lane = "asked" | "model" | "tool";

export const lanes: readonly Lane[] = ["asked", "model", "tool"];

/** A stretch of one lane of the waterfall; `seq` is the shown row it opens. */
export interface LaneSpan {
  readonly lane: Lane;
  readonly start: number;
  readonly end: number;
  readonly seq: number;
}

export interface Waterfall {
  /** Each round's first and last time: the idle time between rounds is not drawn. */
  readonly rounds: readonly (readonly [number, number])[];
  readonly spans: readonly LaneSpan[];
}

/** Lanes from the times the log already has; a step's time is when it began. A
 * model answer runs from what it answered (the message, a tool's result) to its llm/usage, or, with none, to the last
 * step before what stops it; a tool from its call to its result. `end` is where the last round stops (now, while it goes
 * on). */
export function waterfallOf(log: readonly SessionEvent[], end: number): Waterfall {
  const top = log.filter((e) => e.under === undefined && e.type !== "run/start" && e.type !== "run/end");
  const groups: SessionEvent[][] = [];
  for (const e of top) {
    if (groups.length === 0 || (e.type === "user/message" && groups.at(-1)!.length > 0)) groups.push([]);
    groups.at(-1)!.push(e);
  }
  const rounds: [number, number][] = [];
  const spans: LaneSpan[] = [];
  groups.forEach((steps, g) => {
    const from = steps[0]!.time;
    const to = g === groups.length - 1 && end > steps.at(-1)!.time ? end : steps.at(-1)!.time;
    rounds.push([from, to]);
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
          spans.push({ lane: "asked", start: e.time, end: i + 1 < steps.length ? steps[i + 1]!.time : to, seq: e.seq });
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
            spans.push({ lane: "tool", start: calls.get(e.call)!, end: e.time, seq: e.call });
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
      }
      prev = e.time;
    });
    close(to);
    for (const [seq, start] of calls) spans.push({ lane: "tool", start, end: to, seq });
  });
  return { rounds, spans };
}

export interface TrajectorySummary {
  readonly rounds: number;
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
    rounds: roundsOf(shown).length,
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
export const secondsText = (ms: number) => (ms < 10000 ? `${(ms / 1000).toFixed(1)} 秒` : tookText(ms));

export const tokensText = (n: number) => (n < 10000 ? `${n}` : `${(n / 10000).toFixed(1)} 万`);

/** The part after an MCP server's prefix: `mcp__vibevalley__channel_say` is channel_say. */
export function toolName(tool: string) {
  const at = tool.lastIndexOf("__");
  return at >= 0 && at + 2 < tool.length ? tool.slice(at + 2) : tool;
}

/** The trajectory's tag for a step; `asked` names what began a round. */
export function tagOf(step: SessionEvent, asked?: string, job = false): string {
  const sub = step.under !== undefined;
  switch (step.type) {
    case "user/message":
      return sub ? "帮手接到" : (asked ?? (job ? "工单" : "带话"));
    case "memory/recalled":
      return "想起";
    case "assistant/thinking":
      return sub ? "帮手想了想" : "想了想";
    case "assistant/message":
      return sub ? "帮手说" : "它说";
    case "llm/retry":
      return "重试";
    case "llm/usage":
      return "用量";
    case "run/error":
      return "出错";
    case "tool/call":
      if (farmToolText(step.text) !== undefined) return "田头";
      return step.tool ? toolName(step.tool) : spanLabel(step);
    case "run/start":
    case "run/end":
    case "tool/result":
      return "";
  }
}

export const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
