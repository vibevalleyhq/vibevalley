// The farm page's own state (farm/store.ts) and the frames as they come, for the Solid farm.

import { type Accessor, createContext, createMemo, useContext } from "solid-js";
import type { StateFrame } from "@vibevalley/protocol";
import { type Frames, frames } from "../base/frames";
import { farmOf } from "@vibevalley/protocol/rules";
import { farmFrameOf } from "./scope";
import { farmCommands } from "./commands";
import { clock, type FarmUi, farmState, subscribeFarm } from "./store";
import { createExternal } from "../base/external";

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

/** The frame as sent, with only this farm's sessions: for the canvas, the sounds and the effects (scope.ts). */
export const rawFarmFrame = (): Accessor<StateFrame | undefined> =>
  createExternal(
    (l) => {
      const offFrames = frames.subscribe(l);
      const offFarm = subscribeFarm(l);
      return () => (offFrames(), offFarm());
    },
    () => farmFrameOf(frames.get().frame, farmProject()),
  );

/**
 * The frames store with only this farm's sessions, for the farm's DOM (FarmPage provides it to the parts that draw the
 * beds; the chat and the title read the whole farm's).
 */
export function createFarmFrames(outer: Frames, project: Accessor<string>): Frames {
  const sessions = createMemo(() => outer.frame?.state.sessions.filter((h) => farmOf(h) === project()));
  const frame = createMemo(() => {
    const f = outer.frame;
    return f && { ...f, state: { ...f.state, sessions: sessions() ?? [] } };
  });
  return {
    get link() {
      return outer.link;
    },
    get count() {
      return outer.count;
    },
    get frame() {
      return frame();
    },
  };
}

/** The farm's commands, over this farm's part of the frame the page has now. */
export const commands = farmCommands(() => farmFrameOf(frames.get().frame, farmProject()));
