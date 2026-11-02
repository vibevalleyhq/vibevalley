import { type Accessor, createContext, createStore, onSettled, reconcile, useContext } from "solid-js";

import { defaultOrchestrator, type StateFrame, type WorkspaceState, type WorkspaceView } from "@vibevalley/protocol";

import { createExternal } from "@/base/external";

import { type Frames, frames } from "./frames";

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const FramesContext = createContext<Frames>();

/** The state stream (infra/frames.ts) as a store: each frame reconciles in by id, so only what changed updates. */
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
export function useCore(): () => WorkspaceView | undefined {
  const f = useFrames();
  return () => f.frame?.state;
}

export type OrchestratorMood = "idle" | "listening" | "thinking" | "speaking";

export const orchestratorSession = (state: WorkspaceState | undefined, agent = defaultOrchestrator) =>
  state?.sessions.find((session) => session.role === "orchestrator" && session.agent === agent);

export function orchestratorMood(state: WorkspaceState | undefined, agent = defaultOrchestrator): OrchestratorMood {
  const phase = orchestratorSession(state, agent)?.phase;
  if (!phase || phase._tag === "closed") return "idle";
  if (phase._tag !== "working") return "listening";
  return phase.doing.action === "speaking_text" ? "speaking" : "thinking";
}

/**
 * The frame as the stream sent it: a new object each time, for code that compares the one before with the one after
 * (sounds, the canvas, the host's notices). UI reads the store above, which keeps objects and updates only what changed.
 */
export const rawFrame = (): Accessor<StateFrame | undefined> => createExternal(frames.subscribe, () => frames.get().frame);
