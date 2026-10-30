// The beds (the village's plots), what grows in them and what a tool does on them: the server folds the state, these
// only read it.

import { t } from "@vibevalley/i18n";
import type { Crop, FarmView, PlotView, Session } from "@vibevalley/protocol";

export interface Bed {
  readonly index: number;
  /** -1 for locked ones. */
  readonly station: number;
  readonly unlockLevel?: number;
}

export const beds: readonly Bed[] = [
  { index: 0, station: 0 },
  { index: 1, station: 1 },
  { index: 2, station: 2 },
  { index: 3, station: 3 },
  { index: 4, station: 4 },
  { index: 5, station: 5 },
  { index: 6, station: -1, unlockLevel: 5 },
  { index: 7, station: -1, unlockLevel: 8 },
  { index: 8, station: -1, unlockLevel: 12 },
];

export const bedOfStation = (station: number): Bed | undefined => (station < 0 ? undefined : beds.find((b) => b.station === station));

export const isRipe = (crop: Crop) => crop === "wheat" || crop === "carrot";

/** The issue a session works; every session the farm shows has one. */
export const issueOf = (s: Session) => s.issue ?? s.id;

export const isBusy = (s: Session) => s.phase._tag === "arriving" || s.phase._tag === "working";

/** 0..5, or -1 while every bed is taken. */
export const stationOfSession = (s: Session) => (s.play ? Math.round(s.play.station) : -1);

export const sessionAtStation = (sessions: readonly Session[], station: number) =>
  station < 0 ? undefined : sessions.find((s) => stationOfSession(s) === station);

export const nextClearing = (level: number) => beds.find((b) => b.unlockLevel !== undefined && b.unlockLevel > level)?.unlockLevel;

const emptyPlot: PlotView = { crop: "empty" };

export const plotOf = (view: FarmView, s: Session | undefined): PlotView => (s ? (view.plots[s.id] ?? emptyPlot) : emptyPlot);

export const lockedPlot = (bed: Bed, level: number): PlotView => ({ crop: level >= (bed.unlockLevel ?? Infinity) ? "flowering" : "locked" });

/**
 * What a bed shows: a cleared locked bed flowers; a session's plot not yet in the view is a sprout; `leaving` (its
 * session just left) shows the harvested soil.
 */
export function cropOfBed(bed: Bed, sessions: readonly Session[], view: FarmView, leaving = false): Crop {
  if (bed.unlockLevel !== undefined) return lockedPlot(bed, Math.round(view.level.level)).crop;
  const s = sessionAtStation(sessions, bed.station);
  if (!s) return leaving ? "harvested" : "empty";
  return view.plots[s.id]?.crop ?? "sprout";
}

export const cropLabel: Record<Crop, string> = {
  empty: t("web.farm.crop.empty"),
  seeded: t("web.farm.crop.seeded"),
  sprout: t("web.farm.crop.sprout"),
  leafy: t("web.farm.crop.leafy"),
  flowering: t("web.farm.crop.flowering"),
  wheat: t("web.farm.crop.wheat"),
  carrot: t("web.farm.crop.wheat"),
  withered: t("web.farm.crop.withered"),
  weeds: t("web.farm.crop.weeds"),
  dry: t("web.farm.crop.dry"),
  harvested: t("web.farm.crop.harvested"),
  locked: t("web.farm.crop.locked"),
};
