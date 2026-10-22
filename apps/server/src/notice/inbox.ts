// What is waiting on the owner: the inbox the phone rings with, and what the
// orchestrator's patrol reads; each item worded for every route the owner hears it on (the phone, the system notice, the
// tray, the call), so a kind added to InboxKind is worded once, here. A graph's own sessions leave their finished, failed and conflicted work to the graph, which
// questions in their place; a quiet one still questions.

import type { Question, WorkspaceState, InboxFrom, InboxItem, InboxKind, InboxWords, Session } from "@vibevalley/protocol";
import { addressOf, channelOf, generalOf, messagesIn } from "../channel/state.ts";
import { needOf } from "@vibevalley/protocol/rules";
import { graphsOf } from "../task/issues.ts";
import { cut, oneLine, slice } from "../base/text.ts";

/** channel undefined: the general channel; since undefined: from when the reader first saw it. brief is for the orchestrator, {ago} filled with how long it has waited. */
export interface InboxEntry {
  readonly item: InboxItem;
  readonly channel?: string;
  readonly since?: number;
  readonly brief: string;
}

/** Newest first; items of the same moment in the order they are gathered. */
export const inbox = (state: WorkspaceState): InboxItem[] =>
  inboxEntries(state)
    .map((e) => e.item)
    .sort((a, b) => b.at - a.at);

type Unworded = Omit<InboxEntry, "item"> & { readonly item: Omit<InboxItem, "who" | "words"> };

export function inboxEntries(state: WorkspaceState): InboxEntry[] {
  return gathered(state).map((e) => ({ ...e, item: worded(e.item) }));
}

