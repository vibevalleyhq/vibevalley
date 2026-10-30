import { type Accessor, createMemo } from "solid-js";

import type { StateFrame } from "@vibevalley/protocol";
import { farmOf } from "@vibevalley/protocol/rules";

import { createExternal } from "@/base/external";
import { type Frames, frames } from "@/base/frames";

import { farmCommands } from "./commands";
import { farmFrameOf } from "./scope";
import { subscribeFarm } from "./store";
import { farmProject } from "./ui";
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
