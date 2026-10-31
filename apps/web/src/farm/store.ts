// The farm page's own state: what is open, what is held, what the canvas shows the overlays. The farm itself is the
// server's (useFrames/useCore); nothing here copies it: the overlays, the tool held, the chat window (open, large,
// shown), the phone, and which project's farm `/` shows. The looks and who the next job goes to are infra/prefs.ts.

import { dayClock } from "@vibevalley/engine/clock";
import type { GameEffectReward, SessionId } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import type { BedFxKind, Tool } from "./tools";
import type { Rect } from "./world/framing";
import type { Point } from "./world/level";
import type { FarmPanel } from "./world/places";
export type { FarmPanel } from "./world/places";

/**
 * The layers over the farm, at most one of each kind, drawn in this order (later on top): a plot's issue, its harvest,
 * the sowing form, the watering form, a panel, the Esc menu.
 */
export type FarmOverlay =
  | { readonly kind: "inspect"; readonly sessionId: string }
  | { readonly kind: "review"; readonly sessionId: string }
  | { readonly kind: "sow"; readonly station: number }
  | { readonly kind: "water"; readonly sessionId: string }
  | { readonly kind: "panel"; readonly panel: FarmPanel }
  | { readonly kind: "menu" };

const overlayOrder: Record<FarmOverlay["kind"], number> = { inspect: 0, review: 1, sow: 2, water: 3, panel: 4, menu: 5 };

export interface BedFx {
  readonly id: number;
  /** The bed's index (world/plots.ts beds). */
  readonly bed: number;
  readonly kind: BedFxKind;
  /** What a "note" says over the bed. */
  readonly text?: string;
}

/**
 * How the canvas shows the village, for the DOM over it: set by the canvas (null until it has drawn), replaced when the
 * framing changes. Positions are in the farm page's CSS pixels (its top left is 0, 0); art points are the level's.
 */
export interface VillageScreen {
  /** Screen pixels per art pixel. */
  readonly scale: number;
  /** The whole village on the page; it may stick out past the page's edges. */
  readonly box: Rect;
  /** The part of the village inside the page: the HUD goes in here. */
  readonly shown: Rect;
  readonly toScreen: (art: Point) => Point;
  /** A bed's box on the page. */
  readonly plotRect: (bed: number) => Rect;
  /** Where a helper stands now (its feet), on the page; undefined when it is not drawn. Changes every frame. */
  readonly helperAt: (sessionId: SessionId) => Point | undefined;
  /** Calls `fn` after every drawn frame, for DOM that follows walkers; returns how to stop. */
  readonly onFrame: (fn: () => void) => () => void;
}

export interface FarmUi {
  readonly overlays: readonly FarmOverlay[];
  readonly tool: Tool;
  /** The bed and the yard place (YardPlace id) under the pointer, set by the canvas. */
  readonly hoverBed: number | undefined;
  readonly hoverSpot: string | undefined;
  /** Held Alt (or the first visit): every name tag shows. */
  readonly revealNames: boolean;
  /** The phone is unfolded, its right screen the chat; folded whenever the phone is put away, so it opens folded. */
  readonly chatOpen: boolean;
  readonly chatLarge: boolean;
  /** The channel the chat shows: undefined is the general channel, else a thread's or channel's id. */
  readonly chatShown: string | undefined;
  readonly phoneOpen: boolean;
  readonly friendsOpen: boolean;
  /** The task graph the task board shows; null is the newest still open. */
  readonly graphShown: string | undefined;
  readonly titleOpen: boolean;
  readonly bedFx: readonly BedFx[];
  /** Rewards shown in the FX layer for a few seconds each. */
  readonly rewards: readonly GameEffectReward[];
  readonly screen: VillageScreen | undefined;
  /** The project whose farm is on the page ("" for the sessions without one), and the one `/` opens next; this machine's. */
  readonly project: string | undefined;
}

const titleSeenKey = "vibevalley.title.seen";

const projectKey = "vibevalley.farm.project";

const savedProject = () => {
  try {
    return localStorage.getItem(projectKey) ?? undefined;
  } catch {
    return undefined;
  }
};

const titleSeen = () => {
  try {
    return localStorage.getItem(titleSeenKey) === "true";
  } catch {
    return false;
  }
};

let state: FarmUi = {
  overlays: [],
  tool: "hand",
  hoverBed: undefined,
  hoverSpot: undefined,
  revealNames: false,
  chatOpen: false,
  chatLarge: false,
  chatShown: undefined,
  phoneOpen: false,
  friendsOpen: false,
  graphShown: undefined,
  titleOpen: !titleSeen(),
  bedFx: [],
  rewards: [],
  screen: undefined,
  project: savedProject(),
};

const listeners = new Set<() => void>();

