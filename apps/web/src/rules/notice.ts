// The farm at a glance in the tray (traySummary); each inbox item comes worded for it (InboxItem.words).

import type { CoreState, InboxItem } from "@vibevalley/protocol";
import type { TraySummary } from "@vibevalley/host";
import { unreadTotal } from "./chat";

/** The tray's title (working helpers, calls waiting) and its lines. */
export function traySummary(state: CoreState, inbox: readonly InboxItem[]): TraySummary {
  const working = state.sessions.filter((h) => h.phase._tag === "working").length;
  const waiting = inbox.flatMap((c) => c.words.tray ?? []);
  const unread = unreadTotal(state.chat);
  const lines = [
    state.call === "live" ? (working > 0 ? `${working} 个帮工在干活` : "开工了，没有在干的活") : "还没开工",
    ...waiting,
    ...(unread > 0 ? [`田头 ${unread} 条没读`] : []),
  ];
  const title = [...(working > 0 ? [`${working}`] : []), ...(waiting.length > 0 ? [`${waiting.length}!`] : [])].join(" · ");
  return { title, lines };
}
