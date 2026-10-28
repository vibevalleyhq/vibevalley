import { t } from "@vibevalley/i18n";
// A session's events read as facts and journal steps. Pure: it reads the session as
// the core state has it and the session's own bookkeeping, and changes nothing.

import { relative } from "node:path";
import type { Event, TokenTotals, ToolOutputPart } from "@botiverse/oar";
import { classifyTool, type ToolActionKind } from "@botiverse/oar/observe";
import type { FactIn } from "../core/core.ts";
import type { Session, SessionAction, SessionEventType, Spent, ToolAction, SessionId } from "@vibevalley/protocol";
import { isBusy } from "@vibevalley/protocol/rules";
import { doingOf, failureText, jobBreak, recalledIn } from "./rules.ts";
import { clip } from "../base/text.ts";
import type { Rate } from "../runtime/price.ts";
import { shellCommand } from "./shell.ts";

/** The bubble over a session's head holds about this much. */
const labelMax = 40;

/** Empty is the agent itself, else the lineage of a sub-agent it started. */
export type From = readonly string[];

export interface ToolStart {
  readonly text: string;
  readonly action: ToolAction;
  readonly tool: string;
  readonly input?: string;
}

/** What a session is tracked by between its events. */
export interface Tracking {
  /** So a later full input can fix up the bubble's label. */
  readonly shownCall?: { readonly id: string; readonly tool: string };
  /** The next report is counted from it. */
  readonly oarTokens?: TokenTotals;
  readonly rate?: Rate;
  readonly runFrom?: Spent;
  /** The next word from it ends the quiet spell. */
  readonly quiet?: boolean;
}

export interface FactContext {
  readonly id: SessionId;
  readonly runtime: string;
  readonly cwd: string;
}

export type Op =
  | { readonly type: "prompt" | "response" | "thought"; readonly text: string; readonly from?: From }
  | { readonly type: "toolStarted"; readonly callId: string; readonly start: ToolStart; readonly from?: From }
  | { readonly type: "toolInput"; readonly callId: string; readonly input: string; readonly text: string; readonly from?: From }
  | { readonly type: "toolEnded"; readonly callId: string; readonly output: string; readonly ok: boolean; readonly from?: From }
  | { readonly type: "note"; readonly kind: SessionEventType; readonly text: string; readonly from?: From };

export interface Reaction {
  readonly tracking: Tracking;
  readonly facts: FactIn[];
  readonly journal: Op[];
  readonly spentCny: number;
  readonly model: string;
  readonly warn: string;
}

const actions: Partial<Record<ToolActionKind, ToolAction>> = {
  run_command: "run_command",
  read_file: "read_file",
  edit_file: "edit_file",
  search: "search",
  web: "web",
  fetch: "web",
  mcp: "mcp",
  wait: "wait",
};

