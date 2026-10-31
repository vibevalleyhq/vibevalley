// Lengths are UTF-16 units.

import type { FailedTurn, FailureClass, TurnOutcome } from "@botiverse/oar";
import { failureAdvice } from "@botiverse/oar/observe";
import { Result, Schema } from "effect";

import { maybe, t } from "@vibevalley/i18n";
import type { Question, CheckResult, CriterionCheck, IssueAnswer, Outcome } from "@vibevalley/protocol";

import { clip, slice } from "@/base/clip.ts";
import { lastJsonBlock, misfitField } from "@/base/json.ts";
import { messageOf } from "@/errors.ts";

const summaryMax = 160;

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

/** The line the farm rules ask every report to end on: 「结论：…」, perhaps bold or in a list. The markers are asked for in
 * Chinese whatever the owner's language; a model writing English may put them in English, which counts too. */
const verdict = /(?:^|\n)[\s>*#_-]*(?:\*\*)?(?:结论|Conclusion)(?:\*\*)?\s*[:：]\s*(?:\*\*)?/giu;

function conclusion(text: string, min: number): string {
  const blocks = text.trim().split(/\n{2,}/u);
  let tail = "";
  for (let i = blocks.length - 1; i >= 0 && tail.length < min; i--) tail = tail ? blocks[i] + "\n\n" + tail : blocks[i]!;
  return tail;
}

/** A report's verdict: the paragraph after its last 结论：, else empty. */
export function reportVerdict(text: string): string {
  const all = [...text.matchAll(verdict)];
  const last = all.at(-1);
  if (!last) return "";
  // The verdict's own paragraph: a note written after it is not part of it.
  const rest = text
    .slice(last.index + last[0].length)
    .replaceAll("**", "")
    .trim();
  return rest.split(/\n\s*\n/u, 1)[0]!.trim();
}

/** What a report says in short: its verdict, else its last paragraphs. */
export const summaryOf = (text: string) => reportVerdict(text) || conclusion(text, 80);

/** A pull request's description: the verdict, else the whole reply. */

/** Said out loud on the farm, not only in the report. */
const needsYou = new Set<FailureClass>(["auth", "billing", "quota", "model_unavailable"]);

const outcomeOf = (o: TurnOutcome): Outcome => (o.kind === "completed" ? "completed" : o.kind === "aborted" ? "interrupted" : "failed");

export interface SessionRead {
  readonly outcome: Outcome;
  readonly text: string;
  readonly summary: string;
  readonly failure: string;
  readonly needsYou: boolean;
  /** The 要问主人： lines: what it cannot go on without. */
  readonly questions: Question[];
  /** The 标准 N： lines: its word on each of the issue's criteria. */
  readonly checks: CriterionCheck[];
  /** The conclusion block an answer issue asks for (parseAnswer), when one can be read. */
  readonly answer?: IssueAnswer;
}

const AnswerLines = Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])));

/** The conclusion block an answer issue asks for; a conclusion that is not a string reads as none. */
const AnswerBlock = Schema.Struct({ conclusion: Schema.optional(Schema.Unknown), evidence: AnswerLines, unsure: AnswerLines, next: AnswerLines });

const answerLines = (v: (typeof AnswerBlock.Type)["evidence"]): string[] =>
  (v == null ? [] : typeof v === "string" ? [v] : v).map((l) => l.trim()).filter(Boolean);

const answerOf = (raw: typeof AnswerBlock.Type): IssueAnswer => ({
  conclusion: typeof raw.conclusion === "string" ? raw.conclusion.trim() : "",
  evidence: answerLines(raw.evidence),
  unsure: answerLines(raw.unsure),
  next: answerLines(raw.next),
});

