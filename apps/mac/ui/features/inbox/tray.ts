import { t } from "@vibevalley/i18n";
import type { CollabSlice, InboxItem, InboxSlice, SessionsSlice } from "@vibevalley/protocol";
import type { TraySummary } from "@vibevalley/protocol/host";
import { isFreeUserSession } from "@vibevalley/protocol/rules";

import { unreadTotal } from "../channel/index";

/** The tray's title (working helpers, calls waiting) and its lines. */
export function traySummary(slices: {
  readonly sessions: SessionsSlice | undefined;
  readonly collab: CollabSlice | undefined;
  readonly inbox: InboxSlice;
}): TraySummary {
  const working = (slices.sessions?.sessions ?? []).filter((h) => h.role === "worker" && !isFreeUserSession(h) && h.phase._tag === "working").length;
  const waiting = slices.inbox.items.flatMap((c) => (c.words.tray ? [c.words.tray] : []));
  const unread = unreadTotal(slices.collab?.chat, slices.collab?.channelSummary);
  const lines = [
    slices.inbox.call === "live" ? (working > 0 ? t("web.inbox.tray.working", { n: working }) : t("web.inbox.tray.idle")) : t("web.inbox.tray.off"),
    ...waiting,
    ...(unread > 0 ? [t("web.inbox.tray.unread", { n: unread })] : []),
  ];
  const title = [...(working > 0 ? [`${working}`] : []), ...(waiting.length > 0 ? [`${waiting.length}!`] : [])].join(" · ");
  return { title, lines };
}

function countsForRailBadge(target: InboxItem["target"]): boolean {
  switch (target.kind) {
    case "issue":
    case "session":
    case "runtime":
      return true;
    case "chat":
      return false;
  }
}

/** How many calls wait on the user at an issue or runtime; a mention is counted with the chat's unread instead. */
export const waitingOnUser = (inbox: readonly InboxItem[]) => inbox.filter((c) => countsForRailBadge(c.target)).length;
