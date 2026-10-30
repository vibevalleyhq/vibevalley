import { t } from "@vibevalley/i18n";
// Words the HUD shows, from the frame: the clock, the warehouse, what a helper is doing, a plot's title and what the
// orchestrator last said. The runtimes' quotas are features/runtime/quota.ts.

import type { ChatMessage, WorkspaceState, Crop, Issue, Session, DoingView, SessionView } from "@vibevalley/protocol";

import { beds, cropLabel, type Bed } from "@/farm/world/plots";

/** To five minutes; `tod` 0..1, 0.5 is noon. */
export function clockText(tod: number) {
  const minutes = Math.floor(tod * 24 * 60);
  const m = minutes % 60;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(m - (m % 5)).padStart(2, "0")}`;
}

export const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The issues harvested into their main branch (merged here, or by a pull request), newest first: the warehouse. */
export const harvestedOf = (s: WorkspaceState | undefined): Issue[] =>
  (s?.issues ?? []).filter((i) => i.delivered === "merged" || i.delivered === "pull_request").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

const nothing: DoingView = { action: "none", label: "", actionText: "" };

export const doingOf = (h: SessionView): DoingView => (h.phase._tag === "working" ? h.phase.doing : nothing);

/** The levels that clear a locked bed: the level-up banner says so. */
export const clearingLevels = new Set(beds.flatMap((b) => (b.unlockLevel === undefined ? [] : [b.unlockLevel])));

export function plotTitle(bed: Bed, session: Session | undefined, crop: Crop) {
  if (bed.unlockLevel !== undefined) return crop === "locked" ? t("web.farm.overlay.unclaimed") : t("web.farm.overlay.flowerbed");
  if (!session) return t("web.farm.overlay.bare", { plot: bed.station + 1 });
  return `${session.name} · ${cropLabel[crop]}`;
}

/** The orchestrator's last typed line among the general channel's messages (voice lines are not on the web yet). */
export function lastOrchestratorSaid(general: readonly ChatMessage[]) {
  const typed = general.findLast((m) => m.fromKind === "orchestrator" && m.kind === "chat");
  return typed && { key: `m${typed.id}`, text: typed.text, at: typed.at };
}