/** The last block that reads as an answer with a conclusion and something it rests on; problem says why none did. */
export function parseAnswer(text: string): { answer?: IssueAnswer; problem: string } {
  const read = lastJsonBlock(text, AnswerBlock, {
    none: t("server.session.answer.noBlock"),
    unparsed: (e) => t("server.session.answer.unreadable", { why: messageOf(e) }),
    misfit: (issue) => {
      const field = misfitField(issue);
      const why = field === undefined ? t("server.session.answer.notObject") : t("server.session.answer.lines", { field });
      return t("server.session.answer.unreadable", { why });
    },
    refuse: (raw) => {
      const a = answerOf(raw);
      return !a.conclusion ? t("server.session.answer.empty") : a.evidence.length === 0 ? t("server.session.answer.noEvidence") : undefined;
    },
  });
  return Result.isSuccess(read) ? { answer: answerOf(read.success), problem: "" } : { problem: read.failure };
}

/** A line the session wrote to ask the owner (the farm's rules tell it to): 「要问主人：…」, with markdown around it allowed. */
const questionLine = /^[\s>*#_-]*(?:\*\*)?(?:要问主人|Ask the owner|Question for the owner)(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.+)$/iu;

/** The answers it thought of, at the end of the question: 「（选项：A｜B）」. */
const optionsTail = /\s*[（(]\s*(?:选项|Options)\s*[:：]\s*(.+?)\s*[)）]\s*$/iu;

export function questionsOf(said: string): Question[] {
  return said
    .split("\n")
    .map((line) => questionLine.exec(line)?.[1])
    .filter((q): q is string => q !== undefined)
    .map((q) => q.trim().replace(/\*\*$/u, "").trim())
    .flatMap((q): Question[] => {
      const tail = optionsTail.exec(q);
      const question = tail ? q.slice(0, tail.index).trim() : q;
      const options = (tail?.[1] ?? "")
        .split(/[｜|]/u)
        .map((o) => o.trim())
        .filter(Boolean);
      if (!question) return [];
      return [{ question, options: options.length >= 2 ? options : [] }];
    });
}

/** A line on one criterion (the issue's brief asks for them): 「标准 2：做到了 —— bun test 通过」. */
const checkLine =
  /^[\s>*#_-]*(?:\*\*)?(?:标准|Criterion)\s*(\d+)(?:\*\*)?\s*[:：]\s*(?:\*\*)?(做到了|没做到|不确定|not met|unmet|unsure|met)(?![a-z])(?:\*\*)?\s*[，,。.;；:：—–-]*\s*(.*)$/iu;

const checkWords: Record<string, CheckResult> = {
  做到了: "met",
  没做到: "unmet",
  不确定: "unsure",
  met: "met",
  "not met": "unmet",
  unmet: "unmet",
  unsure: "unsure",
};

/** Numbered from 1 as the brief lists them; the last word on a criterion stands. */
export function checksOf(said: string): CriterionCheck[] {
  const out = new Map<number, CriterionCheck>();
  for (const line of said.split("\n")) {
    const m = checkLine.exec(line);
    if (!m) continue;
    const criterion = Number(m[1]) - 1;
    if (criterion < 0) continue;
    const proof = m[3]!.trim().replace(/\*\*$/u, "").trim();
    out.set(criterion, { criterion, result: checkWords[m[2]!.toLowerCase()]!, proof: proof });
  }
  return [...out.values()].toSorted((a, b) => a.criterion - b.criterion);
}

export function readReport(outcome: TurnOutcome, said: string): SessionRead {
  const out = outcomeOf(outcome);
  const failed = outcome.kind === "failed" ? failureText(outcome) : "";
  const text = said.trim();
  // A failed run leads with why it failed; what the session said before that follows.
  const whole = failed && text ? failed + "\n\n" + text : failed || text;
  const summary = failed || summaryOf(text) || (out === "completed" ? t("server.session.done") : t("server.session.unfinished"));
  const answer = out === "completed" ? parseAnswer(text).answer : undefined;
  return {
    outcome: out,
    text: whole,
    summary: clip(summary, summaryMax),
    failure: failed,
    needsYou: outcome.kind === "failed" && needsYou.has(outcome.failure),
    questions: out === "completed" ? questionsOf(text) : [],
    checks: out === "completed" ? checksOf(text) : [],
    ...(answer ? { answer } : {}),
  };
}
