// What an issue's page says, top to bottom, for the owner: what it is, where it stands, what is asked of the owner, how far
// it is against its criteria; and what a bug on its plot is, and the changes to look at before completing. Where it stands (and what the
// owner may do) is the server's Issue.attention; this only words it.

import type { Changes, Doing, Issue, IssueAttention, Session, SessionEvent, Attention, TaskGraph } from "@vibevalley/protocol";
import { shortTitle, attentionLabel } from "@vibevalley/protocol/rules";
import { endedAt, issueInTask, issueTitle } from "./issues";
import { tookText } from "./time";
import type { Tone } from "./cards";

export const attentionTone: Record<Attention, Tone> = {
  draft: "faint",
  queued: "faint",
  working: "water",
  asking: "wheat",
  reviewing: "wheat",
  stuck: "berry",
  done: "leaf",
  canceled: "faint",
};

export { attentionLabel };

/** How long, in round words: 不到 1 分钟, 3 分钟, 2 小时, 4 天. */
export function spanText(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "不到 1 分钟";
  if (m < 60) return `${m} 分钟`;
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小时`;
  return `${Math.floor(m / 60 / 24)} 天`;
}

/** The block that asks the owner for the one thing: its head and what it says under it. */
export interface OwnerQuestion {
  head: string;
  line?: string;
  tone: Tone;
}

const nothing: Doing = { action: "none", label: "" };
const doingOf = (s: Session): Doing => (s.phase._tag === "working" ? s.phase.doing : nothing);

/** One of the criteria as far as it got: the helper's word on it, if it gave one. */
export interface CriterionRow {
  text: string;
  result?: "met" | "unmet" | "unsure";
  proof?: string;
}

function criteriaRows(issue: Issue): CriterionRow[] {
  return (issue.criteria ?? []).map((text, i) => {
    const c = (issue.checks ?? []).find((x) => x.criterion === i);
    return { text, ...(c ? { result: c.result, ...(c.proof ? { proof: c.proof } : {}) } : {}) };
  });
}

/** The one thing the owner is asked for, worded; undefined when nothing is asked of the owner. */
function ownerQuestion(attention: IssueAttention, issue: Issue, head: Session): OwnerQuestion | undefined {
  const who = head.name;
  const said = head.lastRun?.summary;
  switch (attention.state) {
    case "asking":
      return { head: `${who}有 ${issue.questions.length} 个问题要问你`, line: "点一个选项就是回答，也可以自己说。", tone: "wheat" };
    case "reviewing":
      return issue.reviewedAt !== undefined
        ? { head: "验收过了，可以完成", ...(said ? { line: said } : {}), tone: "leaf" }
        : { head: `${who}交回来了，等你验收`, ...(said ? { line: said } : {}), tone: "wheat" };
    case "stuck":
      switch (attention.stuck) {
        case "conflict":
          return { head: `合进 ${head.conflict?.base ?? "主分支"} 会冲突`, line: head.conflict?.files.join("、"), tone: "berry" };
        case "failed":
          return { head: "这一轮没做成", ...(said ? { line: said } : {}), tone: "berry" };
        case "interrupted":
          return { head: "这一轮停在半路", ...(said ? { line: said } : {}), tone: "wheat" };
        case "quiet":
          return { head: `${who}很久没动静了`, line: "可能在跑很久的命令，也可能卡住了：看看它的每一步，不对就叫停。", tone: "berry" };
        case undefined:
          return { head: "卡住了", tone: "berry" };
      }
      break;
    case "canceled":
      return attention.lead === "reopen" ? { head: "已取消", line: "要它接着做就重开：写一句这次要做什么。", tone: "faint" } : undefined;
    case "draft":
    case "queued":
    case "working":
    case "done":
      return undefined;
  }
}

/** `sessions` oldest first; `session` the one on the farm now, if any. */
export function issueState(issue: Issue, sessions: Session[], session: Session | undefined, graphs: TaskGraph[]) {
  const head = session ?? sessions[sessions.length - 1]!;
  const graphId = head.graph?.id ?? issue.parent ?? (issue.graph ? issue.id : undefined);
  const graph = graphId === undefined ? undefined : graphs.find((g) => g.id === graphId);
  const node = head.graph?.task === undefined || !graph ? undefined : graph.tasks.find((t) => t.id === head.graph!.task);
  const attention = issue.attention;
  const current = doingOf(head);
  const rows = criteriaRows(issue);
  // Each helper once, the first time it worked the issue.
  const crew = sessions.filter((s, i) => !sessions.slice(0, i).some((x) => x.agent === s.agent));
  const hand = head.worktree !== undefined ? session : undefined;
  const fullTitle = issueTitle(issue, graphs);
  const title = shortTitle(fullTitle);

  return {
    issue,
    head,
    session,
    attention,
    inTask: issueInTask(issue, session),
    open: attention.state !== "done" && attention.state !== "canceled",
    title,
    /** The whole of a title too long for the page's first line goes with the description. */
    description: [title !== fullTitle ? fullTitle : "", issue.description || (title === head.brief ? "" : head.brief)].filter(Boolean).join("\n\n"),
    project: issue.project ?? head.project,
    taskText: !graph
      ? "这是计划里的一步，跟着计划走。"
      : !node
        ? `在拆计划「${graph.title}」：只读代码，不改文件。`
        : `计划「${graph.title}」的一步：${node.title}。做完自动合进计划的分支，整个计划合进主分支时才进主分支。`,
    ask: ownerQuestion(attention, issue, head),
    /** The lead act and the rest the owner may do, as the server says. */
    lead: attention.lead,
    others: attention.acts.filter((a) => a !== attention.lead),
    criteria: rows,
    met: rows.filter((r) => r.result === "met").length,
    doing:
      attention.state === "working" && current.action !== "none" ? `正在${current.actionText ?? ""}${current.label ? "：" + current.label : ""}` : undefined,
    openFindings: issue.findings.filter((f) => !f.resolved),
    resolvedFindings: issue.findings.filter((f) => f.resolved),
    crewLine:
      crew.length <= 1 && !hand
        ? undefined
        : // One plot, one worktree: only the session on it now changes the code.
          [crew.map((c) => c.name).join("、"), ...(hand ? [`${hand.name}在改代码`] : [])].join(" · "),
    whoLine: `${head.name}${head.runtime ? `（${head.runtime}）` : ""}`,
    historyLine: `${sessions.length} 次：${sessions.map((r) => `${r.name}（${r.id}）`).join(" → ")}`,
    /** 在等你 · 已经 3 分钟 · Claude 师傅 · 第 2 轮 · 用了 4 分钟 · ¥0.42; cny is all the issue's runs when known. */
    statusLine(now: number, cny?: number) {
      const s = session ?? head;
      const turns = Math.round(s.runs);
      return [
        attentionLabel[attention.state],
        ...(attention.since !== undefined ? [`已经 ${spanText(now - attention.since)}`] : []),
        head.name,
        ...(turns > 0 ? [`跑了 ${turns} 轮`] : []),
        `用了 ${spanText((endedAt(head) ?? now) - sessions[0]!.hiredAt)}`,
        ...((cny ?? s.spent?.cny) !== undefined ? [`¥${(cny ?? s.spent!.cny!).toFixed(2)}`] : []),
      ].join(" · ");
    },
    usedLine(steps: SessionEvent[], now: number) {
      const s = session ?? head;
      const turns = s.runs > 0 ? Math.round(s.runs) : steps.filter((e) => e.type === "run/start").length;
      return [
        `${turns} 轮`,
        tookText((endedAt(head) ?? now) - head.hiredAt),
        ...(s.spent?.cny !== undefined ? [`花了 ¥${s.spent.cny.toFixed(2)}`] : []),
        ...(head.spent && head.spent.tokens > 0 ? [`${Math.round(head.spent.tokens)} token`] : []),
      ].join(" · ");
    },
    /** What it made, while there is a worktree to read it from. */
    showsChanges: session !== undefined && attention.state !== "done" && attention.state !== "canceled",
  };
}

export type IssueState = ReturnType<typeof issueState>;

/** A binary file counts -1: not counted. */
export const lineCounts = (c: Changes): [number, number] => [
  c.files.reduce((n, f) => n + Math.max(0, Math.round(f.added)), 0),
  c.files.reduce((n, f) => n + Math.max(0, Math.round(f.removed)), 0),
];

/** The one line over an issue's changes. */
export function changesLine(c: Changes) {
  const [added, removed] = lineCounts(c);
  return `${c.branch ?? ""} → ${c.base} · ${c.commits.length} 个提交 · +${added} -${removed}${c.uncommitted.length ? ` · ${c.uncommitted.length} 个没提交` : ""}`;
}

/** The empty 干活过程 says why. */
export const noStepsText = (head: Session) =>
  endedAt(head) === undefined ? "还没有步骤。" : "干活过程只留 30 天（配置里的 session.trajectory_days），这张工单的已经清掉了。";

/** Nothing to merge: completing only lets the helper go. */
export const nothingChanged = (c: Changes) => c.commits.length === 0 && c.uncommitted.length === 0;

/** What a git status letter is, as a mark and a word; an unknown one is itself. */
export function changeKind(status: string) {
  switch (status) {
    case "A":
      return { mark: "新", label: "新增" };
    case "M":
      return { mark: "改", label: "修改" };
    case "D":
      return { mark: "删", label: "删除" };
    default:
      return { mark: status, label: status };
  }
}

export type PatchMark = "added" | "removed" | "hunk" | "plain";

export const patchMarkOf = (line: string): PatchMark =>
  line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : line.startsWith("@@") ? "hunk" : "plain";

/** A patch from its first hunk: the header above it says nothing the file row does not. */
export function patchLines(text: string) {
  const lines = text.split("\n");
  return lines.slice(
    Math.max(
      0,
      lines.findIndex((l) => l.startsWith("@@")),
    ),
  );
}
