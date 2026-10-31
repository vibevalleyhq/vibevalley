// For the rules' tests: a registry whose frames come from the test, not from a server.

import type { StateFrame } from "@vibevalley/protocol";

import { createRegistry, type FramesSource, framesSource } from "./atom";
import type { Frames } from "./frames";

export interface TestFrames {
  readonly source: FramesSource;
  /** Changes the frames and tells whoever reads them. */
  readonly set: (next: Partial<Frames>) => void;
}

export function testFrames(start: Partial<Frames> = {}): TestFrames {
  let now: Frames = { frame: undefined, link: "open", count: 0, ...start };
  const listeners = new Set<() => void>();
  return {
    source: {
      get: () => now,
      subscribe: (l) => {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
    },
    set: (next) => {
      now = { ...now, ...next };
      for (const l of listeners) l();
    },
  };
}

export function testRegistry(frames: TestFrames = testFrames()) {
  const registry = createRegistry();
  registry.set(framesSource, frames.source);
  return registry;
}

/** An empty farm's frame at this seq. */
export const frameAt = (seq: number): StateFrame => ({
  seq,
  state: { call: "idle", callReason: "", sessions: [], issues: [], orchestrators: {}, crons: [], connectors: [] },
  inbox: [],
  graphs: [],
  effects: [],
  view: { level: { level: 1, xp: 0, need: 100 }, plots: {}, achievements: [] },
});

/** A promise the test settles. */
export function deferred<T>() {
  const ends: { resolve: (value: T) => void; reject: (e: unknown) => void }[] = [];
  const promise = new Promise<T>((resolve, reject) => void ends.push({ resolve, reject }));
  const [end] = ends;
  if (!end) throw new Error("a Promise runs its executor at once");
  return { promise, ...end };
}
