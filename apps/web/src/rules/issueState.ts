// What an issue's page says first and what can be done with it, what a bug on its plot is, and the harvest's checklist.

import type { Changes, Doing, Issue, Session, SessionEvent, TaskGraph } from "@vibevalley/protocol";
import { endedAt, type IssueTag, issueInTask, issueTitle, tagLabel, tagOpen } from "./issues";
import { tookText, wallClockText } from "./time";
import type { Tone } from "./cards";

export type IssueAct = "stop" | "resolve" | "resume" | "harvest" | "cure" | "close";

export const actLabel: Record<IssueAct, string> = {
  stop: "叫停这一轮",
  resolve: "让它解决冲突",
  resume: "接着做",
  harvest: "收获",
  cure: "接着修",
  close: "关上",
};

/** `lead` is the one the page leads with (the primary button). */
export interface IssueOffer {
  act: IssueAct;
  lead: boolean;
}

export interface IssueStatusLine {
  head: string;
  line?: string;
  list: string[];
  tone: Tone;
}

/** The message 接着做 sends to a round that stopped halfway. */
export const resumeWords = "上一轮停在了半路，接着把它做完。";

/** 接着修: the session's brief, once, with what to do about the failure. */
export function bugText(task: string) {
  const original = task.replace(/^接着修：/, "").replace(/。看一下报错，修好再跑一遍测试$/, "");
  return `接着修：${original}。看一下报错，修好再跑一遍测试`;
}

const nothing: Doing = { action: "none", label: "" };
const doingOf = (s: Session): Doing => (s.phase._tag === "working" ? s.phase.doing : nothing);

/** `sessions` oldest first; `session` the one on the farm now, if any. */
export function issueState(issue: Issue, sessions: Session[], tag: IssueTag, session: Session | undefined, graphs: TaskGraph[]) {
  const head = session ?? sessions[sessions.length - 1]!;
  const graphId = head.graph?.id ?? issue.parent ?? (issue.graph ? issue.id : undefined);
  const graph = graphId === undefined ? undefined : graphs.find((g) => g.id === graphId);
  const node = head.graph?.task === undefined || !graph ? undefined : graph.tasks.find((t) => t.id === head.graph!.task);
  const inTask = issueInTask(issue, session);
  const current = doingOf(head);
  const open = tagOpen(tag);
  const lastOutcome = head.lastRun?.outcome;

  /** While it is judged, the verdict goes with the box: 没过 sends what it says as the findings. */
  const judging =
    !inTask && tag === "waiting" && session !== undefined && session.conflict === undefined && issue.acceptedAt === undefined && lastOutcome !== "failed";
  const talking = open && session !== undefined;
  const reopening = !open && !inTask;

  function offers(): IssueOffer[] {
    if (inTask || !session) return [];
    if (tag === "working")
      return [
        { act: "stop", lead: false },
        { act: "close", lead: false },
      ];
    if (tag !== "waiting") return [];
    if (session.conflict)
      return [
        { act: "resolve", lead: true },
        { act: "close", lead: false },
      ];
    // Stopped halfway (叫停, the server restarted): the work goes on first; what is there can still be harvested.
    if (session.lastRun?.outcome === "interrupted")
      return [
        { act: "resume", lead: true },
        { act: "harvest", lead: false },
        { act: "close", lead: false },
      ];
    const failed = session.lastRun?.outcome === "failed";
    return [
      // The server leaves done out of moves until a required acceptance has passed.
      ...(!failed && issue.moves.includes("done") ? [{ act: "harvest" as const, lead: true }] : []),
      ...(failed ? [{ act: "cure" as const, lead: true }] : []),
      { act: "close", lead: false },
    ];
  }

  function status(): IssueStatusLine {
    const who = head.name;
    const round = head.runs > 0 ? `第 ${Math.round(head.runs)} 轮` : undefined;
    const summary = head.lastRun?.summary;
    if (issue.asks.length > 0 && session) return { head: `缺肥：${who}在等你回答`, line: "在下面说一句就算回答。", list: issue.asks, tone: "wheat" };
    if (session?.conflict) return { head: `合进 ${session.conflict.base} 会冲突`, line: session.conflict.files.join("、"), list: [], tone: "berry" };
    if (tag === "working") {
      const doing = current.action === "none" ? "在干活" : `正在${current.actionText ?? ""}`;
      const quiet = head.phase._tag === "working" && head.phase.quietSince !== undefined;
      return {
        head: `${who} ${doing}${round ? `（${round}）` : ""}`,
        line: quiet ? "很久没动静：可能在跑很久的命令，也可能卡住了。" : current.label || undefined,
        list: [],
        tone: "leaf",
      };
    }
    if (tag === "waiting") {
      if (lastOutcome === "failed") return { head: "这一轮没做成", line: summary, list: [], tone: "berry" };
      if (lastOutcome === "interrupted") return { head: "停在了半路", line: summary, list: [], tone: "wheat" };
      if (issue.acceptedAt !== undefined) return { head: "验收过了，可以收获", line: summary, list: [], tone: "leaf" };
      return { head: `等你验收 · ${who}交回来了${round ? `（${round}）` : ""}`, line: summary, list: [], tone: "wheat" };
    }
    const closed = issue.closedAt;
    return { head: closed === undefined ? tagLabel[tag] : `${tagLabel[tag]} · ${wallClockText(closed)}`, line: summary, list: [], tone: "faint" };
  }

  // Each helper once, the first time it worked the issue.
  const crew = sessions.filter((s, i) => !sessions.slice(0, i).some((x) => x.agent === s.agent));
  const hand = head.worktree !== undefined ? session : undefined;

  return {
    issue,
    head,
    session,
    tag,
    inTask,
    open,
    judging,
    talking,
    reopening,
    hasBox: talking || reopening,
    enterSends: !judging,
    title: issueTitle(issue, graphs),
    description: issue.description || head.brief,
    project: issue.project ?? head.project,
    taskText: !graph
      ? "这是种植计划里的一步，跟着计划走。"
      : !node
        ? `在拆种植计划「${graph.title}」：只读代码，不改文件。`
        : `种植计划「${graph.title}」的一步：${node.title}。做完自动合进计划分支，收获整个计划时才进主分支。`,
    weeds: issue.findings.filter((f) => !f.pulled),
    pulled: issue.findings.filter((f) => f.pulled),
    placeholder: judging
      ? "没过就写哪里要修，一行一条；也可以只带句话"
      : reopening
        ? "这次要它做什么（不填就是接着做完）"
        : session?.phase._tag === "working"
          ? "干着活也能收到这句话"
          : "说一句，它接着做一轮",
    boxLabel: reopening ? "重开这张工单" : `给${head.name}带句话`,
    acceptanceEditable: !inTask,
    crewLine:
      crew.length <= 1 && !hand
        ? undefined
        : // One plot, one worktree: only the session on it now changes the code.
          [crew.map((c) => c.name).join("、"), ...(hand ? [`锄头在${hand.name}手上`] : [])].join(" · "),
    whoLine: `${head.name}${head.runtime ? `（${head.runtime}）` : ""}`,
    historyLine: `${sessions.length} 次：${sessions.map((r) => `${r.name}（${r.id}）`).join(" → ")}`,
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
    showsChanges: tag === "waiting" && session !== undefined,
    offers: offers(),
    status: status(),
  };
}

export type IssueState = ReturnType<typeof issueState>;

/** 没过: what the box says, one finding a line, blank lines dropped. */
export const findingsOf = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

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

/** Nothing to merge: harvesting only lets the helper go. */
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
