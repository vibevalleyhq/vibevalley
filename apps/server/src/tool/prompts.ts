// How the tools word what they found.

import { t } from "@vibevalley/i18n";

import {
  type Artifact,
  type Block,
  type Changes,
  type Issue,
  type IssueStatus,
  IssueStatusValues,
  type IssueTimeline,
  type Memory,
  type Priority,
  PriorityValues,
  type Cron,
  type Spent,
  type UncommittedItem,
} from "@vibevalley/protocol";
import { phaseText, shortTitle, attentionWantsOwner } from "@vibevalley/protocol/rules";
import { runtimeLabel } from "@/agent/seed.ts";
import { nextText, whenText } from "@/cron/when.ts";
import { head } from "@/base/clip.ts";
import { yuan } from "@/runtime/money.ts";
import type { Handlers } from "@vibevalley/protocol/api";

type Op = keyof Handlers;
import type { Roster } from "@/session/session.ts";

const wan = (n: number) => (n >= 10_000 ? (n / 10_000).toFixed(n >= 100_000 ? 0 : 1) + " 万" : String(n));

export const spentText = (spent: Spent) => {
  const tokens = wan(spent.tokens) + " token";
  return spent.cny !== undefined ? "约 " + yuan(spent.cny) + " · " + tokens : tokens;
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

/** How a session reads to the orchestrator, in its situation as session_list gives it; number is its issue's. */
export function sessionLine(w: Roster, now: number, number?: number): string {
  const h = w.session;
  let last = "";
  if (h.lastRun) {
    last = "；上一轮" + t(`shared.outcome.${h.lastRun.outcome}`) + "：" + head(h.lastRun.summary, 80);
  }
  const where = w.place.branch ? "在 " + w.place.project + " 的 " + w.place.branch : "在 " + w.place.project;
  const task = h.graph ? (h.graph.task ? "，做计划 " + h.graph.id + " 的步骤 " + h.graph.task : "，在拆计划 " + h.graph.id) : "";
  const spent = h.spent ? "；花了" + spentText(h.spent) : "";
  const issue = number !== undefined ? `#${number} ` : "";
  return `- ${h.name}（${h.id}，${runtimeLabel(h.runtime)}，${where}${task}）工单 ${issue}「${head(h.brief, 60)}」，${phaseText(h, now)}${last}${spent}`;
}

/** The words for a status: its label (wording().status), a few the owner says for it, and its own name. */
const statusNames: Readonly<Record<string, IssueStatus>> = {
  ...Object.fromEntries(IssueStatusValues.map((s) => [t(`shared.status.${s}`), s])),
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
  "没有「" + word + "」这个状态：" + allowed.map((s) => t(`shared.status.${s}`)).join("、");
export const noSuchPriority = (word: string) => "没有「" + word + "」这个优先级：" + PriorityValues.map((p) => t(`shared.priority.${p}`)).join("、");

export const channelLine = (c: { readonly name: string; readonly default?: boolean; readonly description?: string; readonly project?: string }) =>
  "#" + c.name + (c.default === true ? "（默认）" : "") + (c.description ? "：" + c.description : "") + (c.project ? "（默认项目 " + c.project + "）" : "");

/** How long, in round words. */
export function spanWords(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 60) return `${Math.max(1, m)} 分钟`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小时`;
  return `${Math.floor(m / 60 / 24)} 天`;
}

/** One line: its number and short title first, so the orchestrator names it by them; who is the one doing it, when any. */
export function issueLine(issue: Issue, who: string, now: number): string {
  const st = issue.attention;
  const stuck = st.stuck ? "（" + t(`shared.stuck.${st.stuck}`) + "）" : "";
  const parts = [`#${issue.number}「${shortTitle(issue.title)}」${t(`shared.attention.${st.state}`)}${stuck}`];
  if (issue.project) parts.push(issue.project);
  if (who) parts.push(who);
  if (issue.priority !== "medium") parts.push(t(`shared.priority.${issue.priority}`) + "优先级");
  if (attentionWantsOwner(st.state) && st.since !== undefined) parts.push("等了 " + spanWords(now - st.since));
  return "- " + parts.join(" · ");
}

/** One issue in full: what it asks, its criteria as far as they got, what it waits on, and its story, newest first. */
export function issueDetail(issue: Issue, who: string, timeline: IssueTimeline | undefined, now: number): string {
  const lines = [issueLine(issue, who, now).slice(2)];
  if (issue.title !== shortTitle(issue.title) || issue.description) lines.push("要做的：" + head([issue.title, issue.description].join("\n").trim(), 600));
  const criteria = issue.criteria;
  if (criteria.length > 0) {
    lines.push("验收标准：");
    criteria.forEach((c, i) => {
      const check = issue.checks.find((x) => x.criterion === i);
      const mark = check ? { met: "做到了", unmet: "没做到", unsure: "不确定" }[check.result] : "还没说";
      lines.push(`  ${i + 1}. ${c}（${mark}）`);
    });
  }
  if (issue.questions.length > 0) lines.push("在等主人回答：" + issue.questions.map((a) => a.question).join("；"));
  const open = issue.findings.filter((f) => !f.resolved);
  if (open.length > 0) lines.push("验收没过要修的：" + open.map((f) => f.text).join("；"));
  if (issue.lastRun?.outcome) lines.push("最后一轮" + t(`shared.outcome.${issue.lastRun.outcome}`) + "，在等主人点头");
  if (issue.pullRequest) lines.push(`PR #${issue.pullRequest.number}（${issue.pullRequest.state}）${issue.pullRequest.url}`);
  for (const m of (timeline?.milestones ?? []).slice(0, 8)) lines.push(`  · ${spanWords(now - m.at)}前 ${m.who ? m.who + " " : ""}${head(m.text, 120)}`);
  return lines.join("\n");
}

export function cronLine(s: Cron, channel: string): string {
  const direct = s.agent ? "，直接派给 " + s.agent + (s.project ? " 去 " + s.project : "") : "";
  const next = s.enabled ? "下次 " + nextText(s) : nextText(s);
  return `- ${s.id} 号「${s.name}」#${channel} ${whenText(s.when, s.tz)}${direct}；${next}\n  ${s.text}`;
}

/** The way JavaScript's Date reads the forms a model writes. */
export function parseTime(s: string): number | undefined {
  const text = s.trim();
  if (text === "") return undefined;
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

// Parameter descriptions shared by several tools' schemas (tool/schemas.ts).
const issueOrAgent = "工单编号（#41 或 41）；也可以写在做它的帮工的名字";
const issueNumber = "工单编号（#41 或 41）";
const planId = "计划 id";
const projectFolder = "项目文件夹名";
const agentProfile = "帮工档案的名字或 id";
const searchText = "要找什么，几个词或一句话；不填就列出最新的";
const channelRef = "频道：#clock-in 这样的名字，或它的 id";

/** The orchestrator's and the session's tool parameter descriptions (tool/schemas.ts). */
export const params = {
  artifact: {
    title: "标题：主人在卡片上看到的那一行，最多 80 个字",
    kind: "html 是一整页（样式、脚本都写在这一个文件里，图片用 data: 或 https 地址，能用 https 上的图表库，但连不了网也调不了农场的接口），一版一版换；markdown 读成一块一块的，主人和你都能接着改（artifact_block_create、artifact_block_update）",
    content: "这一版的全文；和 file 二选一",
    file: "你工作目录里的一个文件（相对路径），服务端去读它当这一版的全文；和 content 二选一",
    note: "这一版改了什么，一句话；第一版可以写这是什么",
    channel: "在哪说：#<频道>，或 #<频道>:<消息号>（一个串）；不填就是你正在回话的地方",
    issue: "它是为哪张工单做的：编号（#12）；不填就不挂在工单上",
    id: "产出的 id：卡片上、artifact_list 的回答里有",
    version: "第几版；不填是最新的",
  },
  issueOrAgent,
  issueNumber,
  planId,
  projectFolder,
  agentProfile,
  searchText,
  channelRef,

  issueReview: {
    findings: "没过时，每条要修的一句话",
    pass: "验收过了就是 true",
    text: "没过时，还要交代的话",
  },
  graphSplit: {
    agent: "让谁来拆：帮工名字或 id；不填按规则挑",
    goal: "要做的事，照主人的原话",
  },
  issueCreate: {
    assignee: "谁来做：帮工的名字、id 或 runtime；不填，开工时按挑帮工的规则挑",
    channel: "工单串开在哪个频道，比如 #clock-in；不填就是你正在回话的频道",
    deliver:
      "交付什么：change 是改代码、合进项目（不填就是它）；branch 是改代码但分支留着不合（主人说「先别合」「分支留着」）；answer 是只查清楚、交回一份带依据的结论，不改代码（「查一下」「看看为什么」「是不是」）",
    description: "说明：主人说的原话和你补的背景；主人没说的写成建议或待定，不写成要求",
    draft: "要不要让帮工读过代码起草（写成标题、说明、验收标准）；会花钱，主人只是随口记一句时不用",
    priority: "紧急、高、普通、低；不填是普通",
    project: "项目文件夹名；频道有默认项目时可以不填；新项目起一个简短的英文名，开工时会新建",
    start: "记下就开工（没空位就排队）：只在主人要马上做时填 true；记一下、先别开始、只是指派都不填",
    title: "一句话的标题",
  },
  issueStatus: {
    assignee: "挪到待办时谁来做：填另一个帮工的名字、id 或 runtime 就是换人接手，上一个收工、分支留着",
    text: "带给帮工的一句话：从等你看挪回待办（再干一轮，等验收时就是验收意见，一行一条）、重开时必填；卡住了（没做成、冲突、被打断）不填就照原因接着修、解决冲突、接着做；换人时写接手的接着做什么",
    status: "挪到：备选、待办、已完成、已取消",
  },
  issueUpdate: {
    deliver: "交付方式：change（合进项目）、branch（分支留着不合）、answer（只交结论）",
    assignee: "谁来做：帮工的名字或 id（派出去以前才能改）",
    criteria: "验收标准，一条一个主人能照着验的点；给空列表就是清掉（派出去以前才能改）",
    description: "说明（派出去以前才能改）",
    priority: "紧急、高、普通、低",
    project: "项目（派出去以前才能改）",
    title: "标题（派出去以前才能改）",
  },
  issueList: {
    closed: "也列关上的（已完成、已取消）；不填只列开着的",
    limit: "最多列几张，默认 20",
    project: "只看这个项目的",
    status: "只看这个状态的：备选、待办、处理中、等你看、已完成、已取消",
    text: "标题或说明里有这些字的（找重复、找某件事时用）",
    wantsOwner: "只看在等主人的：等回答、等验收、卡住了；按等了多久排，久的在前",
  },
  memoryCreate: {
    project: "只在这个项目里用：项目文件夹名",
    text: "要它记住的一句话",
  },
  channelMessageList: {
    id: "#general、#clock-in，或 #general:<消息号>；管家和主人的私聊是 @owner",
  },
  cron: {
    agent: "直接派给哪个帮工档案（名字或 id）；不填就是到点交给你",
    at: "ISO 时间，带时区，比如 2026-10-13T09:00:00+08:00",
    channel: "在哪个频道，比如 #clock-in；不填是你正在回话的频道",
    expr: "五段 cron：分 时 日 月 周几",
    name: "简短的名字，比如 每日测试",
    project: "直接派活时的项目；不填用频道的默认项目",
    text: "到点时说的话：要做的事",
    tz: "时区，比如 Asia/Shanghai；不填是这台电脑的",
    when: "什么时候：kind 是 once（填 at）、every（填 minutes）、daily（填 time）、weekly（填 days 和 time）、cron（填 expr）",
  },
  graphTask: {
    agent: "帮工档案 id；空字符串表示按规则挑",
    brief: "工单",
    check: "做完跑的检查命令；空字符串表示不跑",
    needs: "要等哪几件做完",
    task: "这件的 id",
    newTask: "这件的 id（新加的就起一个简短的英文 id）",
  },
  issueComment: {
    text: "要带的话",
  },

  // The session's own schemas, where they differ from the orchestrator's.
  sessionMemory: {
    createProject: "不填记在你现在干活的项目；写空字符串是所有项目都用得上",
    searchProject: "不填找你现在干活的项目和所有项目都用的；写空字符串也找别的项目的",
    text: "一句以后还用得上的话：约定、坑、命令",
  },
  channelMessageSend: {
    anyway: "看过新消息、仍要原样发",
    confirm: "确实要发到频道的顶层，而不是刚读的那个串",
    replyTo: "回复同一处的哪一条：它的消息号（msg=）",
  },
  blockCreate: {
    level: "标题的级别 1–3，只给 heading 用；默认 2",
    text: "这一块的字；可以用 **粗**、_斜_、行内代码、~~删~~ 和链接；代码块照原样存",
    type: "块的类型：paragraph（默认）、heading、bulleted、numbered、todo、quote、code",
  },
  blockUpdate: {
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

/** A blocks artifact's block in one line: its id, revision, type and text (artifact_content_get, artifact_block_update's conflict). */
export const blockLine = (b: Block) => `- 〔${b.id} · 第 ${b.rev} 版 · ${b.type}〕${b.text.map((s) => s.t).join("")}`;

/** Where a memory applies, for the tools' answers. */
export const memoryWhere = (m: Memory) => (m.project ? "项目 " + m.project : "所有项目");

/** The orchestrator's tools' descriptions, shown to the model alongside each name and parameters (tool.ts). */
export const descriptions = {
  "project.list": "列出工作目录下的项目（每个文件夹是一个项目），以及是不是 git 仓库。",
  "channel.list": "列出频道：名字、哪个是默认的、是做什么的、默认项目。频道是安排活的地方。",
  "session.list": "列出在场的所有帮工：在做什么、上一轮的结果。",
  "issue.get": "看一张工单的全部：要做的、验收标准做到哪了、在等主人什么、来龙去脉；有帮工在做时加上它上一轮的完整汇报。",
  "issue.diff.get": "看完成一张工单会合进项目什么：它的提交、改了哪些文件（加减行数）、没提交的改动、会不会冲突。主人问「改了什么」或者完成前想确认时用。",
  "channel.message.list":
    "读一个频道或一个串里说的话。id 写 #<频道>（比如 #general），或 #<频道>:<消息号>（一个串），管家读和主人的私聊写 @owner；不填就是你正在回话的地方（帮工是自己的工单串）。unread 只读你还没读过的；before 填消息号往前翻。读过的算你看过了。",
  "issue.review":
    "验收一张交回来的工单：先用 issue_diff_get 看改动，对着它的验收标准逐条看。过了（pass: true）就记下验过，完成仍等主人说；没过就把每条要修的写进 findings，帮工会带着这些接着修一轮。",
  "issue.comment.create": "给在做一张工单的帮工带话：发在工单串里。它正在干就插进去（不能插话的 runtime 会排到这一轮之后），空闲就开新的一轮。",
  "session.stop": "叫停在做一张工单的帮工正在做的这一轮：工单和改动都留着，带句话就接着做。",
  "issue.list":
    "找工单、看一批工单：主人问「哪些在等我」（wantsOwner）、「某个项目有哪些」「卡住了哪些」、记一件事之前查有没有重复（text），都用它；看一张的全部用 issue_get。每行是编号、短标题、现在怎样、项目、谁在做、等了多久。",
  "issue.create":
    "记下一张工单。不填 start 就放进备选、不开工：主人说「记一下」「回头做」「先写下来」「让某某做、先别开始」时这样用。主人要马上做（「去做」「帮我改一下」）才填 start: true，记下就开工，没空位就排队。已经有工单的事不要再建：开工、接着做、换人用 issue_status_update。记之前先用 issue_list 的 text 查有没有差不多的，有就问主人是不是同一件。draft 让帮工读过代码把它写成标题、说明、验收标准（花钱），和 start 不一起用。",
  "issue.update":
    "改一张工单：优先级、交付方式随时能改；标题、说明、项目、谁来做、验收标准只在派出去以前能改。只在主人叫你改时用：你自己看出来该改的，先在频道里问主人。",
  "issue.status.update":
    "挪一张工单的状态，和主人在看板上拖卡片一样：备选挪到待办就是开工（没空位就排队）；排着队的挪回备选是先别开工；等你看挪回待办是带一句话再干一轮，卡住了不带话就照原因接着修、解决冲突、接着做；已完成、已取消挪回待办是带一句话重开；挪到待办时 assignee 填另一个帮工就是换人接手（在干的要先 session_stop）；等你看挪到已完成是完成，也就是验收通过：照工单的交付方式，有提交就合进主分支或开 PR，branch 的分支留着不合，没有改动不碰 git（主人要分支留着，先用 issue_update 把 deliver 改成 branch）；挪到已取消是不做了、帮工回家、改动不收。只在主人叫你挪时用；挪不了时照回答里的原因跟主人说。",
  "cron.create":
    "定一件按时间来的事：到点时频道里出现一条「⏰ 定时任务」消息，然后你收到它照着做；填了 agent 就直接派那个帮工去做（工单就是 text），不经过你。when.kind：once（at 填 ISO 时间，带时区，比如 2026-10-13T09:00:00+08:00）、every（minutes 每隔几分钟，至少 1）、daily（time 填 HH:MM）、weekly（days 填周几，0 是周日，加 time）、cron（expr 填五段：分 时 日 月 周几，比如工作日 9 点是 0 9 * * 1-5，每月 1 号 10 点是 0 10 1 * *；前四种说不清的才用它）。text 写清楚到时候做什么、做完告诉谁。",
  "cron.list": "列出定时：编号、在哪个频道、什么时候、下次什么时候、到点做什么。",
  "cron.delete": "删掉一个定时（编号从 cron_list 看）。",
  "channel.create":
    "开一个新频道：一件长期的事、一个项目，单独一个地方说话、派活。name 是频道名（字母、数字、汉字、- 和 _），description 写它是做什么的，project 是它的默认项目（在这里派的活默认在这个项目里干）。主人要求了才开。",
  "channel.update": "改一个频道是做什么的（description），或它的默认项目（project，写空字符串就是不要默认项目）。",
  "graph.split":
    "起一个计划：派一个帮工读代码，把一件很长的活拆成几件，有先后（每件一个帮工），拆好了等主人看过再开工。goal 是主人要做的事，照他的原话写全；project 是项目文件夹名。",
  "graph.list": "列出还没合进主分支的计划：每件的状态、谁在做、结论。",
  "graph.get": "看一个计划：每件的状态、谁在做、结论。",
  "graph.task.update":
    "改计划里的一件：工单、标题、要等的、谁来做、做完跑的检查命令；没有这一件就加上。没开工的计划什么都能改；开工以后只能改还没开始或没做成的。",
  "graph.task.delete": "从计划里删掉一件：没开工的计划都能删；开工以后只能删还没开始的。",
  "graph.act":
    "对整个计划：start 开工（主人看过、同意了才用），pause 暂停（正在做的做完，不开新的），resume 继续，abandon 放弃（分支留着），merge 合进主分支（都做完以后，把计划的分支合进主分支）。",
  "graph.task.act": "对计划里的一件：retry 重试没做成的，skip 跳过它（后面的照常开工）。",
  "memory.search":
    "在帮工档案的记性里找：它们记下的话、主人替它们记的、做过的活。agent 不填就找所有档案；project 只找那个项目的和所有项目都用的。派活前想知道某个项目有什么约定、谁做过类似的活时用。",
  "memory.create":
    "替一个帮工档案记一句，它以后派出去的帮工开工时会想起。主人要某个帮工以后都记得一件事时用；不填 project 就是所有项目都用。主人对你自己说的偏好用 remember。",
  "artifact.list": "列出产出：在一个频道里说过的，或为一张工单做的；都不填列出最近的。每行是 id、标题、种类、第几版、谁做的、最新这版改了什么。",
  "artifact.get": "看一个产出：每一版是谁做的、改了什么、在对话里哪条消息（主人的评论就是对它的回复）。",
  "artifact.content.get":
    "读一个产出：网页读某一版的全文，照主人的评论改下一版前先读；一起写的读每一块的 id、第几版、类型和字，改一块之前先读，artifact_block_update 要用这里的 id 和版本。",
  "artifact.create":
    "做一个产出：要交给主人看的一整页，比如两种设计让主人挑、调研报告、对比表、带图的说明。它挂在你说话的地方，你会以自己的名义说一句带卡片的话，主人在工作台里点开看、回复卡片评论。只是几句话的事直接说，不用它。",
  "artifact.version.create":
    "给一个网页（html）产出出新的一版（旧的留着）：照主人的评论改完以后用，note 写这版改了什么。会在第一版说过的地方再说一句带卡片的话。一起写的产出不出新版，一块一块改它。",
} satisfies Partial<Record<Op, string>>;

/** A session's tools' descriptions; channel_message_list is the orchestrator's. */
export const sessionDescriptions = {
  "channel.message.list": descriptions["channel.message.list"],
  "session.list": "现在谁在场：每个帮工的编号、名字、农机、在哪个项目、在做什么。",
  "channel.unread.list": "列出你还没读的对话：在哪、几条、有没有提到你、最后是谁说的。",
  "channel.message.send":
    "在群聊里发一条消息。id 不填就是你自己的工单串；#<频道> 是一个频道；#<频道>:<消息号> 是那条消息下面的串。正文里写 @w3、@管家、@主人 就是叫谁。目标里有你没看过的新消息时会先不发，把新消息给你看。",
  "memory.search":
    "在你的记性里找：你和主人以前替你的档案记下的话、做过的活。不填 project 只找这个项目的和所有项目都用的；project 写空字符串也找别的项目的。干到一半想知道「这个项目的测试怎么跑」「上次这个坑怎么绕过去的」时用。",
  "memory.create":
    "往你的记性里记一句，你的档案以后派出去的帮工开工时会想起。不填 project 记这个项目的；project 写空字符串记成所有项目都用的。只记以后还用得上的：约定、坑、命令，不记这一次的进度。",
  "artifact.block.create":
    "在一个一起写的产出末尾加一块。写长的东西时一段一块，不要把整篇塞进一块；写一块要接着改，就用回答里的 id 和版本调 artifact_block_update。",
  "artifact.block.update":
    "把一块的字整段换成新的。baseRev 是你读到或写下它时的版本：这之后别人改过它的字，就不改，回答里有现在的字和版本，看过再决定要不要照着重写。",
  "artifact.list":
    "列出产出：不填就是为你这张工单做的；channel 填 #<频道> 是在那里说过的。每行是 id、标题、是一起写的还是网页、第几版、谁做的、最新这版改了什么。",
  "artifact.get": "看一个产出：每一版是谁做的、改了什么、在对话里哪条消息（主人的评论就是对它的回复）。",
  "artifact.content.get":
    "读一个产出：网页读某一版的全文，照主人的评论改下一版前先读；一起写的读每一块的 id、第几版、类型和字，改一块之前先读，artifact_block_update 要用这里的 id 和版本。",
  "artifact.create":
    "做一个产出：要交给主人看、代码改动说不清的一整页，比如两种设计让主人挑、调研报告、对比表、带图的说明。先把它写成你工作目录里的一个文件，再用 file 交上来（或者直接给 content）。它挂在你的工单上，你会在工单串里说一句带卡片的话，主人在工作台里点开看、回复卡片评论，评论会叫醒你。",
  "artifact.version.create":
    "给一个网页（html）产出出新的一版（旧的留着）：照主人的评论改完以后用，note 写这版改了什么。会在第一版说过的地方再说一句带卡片的话。一起写的产出不出新版，一块一块改它。",
  "issue.split": (maxTasks: number) =>
    `把你手上这张工单拆成几张子工单，挂在它下面，马上派给几个帮工分头做（有先后的按 needs 等）。读完代码觉得这件活一个人做太大、能分成几件各自提交和验证的事时用；一般三到六张，最多 ${maxTasks} 张。拆之前把已经做的提交：计划的分支从你的分支顶上开，没提交的带不过去。拆完你就别再改代码，汇报拆成了哪几步，这一轮结束。`,
};

/** The answers and refusals the orchestrator's and the session's tools give (tool.ts). */
export const answers = {
  failed: (why: string) => "没成：" + why,
  artifact: {
    made: (a: Artifact) =>
      a.body === "html"
        ? `做好了「${a.title}」第 ${a.version} 版（id=${a.id}），已经在对话里带着卡片说了，主人在工作台点开看；主人回复那张卡片就是评论`
        : `做好了「${a.title}」（id=${a.id}），读成了一块一块的，已经在对话里带着卡片说了；要改哪一段，先用 artifact_content_get 读到块的 id 和版本，再 artifact_block_update；主人回复那张卡片就是评论`,
    versioned: (a: Artifact) => `「${a.title}」出了第 ${a.version} 版（id=${a.id}），已经在第一版说过的地方带着卡片说了`,
    none: "还没有产出",
    line: (a: Artifact) => {
      const note = a.versions.at(-1)?.note;
      const what = a.body === "html" ? `网页 · 第 ${a.version} 版` : "一起写的";
      return `- 〔${a.id}〕「${a.title}」${what} · ${a.byName}${note ? " · " + note : ""}`;
    },
    detail: (a: Artifact) =>
      [
        a.body === "html"
          ? `「${a.title}」（id=${a.id}）网页，${a.byName} 做的，最新是第 ${a.version} 版：`
          : `「${a.title}」（id=${a.id}）一起写的，${a.byName} 起的头；用 artifact_content_get 读它的每一块`,
        ...a.versions.map(
          (v) =>
            `- 第 ${v.version} 版 · ${v.byName}${v.note ? " · " + v.note : ""}${v.number !== undefined ? ` · 卡片是 msg=${v.number}，主人的评论是对它的回复` : ""}`,
        ),
      ].join("\n"),
    content: (title: string, version: number, content: string) => `「${title}」第 ${version} 版的全文：\n\n${content}`,
    noPlace: "找不到你的工作目录：用 content 直接给全文",
    outside: (file: string) => `${file} 不在你的工作目录里：只能交工作目录里的文件`,
    notFile: (file: string) => `${file} 不是一个文件`,
    noContent: "content 和 file 要给一个",
    both: "content 和 file 只给一个",
  },
  noIssueNumber: (k: string) => "没有 #" + k + " 这张工单：用 issue_list 找找",
  noIssueOrAgent: (k: string) => "没有叫 " + k + " 的工单或帮工：用 issue_list 找找",
  nobodyOn: (number: number) => `#${number} 现在没有帮工在做：要它接着做，主人说了以后用 issue_status_update 挪到待办`,
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
    wake: "要叫醒谁，就在 channel_message_send 的话里写 @ 加编号（如 @w3）、@管家、@主人；只是提到，不带 @。",
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
      `先没发：你刚读的是 ${lastRead}，这条却要发到 ${target} 顶层。要回在那个串里，就把 id 写成 ${lastRead}；确实要发到顶层，就加 confirm: true。`,
    sent: (target: string, msgNumber: number, absent: string) => `发出去了：${target} msg=${msgNumber}${absent}`,
    absentNote: (names: readonly string[]) => "。" + names.map((m) => "@" + m).join("、") + " 不在场，没送到",
  },
  readChat: {
    failed: (why: string) => "读不了：" + why,
    noUnread: (target: string) => target + " 里没有你没读的消息",
    empty: (target: string) => target + " 里还没有话",
    olderNote: (number: number) => `（更早的还有：before:${number} 往前翻）`,
    head: (target: string, older: string) => target + older + "：\n",
  },
  channelInbox: {
    empty: "没有没读的消息。",
    row: (target: string, unread: number, mentionsYou: boolean, latest: string) =>
      `- ${target}：${unread} 条` + (mentionsYou ? "，提到了你" : "") + (latest ? "，最后是 " + latest : ""),
    nextStep: (target: string) => "下一步：channel_message_list id=" + target + " unread=true",
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
  issues: {
    noneWaiting: "没有在等主人的工单。",
    none: "没有这样的工单。",
    moreNote: (count: number) => `\n（还有 ${count} 张没列）`,
  },
  issueCreate: {
    draftWithStartRefused: "没记：起草交回来以前开不了工。要马上做就不起草；要起草就先不开工。",
    noChannel: (name: string) => "没有 " + name + " 这个频道：先用 channel_list 看看有哪些，或者用 channel_create 开一个。",
    noDefaultProject: (channel: string) => "#" + channel + " 没有默认项目：填上 project。",
    noDeliver: "没记：deliver 是 change（改代码）、branch（改代码，分支留着）或 answer（只查、交结论）",
    notRecorded: (why: string) => "没记：" + why,
    notRecordedFailed: (why: string) => "没记下：" + why,
    noted: (number: number, title: string, answerOnly: boolean) => `记下了：#${number}「${title}」` + (answerOnly ? "（只查、交结论，不改代码）" : ""),
    queuedNoStart: (noted: string, why: string) => `${noted}，在备选里；没开工：${why}。要再开工用 issue_status_update 挪到待办，不要再建一张`,
    queuedInChannel: (noted: string, channel: string, queueNote: string) => `${noted}，在 #${channel} 排进待办：${queueNote}`,
    branchNote: (branch: string) => "，分支 " + branch,
    noAgentFallback: "帮工",
    who: (name: string, id: string) => name + "（" + id + "）",
    dispatched: (noted: string, channel: string, who: string, project: string, branch: string) => `${noted}，已在 #${channel} 派 ${who}去 ${project}${branch}`,
    notStartedNote: "，没开工",
    inBacklog: (noted: string, suffix: string) => `${noted}，在备选里${suffix}`,
    draftingNote: "，帮工在起草",
    draftFailed: (why: string) => "；起草没开始：" + why,
  },
  issueUpdate: {
    updated: (line: string) => "改好了：" + line,
    failed: (why: string) => "没改：" + why,
  },
  issueStatus: {
    notMoved: (why: string) => "没挪：" + why,
    prOpenNote: (number: number, url: string) => `#${number} 的 PR 开着：${url}，合了才算完成`,
    moved: (line: string) => "挪好了：" + line,
  },
  cron: {
    noChannelShort: (name: string) => "没有 " + name + " 这个频道：先用 channel_list 看看",
    badTime: (at: string) => "at 不是一个时间：" + (at || "（没填）"),
    pending: (line: string) =>
      "定好了，等主人同意才生效：\n" +
      line +
      "\n这一轮不是主人叫你定的，而它会反复来或直接派帮工：主人在定时任务列表里点「同意」才开始。跟主人说一声它是做什么的。",
    confirmed: (line: string) => "定好了：\n" + line,
  },
  listCrons: {
    none: "没有定时。",
  },
  cancelCron: {
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
    remembered: (where: string, memId: string) => "记下了（" + where + "）〔" + memId + "〕",
  },
  block: {
    header: (title: string, count: number) => "《" + title + "》，" + count + " 块：",
    appended: (id: string, rev: number) => `加了一块〔${id}〕，第 ${rev} 版。接着改它用 artifact_block_update，block 填 ${id}，baseRev 填 ${rev}。`,
    updated: (id: string, rev: number | undefined) => `改好了〔${id}〕，现在是第 ${rev} 版。`,
    notUpdated: (reason: string | undefined, rev: number | undefined, currentLine: string) =>
      `没改：${reason}，现在是第 ${rev} 版。${currentLine ? "\n现在的字：" + currentLine : ""}`,
  },
};
