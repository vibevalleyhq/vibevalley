import { type Accessor, createMemo } from "solid-js";

import type { GameEffect, StateFrame } from "@vibevalley/protocol";
import { farmOf } from "@vibevalley/protocol/rules";

import { type Frames, frames, rawFrame } from "#/infra/frame.ts";

import { farmCommands } from "./commands";
import { farmRepo } from "./store";

const made = new WeakMap<StateFrame, { repo: string; frame: StateFrame }>();

/** The same frame and repo give back the same object, so a reader comparing frames sees no change. */
export function farmFrameOf(frame: StateFrame | undefined, repo: string): StateFrame | undefined {
  if (!frame) return undefined;
  const was = made.get(frame);
  if (was?.repo === repo) return was.frame;
  const scoped = { ...frame, state: { ...frame.state, sessions: frame.state.sessions.filter((h) => farmOf(h) === repo) } };
  made.set(frame, { repo, frame: scoped });
  return scoped;
}

// Effects made on this page, not by the server: the debug console's level-up and achievement, which earn nothing.
const listeners = new Set<(e: GameEffect) => void>();

export const localEffects = {
  add: (e: GameEffect) => {
    for (const f of listeners) f(e);
  },
  subscribe: (f: (e: GameEffect) => void) => {
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  },
};

/** The frame as sent, with only this farm's sessions: for the canvas, the sounds and the effects. */
export function rawFarmFrame(): Accessor<StateFrame | undefined> {
  const raw = rawFrame();
  return createMemo(() => farmFrameOf(raw(), farmRepo()));
}

/** The frames store with only this farm's sessions, for the farm's DOM (FarmPage provides it to the parts that draw the beds. */
export function createFarmFrames(outer: Frames, repo: Accessor<string>): Frames {
  const sessions = createMemo(() => outer.frame?.state.sessions.filter((h) => farmOf(h) === repo()) ?? [], {
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
export const commands = farmCommands(() => farmFrameOf(frames.get().frame, farmRepo()));
