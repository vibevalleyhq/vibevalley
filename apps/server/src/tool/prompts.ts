// How the tools word what they found.

import { wording } from "@vibevalley/protocol/words";
import {
  type Block,
  type Changes,
  type Issue,
  type IssueStatus,
  IssueStatusValues,
  type IssueTimeline,
  type Memory,
  type Priority,
  PriorityValues,
  type Recurrence,
  type Spent,
  type UncommittedItem,
} from "@vibevalley/protocol";
import { phaseText, shortTitle, attentionWantsOwner } from "@vibevalley/protocol/rules";
import { runtimeLabel } from "../agent/seed.ts";
import { nextText, whenText } from "../recurrence/when.ts";
import { head } from "../base/text.ts";
import { yuan } from "../runtime/money.ts";
import type { Roster } from "../session/session.ts";

const wan = (n: number) => (n >= 10_000 ? (n / 10_000).toFixed(n >= 100_000 ? 0 : 1) + " 万" : String(n));

export const spentText = (spent: Spent) => {
  const tokens = wan(spent.tokens) + " token";
  return spent.cny !== undefined && spent.cny !== null ? "约 " + yuan(spent.cny) + " · " + tokens : tokens;
};

/** s.slice(-n), without splitting a character. */
export function tail(s: string, n: number): string {
  const chars = [...s];
  let units = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    units += chars[i]!.length;
    if (units > n) return chars.slice(i + 1).join("");
  }
  return s;
}

const paths = (items: readonly UncommittedItem[]) => items.map((f) => f.path).join("、");

export function changesText(c: Changes): string {
  if (!c.branch) return `它直接在项目 ${c.project} 里干活，没有分支可合。没提交的改动：${c.uncommitted.length > 0 ? paths(c.uncommitted) : "没有"}`;
  const lines = [`${c.branch} → ${c.project} 的 ${c.base}：${c.commits.length} 个提交，改了 ${c.files.length} 个文件。`];
  for (const x of c.commits.slice(0, 10)) lines.push("- " + x.hash + " " + x.subject);
  if (c.files.length > 0)
    lines.push(
      "文件：" +
        c.files
          .slice(0, 30)
          .map((f) => f.path + "（" + (f.added < 0 ? "二进制" : `+${f.added} −${f.removed}`) + "）")
          .join("、"),
    );
  if (c.uncommitted.length > 0) lines.push("还没提交（完成时会一起提交）：" + paths(c.uncommitted));
  if (c.behind > 0) lines.push(`这期间 ${c.base} 上多了 ${c.behind} 个提交。`);
  lines.push(c.conflicts.length > 0 ? "合进去会冲突：" + c.conflicts.join("、") + "。完成前要先让它解决。" : "能干净地合进去。");
  return lines.join("\n");
}

/** How a session reads to the orchestrator, in its situation as in roster; number is its issue's. */
export function sessionLine(w: Roster, now: number, number?: number): string {
  const h = w.session;
  let last = "";
  if (h.lastRun) {
    last = "；上一轮" + wording().outcome[h.lastRun.outcome] + "：" + head(h.lastRun.summary, 80);
  }
  const where = w.place.branch ? "在 " + w.place.project + " 的 " + w.place.branch : "在 " + w.place.project;
  const task = h.graph ? (h.graph.task ? "，做计划 " + h.graph.id + " 的步骤 " + h.graph.task : "，在拆计划 " + h.graph.id) : "";
  const spent = h.spent ? "；花了" + spentText(h.spent) : "";
  const issue = number !== undefined ? `#${number} ` : "";
  return `- ${h.name}（${h.id}，${runtimeLabel(h.runtime)}，${where}${task}）工单 ${issue}「${head(h.brief, 60)}」，${phaseText(h, now)}${last}${spent}`;
}

