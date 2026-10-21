// The state stream as a store of its own, framework-free: the page reads it through data/frame.ts (a Solid store) and
// rawFrame() (the frames as they came).

import { readStream, statePath, type StateFrame } from "@vibevalley/protocol";

export type Link = "connecting" | "open" | "lost";

export interface Frames {
  readonly frame: StateFrame | undefined;
  readonly link: Link;
  /** Frames received since the page opened. */
  readonly count: number;
}

let current: Frames = { frame: undefined, link: "connecting", count: 0 };
const listeners = new Set<() => void>();
let abort: AbortController | undefined;

function set(next: Frames) {
  current = next;
  for (const l of listeners) l();
}

// One stream while anyone listens; it reconnects a second after it drops and closes with the last listener.
function connect(signal: AbortSignal) {
  readStream<StateFrame>(statePath, (frame) => set({ frame, link: "open", count: current.count + 1 }), signal).catch(() => {
    if (signal.aborted) return;
    set({ ...current, link: "lost" });
    setTimeout(() => !signal.aborted && connect(signal), 1000);
  });
}

export const frames = {
  get: (): Frames => current,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (!abort) {
      abort = new AbortController();
      connect(abort.signal);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size > 0) return;
      abort?.abort();
      abort = undefined;
    };
  },
};
