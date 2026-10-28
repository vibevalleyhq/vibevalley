import { t } from "@vibevalley/i18n";
// The farm at a glance in the tray (traySummary); each inbox item comes worded for it (InboxItem.words).

import type { WorkspaceState, InboxItem } from "@vibevalley/protocol";
import type { TraySummary } from "@vibevalley/protocol/host";
import { unreadTotal } from "../channel";

/** The tray's title (working helpers, calls waiting) and its lines. */
export function traySummary(state: WorkspaceState, inbox: readonly InboxItem[]): TraySummary {
  const working = state.sessions.filter((h) => h.phase._tag === "working").length;
  const waiting = inbox.flatMap((c) => c.words.tray ?? []);
  const unread = unreadTotal(state.chat);
  const lines = [
    state.call === "live" ? (working > 0 ? t("web.notice.tray.working", { n: working }) : t("web.notice.tray.idle")) : t("web.notice.tray.off"),
    ...waiting,
    ...(unread > 0 ? [t("web.notice.tray.unread", { n: unread })] : []),
  ];
  const title = [...(working > 0 ? [`${working}`] : []), ...(waiting.length > 0 ? [`${waiting.length}!`] : [])].join(" · ");
  return { title, lines };
}
