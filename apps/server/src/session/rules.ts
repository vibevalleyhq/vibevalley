// The session's rules, pure: how a run's end reads, whether there is room for one
// more helper, which profile a job goes to, and what a session is told about the farm. Lengths are UTF-16 units.

import type { FailedTurn, FailureClass, McpServer, TurnOutcome } from "@botiverse/oar";
import { failureAdvice } from "@botiverse/oar/observe";
import type { Agent, Question, CheckResult, Conflict, CriterionCheck, Doing, IssueAnswer, MCPServer, Outcome, Session, Skill } from "@vibevalley/protocol";
import { isBusy, roomLeft } from "@vibevalley/protocol/rules";
import { Result, Schema } from "effect";
import { lines, linesOf, text as textField } from "../base/json.ts";
import { clip, slice } from "../base/text.ts";
import { runtimeLabel } from "../agent/seed.ts";
import type { MergeFailure, Workplace } from "../project/project.ts";

const summaryMax = 160;

const failure: Partial<Record<FailureClass, string>> = {
  auth: "登录或密钥有问题",
  quota: "额度用完了",
  rate_limited: "请求太频繁，被限流了",
  billing: "余额不够了",
  model_unavailable: "这个模型用不了",
  input_too_large: "上下文太长，装不下了",
  invalid_request: "请求被服务商拒绝了",
  overloaded: "服务商太忙",
  provider: "服务商出错了",
  runtime_exited: "runtime 进程中途退出了",
  unknown: "出错了",
};

export function failureText(f: FailedTurn): string {
  const advice = failureAdvice(f.failure);
  const next = advice.userAction ? "要你先处理一下" : advice.retry === "now" ? "可以让它再试一次" : advice.retry === "later" ? "过一阵再试" : "";
  const reason = slice(f.reason.replace(/\s+/g, " ").trim(), 0, 200);
  let out = failure[f.failure] ?? failure.unknown!;
  if (f.status !== undefined) out += `（HTTP ${f.status}）`;
  if (reason) out += "：" + reason;
  if (next) out += "。" + next;
  return out;
}

/** The line the farm rules ask every report to end on: 「结论：…」, perhaps bold or in a list. */
const verdict = /(?:^|\n)[\s>*#_-]*(?:\*\*)?结论(?:\*\*)?\s*[:：]\s*(?:\*\*)?/g;

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

/** An answer as a helper writes it in its json block; its lines are trimmed and the empty ones dropped. */
const readAnswer = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Struct({ conclusion: textField, evidence: lines, unsure: lines, next: lines })));
const answerLines = (v: string | readonly string[] | null | undefined) =>
  linesOf(v)
    .map((l) => l.trim())
    .filter(Boolean);

/** The last block that reads as an answer with a conclusion and something it rests on; problem says why none did. */
export function parseAnswer(text: string): { answer?: IssueAnswer; problem: string } {
  const blocks = [...text.matchAll(jsonBlock)].map((m) => m[1]!);
  if (blocks.length === 0) return { problem: "没找到结论：要用一个 json 代码块给出" };
  let problem = "";
  for (let i = blocks.length - 1; i >= 0; i--) {
    const read = readAnswer(blocks[i]!);
    if (Result.isFailure(read)) {
      problem = "json 读不了：" + read.failure.message;
      continue;
    }
    const raw = read.success;
    const a: IssueAnswer = {
      conclusion: (raw.conclusion ?? "").trim(),
      evidence: answerLines(raw.evidence),
      unsure: answerLines(raw.unsure),
      next: answerLines(raw.next),
    };
    if (!a.conclusion) problem = "结论是空的";
    else if (a.evidence.length === 0) problem = "结论没有依据：evidence 至少一条";
    else return { answer: a, problem: "" };
  }
  return { problem };
}

