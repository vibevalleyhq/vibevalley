import { createContext, createStore, onSettled, reconcile, useContext } from "solid-js";
import type { CoreState } from "@vibevalley/protocol";
import { type Frames, frames } from "./frames";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const FramesContext = createContext<Frames>();

/** The state stream (data/frames.ts) as a store: each frame reconciles in by id, so only what changed updates. */
export function createFrames(): Frames {
  // Copies: reconciling changes the store's objects in place, and rawFrame() hands the frames as they came to the code
  // that compares one with the one before.
  const [store, set] = createStore<Mutable<Frames>>(structuredClone(frames.get()));
  const sync = () => {
    const f = frames.get();
    set((d) => {
      d.link = f.link;
      d.count = f.count;
      if (!f.frame) d.frame = undefined;
      else if (!d.frame) d.frame = structuredClone(f.frame);
      else reconcile(structuredClone(f.frame), "id")(d.frame);
    });
  };
  onSettled(() => {
    const stop = frames.subscribe(sync);
    // A frame that came between the copy above and the subscription.
    sync();
    return stop;
  });
  return store;
}

export const useFrames = () => useContext(FramesContext);

/** The folded state; undefined until the first frame. Read it inside JSX or a memo. */
export function useCore(): () => CoreState | undefined {
  const f = useFrames();
  return () => f.frame?.state;
}
