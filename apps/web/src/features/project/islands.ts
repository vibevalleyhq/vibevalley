// The room on an island is roomLeft, the rule the server refuses a start by: an open plot may start now, a shut one
// waits for the farm to free up.

import { t } from "@vibevalley/i18n";
import { type Issue, maxRunning, type PlotView, type ProjectSummary, type Session } from "@vibevalley/protocol";
import { isBusy, phaseText, roomLeft } from "@vibevalley/protocol/rules";
import type { Pose } from "@/ui/cast";

export type Spot = { readonly kind: "taken"; readonly session: Session; readonly plot: PlotView } | { readonly kind: "open" } | { readonly kind: "shut" };

export interface Island {
  readonly project: string;
  /** Undefined for a project the list does not have (any more) that helpers are still in. */
  readonly summary?: ProjectSummary;
  readonly spots: readonly Spot[];
  readonly working: number;
  readonly maxSessions: number;
  readonly queued: readonly Issue[];
}

export const openOf = (i: Island) => i.spots.filter((s) => s.kind === "open").length;

const isFull = (i: Island) => i.working >= i.maxSessions;

const queuedIn = (issues: readonly Issue[], project: string) =>
  issues.filter((i) => i.project === project && i.status === "todo" && i.queuedAt !== undefined).sort((a, b) => a.queuedAt! - b.queuedAt!);

/** Peopled or waited on first, then the newest commit, then by name. */
export function islandsOf({
  projects,
  sessions,
  plots,
  issues,
}: {
  projects: readonly ProjectSummary[];
  sessions: readonly Session[];
  plots: Readonly<Record<string, PlotView>>;
  issues: readonly Issue[];
}): Island[] {
  const known = new Map(projects.map((p) => [p.name, p]));
  const names = new Set([...known.keys(), ...sessions.flatMap((h) => (h.project ? [h.project] : []))]);
  const islands = [...names].map((name) => {
    const summary = known.get(name);
    const mine = sessions.filter((h) => h.project === name).sort((a, b) => a.hiredAt - b.hiredAt);
    const working = mine.filter(isBusy).length;
    // A project the list does not have takes no more work: only its helpers show.
    const maxSessions = summary ? Math.round(summary.maxSessions) : working;
    const left = roomLeft(sessions, name, maxRunning, maxSessions);
    // No more plots are drawn than the farm has places.
    const room = Math.max(0, Math.min(maxSessions > 0 ? left.project : 0, maxRunning - mine.length));
    const open = Math.min(room, left.farm);
    const spots: Spot[] = [
      ...mine.map((h): Spot => ({ kind: "taken", session: h, plot: plots[h.id] ?? { crop: "seeded" } })),
      ...Array.from({ length: open }, (): Spot => ({ kind: "open" })),
      ...Array.from({ length: room - open }, (): Spot => ({ kind: "shut" })),
    ];
    return { project: name, ...(summary ? { summary } : {}), spots, working, maxSessions, queued: queuedIn(issues, name) };
  });
  const quiet = (i: Island) => (i.spots.some((s) => s.kind === "taken") || i.queued.length > 0 ? 0 : 1);
  return islands.sort(
    (a, b) => quiet(a) - quiet(b) || (b.summary?.last ?? 0) - (a.summary?.last ?? 0) || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0),
  );
}

export const homeless = (sessions: readonly Session[]) => sessions.filter((h) => h.project === undefined);

export const mapTally = (islands: readonly Island[]) => ({
  peopled: islands.filter((i) => i.spots.some((s) => s.kind === "taken")).length,
  working: islands.reduce((n, i) => n + i.working, 0),
  queued: islands.reduce((n, i) => n + i.queued.length, 0),
});

/** As plotW and plotH in village/world: change them there and here together. */
const plotW = 34;

const plotH = 26;

const head = 15;

const rowPitch = 36;

const maxColPitch = 54;

export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Each returned point is a plot's foot. */
export function plotsIn(yard: Rect, n: number): { x: number; y: number }[] {
  if (n <= 0) return [];
  const rows = Math.ceil(n / 3);
  const perRow = Math.ceil(n / rows);
  const pitch = perRow === 1 ? 0 : Math.min(maxColPitch, (yard.width - plotW - 8) / (perRow - 1));
  const block = head + plotH + (rows - 1) * rowPitch;
  const cx = yard.left + yard.width / 2;
  const firstBottom = yard.top + yard.height / 2 - block / 2 + head + plotH;
  return Array.from({ length: n }, (_, i) => {
    const row = Math.floor(i / perRow);
    const inRow = Math.min(perRow, n - row * perRow);
    return { x: cx + ((i % perRow) - (inRow - 1) / 2) * pitch, y: firstBottom + row * rowPitch };
  });
}

/** Where a helper stands from its plot's foot. */
export const sessionInPlot = { x: 0, y: -10 };

const handedBack = (h: Session) => h.phase._tag === "done" || h.phase._tag === "resting";

export function mapPose(h: Session): Pose {
  if ((handedBack(h) && h.conflict) || h.phase._tag === "failed") return "worry";
  switch (h.phase._tag) {
    case "working":
      return h.phase.doing.action === "thinking" || h.phase.doing.action === "speaking_text" ? "think" : "work";
    case "done":
      return "cheer";
    default:
      return "idle";
  }
}

export function spotText(spot: Spot, now: number) {
  switch (spot.kind) {
    case "taken":
      return `${spot.session.name} · ${phaseText(spot.session, now)}${spot.session.branch ? t("web.project.project.branch", { branch: spot.session.branch }) : ""}`;
    case "open":
      return t("web.project.project.open");
    case "shut":
      return t("web.project.project.shut", { n: maxRunning });
  }
}

export const islandText = (i: Island) =>
  [
    !i.summary ? t("web.project.project.gone") : t("web.project.project.working", { n: i.working, of: i.maxSessions, full: isFull(i) }),
    ...(i.queued.length > 0 ? [t("web.project.project.queued", { n: i.queued.length })] : []),
  ].join(" · ");

export function islandScale(width: number, cell: number, gap: number) {
  for (const s of [2, 1.5]) if (2 * cell * s + gap <= width) return s;
  const one = width / cell;
  return one >= 1.5 ? Math.min(2.5, Math.floor(one * 2) / 2) : one;
}

export const islandLooks = ["island-meadow", "island-orchard", "island-pond", "island-pines", "island-windmill", "island-lavender"];

export function islandLook(project: string) {
  let h = 0;
  for (const c of project) h = (h * 31 + c.codePointAt(0)!) & 0x7fffffff;
  return islandLooks[h % islandLooks.length]!;
}
