// What is waiting on the owner: the inbox the phone rings with, and what the
// orchestrator's patrol reads; each item worded for every route the owner hears it on (the phone, the system notice, the
// tray, the call), so a kind added to InboxKind is worded once, here. A graph's own sessions leave their finished, failed and conflicted work to the graph, which
// questions in their place; a quiet one still questions.

import { t } from "@vibevalley/i18n";
import type { Question, WorkspaceState, InboxFrom, InboxItem, InboxKind, InboxWords, Session } from "@vibevalley/protocol";
import { needOf, omitUndefined } from "@vibevalley/protocol/rules";

import { cut, oneLine, slice } from "@/base/clip.ts";
import { defaultOf } from "@/channel/folded.ts";
import { graphsOf } from "@/task/issues.ts";

import { patrolBrief, patrolWho } from "./prompts.ts";

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
    .toSorted((a, b) => b.at - a.at);

type Unworded = Omit<InboxEntry, "item"> & { readonly item: Omit<InboxItem, "who" | "words"> };

export function inboxEntries(state: WorkspaceState): InboxEntry[] {
  return gathered(state).map((e) => ({ ...e, item: worded(e.item) }));
}

function gathered(state: WorkspaceState): Unworded[] {
  const chat = state.chat;
  const general = defaultOf(chat)?.id;
  const out: Unworded[] = [];
  // The channel is the session's or the default one; a farm without channels has neither.
  const push = (e: Omit<Unworded, "channel"> & { readonly channel: string | undefined }) => out.push(omitUndefined(e));
  for (const h of state.sessions) {
    const want = wantOf(h, state);
    if (!want || (h.graph && want.kind !== "quiet")) continue;
    const channel = h.channel ?? general;
    const from: InboxFrom = { kind: "session", id: h.id, name: h.name, agent: h.agent };
    const target = { kind: "session", id: h.id } as const;
    const at = h.lastRun?.at ?? h.hiredAt;
    const summary = h.lastRun?.summary ? h.lastRun.summary : h.brief;
    const who = patrolWho(h.name, h.id);
    switch (want.kind) {
      case "ask": {
        const question = want.questions[0]?.question ?? "";
        push({
          item: { id: `${h.id}:ask:${h.runs}`, kind: "ask", from, text: cut(question, 40), at, target },
          channel,
          since: at,
          brief: patrolBrief.ask(who, want.questions.length, slice(question, 0, 60)),
        });
        break;
      }
      case "review":
        push({
          item: { id: `${h.id}:review:${h.runs}`, kind: "review", from, text: cut(summary, 40), at, target },
          channel,
          since: at,
          brief: patrolBrief.review(who, slice(h.brief, 0, 60)),
        });
        break;
      case "fix":
        push({
          item: { id: `${h.id}:fix:${h.runs}`, kind: "fix", from, text: cut(summary, 40), at, target },
          channel,
          since: at,
          brief: patrolBrief.fix(who, slice(summary, 0, 60)),
        });
        break;
      case "interrupted":
        push({
          item: { id: `${h.id}:interrupted:${h.runs}`, kind: "interrupted", from, text: cut(summary, 40), at, target },
          channel,
          since: at,
          brief: patrolBrief.interrupted(who, slice(h.brief, 0, 60)),
        });
        break;
      case "conflict": {
        const files = (h.conflict?.files ?? []).length;
        push({
          item: { id: `${h.id}:conflict:${h.runs}`, kind: "conflict", from, text: t("server.inbox.conflictFiles", { files }), at, target },
          channel,
          since: at,
          brief: patrolBrief.conflict(who, files),
        });
        break;
      }
      case "quiet": {
        push({
          item: { id: `${h.id}:quiet:${want.since}`, kind: "quiet", from, text: cut(h.brief, 40), at: want.since, target },
          channel,
          since: want.since,
          brief: patrolBrief.quiet(who, h.phase._tag === "working" ? h.phase.doing.label : ""),
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
        push({
          item: { id: graph.id + ":draft", kind: "graph-draft", from: orchestrator, text: cut(graph.title, 40), at: graph.createdAt, target },
          channel: general,
          brief: patrolBrief.graphDraft(graph.title, graph.id),
        });
        break;
      case "ready":
        push({
          item: { id: graph.id + ":ready", kind: "graph-ready", from: orchestrator, text: cut(graph.title, 40), at: graph.createdAt, target },
          channel: general,
          brief: patrolBrief.graphReady(graph.title, graph.id),
        });
        break;
      case "running":
      case "paused":
        for (const task of graph.tasks) {
          if (task.state !== "failed") continue;
          // A step retried and failed again asks again: from its second failure the id counts them.
          const failures = task.failures ?? 0;
          const id = graph.id + ":failed:" + task.id + (failures > 1 ? `:${failures}` : "");
          push({
            item: {
              id,
              kind: "task-failed",
              from: orchestrator,
              text: cut(t("server.inbox.step", { graph: graph.title, step: task.title }), 40),
              at: graph.createdAt,
              target,
            },
            channel: general,
            brief: patrolBrief.taskFailed(graph.title, graph.id, task.id, task.title, task.conclusion ? slice(task.conclusion, 0, 80) : ""),
          });
        }
        break;
      case "abandoned":
      case "done":
      case "splitting":
        break;
    }
  }

  for (const sc of state.crons) {
    if (!sc.pending) continue;
    out.push({
      item: {
        id: sc.id + ":ask",
        kind: "cron-ask",
        from: orchestrator,
        text: cut(sc.name, 40),
        at: sc.created,
        target: { kind: "chat", channel: sc.channel },
      },
      channel: sc.channel,
      since: sc.created,
      brief: patrolBrief.cron(sc.name, sc.id),
    });
  }

  for (const { message: m, channel, address } of chat?.ownerMentions ?? []) {
    const from: InboxFrom = m.fromKind === "session" ? { kind: "session", id: m.from, name: m.name, agent: m.agent ?? "" } : orchestrator;
    out.push({
      item: { id: m.id, kind: "mention", from, text: cut(m.text, 40), at: m.at, target: { kind: "chat", channel: m.channel } },
      channel,
      since: m.at,
      brief: patrolBrief.mention(m.name, address, slice(oneLine(m.text), 0, 80)),
    });
  }
  return out;
}

type Want =
  | { readonly kind: "ask"; readonly questions: readonly Question[] }
  | { readonly kind: "review" | "fix" | "interrupted" | "conflict" }
  | { readonly kind: "quiet"; readonly since: number };

/** What a session questions of the owner. Its issue's attention says it, the one the issue page and the phone both read; a
 * session whose issue the state does not hold says it by its phase. */
function wantOf(h: Session, state: WorkspaceState): Want | undefined {
  const issue = h.issue === undefined ? undefined : state.issues.find((item) => item.id === h.issue && item.sessions.at(-1) === h.id);
  if (!issue) {
    const need = needOf(h);
    switch (need?.kind) {
      case undefined:
      case "retrying":
        return undefined;
      case "review":
        return { kind: "review" };
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
      return { kind: "review" };
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
    case "done":
    case "canceled":
      return undefined;
  }
}

function clipLine(text: string, max = 140) {
  const one = text.replace(/\s+/gu, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

function worded(item: Omit<InboxItem, "who" | "words">): InboxItem {
  const who = item.from.kind === "session" ? item.from.name : t("server.inbox.orchestrator");
  return { ...item, who, words: inboxWords(item.kind, who, clipLine(item.text)) };
}

/** What the inbox says of an item: its label, its title, its body (the item's text unless the kind has its own) and the tray's line. */
function inboxWords(kind: InboxKind, who: string, text: string): InboxWords {
  switch (kind) {
    case "review":
      return {
        label: t("server.inbox.item.review.label"),
        title: t("server.inbox.item.review.title", { who }),
        body: text,
        tray: t("server.inbox.item.review.tray", { who }),
      };
    case "ask":
      return { label: t("server.inbox.item.ask.label"), title: t("server.inbox.item.ask.title", { who }), body: text, tray: "" };
    case "fix":
      return {
        label: t("server.inbox.item.fix.label"),
        title: t("server.inbox.item.fix.title", { who }),
        body: text,
        tray: t("server.inbox.item.fix.tray", { who }),
      };
    case "interrupted":
      return { label: t("shared.stuck.interrupted"), title: t("server.inbox.item.interrupted.title", { who }), body: text, tray: "" };
    case "conflict":
      return {
        label: t("server.inbox.item.conflict.label"),
        title: t("server.inbox.item.conflict.title", { who }),
        body: text,
        tray: t("server.inbox.item.conflict.tray", { who }),
      };
    case "quiet":
      return {
        label: t("server.inbox.item.quiet.label"),
        title: t("server.inbox.item.quiet.title", { who }),
        body: t("server.inbox.item.quiet.body"),
        tray: t("server.inbox.item.quiet.tray", { who }),
      };
    case "graph-draft":
      return {
        label: t("server.inbox.item.graph-draft.label"),
        title: t("server.inbox.item.graph-draft.title", { text }),
        body: t("server.inbox.item.graph-draft.body"),
        tray: t("server.inbox.item.graph-draft.tray", { text }),
      };
    case "graph-ready":
      return {
        label: t("server.inbox.item.graph-ready.label"),
        title: t("server.inbox.item.graph-ready.title", { text }),
        body: t("server.inbox.item.graph-ready.body"),
        tray: t("server.inbox.item.graph-ready.tray", { text }),
      };
    case "task-failed":
      return {
        label: t("server.inbox.item.task-failed.label"),
        title: t("server.inbox.item.task-failed.title", { text }),
        body: t("server.inbox.item.task-failed.body"),
        tray: t("server.inbox.item.task-failed.tray", { text }),
      };
    case "mention":
      return { label: t("server.inbox.item.mention.label"), title: t("server.inbox.item.mention.title", { who }), body: text, tray: "" };
    case "cron-ask":
      return {
        label: t("server.inbox.item.cron-ask.label"),
        title: t("server.inbox.item.cron-ask.title"),
        body: t("server.inbox.item.cron-ask.body", { text }),
        tray: t("server.inbox.item.cron-ask.tray", { text }),
      };
  }
}