function gathered(state: WorkspaceState): Unworded[] {
  const chat = state.chat;
  const general = generalOf(chat)?.id;
  const out: Unworded[] = [];
  for (const h of state.sessions) {
    const want = wantOf(h, state);
    if (!want || (h.graph && want.kind !== "quiet")) continue;
    const channel = h.channel ?? general;
    const from: InboxFrom = { kind: "session", id: h.id, name: h.name, agent: h.agent };
    const target = { kind: "session", id: h.id } as const;
    const at = h.lastRun?.at ?? h.hiredAt;
    const summary = h.lastRun?.summary ? h.lastRun.summary : h.brief;
    const who = h.name + "（" + h.id + "）";
    switch (want.kind) {
      case "ask": {
        const question = want.questions[0]?.question ?? "";
        out.push({
          item: { id: `${h.id}:ask:${h.runs}`, kind: "ask", from, text: cut(question, 40), at, target },
          channel,
          since: at,
          brief: who + "问了主人 " + want.questions.length + " 个问题，{ago}没人回：「" + slice(question, 0, 60) + "」",
        });
        break;
      }
      case "merge":
        out.push({
          item: { id: `${h.id}:merge:${h.runs}`, kind: "merge", from, text: cut(summary, 40), at, target },
          channel,
          since: at,
          brief: who + "的活做完 {ago}了还没收：「" + slice(h.brief, 0, 60) + "」",
        });
        break;
      case "fix":
        out.push({
          item: { id: `${h.id}:fix:${h.runs}`, kind: "fix", from, text: cut(summary, 40), at, target },
          channel,
          since: at,
          brief: who + "这一轮没做成，{ago}没人管了：「" + slice(summary, 0, 60) + "」",
        });
        break;
      case "interrupted":
        out.push({
          item: { id: `${h.id}:interrupted:${h.runs}`, kind: "interrupted", from, text: cut(summary, 40), at, target },
          channel,
          since: at,
          brief: who + "这一轮停在了半路，{ago}没人管了：「" + slice(h.brief, 0, 60) + "」",
        });
        break;
      case "conflict": {
        const files = (h.conflict?.files ?? []).length;
        out.push({
          item: { id: `${h.id}:conflict:${h.runs}`, kind: "conflict", from, text: `${files} 个文件和主分支冲突`, at, target },
          channel,
          since: at,
          brief: who + `的活合进主分支会冲突（${files} 个文件），{ago}没人管了`,
        });
        break;
      }
      case "quiet": {
        const doing = h.phase._tag === "working" && h.phase.doing.label !== "" ? "「" + h.phase.doing.label + "」" : "想事情";
        out.push({
          item: { id: `${h.id}:quiet:${want.since}`, kind: "quiet", from, text: cut(h.brief, 40), at: want.since, target },
          channel,
          since: want.since,
          brief: who + "在干活，{ago}没动静了，最后在" + doing,
        });
        break;
      }
    }
  }

  const orchestrator: InboxFrom = { kind: "orchestrator" };
  for (const graph of graphsOf(state)) {
    const target = { kind: "graph", graph: graph.id } as const;
    switch (graph.state) {
      case "draft":
        out.push({
          item: { id: graph.id + ":draft", kind: "graph-draft", from: orchestrator, text: cut(graph.title, 40), at: graph.createdAt, target },
          channel: general,
          brief: "种植计划「" + graph.title + "」（" + graph.id + "）拆好了，{ago}还没人看",
        });
        break;
      case "ripe":
        out.push({
          item: { id: graph.id + ":ripe", kind: "graph-ripe", from: orchestrator, text: cut(graph.title, 40), at: graph.createdAt, target },
          channel: general,
          brief: "种植计划「" + graph.title + "」（" + graph.id + "）都做完了，{ago}还没收",
        });
        break;
      case "running":
      case "paused":
        for (const task of graph.tasks) {
          if (task.state !== "failed") continue;
          // A step retried and failed again asks again: from its second failure the id counts them.
          const failures = task.failures ?? 0;
          const id = graph.id + ":failed:" + task.id + (failures > 1 ? `:${failures}` : "");
          const why = task.conclusion ? "：" + slice(task.conclusion, 0, 80) : "";
          out.push({
            item: { id, kind: "task-failed", from: orchestrator, text: cut(graph.title + "：" + task.title, 40), at: graph.createdAt, target },
            channel: general,
            brief: "种植计划「" + graph.title + "」（" + graph.id + "）的步骤 " + task.id + "「" + task.title + "」没做成，{ago}没人管了" + why,
          });
        }
        break;
    }
  }

  for (const sc of state.recurrences ?? []) {
    if (!sc.pending) continue;
    out.push({
      item: {
        id: sc.id + ":ask",
        kind: "recurrence-ask",
        from: orchestrator,
        text: cut(sc.name, 40),
        at: sc.created,
        target: { kind: "chat", conversation: sc.channel },
      },
      channel: sc.channel,
      since: sc.created,
      brief: "定时「" + sc.name + "」（" + sc.id + "）等主人同意，{ago}了",
    });
  }

  // A message said in full that names the owner, not read and not answered in its conversation yet.
  if (chat) {
    const lastFromUser = new Map<string, number>();
    for (const m of chat.messages ?? []) if (m.from === "user") lastFromUser.set(m.conversation, Math.max(lastFromUser.get(m.conversation) ?? 0, m.number));
    for (const c of chat.conversations ?? []) {
      const read = c.read ?? 0;
      for (const m of messagesIn(chat, c.id)) {
        if (!m.final || m.from === "user" || m.number <= read || (lastFromUser.get(c.id) ?? 0) > m.number || !(m.mentions ?? []).includes("user")) continue;
        const from: InboxFrom = m.fromKind === "agent" ? { kind: "session", id: m.from, name: m.name, agent: m.agent ?? "" } : orchestrator;
        out.push({
          item: { id: m.id, kind: "mention", from, text: cut(m.text, 40), at: m.at, target: { kind: "chat", conversation: c.id } },
          channel: channelOf(chat, c)?.id,
          since: m.at,
          brief: m.name + " 在 " + addressOf(chat, c) + " 问主人的话，{ago}没人回：「" + slice(oneLine(m.text), 0, 80) + "」",
        });
      }
    }
  }
  return out;
}

