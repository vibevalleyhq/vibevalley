import { type Accessor, createMemo } from "solid-js";

import { createExternal } from "@/base/external";

import { clock, type FarmUi, farmState } from "./store";

/** A slice of the farm page's state, following it. */
export const useFarm = <T>(select: (s: FarmUi) => T): Accessor<T> => createMemo(() => select(farmState()));

/** The clock's time of day, 0..1, in steps of five minutes of the day (the HUD's clock text). */
export const timeOfDay = () => createExternal(clock.subscribe, () => Math.floor(clock.day().tod * 288) / 288);