const set = (patch: Partial<FarmUi> | ((s: FarmUi) => Partial<FarmUi>)) => {
  const next = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  if (Object.entries(next).every(([k, v]) => v === Reflect.get(state, k))) return;
  state = next;
  for (const l of listeners) l();
};

export const farmState = () => state;

export const subscribeFarm = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const replace = (kind: FarmOverlay["kind"], next: FarmOverlay | undefined) =>
  set((s) => ({
    overlays: [...s.overlays.filter((o) => o.kind !== kind), ...(next ? [next] : [])].toSorted((a, b) => overlayOrder[a.kind] - overlayOrder[b.kind]),
  }));

export const overlayOf = <K extends FarmOverlay["kind"]>(s: FarmUi, kind: K) => s.overlays.find((o): o is Extract<FarmOverlay, { kind: K }> => o.kind === kind);

let nextFx = 0;
const fxLinger = 2200;
const rewardLinger = 4000;

/** The world's one day clock: the canvas advances it each frame, the HUD and the debug console read and set it. */
export const clock = dayClock({ daySeconds: 600, start: 0.42 });

export const farm = {
  /** Opens a plot's issue (null closes it). */
  select: (sessionId: string | undefined) => replace("inspect", sessionId === undefined ? undefined : { kind: "inspect", sessionId }),
  review: (sessionId: string | undefined) => replace("review", sessionId === undefined ? undefined : { kind: "review", sessionId }),
  sow: (station: number | undefined) => replace("sow", station === undefined ? undefined : { kind: "sow", station }),
  water: (sessionId: string | undefined) => replace("water", sessionId === undefined ? undefined : { kind: "water", sessionId }),
  panel: (panel: FarmPanel | undefined) => replace("panel", panel === undefined ? undefined : { kind: "panel", panel }),
  menu: (open: boolean) => replace("menu", open ? { kind: "menu" } : undefined),
  /** Closes the top layer; false when none was open. */
  closeTop: () => {
    const top = state.overlays.at(-1);
    if (!top) return false;
    replace(top.kind, undefined);
    return true;
  },
  openTaskBoard: (graph?: string) => {
    if (graph) set({ graphShown: graph });
    replace("panel", { kind: "panel", panel: "taskBoard" });
  },
  showGraph: (graph: string | undefined) => set({ graphShown: graph }),
  hold: (tool: Tool) => set({ tool }),
  hover: (bed: number | undefined, spot: string | undefined) => set({ hoverBed: bed, hoverSpot: spot }),
  revealNames: (on: boolean) => set({ revealNames: on }),
  /** Unfolds the phone (taking it out) or folds it. */
  chatOpen: (open: boolean) => set(open ? { chatOpen: true, phoneOpen: true } : { chatOpen: false }),
  chatLarge: (large: boolean) => set({ chatLarge: large }),
  /** Shows a channel in the chat: the phone comes out unfolded. */
  showChat: (channel: string | undefined) => set({ chatShown: channel, chatOpen: true, phoneOpen: true }),
  phoneOpen: (open: boolean) => set(open ? { phoneOpen: true } : { phoneOpen: false, chatOpen: false }),
  friendsOpen: (open: boolean) => set({ friendsOpen: open }),
  /** Leaves the title screen; it does not show again on this machine. */
  closeTitle: () => {
    set({ titleOpen: false });
    try {
      localStorage.setItem(titleSeenKey, "true");
    } catch {
      // No storage: it shows again next time.
    }
  },
  showTitle: () => set({ titleOpen: true }),
  /** Plays a bed's effect for a moment: the canvas draws it, the sounds hear it. */
  bedFx: (bed: number, kind: BedFxKind, text?: string) => {
    const fx: BedFx = omitUndefined({ id: ++nextFx, bed, kind, text });
    set((s) => ({ bedFx: [...s.bedFx, fx] }));
    setTimeout(() => set((s) => ({ bedFx: s.bedFx.filter((f) => f !== fx) })), fxLinger);
  },
  reward: (r: GameEffectReward) => {
    set((s) => ({ rewards: [...s.rewards, r] }));
    setTimeout(() => set((s) => ({ rewards: s.rewards.filter((x) => x !== r) })), rewardLinger);
  },
  setScreen: (screen: VillageScreen | undefined) => set({ screen }),
  setProject: (project: string) => {
    set({ project });
    try {
      localStorage.setItem(projectKey, project);
    } catch {
      // No storage: remembered until the page closes.
    }
  },
};

/** For tests and leaving the page: everything but the title's seen flag back to the start. */
export function resetFarm() {
  set({
    overlays: [],
    tool: "hand",
    hoverBed: undefined,
    hoverSpot: undefined,
    revealNames: false,
    chatOpen: false,
    chatLarge: false,
    chatShown: undefined,
    phoneOpen: false,
    friendsOpen: false,
    graphShown: undefined,
    bedFx: [],
    rewards: [],
    screen: undefined,
  });
}