type Want =
  | { readonly kind: "ask"; readonly questions: readonly Question[] }
  | { readonly kind: "merge" | "fix" | "interrupted" | "conflict" }
  | { readonly kind: "quiet"; readonly since: number };

/** What a session questions of the owner. Its issue's attention says it, the one the issue page and the phone both read; a
 * session whose issue the state does not hold says it by its phase. */
function wantOf(h: Session, state: WorkspaceState): Want | undefined {
  const issue = h.issue === undefined ? undefined : state.issues?.find((t) => t.id === h.issue && t.sessions.at(-1) === h.id);
  if (!issue) {
    const need = needOf(h);
    switch (need?.kind) {
      case undefined:
      case "retrying":
        return undefined;
      case "harvest":
        return { kind: "merge" };
      case "fix":
        return { kind: "fix" };
      case "conflict":
        return { kind: "conflict" };
      case "quiet":
        return { kind: "quiet", since: need.since };
    }
  }
  const st = issue.attention;
  switch (st.state) {
    case "asking":
      return { kind: "ask", questions: issue.questions };
    case "reviewing":
      return { kind: "merge" };
    case "stuck":
      switch (st.stuck) {
        case "failed":
          return { kind: "fix" };
        case "interrupted":
          return { kind: "interrupted" };
        case "conflict":
          return { kind: "conflict" };
        case "quiet":
          return { kind: "quiet", since: st.since ?? h.hiredAt };
        case undefined:
          return { kind: "fix" };
      }
      return undefined;
    case "draft":
    case "queued":
    case "working":
    case "harvested":
    case "closed":
      return undefined;
  }
}

function clipLine(text: string, max = 140) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const words: Readonly<Record<InboxKind, (who: string, text: string) => InboxWords>> = {
  merge: (who, text) => ({ label: "活熟了", title: `${who} 做完了`, body: text, tray: `${who} 做完了，可以收` }),
  ask: (who, text) => ({ label: "有问题问你", title: `${who} 有问题问你`, body: text }),
  fix: (who, text) => ({ label: "活没做成", title: `${who} 没做成`, body: text, tray: `${who} 没做成` }),
  interrupted: (who, text) => ({ label: "停在了半路", title: `${who} 停在了半路`, body: text }),
  conflict: (who, text) => ({ label: "合不进去", title: `${who} 的活合进主分支会冲突`, body: text, tray: `${who} 的活会冲突` }),
  quiet: (who) => ({
    label: "好久没动静",
    title: `${who} 好一阵没动静了`,
    body: "可能在跑很久的命令，也可能卡住了：看看它的干活过程。",
    tray: `${who} 好一阵没动静`,
  }),
  "graph-draft": (_, text) => ({ label: "计划拆好了", title: `计划「${text}」拆好了`, body: "看过再开工", tray: `计划「${text}」等你看` }),
  "graph-ripe": (_, text) => ({
    label: "计划能收了",
    title: `计划「${text}」都做完了`,
    body: "看看改动，收获进主分支",
    tray: `计划「${text}」可以收获`,
  }),
  "task-failed": (_, text) => ({ label: "计划卡住了", title: `计划卡住了：${text}`, body: "重试、改工单，或者跳过", tray: `计划「${text}」没做成` }),
  mention: (who, text) => ({ label: "找你", title: `${who} 叫你`, body: text }),
  "recurrence-ask": (_, text) => ({
    label: "定时等你同意",
    title: "管家想定一个定时",
    body: `「${text}」：同意了才开始`,
    tray: `定时「${text}」等你同意`,
  }),
};

function worded(item: Omit<InboxItem, "who" | "words">): InboxItem {
  const who = item.from.kind === "session" ? item.from.name : "管家";
  return { ...item, who, words: words[item.kind](who, clipLine(item.text)) };
}
