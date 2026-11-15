import type { FailedTurn, FailureClass, TurnOutcome } from "@botiverse/oar";
import { failureAdvice } from "@botiverse/oar/observe";

import { list, maybe, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { clip, slice } from "#/base/clip.ts";
import { checksFromText, questionsFromText, type CriterionCheck } from "#/base/questions.ts";

import type { IssueReport } from "./shapes.ts";

const summaryMax = 160;

export const handsToUser = (report: IssueReport | undefined) =>
  report !== undefined && (!report.prSubmit || report.questions.length > 0 || report.checks.some((check) => check.result !== "met"));

/** A turn that completed while background tasks still run, and that does not hand the work to the user, waits for
 * them (settling) before it is reported. */
export const settlesFirst = (completed: boolean, declared: IssueReport | undefined, pendingTasks: number) =>
  completed && !handsToUser(declared) && pendingTasks > 0;

/** A completed turn whose policy allows resting and that does not hand work to the user rests: it waits on outside
 * events, not on the user. */
export const restsAfter = (completed: boolean, restAfterTurn: boolean, declared: IssueReport | undefined) =>
  completed && restAfterTurn && !handsToUser(declared);

export function failureText(f: FailedTurn): string {
  const advice = failureAdvice(f.failure);
  const next = advice.userAction
    ? t("server.session.failureNext.userAction")
    : advice.retry === "now"
      ? t("server.session.failureNext.now")
      : advice.retry === "later"
        ? t("server.session.failureNext.later")
        : "";
  const reason = slice(f.reason.replace(/\s+/gu, " ").trim(), 0, 200);
  let out = maybe(`server.session.failure.${f.failure}`) ?? t("server.session.failure.unknown");
  if (f.status !== undefined) out += t("server.session.failureStatus", { status: f.status });
  if (reason) out += t("server.session.failureReason", { reason });
  if (next) out += t("server.session.failureThen", { next });
  return out;
}

function conclusion(text: string, min: number): string {
  const blocks = text.trim().split(/\n{2,}/u);
  let tail = "";
  for (let i = blocks.length - 1; i >= 0 && tail.length < min; i--) {
    const block = blocks[i] ?? "";
    tail = tail ? block + "\n\n" + tail : block;
  }
  return tail;
}

/** What an undeclared report says in short. Questions may also come from its question lines. */
export const summaryOf = (text: string) => conclusion(text, 80);

/** A pull request's description: the verdict, else the whole reply. */

/** Said out loud on the farm, not only in the report. */
const needsYou = new Set<FailureClass>(["auth", "billing", "quota", "model_unavailable"]);

const outcomeOf = (o: TurnOutcome): T.Outcome => (o.kind === "completed" ? "completed" : o.kind === "aborted" ? "interrupted" : "failed");

interface SessionRead {
  readonly outcome: T.Outcome;
  readonly text: string;
  readonly summary: string;
  readonly failure: string;
  readonly needsYou: boolean;
  /** Explicit issue_report questions. */
  readonly questions: T.Question[];
  /** Explicit issue_report criterion checks. */
  readonly checks: CriterionCheck[];
}

export function readReport(outcome: TurnOutcome, said: string): SessionRead {
  const out = outcomeOf(outcome);
  const failed = outcome.kind === "failed" ? failureText(outcome) : "";
  const text = said.trim();
  // A failed run leads with why it failed; what the session said before that follows.
  const whole = failed && text ? failed + "\n\n" + text : failed || text;
  const summary = failed || summaryOf(text) || (out === "completed" ? t("server.session.done") : t("server.session.unfinished"));
  return {
    outcome: out,
    text: whole,
    summary: clip(summary, summaryMax),
    failure: failed,
    needsYou: outcome.kind === "failed" && needsYou.has(outcome.failure),
    questions: questionsFromText(text),
    checks: checksFromText(text),
  };
}

export const tokensOf = (u: { input: number; cacheRead: number; output: number }): T.EventTokens => ({
  input: u.input,
  cacheRead: u.cacheRead,
  output: u.output,
});

/** Groups of three digits, split by a space: 41 200. */
const digits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");

/** changed is a prefix_changed's parts, none when the prompt's start was as before. */
export function usageText(tokens: T.EventTokens, changed: readonly string[] = []): string {
  const prompt = tokens.cacheRead + tokens.input;
  let text =
    prompt > 0
      ? t("server.session.usage.cached", {
          percent: Math.trunc((tokens.cacheRead * 100) / prompt),
          read: digits(tokens.cacheRead),
          missed: digits(tokens.input),
          output: digits(tokens.output),
        })
      : t("server.session.usage.unread", { output: digits(tokens.output) });
  // As the brain's prefix_changed names the parts.
  if (changed.length > 0) text += t("server.session.usage.changed", { parts: list(changed.map((n) => maybe(`server.session.usage.parts.${n}`) ?? n)) });
  return text;
}

const spanText = (ms: number) =>
  ms < 60_000 ? t("shared.seconds", { n: Math.max(1, Math.round(ms / 1000)) }) : t("shared.minutes", { n: Math.round(ms / 60_000) });

type Retry = NonNullable<Extract<T.Phase, { _tag: "working" }>["retry"]>;
type Conflict = NonNullable<T.Issue["conflict"]>;

export type Need =
  | { readonly kind: "quiet"; readonly since: number }
  | { readonly kind: "retrying"; readonly retry: Retry }
  | { readonly kind: "conflict"; readonly conflict: Conflict }
  | { readonly kind: "review" }
  | { readonly kind: "fix" };

export function needOf(h: T.Session, conflict?: Conflict): Need | undefined {
  const p = h.phase;
  switch (p._tag) {
    case "working":
      if (p.quietSince !== undefined) return { kind: "quiet", since: p.quietSince };
      if (p.retry !== undefined) return { kind: "retrying", retry: p.retry };
      return undefined;
    case "done":
      return conflict ? { kind: "conflict", conflict } : { kind: "review" };
    case "failed":
      return { kind: "fix" };
    case "resting":
      return conflict ? { kind: "conflict", conflict } : undefined;
    default:
      return undefined;
  }
}

/** The span placeholder in phaseWords. */
const phaseSpan = "{span}";

/** phaseWords as said at now. */
export function phaseText(h: T.Session, now: number, conflict?: Conflict): string {
  const said = phaseWords(h, conflict);
  const need = needOf(h, conflict);
  return need?.kind === "quiet" ? said.replaceAll(phaseSpan, spanText(now - need.since)) : said;
}

/** What a session is doing in words, how long it has been quiet left as {span}. */
export function phaseWords(h: T.Session, conflict?: Conflict): string {
  const need = needOf(h, conflict);
  const conflictWords = need?.kind === "conflict" ? t("shared.phase.conflict", { base: need.conflict.base, files: list(need.conflict.files) }) : "";
  const p = h.phase;
  switch (p._tag) {
    case "working": {
      const action = t(`shared.action.${p.doing.action}`);
      const what = p.doing.label !== "" ? t("shared.phase.workingOn", { action, label: p.doing.label }) : t("shared.phase.working", { action });
      if (need?.kind === "quiet") return t("shared.phase.quiet", { what, span: phaseSpan });
      if (need?.kind === "retrying")
        return need.retry.of != null && need.retry.of !== 0
          ? t("shared.phase.retryingOf", { what, attempt: need.retry.attempt, of: need.retry.of })
          : t("shared.phase.retrying", { what, attempt: need.retry.attempt });
      return what;
    }
    case "done":
      return t("shared.phase.done", { conflict: conflictWords });
    case "failed":
      return t("shared.phase.failed");
    case "resting": {
      // No last run is a session that has not finished one yet (a new orchestrator), not one that broke off.
      const outcome = h.lastRun?.outcome;
      return outcome === undefined
        ? t("shared.phase.rested", { conflict: conflictWords })
        : t("shared.phase.resting", { last: t(`shared.outcome.${outcome}`), conflict: conflictWords });
    }
    default:
      return "";
  }
}
