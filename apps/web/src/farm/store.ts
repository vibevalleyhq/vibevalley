// The farm page's own state: what is open, what is held, what the canvas shows the overlays. The farm itself is the
// server's (useFrames/useCore); nothing here copies it: the overlays, the tool held, the chat window (open, large,
// shown), the phone, and the looks and picks kept on this machine.

import { dayClock } from "@vibevalley/engine/clock";
import type { GameEffectReward } from "@vibevalley/protocol";
import type { BedFxKind, Tool } from "./tools";
import type { Point } from "./world/level";
import type { FarmPanel } from "./world/places";
import type { Rect } from "./world/framing";

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
  readonly helperAt: (sessionId: string) => Point | undefined;
  /** Calls `fn` after every drawn frame, for DOM that follows walkers; returns how to stop. */
  readonly onFrame: (fn: () => void) => () => void;
}

export interface FarmUi {
  readonly overlays: readonly FarmOverlay[];
  readonly tool: Tool;
  /** The bed and the yard place (YardPlace id) under the pointer, set by the canvas. */
  readonly hoverBed: number | null;
  readonly hoverSpot: string | null;
  /** Held Alt (or the first visit): every name tag shows. */
  readonly revealNames: boolean;
  readonly chatOpen: boolean;
  readonly chatLarge: boolean;
  /** The conversation the chat window shows: null is the general channel, else a thread's or channel's id. */
  readonly chatShown: string | null;
  readonly phoneOpen: boolean;
  readonly friendsOpen: boolean;
  /** The task graph the task board shows; null is the newest still open. */
  readonly graphShown: string | null;
  readonly titleOpen: boolean;
  readonly bedFx: readonly BedFx[];
  /** Rewards shown in the FX layer for a few seconds each. */
  readonly rewards: readonly GameEffectReward[];
  readonly screen: VillageScreen | null;
  /** The orchestrator's look (tools.ts orchestratorLooks ids; "farmer" is the plain one) and the pet by his door: this machine's. */
  readonly orchestratorLook: string;
  readonly pet: string;
  /** Who the next job goes to: a profile's id, or "auto" for the orchestrator to choose; this machine's. */
  readonly pick: string;
  /** The project whose farm is on the page ("" for the sessions without one), and the one `/` opens next; this machine's. */
  readonly project: string | null;
}

const titleSeenKey = "vibevalley.title.seen";

const looksKey = "vibevalley.farm.looks";

/** The orchestrator's look and the pet, kept per machine. */
const savedLooks = (): { orchestratorLook: string; pet: string } => {
  try {
    const raw = JSON.parse(localStorage.getItem(looksKey) ?? "{}") as { orchestratorLook?: unknown; pet?: unknown };
    return { orchestratorLook: typeof raw.orchestratorLook === "string" ? raw.orchestratorLook : "farmer", pet: typeof raw.pet === "string" ? raw.pet : "dog" };
  } catch {
    return { orchestratorLook: "farmer", pet: "dog" };
  }
};

const saveLooks = (looks: { orchestratorLook: string; pet: string }) => {
  try {
    localStorage.setItem(looksKey, JSON.stringify(looks));
  } catch {
    // No storage: the choice lasts until the page closes.
  }
};

const pickKey = "vibevalley.farm.pick";

const savedPick = () => {
  try {
    return localStorage.getItem(pickKey) ?? "auto";
  } catch {
    return "auto";
  }
};

const projectKey = "vibevalley.farm.project";