/** The words for a status: its label (wording().status), a few the owner says for it, and its own name. */
const statusNames: Readonly<Record<string, IssueStatus>> = {
  ...Object.fromEntries(IssueStatusValues.map((s) => [wording().status[s], s])),
  草稿: "backlog",
  在做: "in_progress",
  等验收: "in_review",
  完成: "done",
  取消: "canceled",
  ...Object.fromEntries(IssueStatusValues.map((s) => [s, s])),
};
export const statusOf = (word: string): IssueStatus | undefined => statusNames[word.trim()];

const priorityNames: Readonly<Record<string, Priority>> = {
  紧急: "urgent",
  高: "high",
  普通: "medium",
  中: "medium",
  低: "low",
  ...Object.fromEntries(PriorityValues.map((p) => [p, p])),
};
export const priorityOf = (word: string): Priority | undefined => priorityNames[word.trim()];

export const noSuchStatus = (word: string, allowed: readonly IssueStatus[]) =>
  "没有「" + word + "」这个状态：" + allowed.map((s) => wording().status[s]).join("、");
export const noSuchPriority = (word: string) => "没有「" + word + "」这个优先级：" + PriorityValues.map((p) => wording().priority[p]).join("、");

/** A channel in one line: its name, whether it is the default, what it is for, its default project. */
export const channelLine = (c: { readonly name: string; readonly default?: boolean; readonly description?: string; readonly project?: string }) =>
  "#" + c.name + (c.default ? "（默认）" : "") + (c.description ? "：" + c.description : "") + (c.project ? "（默认项目 " + c.project + "）" : "");

/** How long, in round words. */
export function spanWords(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 60) return `${Math.max(1, m)} 分钟`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小时`;
  return `${Math.floor(m / 60 / 24)} 天`;
}

/** One line: its number and short title first, so the orchestrator names it by them; who is the one doing it, when any. */
export function issueLine(t: Issue, who: string, now: number): string {
  const st = t.attention;
  const stuck = st.stuck ? "（" + wording().stuck[st.stuck] + "）" : "";
  const parts = [`#${t.number}「${shortTitle(t.title)}」${wording().attention[st.state]}${stuck}`];
  if (t.project) parts.push(t.project);
  if (who) parts.push(who);
  if (t.priority !== "medium") parts.push(wording().priority[t.priority] + "优先级");
  if (attentionWantsOwner(st.state) && st.since !== undefined) parts.push("等了 " + spanWords(now - st.since));
  return "- " + parts.join(" · ");
}

/** One issue in full: what it asks, its criteria as far as they got, what it waits on, and its story, newest first. */
export function issueDetail(t: Issue, who: string, timeline: IssueTimeline | undefined, now: number): string {
  const lines = [issueLine(t, who, now).slice(2)];
  if (t.title !== shortTitle(t.title) || t.description) lines.push("要做的：" + head([t.title, t.description ?? ""].join("\n").trim(), 600));
  const criteria = t.criteria ?? [];
  if (criteria.length > 0) {
    lines.push("验收标准：");
    criteria.forEach((c, i) => {
      const check = (t.checks ?? []).find((x) => x.criterion === i);
      const mark = check ? { met: "做到了", unmet: "没做到", unsure: "不确定" }[check.result] : "还没说";
      lines.push(`  ${i + 1}. ${c}（${mark}）`);
    });
  }
  if (t.questions.length > 0) lines.push("在等主人回答：" + t.questions.map((a) => a.question).join("；"));
  const open = t.findings.filter((f) => !f.resolved);
  if (open.length > 0) lines.push("验收没过要修的：" + open.map((f) => f.text).join("；"));
  if (t.lastRun?.outcome) lines.push("最后一轮" + wording().outcome[t.lastRun.outcome] + "，在等主人点头");
  if (t.pullRequest) lines.push(`PR #${t.pullRequest.number}（${t.pullRequest.state}）${t.pullRequest.url}`);
  for (const m of (timeline?.milestones ?? []).slice(0, 8)) lines.push(`  · ${spanWords(now - m.at)}前 ${m.who ? m.who + " " : ""}${head(m.text, 120)}`);
  return lines.join("\n");
}

