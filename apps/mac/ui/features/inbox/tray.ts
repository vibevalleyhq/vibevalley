import { t } from "@vibevalley/i18n";
import type { InboxItem, SpaceView } from "@vibevalley/protocol";
import type { TraySummary } from "@vibevalley/protocol/host";

import { unreadTotal } from "../channel/index";

/** The tray's title (working helpers, calls waiting) and its lines. */
export function traySummary(state: SpaceView, inbox: readonly InboxItem[]): TraySummary {
  const working = state.sessions.filter((h) => h.role === "worker" && h.phase._tag === "working").length;
  const waiting = inbox.flatMap((c) => (c.words.tray ? [c.words.tray] : []));
  const unread = unreadTotal(state.chat, state.channelSummary);
  const lines = [
    state.call === "live" ? (working > 0 ? t("web.inbox.tray.working", { n: working }) : t("web.inbox.tray.idle")) : t("web.inbox.tray.off"),
    ...waiting,
    ...(unread > 0 ? [t("web.inbox.tray.unread", { n: unread })] : []),
  ];
  const title = [...(working > 0 ? [`${working}`] : []), ...(waiting.length > 0 ? [`${waiting.length}!`] : [])].join(" · ");
  return { title, lines };
}

/** How many calls wait on the user at an issue; a mention is counted with the chat's unread instead. */
export const waitingOnUser = (inbox: readonly InboxItem[]) => inbox.filter((c) => c.target.kind !== "chat").length;
