// An issue's rules: its text as a job and back, the next task's
// id, its draft (what the drafting session is told and how what it hands back is read), where its status may move, and
// the sowing form's templates filled for a project.

import { reportVerdict } from "../session/rules.ts";
import type {
  Deliverable,
  Question,
  Issue,
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
import { closedText, outcomeLabel, shortTitle } from "@vibevalley/protocol/rules";
import { isForOrchestrator } from "./state.ts";
import { Result, Schema } from "effect";
import { lines, linesOf, text as textField } from "../base/json.ts";
import { clip } from "../base/text.ts";

export const isClosed = (s: IssueStatus) => s === "done" || s === "canceled";

export const criteriaHead =
  "验收标准（主人照这几条验收；做完逐条对照，在结论前面每条写一行「标准 N：做到了」「标准 N：没做到」或「标准 N：不确定」，后面接凭据：跑了什么命令、结果如何，或改了哪个文件）：";

/** The criteria go last, so whoever works it checks each one before it hands the work back. An answer issue is read
 * only, and its job ends with the block its conclusion comes back in (parseAnswer). */
export function issueJob(t: Pick<Issue, "title" | "description" | "criteria"> & { readonly deliver?: Deliverable }): string {
  let job = t.title;
  if (t.description) job += "\n\n" + t.description;
  if (t.criteria && t.criteria.length > 0) job += "\n\n" + criteriaHead + "\n" + t.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n");
  return t.deliver === "answer" ? answerOpening + "\n\n" + job + "\n\n" + answerFormat : job;
}

// ── an answer issue ──

export const answerOpening =
  "这一轮你只查清楚、回答问题：读代码、跑只读的命令，不改文件、不提交；干活的规矩里提交、写 commit 号的那两条，这一轮不用照做。你改了什么，交回来以后都会被清掉。";

const answerExample = {
  conclusion: "看板拖卡还在调旧的 start 接口，所以挪到已完成时没反应。",
  evidence: ["apps/web/src/pages/issues/Board.tsx:120 拖放调的是 api.issue.start", "rg 'issue.start' 只在 Board.tsx 里出现一次"],
  unsure: ["不确定命令行有没有走同一条路"],
  next: ["把拖放改成 issue.status"],
};

const answerFormat = [
  "汇报的最后，用一个 json 代码块交结论，格式照这个：",
  "```json",
  JSON.stringify(answerExample, null, 2),
  "```",
  "conclusion 一两句说答案；evidence 是依据，至少一条：文件和行号看到了什么、跑了什么命令输出了什么；unsure 是拿不准的，next 是建议接着做的，没有就给空数组。",
].join("\n");

/** 接着修 for an answer that could not be read: what was wrong with it, and the format again. */
export const answerCureWords = (problem: string) => `接着修：上一轮交回的结论读不出来（${problem}）。接着查清楚，最后照这个格式交：\n${answerFormat}`;

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

/** One more than the largest p<number> among ids (a number as Go's ParseInt reads one); the rest do not count. */
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

/** A draft as its session hands it back, in the json block its brief asks for. A list may come as one string. */
export interface IssueRefinement {
  readonly title: string;
  readonly why: string;
  readonly todo: string[];
  readonly criteria: string[];
  readonly notDoing: string[];
  readonly files: string[];
}

/** The lines with words in them, trimmed. */
export const kept = (lines: readonly string[] | undefined) => (lines ?? []).map((l) => l.trim()).filter((l) => l !== "");

/** The questions with words in them. */
export const openQuestions = (questions: readonly Question[] | undefined): Question[] => (questions ?? []).filter((a) => a.question.trim() !== "");

/** A draft as a helper writes it in its json block. */
const RefinementBlock = Schema.fromJsonString(
  Schema.Struct({
    title: textField,
    why: textField,
    todo: lines,
    criteria: lines,
    notDoing: lines,
    files: lines,
  }),
);
const readRefinement = Schema.decodeUnknownResult(RefinementBlock);

const refinementBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

/** The last block that reads as a draft with a title; problem says why none did. */
export function parseRefinement(text: string): { draft?: IssueRefinement; problem: string } {
  const blocks = [...text.matchAll(refinementBlock)].map((m) => m[1]!);
  if (blocks.length === 0) return { problem: "没找到草稿：要用一个 json 代码块给出" };
  let problem = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    const read = readRefinement(blocks[i]!);
    if (Result.isFailure(read)) {
      problem = "json 读不了：" + read.failure.message;
      continue;
    }
    const raw = read.success;
    const d: IssueRefinement = {
      title: raw.title ?? "",
      why: raw.why ?? "",
      todo: linesOf(raw.todo),
      criteria: linesOf(raw.criteria),
      notDoing: linesOf(raw.notDoing),
      files: linesOf(raw.files),
    };
    const title = clip(d.title, 80);
    if (!title) {
      problem = "草稿没有标题";
      continue;
    }
    return { draft: { ...d, title }, problem: "" };
  }
  return { problem };
}