const savedProject = () => {
  try {
    return localStorage.getItem(projectKey);
  } catch {
    return null;
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
  hoverBed: null,
  hoverSpot: null,
  revealNames: false,
  chatOpen: true,
  chatLarge: false,
  chatShown: null,
  phoneOpen: false,
  friendsOpen: false,
  graphShown: null,
  titleOpen: !titleSeen(),
  bedFx: [],
  rewards: [],
  screen: null,
  ...savedLooks(),
  pick: savedPick(),
  project: savedProject(),
};

const listeners = new Set<() => void>();

const set = (patch: Partial<FarmUi> | ((s: FarmUi) => Partial<FarmUi>)) => {
  const next = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  if (Object.keys(next).every((k) => next[k as keyof FarmUi] === state[k as keyof FarmUi])) return;
  state = next;
  for (const l of listeners) l();
};

export const farmState = () => state;

export const subscribeFarm = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

const replace = (kind: FarmOverlay["kind"], next: FarmOverlay | null) =>
  set((s) => ({
    overlays: [...s.overlays.filter((o) => o.kind !== kind), ...(next ? [next] : [])].sort((a, b) => overlayOrder[a.kind] - overlayOrder[b.kind]),
  }));

export const overlayOf = <K extends FarmOverlay["kind"]>(s: FarmUi, kind: K) => s.overlays.find((o): o is Extract<FarmOverlay, { kind: K }> => o.kind === kind);

let nextFx = 0;
const fxLinger = 2200;
const rewardLinger = 4000;

/** The world's one day clock: the canvas advances it each frame, the HUD and the debug console read and set it. */
export const clock = dayClock({ daySeconds: 600, start: 0.42 });

export const farm = {
  /** Opens a plot's issue (null closes it). */
  select: (sessionId: string | null) => replace("inspect", sessionId === null ? null : { kind: "inspect", sessionId }),
  review: (sessionId: string | null) => replace("review", sessionId === null ? null : { kind: "review", sessionId }),
  sow: (station: number | null) => replace("sow", station === null ? null : { kind: "sow", station }),
  water: (sessionId: string | null) => replace("water", sessionId === null ? null : { kind: "water", sessionId }),
  panel: (panel: FarmPanel | null) => replace("panel", panel === null ? null : { kind: "panel", panel }),
  menu: (open: boolean) => replace("menu", open ? { kind: "menu" } : null),
  /** Closes the top layer; false when none was open. */
  closeTop: () => {
    const top = state.overlays.at(-1);
    if (!top) return false;
    replace(top.kind, null);
    return true;
  },
  openTaskBoard: (graph?: string) => {
    if (graph) set({ graphShown: graph });
    replace("panel", { kind: "panel", panel: "taskBoard" });
  },
  showGraph: (graph: string | null) => set({ graphShown: graph }),
  hold: (tool: Tool) => set({ tool }),
  hover: (bed: number | null, spot: string | null) => set({ hoverBed: bed, hoverSpot: spot }),
  revealNames: (on: boolean) => set({ revealNames: on }),
  chatOpen: (open: boolean) => set({ chatOpen: open }),
  chatLarge: (large: boolean) => set({ chatLarge: large }),
  /** Shows a conversation in the chat window and opens it. */
  showChat: (conversation: string | null) => set({ chatShown: conversation, chatOpen: true }),
  phoneOpen: (open: boolean) => set({ phoneOpen: open }),
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
    const fx: BedFx = { id: ++nextFx, bed, kind, text };
    set((s) => ({ bedFx: [...s.bedFx, fx] }));
    setTimeout(() => set((s) => ({ bedFx: s.bedFx.filter((f) => f !== fx) })), fxLinger);
  },
  reward: (r: GameEffectReward) => {
    set((s) => ({ rewards: [...s.rewards, r] }));
    setTimeout(() => set((s) => ({ rewards: s.rewards.filter((x) => x !== r) })), rewardLinger);
  },
  setScreen: (screen: VillageScreen | null) => set({ screen }),
  setOrchestratorLook: (orchestratorLook: string) => {
    set({ orchestratorLook });
    saveLooks({ orchestratorLook, pet: state.pet });
  },
  setProject: (project: string) => {
    set({ project });
    try {
      localStorage.setItem(projectKey, project);
    } catch {
      // No storage: remembered until the page closes.
    }
  },
  setPick: (pick: string) => {
    set({ pick });
    try {
      localStorage.setItem(pickKey, pick);
    } catch {
      // No storage: the pick lasts until the page closes.
    }
  },
  setPet: (pet: string) => {
    set({ pet });
    saveLooks({ orchestratorLook: state.orchestratorLook, pet });
  },
};

/** For tests and leaving the page: everything but the title's seen flag back to the start. */
export function resetFarm() {
  set({
    overlays: [],
    tool: "hand",
    hoverBed: null,
    hoverSpot: null,
    revealNames: false,
    chatOpen: true,
    chatLarge: false,
    chatShown: null,
    phoneOpen: false,
    friendsOpen: false,
    graphShown: null,
    bedFx: [],
    rewards: [],
    screen: null,
  });
}