export function recurrenceLine(s: Recurrence, channel: string): string {
  const direct = s.agent ? "，直接派给 " + s.agent + (s.project ? " 去 " + s.project : "") : "";
  const next = s.enabled ? "下次 " + nextText(s) : nextText(s);
  return `- ${s.id} 号「${s.name}」#${channel} ${whenText(s.when, s.tz)}${direct}；${next}\n  ${s.text}`;
}

/** The way JavaScript's Date reads the forms a model writes. */
export function parseTime(s: string): number | undefined {
  const t = s.trim();
  if (t === "") return undefined;
  const ms = new Date(t).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

// Parameter descriptions shared by several tools' schemas (tool/schemas.ts).
const issueOrAgent = "工单编号（#41 或 41）；也可以写在做它的帮工的名字";
const issueNumber = "工单编号（#41 或 41）";
const planId = "计划 id";
const projectFolder = "项目文件夹名";
const agentProfile = "帮工档案的名字或 id";
const searchQuery = "要找什么，几个词或一句话；不填就列出最新的";
const docId = "文档的 id";

/** The orchestrator's and the session's tool parameter descriptions (tool/schemas.ts). */
export const params = {
  issueOrAgent,
  issueNumber,
  planId,
  projectFolder,
  agentProfile,
  searchQuery,
  docId,

  accept: {
    findings: "没过时，每条要修的一句话",
    pass: "验收过了就是 true",
    text: "没过时，还要交代的话",
  },
  graphSplit: {
    agent: "让谁来拆：帮工名字或 id；不填按规则挑",
    goal: "要做的事，照主人的原话",
  },
  graphs: {
    id: "计划 id，比如 p1；不填列出所有还没合进主分支的",
  },
  issueCreate: {
    agent: "谁来做：帮工的名字、id 或 runtime；不填，开工时按挑帮工的规则挑",
    channel: "工单串开在哪个频道，比如 #clock-in；不填就是你正在回话的频道",
    deliver: "交付什么：change 是改代码、合进项目（不填就是它）；answer 是只查清楚、交回一份带依据的结论，不改代码（「查一下」「看看为什么」「是不是」）",
    description: "说明：主人说的原话和你补的背景；主人没说的写成建议或待定，不写成要求",
    draft: "要不要让帮工读过代码起草（写成标题、说明、验收标准）；会花钱，主人只是随口记一句时不用",
    priority: "紧急、高、普通、低；不填是普通",
    project: "项目文件夹名；频道有默认项目时可以不填；新项目起一个简短的英文名，开工时会新建",
    start: "记下就开工（没空位就排队）：只在主人要马上做时填 true；记一下、先别开始、只是指派都不填",
    title: "一句话的标题",
  },
  issueStatus: {
    agent: "挪到待办时谁来做：填另一个帮工的名字、id 或 runtime 就是换人接手，上一个收工、分支留着",
    keepBranch: "挪到已完成时：完成，但分支留着不合（主人说「先别合」「分支留着」时）",
    text: "带给帮工的一句话：从等你看挪回待办（再干一轮）、重开时必填；换人时写接手的接着做什么",
    to: "挪到：备选、待办、已完成、已取消",
  },
  issueUpdate: {
    acceptance: "验收方式：glance（完成就算验收）或 required（先验收通过才能完成）",
    agent: "谁来做：帮工的名字或 id（派出去以前才能改）",
    criteria: "验收标准，一条一个主人能照着验的点；给空列表就是清掉（派出去以前才能改）",
    description: "说明（派出去以前才能改）",
    priority: "紧急、高、普通、低",
    project: "项目（派出去以前才能改）",
    title: "标题（派出去以前才能改）",
  },
  issues: {
    closed: "也列关上的（已完成、已取消）；不填只列开着的",
    issue: "看一张的全部：工单编号（#41 或 41）；填了它别的条件都不看",
    limit: "最多列几张，默认 20",
    project: "只看这个项目的",
    status: "只看这个状态的：备选、待办、处理中、等你看、已完成、已取消",
    text: "标题或说明里有这些字的（找重复、找某件事时用）",
    wantsOwner: "只看在等主人的：等回答、等验收、卡住了；按等了多久排，久的在前",
  },
  memoryAdd: {
    project: "只在这个项目里用：项目文件夹名",
    text: "要它记住的一句话",
  },
  readChat: {
    target: "#general、#clock-in，或 #general:<消息号>",
  },
  recurrence: {
    agent: "直接派给哪个帮工档案（名字或 id）；不填就是到点交给你",
    channel: "在哪个频道，比如 #clock-in；不填是你正在回话的频道",
    cron: "五段 cron：分 时 日 月 周几",
    name: "简短的名字，比如 每日测试",
    project: "直接派活时的项目；不填用频道的默认项目",
    text: "到点时说的话：要做的事",
    tz: "时区，比如 Asia/Shanghai；不填是这台电脑的",
  },
  taskAction: {
    task: "这件的 id",
  },
  taskEdit: {
    agent: "帮工档案 id；空字符串表示按规则挑",
    brief: "工单",
    check: "做完跑的检查命令；空字符串表示不跑",
    needs: "要等哪几件做完",
    task: "这件的 id（新加的就起一个简短的英文 id）",
  },
  tell: {
    message: "要带的话",
  },

  // The session's own schemas, where they differ from the orchestrator's.
  sessionMemoryAdd: {
    agent: "不用填：只能记进你自己的档案",
    allProjects: "所有项目都用得上，不只是这个项目",
    text: "一句以后还用得上的话：约定、坑、命令",
  },
  sessionMemorySearch: {
    allProjects: "也找别的项目里记下的",
  },
  channelSay: {
    anyway: "看过新消息、仍要原样发",
    confirm: "确实要发到频道的顶层，而不是刚读的那个串",
  },
  docAppend: {
    level: "标题的级别 1–3，只给 heading 用；默认 2",
    text: "这一块的字；可以用 **粗**、_斜_、行内代码、~~删~~ 和链接；代码块照原样存",
    type: "块的类型：paragraph（默认）、heading、bulleted、numbered、todo、quote、code",
  },
  docUpdate: {
    baseRev: "你读到或写下这一块时它是第几版",
    block: "块的 id",
    text: "这一块完整的新字，不是增量",
  },
  issueSplit: {
    tasksDescription: "子工单，每张一个帮工在自己的分支上做完、提交、单独验证",
    task: {
      acceptance: "这张只写现在会失败的测试，别的都等它，合进去以后冻结",
      agent: "帮工档案 id；不填按规则挑",
      brief: "这张子工单：目标、改哪里、做到什么算完、留给后面的步骤什么；做它的帮工只看得到它和前面步骤的结论",
      check: "做完在它的分支上跑的检查命令，比如 go test ./...",
      id: "简短的英文小写 id，比如 schema、api",
      needs: "要等哪几张做完（填 id）；不互相依赖的会同时做",
      scope: "它要改的文件或目录；同时做的几张尽量不重叠",
    },
    title: "拆完的计划叫什么；不填照工单的标题",
  },
};

/** Who the orchestrator is, as a tool answer names it. */
export const ownerAgentWord = "管家";

/** A document's block in one line: its id, revision, type and text (tool.ts doc_read, doc_update's conflict). */
export const blockLine = (b: Block) => `- 〔${b.id} · 第 ${b.rev} 版 · ${b.type}〕${b.text.map((s) => s.t).join("")}`;

/** Where a memory applies, for the tools' answers. */
export const memoryWhere = (m: Memory) => (m.project ? "项目 " + m.project : "所有项目");

/** A tool's description, shown to the model alongside its name and parameters (tool.ts). */
export const descriptions = {
  projects: "列出工作目录下的项目（每个文件夹是一个项目），以及是不是 git 仓库。",
  channels: "列出频道：名字、哪个是默认的、是做什么的、默认项目。频道是安排活的地方。",
  roster: "列出在场的所有帮工：在做什么、上一轮的结果。",
  check: "看一张工单的全部：要做的、验收标准做到哪了、在等主人什么、来龙去脉；有帮工在做时加上它上一轮的完整汇报。",
  changes: "看完成一张工单会合进项目什么：它的提交、改了哪些文件（加减行数）、没提交的改动、会不会冲突。主人问「改了什么」或者完成前想确认时用。",
  sessionList: "现在谁在场：每个帮工的编号、名字、农机、在哪个项目、在做什么。",
  readChat:
    "读一个频道或一个串里说的话。target 写 #<频道>（比如 #general），或 #<频道>:<消息号>（一个串）；不填就是你正在回话的地方（帮工是自己的工单串）。unread 只读你还没读过的；before 填消息号往前翻。读过的算你看过了。",
  channelInbox: "列出你还没读的对话：在哪、几条、有没有提到你、最后是谁说的。",
  accept:
    "验收一张交回来的工单：先用 changes 看改动，对着它的验收标准逐条看。过了（pass: true）就能完成；没过就把每条要修的写进 findings，帮工会带着这些接着修一轮。",
  tell: "给在做一张工单的帮工带话：发在工单串里。它正在干就插进去（不能插话的 runtime 会排到这一轮之后），空闲就开新的一轮。",
  stop: "叫停在做一张工单的帮工正在做的这一轮。",
  dismiss: "让在做一张工单的帮工收工离开，不收它的改动（分支留着）。",
  issues:
    "找工单、看一批工单：主人问「哪些在等我」（wants_owner）、「某个项目有哪些」「卡住了哪些」、记一件事之前查有没有重复（text），都用它；填 issue 是看一张的全部。每行是编号、短标题、现在怎样、项目、谁在做、等了多久。",
  issueCreate:
    "记下一张工单。不填 start 就放进备选、不开工：主人说「记一下」「回头做」「先写下来」「让某某做、先别开始」时这样用。主人要马上做（「去做」「帮我改一下」）才填 start: true，记下就开工，没空位就排队。已经有工单的事不要再建：开工、接着做、换人用 issue_status。记之前先用 issues 的 text 查有没有差不多的，有就问主人是不是同一件。draft 让帮工读过代码把它写成标题、说明、验收标准（花钱），和 start 不一起用。",
  issueUpdate:
    "改一张工单：优先级、验收方式随时能改；标题、说明、项目、谁来做、验收标准只在派出去以前能改。只在主人叫你改时用：你自己看出来该改的，先在频道里问主人。",
  issueStatus:
    "挪一张工单的状态，和主人在看板上拖卡片一样：备选挪到待办就是开工（没空位就排队）；排着队的挪回备选是先别开工；等你看挪回待办是带一句话再干一轮；已完成、已取消挪回待办是带一句话重开；挪到待办时 agent 填另一个帮工就是换人接手（在干的要先 stop）；等你看挪到已完成是完成：照工单交付，有提交就合进主分支或开 PR，没有改动不碰 git，keep_branch 是完成但分支留着不合；挪到已取消是不做了、帮工回家、改动不收。只在主人叫你挪时用；挪不了时照回答里的原因跟主人说。",
  recurrence:
    "定一件按时间来的事：到点时频道里出现一条「⏰ 定时」消息，然后你收到它照着做；填了 agent 就直接派那个帮工去做（工单就是 text），不经过你。kind：once（at 填 ISO 时间，带时区，比如 2026-10-13T09:00:00+08:00）、every（minutes 每隔几分钟，至少 1）、daily（time 填 HH:MM）、weekly（days 填周几，0 是周日，加 time）、cron（cron 填五段：分 时 日 月 周几，比如工作日 9 点是 0 9 * * 1-5，每月 1 号 10 点是 0 10 1 * *；前四种说不清的才用它）。text 写清楚到时候做什么、做完告诉谁。",
  listRecurrences: "列出定时：编号、在哪个频道、什么时候、下次什么时候、到点做什么。",
  cancelRecurrence: "删掉一个定时（编号从 list_recurrences 看）。",
  openChannel:
    "开一个新频道：一件长期的事、一个项目，单独一个地方说话、派活。name 是频道名（字母、数字、汉字、- 和 _），description 写它是做什么的，project 是它的默认项目（在这里派的活默认在这个项目里干）。主人要求了才开。",
  channelSettings: "改一个频道是做什么的（description），或它的默认项目（project，写空字符串就是不要默认项目）。",
  graphSplit:
    "起一个计划：派一个帮工读代码，把一件很长的活拆成几件，有先后（每件一个帮工），拆好了等主人看过再开工。goal 是主人要做的事，照他的原话写全；project 是项目文件夹名。",
  graphs: "列出计划：每件的状态、谁在做、结论。",
  taskEdit:
    "改计划里的一件：工单、标题、要等的、谁来做、做完跑的检查命令；没有这一件就加上。remove 为 true 时删掉它。没开工的计划什么都能改；开工以后只能改还没开始或没做成的。",
  graphAction:
    "对整个计划：start 开工（主人看过、同意了才用），pause 暂停（正在做的做完，不开新的），resume 继续，abandon 放弃（分支留着），merge 合进主分支（都做完以后，把计划的分支合进主分支）。",
  taskAction: "对计划里的一件：retry 重试没做成的，skip 跳过它（后面的照常开工）。",
  docRead: "读一篇文档：每一块的 id、第几版、类型和字。改一块之前先读，doc_update 要用这里的 id 和版本。",
  docAppend: "在文档末尾加一块。写长的东西时一段一块，不要把整篇塞进一块；写一块要接着改，就用回答里的 id 和版本调 doc_update。",
  docUpdate: "把一块的字整段换成新的。base_rev 是你读到或写下它时的版本：这之后别人改过它的字，就不改，回答里有现在的字和版本，看过再决定要不要照着重写。",
  issueSplit: (maxTasks: number) =>
    `把你手上这张工单拆成几张子工单，挂在它下面，马上派给几个帮工分头做（有先后的按 needs 等）。读完代码觉得这件活一个人做太大、能分成几件各自提交和验证的事时用；一般三到六张，最多 ${maxTasks} 张。拆之前把已经做的提交：计划的分支从你的分支顶上开，没提交的带不过去。拆完你就别再改代码，汇报拆成了哪几步，这一轮结束。`,
  channelSay:
    "在群聊里发一条消息。target 不填就是你自己的工单串；#<频道> 是一个频道（channels 列出有哪些、哪个是默认的）；#<频道>:<消息号> 是那条消息下面的串。正文里写 @w3、@管家、@主人 就是叫谁。目标里有你没看过的新消息时会先不发，把新消息给你看。",
  memorySearchOrchestrator:
    "在帮工档案的记性里找：它们记下的话、主人替它们记的、做过的活。agent 不填就找所有档案；project 只找那个项目的和所有项目都用的。派活前想知道某个项目有什么约定、谁做过类似的活时用。",
  memorySearchSession:
    "在你的记性里找：你和主人以前替你的档案记下的话、做过的活。只找这个项目的和所有项目都用的；all_projects 也找别的项目的。干到一半想知道「这个项目的测试怎么跑」「上次这个坑怎么绕过去的」时用。",
  memoryAddOrchestrator:
    "替一个帮工档案记一句，它以后派出去的帮工开工时会想起。主人要某个帮工以后都记得一件事时用；不填 project 就是所有项目都用。主人对你自己说的偏好用 remember。",
  memoryAddSession:
    "往你的记性里记一句，你的档案以后派出去的帮工开工时会想起。记这个项目的；all_projects 记成所有项目都用的。只记以后还用得上的：约定、坑、命令，不记这一次的进度。",
};

/** The answers and refusals the orchestrator's and the session's tools give (tool.ts). */
export const answers = {
  failed: (why: string) => "没成：" + why,
  noIssueNumber: (k: string) => "没有 #" + k + " 这张工单：用 issues 找找",
  noIssueOrAgent: (k: string) => "没有叫 " + k + " 的工单或帮工：用 issues 找找",
  nobodyOn: (number: number) => `#${number} 现在没有帮工在做：要它接着做，主人说了以后用 issue_status 挪到待办`,
  noAgentToDispatch: "没有能派的帮工：先去「帮工」页面建一个，或者把 runtime 装好。",
  noAgentOrRuntime: (key: string) => "没有叫 " + key + " 的帮工档案或 runtime",
  rememberOwnNote: "你自己的记性在系统提示里：要记用 remember，要找旧对话用 search_archive",
  noProfileNamed: (key: string) => "没有叫 " + key + " 的帮工档案",
  notWorking: "你不在场：记性只给在干活的帮工用",

  projects: {
    empty: (root: string) => "工作目录（" + root + "）下还没有项目。",
    notGitYet: "（还不是 git 仓库，第一次派活时会建）",
  },
  roster: {
    empty: "现在没有在场的帮工。",
  },
  check: {
    workdir: (cwd: string) => "目录：" + cwd,
    lastReport: (text: string | undefined) => "上一轮完整汇报（结尾部分）：\n" + (text ? tail(text, 2000) : "还没有"),
  },
  changes: {
    failed: (why: string) => "看不了改动：" + why,
  },
  sessionList: {
    intro: "在场的有主人、管家，和这些帮工：",
    row: (id: string, name: string, runtime: string, project: string, phase: string, brief: string) =>
      `- ${id} ${name}（${runtime}，在 ${project}；${phase}）工单：${brief}`,
    wake: "要叫醒谁，就在 channel_say 的话里写 @ 加编号（如 @w3）、@管家、@主人；只是提到，不带 @。",
  },
  spoken: {
    held: (target: string, shownCount: number, more: number, inbox: string) =>
      [
        `先没发：${target} 里有 ${shownCount + more} 条你还没看过的新消息${more > 0 ? `（这里是最新的 ${shownCount} 条）` : ""}：`,
        inbox,
        "",
        "看过了：要改就改了再发；原样发就加 anyway: true；不用发了就不发。",
      ].join("\n"),
    confirm: (target: string, lastRead: string | undefined) =>
      `先没发：你刚读的是 ${lastRead}，这条却要发到 ${target} 顶层。要回在那个串里，就把 target 写成 ${lastRead}；确实要发到顶层，就加 confirm: true。`,
    sent: (target: string, msgNumber: number, absent: string) => `发出去了：${target} msg=${msgNumber}${absent}`,
    absentNote: (names: string) => "。" + names + " 不在场，没送到",
  },
  readChat: {
    failed: (why: string) => "读不了：" + why,
    noUnread: (target: string) => target + " 里没有你没读的消息",
    empty: (target: string) => target + " 里还没有话",
    olderNote: (number: number) => `（更早的还有：before:${number} 往前翻）`,
  },
  channelInbox: {
    empty: "没有没读的消息。",
    row: (target: string, unread: number, mentionsYou: boolean, latest: string) =>
      `- ${target}：${unread} 条` + (mentionsYou ? "，提到了你" : "") + (latest ? "，最后是 " + latest : ""),
    nextStep: (target: string) => "下一步：read_chat target=" + target + " unread=true",
  },
  accept: {
    passed: (number: number) => `#${number} 验收过了，等主人点完成`,
    failed: (number: number, count: number) => `#${number} 没过验收，${count} 处要修，已经交回给帮工`,
  },
  tell: {
    told: (number: number, name: string) => `已经在 #${number} 的工单串里跟 ${name} 说了`,
    failed: (why: string) => "没带到：" + why,
  },
  stop: {
    stopped: (number: number) => `#${number} 这一轮叫停了`,
  },
  dismiss: {
    dismissed: (name: string, number: number) => `${name} 收工了（#${number}）`,
  },
  issues: {
    noneWaiting: "没有在等主人的工单。",
    none: "没有这样的工单。",
    moreNote: (count: number) => `\n（还有 ${count} 张没列）`,
  },
  issueCreate: {
    draftWithStartRefused: "没记：起草交回来以前开不了工。要马上做就不起草；要起草就先不开工。",
    noChannel: (name: string) => "没有 " + name + " 这个频道：先用 channels 看看有哪些，或者用 open_channel 开一个。",
    noDefaultProject: (channel: string) => "#" + channel + " 没有默认项目：填上 project。",
    noDeliver: "没记：deliver 是 change（改代码）或 answer（只查、交结论）",
    notRecorded: (why: string) => "没记：" + why,
    notRecordedFailed: (why: string) => "没记下：" + why,
    noted: (number: number, title: string, answerOnly: boolean) => `记下了：#${number}「${title}」` + (answerOnly ? "（只查、交结论，不改代码）" : ""),
    queuedNoStart: (noted: string, why: string) => `${noted}，在备选里；没开工：${why}。要再开工用 issue_status 挪到待办，不要再建一张`,
    queuedInChannel: (noted: string, channel: string, queueNote: string) => `${noted}，在 #${channel} 排进待办：${queueNote}`,
    branchNote: (branch: string) => "，分支 " + branch,
    noAgentFallback: "帮工",
    dispatched: (noted: string, channel: string, who: string, project: string, branch: string) => `${noted}，已在 #${channel} 派 ${who}去 ${project}${branch}`,
    notStartedNote: "，没开工",
    inBacklog: (noted: string, suffix: string) => `${noted}，在备选里${suffix}`,
    draftingNote: "，帮工在起草",
    draftFailed: (why: string) => "；起草没开始：" + why,
  },
  issueUpdate: {
    noAcceptanceValue: "验收方式只有 glance 和 required",
    updated: (line: string) => "改好了：" + line,
    failed: (why: string) => "没改：" + why,
  },
  issueStatus: {
    notMoved: (why: string) => "没挪：" + why,
    prOpenNote: (number: number, url: string) => `#${number} 的 PR 开着：${url}，合了才算完成`,
    moved: (line: string) => "挪好了：" + line,
  },
  recurrence: {
    noChannelShort: (name: string) => "没有 " + name + " 这个频道：先用 channels 看看",
    badTime: (at: string) => "at 不是一个时间：" + (at || "（没填）"),
    pending: (line: string) =>
      "定好了，等主人同意才生效：\n" +
      line +
      "\n这一轮不是主人叫你定的，而它会反复来或直接派帮工：主人在定时列表里点「同意」才开始。跟主人说一声它是做什么的。",
    confirmed: (line: string) => "定好了：\n" + line,
  },
  listRecurrences: {
    none: "没有定时。",
  },
  cancelRecurrence: {
    canceled: (name: string) => "删掉了「" + name + "」。",
  },
  openChannel: {
    opened: (name: string, project: string) => "开好了 #" + name + (project ? "，默认项目 " + project : "") + "。",
  },
  channelSettings: {
    noChannel: (name: string) => "没有 " + name + " 这个频道",
    updated: (name: string) => "改好了 #" + name + "。",
  },
  graphs: {
    noGraphNamed: (id: string) => "没有 " + id + " 这个计划",
    none: "现在没有计划。",
  },
  memory: {
    rememberedFor: (id: string, where: string, memId: string) => "替 " + id + " 记下了（" + where + "）〔" + memId + "〕",
    notYourProfile: (mine: string, theirs: string) => "只能记进你自己的档案（" + mine + "），" + theirs + " 的记性不归你写",
    remembered: (where: string, memId: string) => "记下了（" + where + "）〔" + memId + "〕",
  },
  doc: {
    header: (title: string, count: number) => "《" + title + "》，" + count + " 块：",
    badBlockType: (types: readonly string[]) => "块的类型只能是 " + types.join("、"),
    appended: (id: string, rev: number) => `加了一块〔${id}〕，第 ${rev} 版。接着改它用 doc_update，block 填 ${id}，base_rev 填 ${rev}。`,
    updated: (id: string, rev: number | undefined) => `改好了〔${id}〕，现在是第 ${rev} 版。`,
    notUpdated: (reason: string | undefined, rev: number | undefined, currentLine: string) =>
      `没改：${reason}，现在是第 ${rev} 版。${currentLine ? "\n现在的字：" + currentLine : ""}`,
  },
};
