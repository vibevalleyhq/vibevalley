import { maybe, t } from "@vibevalley/i18n";

import { reportVerdict } from "../session/rules.ts";
import type {
  Deliverable,
  Question,
  Issue,
  IssueFilter,
  IssueStatus,
  IssueTemplate,
  IssueTimeline,
  Milestone,
  MilestoneKind,
  ProjectStack,
  Run,
  RunTrigger,
  Spent,
  TemplateBlank,
  TemplateKind,
} from "@vibevalley/protocol";
import { attentionWantsOwner, closedText, shortTitle } from "@vibevalley/protocol/rules";
import { isForOrchestrator } from "./state.ts";
import { clip } from "../base/text.ts";
import { answerFormat, answerOpening, criteriaHead } from "./prompts.ts";

export const isClosed = (s: IssueStatus) => s === "done" || s === "canceled";

/** The criteria go last, so whoever works it checks each one before handing the work back; an answer issue's job ends with the block parseAnswer reads. */
export function issueJob(pick: Pick<Issue, "title" | "description" | "criteria"> & { readonly deliver?: Deliverable }): string {
  let job = pick.title;
  if (pick.description) job += "\n\n" + pick.description;
  if (pick.criteria && pick.criteria.length > 0) job += "\n\n" + criteriaHead + "\n" + pick.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return pick.deliver === "answer" ? answerOpening + "\n\n" + job + "\n\n" + answerFormat : job;
}

/** 接着修 for an answer that could not be read; cureWords is the one for a failed round. */
export const answerCureWords = (problem: string) => t("server.issue.job.answerUnread", { problem }) + "\n" + answerFormat;

/** The first line with words is the title, the rest the description; a first line too long for a title gives its
 * short title (shortTitle) and the whole job is the description. */
export function splitJob(job: string): [string, string] {
  const lines = job.replaceAll("\r\n", "\n").split("\n");
  const i = lines.findIndex((l) => l.trim() !== "");
  if (i < 0) return ["", ""];
  const first = lines[i]!.trim();
  const title = shortTitle(first);
  if (title !== first) return [title, lines.slice(i).join("\n").trim()];
  return [
    first,
    lines
      .slice(i + 1)
      .join("\n")
      .trim(),
  ];
}

const int64Max = 9223372036854775807n;

export function nextTaskId(ids: readonly string[]): string {
  let top = 0n;
  for (const id of ids) {
    const m = /^p([+-]?\d+)$/.exec(id);
    if (m) {
      const n = BigInt(m[1]!);
      if (n > top && n <= int64Max) top = n;
    }
  }
  return "p" + (top + 1n).toString();
}

/** As its session hands it back; a list may come as one string. */
export interface IssueRefinement {
  readonly title: string;
  readonly why: string;
  readonly todo: string[];
  readonly criteria: string[];
  readonly notDoing: string[];
  readonly files: string[];
}

export const kept = (lines: readonly string[] | undefined) => (lines ?? []).map((l) => l.trim()).filter((l) => l !== "");

export const openQuestions = (questions: readonly Question[] | undefined): Question[] => (questions ?? []).filter((a) => a.question.trim() !== "");

function linesOf(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v;
  throw new Error(t("server.issue.refinement.lines", { field }));
}

function textOf(v: unknown, field: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  throw new Error(t("server.issue.refinement.text", { field }));
}

const refinementBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

