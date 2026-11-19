// VibeValley's infra/frame.ts with the same exports, fed by the transport
// (vv/web/infra/transport.ts) instead of the SSE streams. Solid's store
// and reconcile have no nsh equivalent: createFrames hands out the newest
// frame whole, and keyed lists (`Each`) keep their rows by id.
import { cleanup, signal, type Accessor } from "nsh";

import { defaultOrchestrator, type LiveEvent, type StateFrame, type SpaceState, type SpaceView } from "@vibevalley/protocol";

import { createContext, useContext } from "../../solid";
import { onTransportChange, transport } from "./transport";

export type Link = "connecting" | "open" | "lost";

export interface Frames {
  readonly frame: StateFrame | undefined;
  readonly link: Link;
  /** Frames received since the page opened. */
  readonly count: number;
}

/** Where the frames come from: frames below, or a source of a test's own. */
export interface FramesSource {
  readonly get: () => Frames;
  readonly subscribe: (listener: () => void) => () => void;
}

let current: Frames = { frame: undefined, link: "connecting", count: 0 };
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;

function set(next: Frames) {
  current = next;
  for (const l of listeners) l();
}

function connect() {
  stop?.();
  stop = transport().state((frame) => set({ frame, link: "open", count: current.count + 1 }));
}

onTransportChange(() => {
  if (!stop) return;
  set({ frame: undefined, link: "connecting", count: 0 });
  connect();
});

export const frames: FramesSource = {
  get: (): Frames => current,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (!stop) connect();
    return () => {
      listeners.delete(listener);
      if (listeners.size > 0) return;
      stop?.();
      stop = undefined;
    };
  },
};

export const FramesContext = createContext<Frames>();

/** The frames above as a reactive object: each read follows the newest frame. */
export function createFrames(source: FramesSource = frames): Frames {
  const now = signal<Frames>(source.get(), { equals: false });
  const off = source.subscribe(() => now.set(source.get()));
  cleanup(off);
  return {
    get frame() {
      return now().frame;
    },
    get link() {
      return now().link;
    },
    get count() {
      return now().count;
    },
  };
}

let shared: Frames | undefined;
/** The nearest provided frames, else the app's one stream. */
export const useFrames = (): Frames => useContext(FramesContext) ?? (shared ??= createFrames());

/** The folded state. undefined until the first frame. */
export function useCore(): () => SpaceView | undefined {
  const f = useFrames();
  return () => f.frame?.state;
}

export type OrchestratorMood = "idle" | "listening" | "thinking" | "speaking";

export const orchestratorSession = (state: SpaceState | undefined, agent = defaultOrchestrator) =>
  state?.sessions.find((session) => session.role === "orchestrator" && session.agent === agent);

export function orchestratorMood(state: SpaceState | undefined, agent = defaultOrchestrator): OrchestratorMood {
  const phase = orchestratorSession(state, agent)?.phase;
  if (!phase || phase._tag === "closed") return "idle";
  if (phase._tag !== "working") return "listening";
  return phase.doing.action === "speaking_text" ? "speaking" : "thinking";
}

/** The frame as it came: a new object each time. */
export const rawFrame = (): Accessor<StateFrame | undefined> => {
  const now = signal(frames.get().frame, { equals: false });
  cleanup(frames.subscribe(() => now.set(frames.get().frame)));
  return () => now();
};

/** Listens to the live events; returns how to stop. */
export function subscribeLive(l: (e: LiveEvent) => void, connected?: () => void) {
  const off = transport().live(l);
  connected?.();
  return off;
}
