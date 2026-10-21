// What the inbox rings on the machine (CallBell, noticeFor) and shows in the tray (traySummary).

import type { CoreState, InboxItem } from "@vibevalley/protocol";
import type { Notice, TraySummary } from "@vibevalley/host";
import { unreadTotal } from "./chat";

export const callerName = (call: InboxItem) => (call.from.kind === "session" ? call.from.name : "管家");

export function clipLine(text: string, max = 140) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function noticeFor(call: InboxItem): Notice {
  const who = callerName(call);
  const text = clipLine(call.text);
  switch (call.kind) {
    case "merge":
      return { title: `${who} 做完了`, body: text };
    case "fix":
      return { title: `${who} 没做成`, body: text };
    case "conflict":
      return { title: `${who} 的活合进主分支会冲突`, body: text };
    case "quiet":
      return { title: `${who} 好一阵没动静了`, body: "可能在跑很久的命令，也可能卡住了：看看它的干活过程。" };
    case "graph-draft":
      return { title: `计划「${text}」拆好了`, body: "看过再开工" };
    case "graph-ripe":
      return { title: `计划「${text}」都做完了`, body: "看看改动，收获进主分支" };
    case "task-failed":
      return { title: `计划卡住了：${text}`, body: "重试、改工单，或者跳过" };
    case "mention":
      return { title: `${who} 叫你`, body: text };
    case "schedule-ask":
      return { title: "管家想定一个定时", body: `「${text}」：同意了才开始` };
  }
}

/** The calls standing when the page opens are known, not rung; an id rings once (a helper's next ripe turn has a new id). */
export class CallBell {
  private seen = new Set<string>();
  private primed = false;

  ring(calls: InboxItem[]): InboxItem[] {
    const fresh = calls.filter((c) => !this.seen.has(c.id));
    for (const c of fresh) this.seen.add(c.id);
    if (!this.primed) {
      this.primed = true;
      return [];
    }
    return fresh;
  }
}

/** A call's line in the tray; a mention is counted with the unread instead. */
export function waitingLine(call: InboxItem): string | undefined {
  const who = callerName(call);
  switch (call.kind) {
    case "merge":
      return `${who} 做完了，可以收`;
    case "fix":
      return `${who} 没做成`;
    case "conflict":
      return `${who} 的活会冲突`;
    case "quiet":
      return `${who} 好一阵没动静`;
    case "graph-draft":
      return `计划「${call.text}」等你看`;
    case "graph-ripe":
      return `计划「${call.text}」可以收获`;
    case "task-failed":
      return `计划「${call.text}」没做成`;
    case "schedule-ask":
      return `定时「${call.text}」等你同意`;
    case "mention":
      return undefined;
  }
}

/** The tray's title (working helpers, calls waiting) and its lines. */
export function traySummary(state: CoreState, inbox: readonly InboxItem[]): TraySummary {
  const working = state.sessions.filter((h) => h.phase._tag === "working").length;
  const waiting = inbox.flatMap((c) => waitingLine(c) ?? []);
  const unread = unreadTotal(state.chat);
  const lines = [
    state.call === "live" ? (working > 0 ? `${working} 个帮工在干活` : "开工了，没有在干的活") : "还没开工",
    ...waiting,
    ...(unread > 0 ? [`田头 ${unread} 条没读`] : []),
  ];
  const title = [...(working > 0 ? [`${working}`] : []), ...(waiting.length > 0 ? [`${waiting.length}!`] : [])].join(" · ");
  return { title, lines };
}
