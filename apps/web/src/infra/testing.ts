// For the rules' tests: frames that come from the test, not from a server.

import type { Frames, FramesSource } from "./frames";

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
