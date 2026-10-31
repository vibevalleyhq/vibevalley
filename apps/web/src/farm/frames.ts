import { type Accessor, createMemo } from "solid-js";

import type { StateFrame } from "@vibevalley/protocol";
import { farmOf } from "@vibevalley/protocol/rules";

import { rawFrame } from "@/infra/frame";
import { type Frames, frames } from "@/infra/frames";

import { farmCommands } from "./commands";
import { farmFrameOf } from "./scope";
import { farmProject } from "./store";

/** The frame as sent, with only this farm's sessions: for the canvas, the sounds and the effects (scope.ts). */
export function rawFarmFrame(): Accessor<StateFrame | undefined> {
  const raw = rawFrame();
  return createMemo(() => farmFrameOf(raw(), farmProject()));
}

/**
 * The frames store with only this farm's sessions, for the farm's DOM (FarmPage provides it to the parts that draw the
 * beds; the chat and the title read the whole farm's). The frame is the store's own, seen through a proxy that answers
 * state.sessions with this farm's: a copy made on each frame would be a new object every time, and every reader of it
 * would run again for any change at all, where reading through the store runs only those whose part changed.
 */
export function createFarmFrames(outer: Frames, project: Accessor<string>): Frames {
  const sessions = createMemo(() => outer.frame?.state.sessions.filter((h) => farmOf(h) === project()) ?? [], {
    equals: (a, b) => a.length === b.length && a.every((h, i) => h === b[i]),
  });
  const frame = createMemo(() => {
    const f = outer.frame;
    if (!f) return undefined;
    const state = new Proxy(f.state, { get: (target, key): unknown => (key === "sessions" ? sessions() : Reflect.get(target, key)) });
    return new Proxy(f, { get: (target, key): unknown => (key === "state" ? state : Reflect.get(target, key)) });
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
