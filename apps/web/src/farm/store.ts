import { type Accessor, createMemo } from "solid-js";
import { z } from "zod";

import { dayClock } from "@vibevalley/engine/clock";
import { t } from "@vibevalley/i18n";
import type { Channel, GameEffectReward, IssueAct, SessionId } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { createExternal } from "#/base/external.ts";
import { channelLabel } from "#/features/channel/index.ts";
import { defineAtom } from "#/state/atom.ts";
import { defineStored } from "#/state/stored.ts";

import type { BedFxKind, Tool } from "./tools";
import type { Point } from "./world/level";
import type { FarmPanel, Rect } from "./world/world";
export type { FarmPanel } from "./world/world";

/** The layers over the farm, at most one of each kind, drawn in this order (later on top). */
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

/** How the canvas shows the village, for the DOM over it: set by the canvas (null until it has drawn), replaced when the framing changes. */
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
  /** Where a helper stands now (its feet), on the page. undefined when it is not drawn. */
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
  readonly bedFx: readonly BedFx[];
  /** Rewards shown in the FX layer for a few seconds each. */
  readonly rewards: readonly GameEffectReward[];
  readonly screen: VillageScreen | undefined;
}

/** The repo whose farm was on the page last ("" for the sessions without one), the one `/farm` opens; null before any. */
const lastFarm = defineStored("farm.repo", z.string().nullable(), null);

const farmUi = defineAtom<FarmUi>({
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
  bedFx: [],
  rewards: [],
  screen: undefined,
});

const set = (patch: Partial<FarmUi> | ((s: FarmUi) => Partial<FarmUi>)) =>
  farmUi.update((state) => {
    const next = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
    return Object.entries(next).every(([k, v]) => v === Reflect.get(state, k)) ? state : next;
  });

/** The farm page's state now; read in a computation or a component, it follows it. */
export const farmState = farmUi.get;

/** A slice of the farm page's state, following it. */
export const useFarm = <T>(select: (s: FarmUi) => T): Accessor<T> => createMemo(() => select(farmState()));

export const subscribeFarm = farmUi.subscribe;

/** The repo whose farm is on the page ("" for the sessions without one): the route sets it. */
export const farmRepo = () => lastFarm.get() ?? "";

/** The farm `/farm` opens: the one entered last on this machine, if any. */
export const lastFarmRepo = () => lastFarm.get() ?? undefined;

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

/** The clock's time of day, 0..1, in steps of five minutes of the day (the HUD's clock text). */
export const timeOfDay = () => createExternal(clock.subscribe, () => Math.floor(clock.day().tod * 288) / 288);

/** The farm's words for an issue's acts where they are its own: completing a change is a harvest here. */
export const farmActWords: Partial<Record<IssueAct, string>> = { complete: t("web.farm.tool.harvest.label") };

/** The farm calls the default channel by its words' chat.label (the farm chat). */
export const farmChannelLabel = (c: Channel | undefined) => (!c || c.default ? t("web.farm.chat.label") : channelLabel(c));

export const farmClock = (at: number) => {
  const d = new Date(Math.round(at));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Long enough to fold: over 240 characters, eight lines or more, a heading or a code block. */
export const readsLong = (text: string) => text.length > 240 || (text.match(/\n/gu)?.length ?? 0) >= 8 || /^(#{1,6} |```)/mu.test(text);

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
    const top = farmUi.get().overlays.at(-1);
    if (!top) return false;
    replace(top.kind, undefined);
    return true;
  },
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
  /** Plays a bed's effect for a moment: the canvas draws it, the sounds hear it. */
  bedFx: (bed: number, kind: BedFxKind, text?: string) => {
    const fx: BedFx = omitUndefined({ id: ++nextFx, bed, kind, text });
    set((s) => ({ bedFx: [...s.bedFx, fx] }));
    // oxlint-disable-next-line vibevalley/dropped-timer -- the farm's store lives as long as the page
    setTimeout(() => set((s) => ({ bedFx: s.bedFx.filter((f) => f !== fx) })), fxLinger);
  },
  reward: (r: GameEffectReward) => {
    set((s) => ({ rewards: [...s.rewards, r] }));
    // oxlint-disable-next-line vibevalley/dropped-timer -- the farm's store lives as long as the page
    setTimeout(() => set((s) => ({ rewards: s.rewards.filter((x) => x !== r) })), rewardLinger);
  },
  setScreen: (screen: VillageScreen | undefined) => set({ screen }),
  setRepo: (repo: string) => lastFarm.set(repo),
};

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
    bedFx: [],
    rewards: [],
    screen: undefined,
  });
}
