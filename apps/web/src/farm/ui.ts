// The farm page's own state (farm/store.ts) as the Solid farm reads it, and the time of day.

import { type Accessor, createContext, createMemo, useContext } from "solid-js";

import { clock, type FarmUi, farmState, subscribeFarm } from "./store";
import { createExternal } from "@/base/external";
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

/** The project whose farm is on the page ("" for the sessions without one): the route sets it. */
export const farmProject = () => farmState().project ?? "";
