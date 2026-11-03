// The state stream, and the Solid store the page reads it through: one stream while anyone listens, and the frames as
// they came for the code that compares them (rawFrame below).

import { type Accessor, createContext, createStore, onSettled, reconcile, useContext } from "solid-js";

import { defaultOrchestrator, readStream, type StateFrame, statePath, type WorkspaceState, type WorkspaceView } from "@vibevalley/protocol";

import { createExternal } from "@/base/external";

export type Link = "connecting" | "open" | "lost";

export interface Frames {
  readonly frame: StateFrame | undefined;
  readonly link: Link;
  /** Frames received since the page opened. */
  readonly count: number;
}

/** Where the frames come from: frames below, or a source of a test's own (infra/testing.ts). */
export interface FramesSource {
  readonly get: () => Frames;
  readonly subscribe: (listener: () => void) => () => void;
}

let current: Frames = { frame: undefined, link: "connecting", count: 0 };
const listeners = new Set<() => void>();
let abort: AbortController | undefined;

function set(next: Frames) {
  current = next;
  for (const l of listeners) l();
}

// One stream while anyone listens; it reconnects a second after it drops, or after it went silent past the server's
// heartbeat (readStream), and closes with the last listener.
function connect(signal: AbortSignal) {
  readStream("", statePath, (frame) => set({ frame, link: "open", count: current.count + 1 }), signal).catch(() => {
    if (signal.aborted) return;
    set({ ...current, link: "lost" });
    const again = setTimeout(() => connect(signal), 1000);
    signal.addEventListener("abort", () => clearTimeout(again), { once: true });
  });
}

export const frames: FramesSource = {
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

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const FramesContext = createContext<Frames>();

/** The stream above as a store: each frame reconciles in by id, so only what changed updates. */
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