/** The last block that reads as a draft with a title; problem says why none did. */
export function parseRefinement(text: string): { draft?: IssueRefinement; problem: string } {
  const blocks = [...text.matchAll(refinementBlock)].map((m) => m[1]!);
  if (blocks.length === 0) return { problem: t("server.issue.refinement.noBlock") };
  let problem = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    let d: IssueRefinement;
    try {
      const raw = JSON.parse(blocks[i]!) as Record<string, unknown>;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(t("server.issue.refinement.notObject"));
      d = {
        title: textOf(raw.title, "title"),
        why: textOf(raw.why, "why"),
        todo: linesOf(raw.todo, "todo"),
        criteria: linesOf(raw.criteria, "criteria"),
        notDoing: linesOf(raw.notDoing, "notDoing"),
        files: linesOf(raw.files, "files"),
      };
    } catch (e) {
      problem = t("server.issue.refinement.unreadable", { why: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const title = clip(d.title, 80);
    if (!title) {
      problem = t("server.issue.refinement.noTitle");
      continue;
    }
    return { draft: { ...d, title }, problem: "" };
  }
  return { problem };
}

export function refinementDescription(d: IssueRefinement): string {
  const parts: string[] = [];
  const why = d.why.trim();
  if (why) parts.push(t("server.issue.refinement.why") + "\n" + why);
  for (const [head, lines] of [
    [t("server.issue.refinement.todo"), kept(d.todo)],
    [t("server.issue.refinement.notDoing"), kept(d.notDoing)],
    [t("server.issue.refinement.files"), kept(d.files)],
  ] as const)
    if (lines.length > 0) parts.push(head + "\n- " + lines.join("\n- "));
  return parts.join("\n\n");
}

const recentTitles = 5;
/** A title longer than this is a long instruction, not one to send again. */
const recentTitleLength = 60;

/** orchestrator: whether a profile id is an orchestrator's. */
export function sentTitles(all: readonly Issue[], project: string, orchestrator: (id: string) => boolean): string[] {
  const mine = all
    .filter(
      (i) =>
        i.project === project &&
        i.sessions.length > 0 &&
        !i.graph &&
        !i.task &&
        i.parent === undefined &&
        i.recurrence === undefined &&
        !isForOrchestrator(i, orchestrator),
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const out: string[] = [];
  for (const i of mine) {
    const title = i.title.split(/\s+/).filter(Boolean).join(" ");
    if (!title || [...title].length > recentTitleLength || out.includes(title)) continue;
    out.push(title);
    if (out.length === recentTitles) break;
  }
  return out;
}

const commandHoles = /\s?\{(test|lint|build)\}\s?/g;

/** A known command goes in as code, spaced from the words around it; an unknown one is a plain word, unspaced as Chinese is. */
export function filledTemplate(s: IssueTemplate, stack: Partial<ProjectStack>): IssueTemplate {
  const commands: Record<string, string | undefined> = { test: stack.test, lint: stack.lint, build: stack.build };
  const done = s.done.replace(commandHoles, (hole, name: string) =>
    commands[name] ? hole.replace(`{${name}}`, "`" + commands[name] + "`") : (maybe(`server.issue.template.commands.${name}`) ?? hole),
  );
  const text = t("server.issue.template.done", { title: s.title, done });
  const blank = firstBlank(text);
  const { blank: _, ...rest } = s;
  return { ...rest, done, text, ...(blank ? { blank } : {}) };
}

export const filledKinds = (kinds: readonly TemplateKind[], stack: Partial<ProjectStack>): TemplateKind[] =>
  kinds.map((k) => ({ ...k, templates: k.templates.map((template) => filledTemplate(template, stack)) }));

function firstBlank(text: string): TemplateBlank | undefined {
  const m = /〔[^〕]*〕/.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : undefined;
}

function startWords(trigger: RunTrigger, first: boolean): [MilestoneKind, string] {
  switch (trigger.kind) {
    case "refine":
      return ["started", t("server.issue.timeline.refine")];
    case "comment":
      return ["told", t("server.issue.timeline.told")];
    case "issue":
      return ["started", first ? t("server.issue.timeline.start") : t("server.issue.timeline.restart")];
    case "task":
      return ["started", t("server.issue.timeline.graph")];
    case "recurrence":
      return ["started", t("server.issue.timeline.recurrence", { missed: trigger.missed ?? false })];
    case "runtime":
      return ["started", t("server.issue.timeline.runtime")];
  }
}

/** runs oldest first; names: a session's name by its id. The milestones come newest first, the questions it waits on now
 * with its last run. */
export function milestonesOf(issue: Issue, runs: readonly Run[], names: ReadonlyMap<string, string>): IssueTimeline {
  const out: Milestone[] = [{ at: issue.createdAt, kind: "opened", text: t("server.issue.timeline.opened") }];
  const lastDone = runs.findLastIndex((r) => r.endedAt !== undefined);
  runs.forEach((r, i) => {
    const who = names.get(r.session);
    const by = who !== undefined ? { who } : {};
    const draft = r.triggeredBy.kind === "refine";
    const [kind, text] = startWords(r.triggeredBy, !runs.slice(0, i).some((x) => x.triggeredBy.kind !== "refine"));
    out.push({ at: r.startedAt, kind, ...by, text });
    if (r.endedAt === undefined || r.outcome === undefined) return;
    const said = r.summary ? t("server.issue.timeline.said", { summary: r.summary }) : "";
    switch (r.outcome) {
      case "completed":
        if (i === lastDone && issue.questions.length > 0)
          out.push({
            at: r.endedAt,
            kind: "asked",
            ...by,
            text: t("server.issue.timeline.asked", { questions: issue.questions.map((a) => a.question).join(" / ") }),
          });
        else
          out.push({
            at: r.endedAt,
            kind: draft ? "refined" : "reported",
            ...by,
            text: (draft ? t("server.issue.timeline.refined") : t("server.issue.timeline.reported")) + said,
          });
        break;
      case "failed":
        out.push({ at: r.endedAt, kind: "failed", ...by, text: t("shared.outcome.failed") + said });
        break;
      case "interrupted":
        out.push({ at: r.endedAt, kind: "stopped", ...by, text: t("shared.outcome.interrupted") + said });
        break;
    }
  });
  const sentBack = new Map<number, string[]>();
  for (const f of issue.findings) sentBack.set(f.at, [...(sentBack.get(f.at) ?? []), f.text]);
  for (const [at, lines] of sentBack)
    out.push({ at, kind: "rejected", text: t("server.issue.timeline.rejected", { lines: lines.join(t("server.issue.timeline.rejectedSeparator")) }) });
  if (issue.reviewedAt !== undefined) out.push({ at: issue.reviewedAt, kind: "accepted", text: t("server.issue.timeline.accepted") });
  if (issue.closedAt !== undefined) out.push({ at: issue.closedAt, kind: "closed", text: closedText(issue) });
  // Newest first; at the same moment, the later step of the story first.
  const milestones = out
    .map((m, i) => [m, i] as const)
    .sort((a, b) => b[0].at - a[0].at || b[1] - a[1])
    .map(([m]) => m);
  const spent = runs.reduce<Spent | undefined>((sum, r) => {
    if (!r.spent) return sum;
    const cny = r.spent.cny === undefined ? sum?.cny : (sum?.cny ?? 0) + r.spent.cny;
    return { tokens: (sum?.tokens ?? 0) + r.spent.tokens, ...(cny !== undefined ? { cny } : {}) };
  }, undefined);
  return { milestones, ...(spent ? { spent } : {}) };
}

export const resumeWords = () => t("server.issue.job.resume");

/** Calling it twice gives the same job: a 接着修 told before is taken off first. */
export function cureWords(job: string): string {
  let original = job;
  if (original.startsWith(t("server.issue.job.cureHead"))) original = original.slice(t("server.issue.job.cureHead").length);
  if (original.endsWith(t("server.issue.job.cureTail"))) original = original.slice(0, -t("server.issue.job.cureTail").length);
  return t("server.issue.job.cure", { job: original });
}

export const findingsOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** A pull request's description: the session's conclusion (its 结论： part), else all it last said. */
export const pullRequestConclusion = (text: string) => reportVerdict(text) || text;

export const nullText = (s: string | undefined) => {
  const text = (s ?? "").trim();
  return text === "" ? null : text;
};

export const jsonOrNull = (v: unknown, there: boolean) => (there ? JSON.stringify(v) : null);

const spaces = /\s+/;

/** The issues a filter picks, newest first: the open ones unless it asks for closed ones or names a closed status; waiting on
 * the owner, the longest waiting first. */
export function pickIssues(all: readonly Issue[], f: IssueFilter, now: number): Issue[] {
  const words = (f.text ?? "").split(spaces).filter(Boolean);
  const project = (f.project ?? "").trim();
  let found = all.filter(
    (item) =>
      (f.status ? item.status === f.status : f.closed || (item.status !== "done" && item.status !== "canceled")) &&
      (!f.wantsOwner || attentionWantsOwner(item.attention.state)) &&
      (!project || item.project === project) &&
      words.every((w) => (item.title + "\n" + (item.description ?? "")).includes(w)),
  );
  if (f.wantsOwner) found = found.sort((a, b) => (a.attention.since ?? now) - (b.attention.since ?? now));
  return f.limit && f.limit > 0 ? found.slice(0, Math.trunc(f.limit)) : found;
}
