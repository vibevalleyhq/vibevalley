import { list, maybe, t } from "@vibevalley/i18n";
// The session's rules, pure: how a run's end reads, whether there is room for one
// more helper, which profile a job goes to, and what a session is told about the farm. Lengths are UTF-16 units.

import { recallHead, recallIntro } from "./prompts.ts";
import type { FailedTurn, FailureClass, McpServer, TurnOutcome } from "@botiverse/oar";
import { failureAdvice } from "@botiverse/oar/observe";
import type { Agent, Question, CheckResult, Conflict, CriterionCheck, Doing, IssueAnswer, MCPServer, Outcome, Session, Skill } from "@vibevalley/protocol";
import { isBusy, roomLeft } from "@vibevalley/protocol/rules";
import { clip, slice } from "../base/text.ts";
import { runtimeLabel } from "../agent/seed.ts";
import type { MergeFailure } from "../project/shapes.ts";

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
  const reason = slice(f.reason.replace(/\s+/g, " ").trim(), 0, 200);
  let out = maybe(`server.session.failure.${f.failure}`) ?? t("server.session.failure.unknown");
  if (f.status !== undefined) out += t("server.session.failureStatus", { status: f.status });
  if (reason) out += t("server.session.failureReason", { reason });
  if (next) out += t("server.session.failureThen", { next });
  return out;
}

/** The line the farm rules ask every report to end on: 「结论：…」, perhaps bold or in a list. The markers are asked for in
 * Chinese whatever the owner's language; a model writing English may put them in English, which counts too. */
const verdict = /(?:^|\n)[\s>*#_-]*(?:\*\*)?(?:结论|Conclusion)(?:\*\*)?\s*[:：]\s*(?:\*\*)?/gi;

function conclusion(text: string, min: number): string {
  const blocks = text.trim().split(/\n{2,}/);
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
  return rest.split(/\n\s*\n/, 1)[0]!.trim();
}

/** What a report says in short: its verdict, else its last paragraphs. */
export const summaryOf = (text: string) => reportVerdict(text) || conclusion(text, 80);

/** A pull request's description: the verdict, else the whole reply. */

/** Said out loud on the farm, not only in the report. */
const needsYou = new Set<FailureClass>(["auth", "billing", "quota", "model_unavailable"]);

export const outcomeOf = (o: TurnOutcome): Outcome => (o.kind === "completed" ? "completed" : o.kind === "aborted" ? "interrupted" : "failed");

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

/** A json block in what a session said: the last one wins. */
const jsonBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

const answerLines = (v: unknown, field: string): string[] => {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v.trim()].filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v.map((l) => l.trim()).filter(Boolean);
  throw new Error(t("server.session.answer.lines", { field }));
};

