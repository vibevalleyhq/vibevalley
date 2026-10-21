// The farm page's own state (farm/store.ts) and the frames as they come, for the Solid farm.

import { type Accessor, createContext, createMemo, useContext } from "solid-js";
import type { StateFrame } from "@vibevalley/protocol";
import { frames } from "../data/frames";
import { farmCommands } from "./commands";
import { clock, type FarmUi, farmState, subscribeFarm } from "./store";
import { createExternal } from "../data/external";

export const FarmUiContext = createContext<Accessor<FarmUi>>();

/** One subscription to the farm's store for the page; useFarm reads slices of it. */
export const createFarmUi = () => createExternal(subscribeFarm, farmState);

/** A slice of the farm's state; it notifies only when the slice changes. */
export function useFarm<T>(select: (s: FarmUi) => T): Accessor<T> {
  const ui = useContext(FarmUiContext);
  return createMemo(() => select(ui()));
}

/** The clock's time of day, 0..1, in steps of five minutes of the day (the HUD's clock text). */
export const timeOfDay = () => createExternal(clock.subscribe, () => Math.floor(clock.day().tod * 288) / 288);

/**
 * The frame as the stream sent it: a new object each time, for code that compares the one before with the one after
 * (sounds, the canvas). UI reads the store (data/frames.ts), which keeps objects and updates only what changed.
 */
export const rawFrame = (): Accessor<StateFrame | undefined> => createExternal(frames.subscribe, () => frames.get().frame);

/** The farm's commands, over the frame the page has now. */
export const commands = farmCommands(() => frames.get().frame);