/** The issue's description from a draft, under the same headings every time; a heading with nothing under it is left out. */
export function refinementDescription(d: IssueRefinement): string {
  const parts: string[] = [];
  const why = d.why.trim();
  if (why) parts.push("为什么：\n" + why);
  for (const [head, lines] of [
    ["要做的：", kept(d.todo)],
    ["不做的：", kept(d.notDoing)],
    ["可能涉及：", kept(d.files)],
  ] as const)
    if (lines.length > 0) parts.push(head + "\n- " + lines.join("\n- "));
  return parts.join("\n\n");
}

export const refinementOpening =
  "这一轮你只起草工单：读代码，把主人想做的事写成一张能派出去的工单，交给别的帮工去做。你不改文件、不提交；干活的规矩里提交、写 commit 号的那两条，这一轮不用照做。你改了什么，交回来以后都会被清掉。";

/** What the drafting session is told: the owner's word, the draft so far when there is one (as the owner may have edited it), and what it asked with the owner's answer. */
export function refinementBrief(
  t: Pick<Issue, "title" | "description" | "criteria"> & {
    readonly questions?: readonly Question[];
  },
  word: string,
  project: string,
): string {
  word = word.trim();
  const questions = t.questions ?? [];
  const criteria = t.criteria ?? [];
  const answering = word !== "" && questions.length > 0;
  const redraft = !!t.description || criteria.length > 0;
  const example = {
    title: "看板拖卡改用 issue.status",
    why: "看板拖卡片还在调旧的 start 接口，挪到已完成时收不了。",
    todo: ["board.dart 的拖放改调 issue.status", "删掉旧接口的调用"],
    criteria: ["把一张备选拖到待办，它开工", "flutter test test/workbench/issues_test.dart 通过"],
    notDoing: ["不改看板的样子"],
    files: ["app/lib/workbench/issues/board.dart"],
  };
  const lines = [refinementOpening, "", `项目：${project}（你现在就在它的目录里）`, "主人想做的：" + (word !== "" && !redraft ? word : t.title)];
  if (redraft) {
    lines.push("", "上一版草稿（主人可能改过，以这一版为准）：", "标题：" + t.title);
    if (t.description) lines.push(t.description);
    if (criteria.length > 0) lines.push("验收标准：", "- " + criteria.join("\n- "));
  }
  if (answering)
    lines.push("", "你上一版问主人的：", "- " + questions.map((a) => a.question).join("\n- "), "主人的回答：" + word, "", "照主人的回答再起草一版，整张重写。");
  else if (redraft && word) lines.push("", "主人这次说：" + word, "", "照主人说的再起草一版，整张重写。");
  else if (redraft) lines.push("", "再起草一版，整张重写。");
  lines.push(
    "",
    "先读代码，弄清现状，再写。写的规矩：",
    "- title：短标题，说做什么，不超过 20 个字；细节写在 why、todo 里，不写进标题。",
    "- why：为什么要做，一两句。",
    "- todo：要做的几件事，一件一条，写到改哪里。",
    "- criteria：怎么算做完，一条一个主人能照着验的点（跑什么命令、看到什么结果、页面上是什么样）。",
    "- notDoing：这张工单不做的，免得做多了；没有就给空数组。",
    "- files：可能涉及的文件或目录。",
    "- 拿不准、要主人定的，写在代码块前面，每行以「要问主人：」开头，一行问一件事，想得到的几种回答写在句末「（选项：A｜B）」；能自己查到的不要问。问了也照你最好的猜测把草稿写完整。",
    "",
    "汇报的最后，用一个 json 代码块给出草稿，格式照这个：",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "代码块之后写一句结论：草稿写好了没有，还要问主人什么。",
  );
  return lines.join("\n");
}

// ── the sowing form's templates ──

const recentTitles = 5;
/** A title longer than this is a long instruction, not one to send again. */
const recentTitleLength = 60;