/** The last block that reads as an answer with a conclusion and something it rests on; problem says why none did. */
export function parseAnswer(text: string): { answer?: IssueAnswer; problem: string } {
  const blocks = [...text.matchAll(jsonBlock)].map((m) => m[1]!);
  if (blocks.length === 0) return { problem: t("server.session.answer.noBlock") };
  let problem = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    let a: IssueAnswer;
    try {
      const raw = JSON.parse(blocks[i]!) as Record<string, unknown>;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(t("server.session.answer.notObject"));
      a = {
        conclusion: typeof raw.conclusion === "string" ? raw.conclusion.trim() : "",
        evidence: answerLines(raw.evidence, "evidence"),
        unsure: answerLines(raw.unsure, "unsure"),
        next: answerLines(raw.next, "next"),
      };
    } catch (e) {
      problem = t("server.session.answer.unreadable", { why: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (!a.conclusion) problem = t("server.session.answer.empty");
    else if (a.evidence.length === 0) problem = t("server.session.answer.noEvidence");
    else return { answer: a, problem: "" };
  }
  return { problem };
}

/** A line the session wrote to ask the owner (the farm's rules tell it to): 「要问主人：…」, with markdown around it allowed. */
const questionLine = /^[\s>*#_-]*(?:\*\*)?(?:要问主人|Ask the owner|Question for the owner)(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.+)$/i;

/** The answers it thought of, at the end of the question: 「（选项：A｜B）」. */
const optionsTail = /\s*[（(]\s*(?:选项|Options)\s*[:：]\s*(.+?)\s*[)）]\s*$/i;

export function questionsOf(said: string): Question[] {
  return said
    .split("\n")
    .map((line) => questionLine.exec(line)?.[1])
    .filter((q): q is string => q !== undefined)
    .map((q) => q.trim().replace(/\*\*$/, "").trim())
    .flatMap((q): Question[] => {
      const tail = optionsTail.exec(q);
      const question = tail ? q.slice(0, tail.index).trim() : q;
      const options = (tail?.[1] ?? "")
        .split(/[｜|]/)
        .map((o) => o.trim())
        .filter(Boolean);
      if (!question) return [];
      return [options.length >= 2 ? { question, options } : { question }];
    });
}

/** A line on one criterion (the issue's brief asks for them): 「标准 2：做到了 —— bun test 通过」. */
const checkLine =
  /^[\s>*#_-]*(?:\*\*)?(?:标准|Criterion)\s*(\d+)(?:\*\*)?\s*[:：]\s*(?:\*\*)?(做到了|没做到|不确定|not met|unmet|unsure|met)(?![a-z])(?:\*\*)?\s*[，,。.;；:：—–-]*\s*(.*)$/i;
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
    const proof = m[3]!.trim().replace(/\*\*$/, "").trim();
    out.set(criterion, { criterion, result: checkWords[m[2]!.toLowerCase()]!, ...(proof ? { proof } : {}) });
  }
  return [...out.values()].sort((a, b) => a.criterion - b.criterion);
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

export interface SessionLimits {
  readonly workspace: number;
  readonly perRuntime: number;
  readonly perProject: number;
}

/** Why one more cannot start; except is a session about to work again, which does not count against itself. */
export function noRoom(sessions: readonly Session[], runtime: string, project: string, limits: SessionLimits, except = ""): string {
  const room = roomLeft(sessions, project, limits.workspace, limits.perProject, except);
  if (room.farm === 0) return t("server.session.noRoom.farm", { max: limits.workspace });
  const onRuntime = sessions.filter((h) => isBusy(h) && h.id !== except && h.runtime === runtime).length;
  if (limits.perRuntime > 0 && onRuntime >= limits.perRuntime)
    return t("server.session.noRoom.runtime", { runtime: runtimeLabel(runtime), on: onRuntime, max: limits.perRuntime });
  if (room.project === 0) return t("server.session.noRoom.project", { project, on: room.inProject, max: limits.perProject });
  return "";
}

export function sessionName(sessions: readonly Session[], agentId: string, agentName: string): string {
  const same = sessions.filter((h) => h.agent === agentId).length;
  return same === 0 ? agentName : `${agentName} ${same + 1}`;
}

/** What the detail panel shows starts after it. */
export const jobBreak = "\n\n---\n\n";

export const toOarMcp = (server: MCPServer): McpServer =>
  server.type === "http"
    ? { name: server.name, type: "http", url: server.url, headers: server.headers }
    : { name: server.name, command: server.command, args: server.args, env: server.env };

export function instructions(agent: Agent, library: readonly Skill[]): string {
  const parts = [(agent.persona ?? "").trim()];
  for (const id of agent.skills ?? []) {
    const skill = library.find((s) => s.id === id);
    if (skill) parts.push("## " + skill.name + "\n" + skill.body.trim());
  }
  return parts.filter((p) => p !== "").join("\n\n");
}

/** recalledIn finds the block by these words. */
export const recallBlock = (recalled: readonly string[]) => (recalled.length === 0 ? "" : [recallHead + recallIntro, ...recalled].join("\n"));

/** Set apart, so the detail panel shows the two apart. */
export const withRecall = (block: string, input: string) => (block ? block + jobBreak + input : input);

export function recalledIn(input: string): string {
  const parts = input.split(jobBreak);
  if (parts.length < 2) return "";
  const block = parts[parts.length - 2]!;
  return block.startsWith(recallHead) ? block.split("\n").slice(1).join("\n") : "";
}

export const doingOf = (h: Session): Doing => (h.phase._tag === "working" ? h.phase.doing : { action: "none", label: "" });

/** What a session is told when merging its base in would conflict. */
export const conflictBrief = (base: string, files: readonly string[]) => t("server.session.conflictBrief", { base, files: list(files) });

/** The conflict a preview of the session's branch shows; none when it goes in clean. */
export const conflictOf = (changes: { readonly base: string; readonly conflicts?: readonly string[] }): Conflict | undefined =>
  changes.conflicts && changes.conflicts.length > 0 ? { base: changes.base, files: [...changes.conflicts] } : undefined;

export const sameConflict = (a: Conflict | undefined, b: Conflict | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Who settles a conflict when the work does not go in: the owner (an issue: told what to tell the helper), or the helper
 * at once (a task graph's step). */
export type Settle = "owner" | "helper";

/** What a take-in that did not go through means. The session stays with its branch and worktree either way. fix: what
 * the helper is sent back with ("" when it is left to the owner); owner: what the owner is told; notice: the farm's line;
 * short: the line a task graph keeps. */
export function notTakenIn(
  f: MergeFailure,
  name: string,
  settle: Settle,
): { readonly fix: string; readonly owner: string; readonly notice: string; readonly short: string } {
  switch (f.kind) {
    case "conflict": {
      const files = list(f.files);
      return {
        fix: settle === "helper" ? conflictBrief(f.base, f.files) : "",
        owner: t("server.session.notTaken.conflictOwner", { base: f.base, files, name, brief: conflictBrief(f.base, f.files) }),
        notice: t("server.session.notTaken.conflictNotice", { name, base: f.base, files }),
        short: t("server.session.notTaken.conflictShort", { base: f.base, files }),
      };
    }
    case "check":
      return {
        fix: t("server.session.notTaken.checkFix", { reason: f.reasonText }),
        owner: t("server.session.notTaken.owner", { why: f.reasonText, name }),
        notice: t("server.session.notTaken.notice", { name, why: f.reasonText }),
        short: t("server.session.notTaken.checkShort"),
      };
    case "error": {
      const why = f.reasonText || f.message;
      return { fix: "", owner: t("server.session.notTaken.owner", { why, name }), notice: t("server.session.notTaken.notice", { name, why }), short: why };
    }
  }
}

/** Who goes home so one more can come, when the farm holds max: whoever has been idle longest; none while there is room,
 * or when every one is at work. */
export function whoMakesRoom(sessions: readonly Session[], max: number): Session | undefined {
  if (sessions.length < max) return undefined;
  return sessions.filter((s) => !isBusy(s)).sort((a, b) => a.hiredAt - b.hiredAt)[0];
}
