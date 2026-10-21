// What is waiting on the owner: the inbox the phone rings with, and what the
// manager's patrol reads. A graph's own sessions leave their finished, failed and conflicted work to the graph, which
// asks in their place; a quiet one still asks.

import type { CoreState, InboxFrom, InboxItem } from "../shapes";
import { addressOf, channelOf, generalOf, messagesIn } from "./chat";
import { needOf } from "./phase";
import { graphsOf } from "./taskIssues";
import { cut, oneLine, slice } from "./text";

/** channel undefined: the general channel; since undefined: from when the reader first saw it. brief is for the manager, {ago} filled with how long it has waited. */
export interface InboxEntry {
  readonly item: InboxItem;
  readonly channel?: string;
  readonly since?: number;
  readonly brief: string;
}

/** Newest first; items of the same moment in the order they are gathered. */
export const inbox = (state: CoreState): InboxItem[] =>
  inboxEntries(state)
    .map((e) => e.item)
    .sort((a, b) => b.at - a.at);

export function inboxEntries(state: CoreState): InboxEntry[] {
  const chat = state.chat;
  const general = generalOf(chat)?.id;
  const out: InboxEntry[] = [];
  for (const h of state.sessions) {
    const need = needOf(h);
    if (!need || need.kind === "retrying" || (h.graph && need.kind !== "quiet")) continue;
    const channel = h.channel ?? general;
    const from: InboxFrom = { kind: "session", id: h.id, name: h.name, agent: h.agent };
    const target = { kind: "session", id: h.id } as const;
    const at = h.lastRun?.at ?? h.hiredAt;
    const summary = h.lastRun?.summary ? h.lastRun.summary : h.brief;
    const who = h.name + "（" + h.id + "）";
    switch (need.kind) {
      case "harvest":
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
      case "conflict": {
        const files = (need.conflict.files ?? []).length;
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
          item: { id: `${h.id}:quiet:${need.since}`, kind: "quiet", from, text: cut(h.brief, 40), at: need.since, target },
          channel,
          since: need.since,
          brief: who + "在干活，{ago}没动静了，最后在" + doing,
        });
        break;
      }
    }
  }

  const manager: InboxFrom = { kind: "manager" };
  for (const graph of graphsOf(state)) {
    const target = { kind: "graph", graph: graph.id } as const;
    switch (graph.state) {
      case "draft":
        out.push({
          item: { id: graph.id + ":draft", kind: "graph-draft", from: manager, text: cut(graph.title, 40), at: graph.createdAt, target },
          channel: general,
          brief: "种植计划「" + graph.title + "」（" + graph.id + "）拆好了，{ago}还没人看",
        });
        break;
      case "ripe":
        out.push({
          item: { id: graph.id + ":ripe", kind: "graph-ripe", from: manager, text: cut(graph.title, 40), at: graph.createdAt, target },
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
            item: { id, kind: "task-failed", from: manager, text: cut(graph.title + "：" + task.title, 40), at: graph.createdAt, target },
            channel: general,
            brief: "种植计划「" + graph.title + "」（" + graph.id + "）的步骤 " + task.id + "「" + task.title + "」没做成，{ago}没人管了" + why,
          });
        }
        break;
    }
  }

  for (const sc of state.schedules ?? []) {
    if (!sc.pending) continue;
    out.push({
      item: {
        id: sc.id + ":ask",
        kind: "schedule-ask",
        from: manager,
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
        const from: InboxFrom = m.fromKind === "agent" ? { kind: "session", id: m.from, name: m.name, agent: m.agent ?? "" } : manager;
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