/** The owner's own issues sent out in the project, newest first, each title once. */
export function sentTitles(all: readonly Issue[], project: string): string[] {
  const mine = all
    .filter(
      (i) =>
        i.project === project && i.sessions.length > 0 && !i.graph && !i.task && i.parent === undefined && i.recurrence === undefined && !isForOrchestrator(i),
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
const words: Record<string, string> = { test: "测试", lint: "代码检查", build: "构建" };

/** A known command goes in as code, spaced from the words around it; an unknown one is a plain word, unspaced as Chinese is. */
export function filledTemplate(s: IssueTemplate, stack: Partial<ProjectStack>): IssueTemplate {
  const commands: Record<string, string | undefined> = {
    test: stack.test,
    lint: stack.lint,
    build: stack.build,
  };
  const done = s.done.replace(commandHoles, (hole, name: string) => (commands[name] ? hole.replace(`{${name}}`, "`" + commands[name] + "`") : words[name]!));
  const text = s.title + "\n做到什么程度算完：" + done;
  const blank = firstBlank(text);
  const { blank: _, ...rest } = s;
  return { ...rest, done, text, ...(blank ? { blank } : {}) };
}

export const filledKinds = (kinds: readonly TemplateKind[], stack: Partial<ProjectStack>): TemplateKind[] =>
  kinds.map((k) => ({ ...k, templates: k.templates.map((t) => filledTemplate(t, stack)) }));

function firstBlank(text: string): TemplateBlank | undefined {
  const start = text.indexOf("〔");
  if (start < 0) return undefined;
  const end = text.indexOf("〕", start);
  return end < 0 ? undefined : { start, end: end + 1 };
}

// ── the issue's story ──

function startWords(t: RunTrigger, first: boolean): [MilestoneKind, string] {
  switch (t.kind) {
    case "refine":
      return ["started", "开始起草"];
    case "comment":
      return ["told", "你带了话，接着做一轮"];
    case "issue":
      return ["started", first ? "开工" : "重开，接着做"];
    case "task":
      return ["started", "照计划开工"];
    case "recurrence":
      return ["started", t.missed ? "定时开工（补跑）" : "定时开工"];
    case "runtime":
      return ["started", "农机自己接着做"];
  }
}

/** The issue's milestones out of what is kept: its runs (oldest first), the findings it was sent back with, its
 * acceptance and its close; newest first. The questions it waits on now go with its last run. names: a session's name. */
export function milestonesOf(t: Issue, runs: readonly Run[], names: ReadonlyMap<string, string>): IssueTimeline {
  const out: Milestone[] = [{ at: t.createdAt, kind: "opened", text: "开单" }];
  const lastDone = runs.findLastIndex((r) => r.endedAt !== undefined);
  runs.forEach((r, i) => {
    const who = names.get(r.session);
    const by = who !== undefined ? { who } : {};
    const draft = r.triggeredBy.kind === "refine";
    const [kind, text] = startWords(r.triggeredBy, !runs.slice(0, i).some((x) => x.triggeredBy.kind !== "refine"));
    out.push({ at: r.startedAt, kind, ...by, text });
    if (r.endedAt === undefined || r.outcome === undefined) return;
    const said = r.summary ? `：${r.summary}` : "";
    switch (r.outcome) {
      case "completed":
        if (i === lastDone && t.questions.length > 0)
          out.push({
            at: r.endedAt,
            kind: "asked",
            ...by,
            text: "问你：" + t.questions.map((a) => a.question).join(" / "),
          });
        else
          out.push({
            at: r.endedAt,
            kind: draft ? "refined" : "reported",
            ...by,
            text: (draft ? "起草好了" : "交回来了") + said,
          });
        break;
      case "failed":
        out.push({ at: r.endedAt, kind: "failed", ...by, text: outcomeLabel.failed + said });
        break;
      case "interrupted":
        out.push({ at: r.endedAt, kind: "stopped", ...by, text: outcomeLabel.interrupted + said });
        break;
    }
  });
  const sentBack = new Map<number, string[]>();
  for (const f of t.findings) sentBack.set(f.at, [...(sentBack.get(f.at) ?? []), f.text]);
  for (const [at, lines] of sentBack) out.push({ at, kind: "rejected", text: "打回：" + lines.join("；") });
  if (t.reviewedAt !== undefined) out.push({ at: t.reviewedAt, kind: "accepted", text: "验收通过" });
  if (t.closedAt !== undefined) out.push({ at: t.closedAt, kind: "closed", text: closedText(t) });
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

// ── what an act says to the helper ──

/** 接着做: a round that stopped halfway goes on. */
export const resumeWords = "上一轮停在了半路，接着把它做完。";

/** 接着修: the job once, with what to do about the failure; a job that was told this before is not told it twice. */
export function cureWords(job: string): string {
  const original = job.replace(/^接着修：/, "").replace(/。看一下报错，修好再跑一遍测试$/, "");
  return `接着修：${original}。看一下报错，修好再跑一遍测试`;
}

/** 打回: one finding a line. */
export const findingsOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** A pull request's description: the session's conclusion (its 结论： part), else all it last said. */
export const pullRequestConclusion = (text: string) => reportVerdict(text) || text;

/** A text column: blank is null. */
export const nullText = (s: string | undefined) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t;
};

/** A JSON column: null when there is nothing to keep. */
export const jsonOrNull = (v: unknown, there: boolean) => (there ? JSON.stringify(v) : null);
