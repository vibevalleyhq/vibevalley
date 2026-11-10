import type { FailedTurn, FailureClass, TurnOutcome } from "@botiverse/oar";
import { failureAdvice } from "@botiverse/oar/observe";

import { list, maybe, t } from "@vibevalley/i18n";
import type { EventTokens, Question, CriterionCheck, Outcome, IssueReport } from "@vibevalley/protocol";
import { slice } from "@vibevalley/protocol/rules";

import { clip } from "#/base/clip.ts";
import { checksFromText, questionsFromText } from "#/base/questions.ts";

const summaryMax = 160;

export const handsToUser = (report: IssueReport | undefined) =>
  report !== undefined && (!report.prSubmit || report.questions.length > 0 || report.checks.some((check) => check.result !== "met"));

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

const outcomeOf = (o: TurnOutcome): Outcome => (o.kind === "completed" ? "completed" : o.kind === "aborted" ? "interrupted" : "failed");

interface SessionRead {
  readonly outcome: Outcome;
  readonly text: string;
  readonly summary: string;
  readonly failure: string;
  readonly needsYou: boolean;
  /** Explicit issue_report questions. */
  readonly questions: Question[];
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

export const tokensOf = (u: { input: number; cacheRead: number; output: number }): EventTokens => ({
  input: u.input,
  cacheRead: u.cacheRead,
  output: u.output,
});

/** Groups of three digits, split by a space: 41 200. */
const digits = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, " ");

/** changed is a prefix_changed's parts, none when the prompt's start was as before. */
export function usageText(tokens: EventTokens, changed: readonly string[] = []): string {
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