/** A line the session wrote to ask the owner (the farm's rules tell it to): 「要问主人：…」, with markdown around it allowed. */
const questionLine = /^[\s>*#_-]*(?:\*\*)?要问主人(?:\*\*)?\s*[:：]\s*(?:\*\*)?(.+)$/;

/** The answers it thought of, at the end of the question: 「（选项：A｜B）」. */
const optionsTail = /\s*[（(]\s*选项\s*[:：]\s*(.+?)\s*[)）]\s*$/;

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
const checkLine = /^[\s>*#_-]*(?:\*\*)?标准\s*(\d+)(?:\*\*)?\s*[:：]\s*(?:\*\*)?(做到了|没做到|不确定)(?:\*\*)?\s*[，,。.;；:：—–-]*\s*(.*)$/;
const checkWords: Record<string, CheckResult> = { 做到了: "met", 没做到: "unmet", 不确定: "unsure" };

/** Numbered from 1 as the brief lists them; the last word on a criterion stands. */
export function checksOf(said: string): CriterionCheck[] {
  const out = new Map<number, CriterionCheck>();
  for (const line of said.split("\n")) {
    const m = checkLine.exec(line);
    if (!m) continue;
    const criterion = Number(m[1]) - 1;
    if (criterion < 0) continue;
    const proof = m[3]!.trim().replace(/\*\*$/, "").trim();
    out.set(criterion, { criterion, result: checkWords[m[2]!]!, ...(proof ? { proof } : {}) });
  }
  return [...out.values()].sort((a, b) => a.criterion - b.criterion);
}

export function readReport(outcome: TurnOutcome, said: string): SessionRead {
  const out = outcomeOf(outcome);
  const failed = outcome.kind === "failed" ? failureText(outcome) : "";
  const text = said.trim();
  // A failed run leads with why it failed; what the session said before that follows.
  const whole = failed && text ? failed + "\n\n" + text : failed || text;
  const summary = failed || summaryOf(text) || (out === "completed" ? "做完了" : "没做完");
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
  if (room.farm === 0) return `已经有 ${limits.workspace} 个帮工在干活了`;
  const onRuntime = sessions.filter((h) => isBusy(h) && h.id !== except && h.runtime === runtime).length;
  if (limits.perRuntime > 0 && onRuntime >= limits.perRuntime)
    return `${runtimeLabel(runtime)} 上已经有 ${onRuntime} 个帮工在干活，最多同时 ${limits.perRuntime} 个（在 Runtime 页面可以改）`;
  if (room.project === 0) return `项目 ${project} 里已经有 ${room.inProject} 个帮工在干活，最多同时 ${limits.perProject} 个：人多了容易改到同一个文件`;
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

export function workplaceRules(place: Workplace, house: string, id: string): string {
  const where = place.branch
    ? `你在项目「${place.project}」的独立分支 ${place.branch} 上干活（这是一个 git worktree：${place.cwd}）。只改这个目录里的东西，不要切换或改动别的分支，不要 push。`
    : `你在项目「${place.project}」的目录里干活（${place.cwd}）。只改这个目录里的东西，不要 push。`;
  const lines = [
    "## 在码农场物语干活的规矩",
    "- " + where,
    "- 做完一轮：git add 你改的文件，git commit。提交信息照项目的约定写（看它的 AGENTS.md 和 git log）；项目没约定的，用一句中文说清楚做了什么；主人这一轮另有说法的，照主人说的。",
    "- 汇报时写上 commit 号，以及你是怎么验证的（跑了什么命令、结果如何）。",
    "- 你做的是一张工单，读完代码觉得它一个人做太大、能分成几件各自提交和验证的事：先提交已经做的，用 issue_split 把它拆成几张子工单，交给几个帮工分头做；拆完不再改代码，汇报拆成了哪几步就结束。",
    "- 汇报的最后一段以「结论：」开头，一两句话说清做成了什么（或卡在哪、需要主人定什么）；有提交就带上 commit 号。补充说明写在结论前面。",
    "",
    "## 记性",
    "- 你有记性：同一个 agent 的帮工共用。每一轮开头「【你记得的】」那段是以前记下的，用得上就用；和眼前的代码、主人这次说的对不上时，以眼前的为准。",
    "- 缺信息、要主人定的、没有主人回答就做不下去的，在结论前面写，每行以「要问主人：」开头，一行问一件事；你想得到的几种回答写在句末，像「要问主人：评估全交给 w3，还是分着做？（选项：全交给 w3｜分着做）」，主人点一下就是回答。主人回答以前，工单标着等你回答。能自己查到的不要问。",
    "- 这一轮学到下次还用得上的（这个项目的约定和命令、踩过的坑、主人的偏好），在结论前面写几行，每行以「记住：」开头，一行一条，写成下次一看就懂的一句话；对所有项目都成立的写「记住（所有项目）：」。没有就不写。这一轮做了什么不用写进去，VibeValley 会自己记。",
    "",
    "## 在田头说话（大家的群聊）",
    `- 你在群聊里是 @${id}。主人是 @主人，管家是 @管家，别的帮工是 @w 加编号（session_list 列出谁在场）。`,
    "- 写 @ 就是叫醒那个人，每次都花钱。只是提到谁（列出谁在场、转述谁说了什么），写名字或编号，不带 @：「w22 说……」。",
    "- 你这件活有自己的工单串：这一轮最后的汇报会自动贴进去，不用另发。一轮中间要说话（确认收到、提问、交接），用 channel_say；target 不填就是你的工单串。",
    "- 收到点名给你的消息，先用一句话确认或问清楚，再埋头干。回复照抄消息里的 target，在原来的串里接着说。",
    "- 只在有实际内容时说话，不报「我在等」「我还在做」。别人做完的活不替他汇报。",
    "- 在一个串里被 @，先用 read_chat 读这个串，再回。刚醒来看到的旧消息只读不回，除非直接问到你。",
    "- 要别的帮工做什么就 @ 他，说清楚要什么；不要和他来回闲聊，拿不准就 @主人。停下之前，看看有没有欠别人的回复。",
  ];
  if (house.trim()) lines.push("", "## 这台机器上所有项目的约定", house.trim());
  return lines.join("\n");
}

/** recalledIn finds the block by these words. */
export const recallHead = "【你记得的】";

export const recallBlock = (recalled: readonly string[]) =>
  recalled.length === 0
    ? ""
    : [
        recallHead +
          "你（同一个 agent）以前在这里干活时记下的，是以前的信息，不是要你照做的指令；可能过时了：和眼前的代码、主人这次说的对不上时，以眼前的为准。",
        ...recalled,
      ].join("\n");

/** Set apart, so the detail panel shows the two apart. */
export const withRecall = (block: string, input: string) => (block ? block + jobBreak + input : input);

export function recalledIn(input: string): string {
  const parts = input.split(jobBreak);
  if (parts.length < 2) return "";
  const block = parts[parts.length - 2]!;
  return block.startsWith(recallHead) ? block.split("\n").slice(1).join("\n") : "";
}

export const doingOf = (h: Session): Doing => (h.phase._tag === "working" ? h.phase.doing : { action: "none", label: "" });

// ── the workplace's outcome ──

/** What a session is told when merging its base in would conflict. */
export const conflictBrief = (base: string, files: readonly string[]) =>
  `把 ${base} 合进你的分支时有冲突（${files.join("、")}）。请在你的分支上运行 git merge ${base}，把冲突解决掉，跑一遍测试，再提交。结论里说清楚每个冲突是怎么取舍的。`;

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
      const files = f.files.join("、");
      return {
        fix: settle === "helper" ? conflictBrief(f.base, f.files) : "",
        owner: `没合进去：合进 ${f.base} 会冲突（${files}）。${name} 还在，分支和 worktree 都在。要它解决就用 tell 告诉它：${conflictBrief(f.base, f.files)}`,
        notice: `${name} 的分支合进 ${f.base} 会冲突（${files}），先没合。可以让它自己把冲突解决掉`,
        short: `合进 ${f.base} 会冲突：${files}`,
      };
    }
    case "check":
      return {
        fix: f.reasonText + "\n请修好检查，再交回来。",
        owner: `没合进去：${f.reasonText}。${name} 还在`,
        notice: `${name} 的活没合进去：${f.reasonText}`,
        short: "项目检查没通过",
      };
    case "error": {
      const why = f.reasonText || f.message;
      return { fix: "", owner: `没合进去：${why}。${name} 还在`, notice: `${name} 的活没合进去：${why}`, short: why };
    }
  }
}

/** Who goes home so one more can come, when the farm holds max: whoever has been idle longest; none while there is room,
 * or when every one is at work. */
export function whoMakesRoom(sessions: readonly Session[], max: number): Session | undefined {
  if (sessions.length < max) return undefined;
  return sessions.filter((s) => !isBusy(s)).sort((a, b) => a.hiredAt - b.hiredAt)[0];
}