/** What was spent from from to now; undefined when nothing was counted from. */
export function since(now: Spent, from: Spent | undefined): Spent | undefined {
  if (!from) return undefined;
  return { tokens: now.tokens - from.tokens, ...(now.cny !== undefined ? { cny: now.cny - (from.cny ?? 0) } : {}) };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The bubble has no room for the rest: `cd <worktree> && pnpm test` is shown as what it runs. */
export function near(cwd: string, detail: string): string {
  if (detail.startsWith("/") && !detail.includes(" ")) {
    const rel = relative(cwd, detail);
    return rel.startsWith("..") ? detail : rel || ".";
  }
  return detail.replace(new RegExp(`^cd ${escape(cwd)}/? *(&&|;) *`), "").replaceAll(cwd + "/", "");
}

const toolOutput = (content: readonly ToolOutputPart[] = []) =>
  content.flatMap((part) => (part.type === "text" ? (part.text ? [part.text] : []) : part.type === "image" ? [t("server.session.log.image")] : [])).join("\n");

function label(runtime: string, tool: string, input: string | undefined, cwd: string) {
  const action = classifyTool(runtime, tool, input);
  let detail = action.detail || "";
  if (action.kind === "run_command" && detail) detail = shellCommand(detail);
  return { kind: action.kind, detail: detail ? near(cwd, detail) : "" };
}

export function eventFacts(event: Event, session: Session | undefined, tracking: Tracking, ctx: FactContext): Reaction {
  const id = ctx.id;
  const facts: FactIn[] = [];
  let journal: Op[] = [];
  let next: Tracking = tracking;
  let spentCny = 0;
  let model = "";
  let warn = "";
  const working = session?.phase._tag === "working" ? session.phase : undefined;

  // A fact only when something changed.
  const doing = (action: SessionAction, text: string) => {
    if (!working || (working.doing.action === action && working.doing.label === text)) return;
    facts.push({ type: "doing", id, action, label: text });
  };

  // Any word from it ends a quiet spell: the same doing again says so.
  if (tracking.quiet && event.kind !== "usage") {
    next = { ...next, quiet: false };
    if (working) facts.push({ type: "doing", id, action: working.doing.action, label: working.doing.label });
  }

  switch (event.kind) {
    case "turn_started": {
      next = { ...next, runFrom: session?.spent ? { ...session.spent } : { tokens: 0 } };
      // A prompt-mode persona and what the turn is reminded of ride on top of the input: the panel shows the job itself,
      // then what was recalled.
      const at = event.input.lastIndexOf(jobBreak);
      journal.push({ type: "prompt", text: at >= 0 ? event.input.slice(at + jobBreak.length) : event.input });
      const recalled = recalledIn(event.input);
      if (recalled) journal.push({ type: "note", kind: "memory/recalled", text: recalled });
      facts.push({ type: "run", id });
      break;
    }
    case "reasoning":
      doing("thinking", "");
      if (event.content.kind === "text" && event.content.text) journal.push({ type: "thought", text: event.content.text });
      break;
    case "tool_call_started": {
      const { kind, detail } = label(ctx.runtime, event.tool, event.input, ctx.cwd);
      const action = actions[kind] ?? "other";
      const text = detail || event.tool;
      next = { ...next, shownCall: { id: event.callId, tool: event.tool } };
      journal.push({
        type: "toolStarted",
        callId: event.callId,
        start: { text, action, tool: event.tool, ...(event.input !== undefined ? { input: event.input } : {}) },
      });
      doing(action, clip(text, labelMax));
      break;
    }
    case "tool_call_input": {
      // The complete input arrives later on some runtimes (claude); it names the target better.
      const shown = tracking.shownCall;
      const detail = shown && event.callId === shown.id ? label(ctx.runtime, shown.tool, event.input, ctx.cwd).detail : "";
      journal.push({ type: "toolInput", callId: event.callId, input: event.input, text: detail });
      if (detail && session) {
        const action = doingOf(session).action;
        if (action !== "none" && action !== "thinking" && action !== "speaking_text") doing(action, clip(detail, labelMax));
      }
      break;
    }
    case "tool_call_ended":
      journal.push({
        type: "toolEnded",
        callId: event.callId,
        output: toolOutput(event.content),
        ok: event.result !== "failed" && (event.exitCode ?? 0) === 0,
      });
      if (tracking.shownCall && event.callId === tracking.shownCall.id) doing("thinking", "");
      break;
    case "text_delta":
      journal.push({ type: "response", text: event.text });
      doing("speaking_text", "");
      break;
    case "retry": {
      const text =
        (event.maxAttempts
          ? t("server.session.log.retryOf", { attempt: event.attempt, of: event.maxAttempts })
          : t("server.session.log.retry", { attempt: event.attempt })) +
        (event.delayMs ? t("server.session.log.retryIn", { s: Math.ceil(event.delayMs / 1000) }) : "") +
        (event.reason ? t("server.session.log.retryWhy", { reason: clip(event.reason, 160) }) : "");
      journal.push({ type: "note", kind: "llm/retry", text });
      facts.push({ type: "retry", id, attempt: event.attempt, ...(event.maxAttempts ? { of: event.maxAttempts } : {}) });
      break;
    }
    case "usage": {
      // Counted from the session's last report, at its model's price.
      const tokens = event.usage.tokens;
      if (!tokens) break;
      const last = tracking.oarTokens ?? { input: 0, output: 0 };
      const delta = {
        input: Math.max(0, tokens.input - last.input),
        output: Math.max(0, tokens.output - last.output),
        cacheRead: Math.max(0, (tokens.cacheRead ?? 0) - (last.cacheRead ?? 0)),
        cacheWrite: Math.max(0, (tokens.cacheWrite ?? 0) - (last.cacheWrite ?? 0)),
      };
      next = { ...next, oarTokens: { ...tokens } };
      if (!session) break;
      const cny = tracking.rate?.charge(delta);
      const before = session.spent ?? { tokens: 0 };
      const total = before.cny !== undefined || cny !== undefined ? (before.cny ?? 0) + (cny ?? 0) : undefined;
      facts.push({ type: "spent", id, spent: { tokens: before.tokens + delta.input + delta.output, ...(total !== undefined ? { cny: total } : {}) } });
      if (cny) spentCny = cny;
      break;
    }
    case "model":
      model = event.model;
      break;
    case "turn_ended":
      if (event.outcome.kind === "failed") journal.push({ type: "note", kind: "run/error", text: failureText(event.outcome) });
      break;
    case "exited":
      if (session && isBusy(session)) {
        const why =
          event.code !== null && event.code !== undefined
            ? t("server.session.log.exitedCode", { runtime: ctx.runtime, code: event.code })
            : t("server.session.log.exited", { runtime: ctx.runtime });
        facts.push({ type: "report", id, outcome: "failed", summary: why, runs: session.runs });
        warn = t("server.session.log.exitedNotice", { name: session.name, why });
      }
      break;
    default:
      break;
  }

  // A sub-agent's steps (a claude TaskGraph, a codex sub-thread) say whose they are.
  if (event.agentPath.length > 0) journal = journal.map((op) => ({ ...op, from: [...event.agentPath] }));
  return { tracking: next, facts, journal, spentCny, model, warn };
}
