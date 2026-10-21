// An issue's rules: its text as a job and back, the next task's
// id, its draft (what the drafting session is told and how what it hands back is read), where its status may move, and
// the sowing form's templates filled for a project.

import {
  type Issue,
  type IssueStatus,
  IssueStatusValues,
  type IssueTemplate,
  type ProjectStack,
  type TemplateBlank,
  type TemplateKind,
} from "@vibevalley/protocol";
import { clip, isForManager } from "@vibevalley/protocol/rules";

export const isClosed = (s: IssueStatus) => s === "done" || s === "canceled";

export const criteriaHead = "验收标准（主人照这几条验收；做完逐条对照，结论里说每条是怎么验的）：";

/** The criteria go last, so whoever works it checks each one before it hands the work back. */
export function issueJob(t: Pick<Issue, "title" | "description" | "criteria">): string {
  let job = t.title;
  if (t.description) job += "\n\n" + t.description;
  if (t.criteria && t.criteria.length > 0) job += "\n\n" + criteriaHead + "\n- " + t.criteria.join("\n- ");
  return job;
}

/** The first line with words is the title, the rest the description. */
export function splitJob(job: string): [string, string] {
  const lines = job.replaceAll("\r\n", "\n").split("\n");
  const i = lines.findIndex((l) => l.trim() !== "");
  return i < 0
    ? ["", ""]
    : [
        lines[i]!.trim(),
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
export interface IssueDraft {
  readonly title: string;
  readonly why: string;
  readonly todo: string[];
  readonly criteria: string[];
  readonly notDoing: string[];
  readonly files: string[];
}

/** The lines with words in them, trimmed. */
export const kept = (lines: readonly string[] | undefined) => (lines ?? []).map((l) => l.trim()).filter((l) => l !== "");

function linesOf(v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new Error(`${field}：要是字符串或字符串的数组`);
}

function textOf(v: unknown, field: string): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v;
  throw new Error(`${field}：要是字符串`);
}

const draftBlock = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;

/** The last block that reads as a draft with a title; problem says why none did. */
export function parseDraft(text: string): { draft?: IssueDraft; problem: string } {
  const blocks = [...text.matchAll(draftBlock)].map((m) => m[1]!);
  if (blocks.length === 0) return { problem: "没找到草稿：要用一个 json 代码块给出" };
  let problem = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    let d: IssueDraft;
    try {
      const raw = JSON.parse(blocks[i]!) as Record<string, unknown>;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("要是一个对象");
      d = {
        title: textOf(raw.title, "title"),
        why: textOf(raw.why, "why"),
        todo: linesOf(raw.todo, "todo"),
        criteria: linesOf(raw.criteria, "criteria"),
        notDoing: linesOf(raw.notDoing, "notDoing"),
        files: linesOf(raw.files, "files"),
      };
    } catch (e) {
      problem = "json 读不了：" + (e instanceof Error ? e.message : String(e));
      continue;
    }
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
export function draftDescription(d: IssueDraft): string {
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

export const draftOpening =
  "这一轮你只起草工单：读代码，把主人想做的事写成一张能派出去的工单，交给别的帮工去做。你不改文件、不提交；农场规矩里提交、写 commit 号的那两条，这一轮不用照做。你改了什么，交回来以后都会被清掉。";

/** What the drafting session is told: the owner's word, the draft so far when there is one (as the owner may have edited it), and what it asked with the owner's answer. */
export function draftBrief(
  t: Pick<Issue, "title" | "description" | "criteria"> & { readonly asks?: readonly string[] },
  word: string,
  project: string,
): string {
  word = word.trim();
  const asks = t.asks ?? [];
  const criteria = t.criteria ?? [];
  const answering = word !== "" && asks.length > 0;
  const redraft = !!t.description || criteria.length > 0;
  const example = {
    title: "看板拖卡改用 issue.status",
    why: "看板拖卡片还在调旧的 start 接口，挪到已完成时收不了。",
    todo: ["board.dart 的拖放改调 issue.status", "删掉旧接口的调用"],
    criteria: ["把一张备选拖到待办，它开工", "flutter test test/workbench/issues_test.dart 通过"],
    notDoing: ["不改看板的样子"],
    files: ["app/lib/workbench/issues/board.dart"],
  };
  const lines = [draftOpening, "", `项目：${project}（你现在就在它的目录里）`, "主人想做的：" + (word !== "" && !redraft ? word : t.title)];
  if (redraft) {
    lines.push("", "上一版草稿（主人可能改过，以这一版为准）：", "标题：" + t.title);
    if (t.description) lines.push(t.description);
    if (criteria.length > 0) lines.push("验收标准：", "- " + criteria.join("\n- "));
  }
  if (answering) lines.push("", "你上一版问主人的：", "- " + asks.join("\n- "), "主人的回答：" + word, "", "照主人的回答再起草一版，整张重写。");
  else if (redraft && word) lines.push("", "主人这次说：" + word, "", "照主人说的再起草一版，整张重写。");
  else if (redraft) lines.push("", "再起草一版，整张重写。");
  lines.push(
    "",
    "先读代码，弄清现状，再写。写的规矩：",
    "- title：一句话说清做什么，不超过 30 个字。",
    "- why：为什么要做，一两句。",
    "- todo：要做的几件事，一件一条，写到改哪里。",
    "- criteria：怎么算做完，一条一个主人能照着验的点（跑什么命令、看到什么结果、页面上是什么样）。",
    "- notDoing：这张工单不做的，免得做多了；没有就给空数组。",
    "- files：可能涉及的文件或目录。",
    "- 拿不准、要主人定的，写在代码块前面，每行以「要问主人：」开头，一行问一件事；能自己查到的不要问。问了也照你最好的猜测把草稿写完整。",
    "",
    "汇报的最后，用一个 json 代码块给出草稿，格式照这个：",
    "```json",
    JSON.stringify(example, null, 2),
    "```",
    "代码块之后写一句结论：草稿写好了没有，还要问主人什么。",
  );
  return lines.join("\n");
}

// ── where a status may go ──

/** What moving an issue to a status does. in_progress and in_review are the session's to reach, never the owner's. */
export type Move =
  | "none"
  /** backlog → todo: sent out now, or waits in todo for room */
  | "start"
  /** todo → backlog */
  | "unqueue"
  /** in_review → todo: another round, with the owner's words */
  | "round"
  /** done, canceled → todo: a new session picks it up, with the owner's words */
  | "reopen"
  /** canceled before it was ever sent → backlog */
  | "revive"
  /** in_review → done */
  | "merge"
  /** in_progress, in_review → canceled: its session goes home */
  | "cancel"
  /** backlog, todo → canceled: never sent */
  | "drop";

export const statusWords: Readonly<Record<IssueStatus, string>> = {
  backlog: "备选",
  todo: "待办",
  in_progress: "处理中",
  in_review: "等你看",
  done: "已完成",
  canceled: "已取消",
};

/** The whole table; the reason says why when there is no move. */
export function statusMove(t: Issue, to: IssueStatus): [Move, string] {
  const from = t.status;
  if (isForManager(t)) return ["none", "这是派给管家的工单：管家答完就关"];
  if (t.graph || t.task || t.closed === "merged_into_graph") return ["none", "这是种植计划的工单，跟着计划走：在计划里改"];
  if (from === to) return ["none", "它已经是这个状态了"];
  if (to === "in_progress" || to === "in_review") return ["none", "处理中和等你看是帮工干出来的：挪到待办，它就开工"];
  const sent = t.sessions.length > 0;
  switch (from) {
    case "backlog":
      if (to === "todo") return t.drafting ? ["none", t.drafting.name + " 正在起草：等它交回来再开工"] : ["start", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "todo":
      if (to === "backlog") return ["unqueue", ""];
      if (to === "canceled") return ["drop", ""];
      break;
    case "in_progress":
      return to === "canceled" ? ["cancel", ""] : ["none", "帮工还在干：等它交回来，或者挪到已取消让它回家"];
    case "in_review":
      if (to === "todo") return ["round", ""];
      // Every issue has an acceptance; a glance one is passed by this harvest itself.
      if (to === "done") return t.acceptance === "required" && t.acceptedAt === undefined ? ["none", "这张工单要先过验收：验收通过才能收获"] : ["merge", ""];
      if (to === "canceled") return ["cancel", ""];
      break;
    case "done":
    case "canceled":
      if (to === "todo" && sent) return ["reopen", ""];
      if (to === "backlog" && !sent) return ["revive", ""];
      return sent ? ["none", "关上的工单挪回待办，就是带一句话重开"] : ["none", "没开过工就取消的工单，挪回备选再说"];
  }
  return ["none", "不能从" + statusWords[from] + "挪到" + statusWords[to]];
}

export const statusMoves = (t: Issue): IssueStatus[] => IssueStatusValues.filter((to) => statusMove(t, to)[0] !== "none");

// ── the sowing form's templates ──

const recentTitles = 5;
/** A title longer than this is a long instruction, not one to send again. */
const recentTitleLength = 60;

/** The owner's own issues sent out in the project, newest first, each title once. */
export function sentTitles(all: readonly Issue[], project: string): string[] {
  const mine = all
    .filter(
      (i) => i.project === project && i.sessions.length > 0 && !i.graph && !i.task && i.parent === undefined && i.schedule === undefined && !isForManager(i),
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
  const commands: Record<string, string | undefined> = { test: stack.test, lint: stack.lint, build: stack.build };
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
