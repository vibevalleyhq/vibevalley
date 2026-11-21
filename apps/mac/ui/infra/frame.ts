// VibeValley's infra/frame.ts with the same exports, fed by the transport
// (vv/web/infra/transport.ts) instead of the SSE streams. Solid's store
// and reconcile have no nsh equivalent: createFrames hands out the newest
// frame whole, and keyed lists (`Each`) keep their rows by id.
import { cleanup, signal, type Accessor } from "nsh";

import {
  defaultOrchestrator,
  type Channel,
  type Issue,
  type LiveEvent,
  type SessionView,
  type StateFrame,
  type SpaceState,
  type SpaceView,
} from "@vibevalley/protocol";

import { createContext, useContext } from "./solid";
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

interface FrameIndex {
  readonly sessionsById: () => ReadonlyMap<string, SessionView>;
  readonly sessionsByIssue: () => ReadonlyMap<string, SessionView>;
  readonly issuesById: () => ReadonlyMap<string, Issue>;
}

const frameIndices = new WeakMap<Frames, FrameIndex>();
const emptySessions = new Map<string, SessionView>();
const emptyIssues = new Map<string, Issue>();

/** The frames above as a reactive object: each read follows the newest frame. */
export function createFrames(source: FramesSource = frames): Frames {
  const now = signal<Frames>(source.get(), { equals: false });
  const off = source.subscribe(() => now.set(source.get()));
  cleanup(off);

  let lastSessions: readonly SessionView[] | undefined;
  let sessionsById: ReadonlyMap<string, SessionView> = emptySessions;
  let sessionsByIssue: ReadonlyMap<string, SessionView> = emptySessions;
  let lastIssues: readonly Issue[] | undefined;
  let issuesById: ReadonlyMap<string, Issue> = emptyIssues;

  const syncSessions = () => {
    const list = now().frame?.state.sessions;
    if (list !== lastSessions) {
      if (list && list.length > 0) {
        const byId = new Map<string, SessionView>();
        const byIssue = new Map<string, SessionView>();
        for (const s of list) {
          byId.set(s.id, s);
          if (s.issue !== undefined) byIssue.set(s.issue, s);
        }
        sessionsById = byId;
        sessionsByIssue = byIssue;
      } else {
        sessionsById = emptySessions;
        sessionsByIssue = emptySessions;
      }
      lastSessions = list;
    }
  };

  const syncIssues = () => {
    const list = now().frame?.state.issues;
    if (list !== lastIssues) {
      issuesById = list && list.length > 0 ? new Map(list.map((i) => [i.id, i])) : emptyIssues;
      lastIssues = list;
    }
  };

  const handle: Frames = {
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
  frameIndices.set(handle, {
    sessionsById: () => {
      syncSessions();
      return sessionsById;
    },
    sessionsByIssue: () => {
      syncSessions();
      return sessionsByIssue;
    },
    issuesById: () => {
      syncIssues();
      return issuesById;
    },
  });
  return handle;
}

let shared: Frames | undefined;
/** The nearest provided frames, else the app's one stream. */
export const useFrames = (): Frames => useContext(FramesContext) ?? (shared ??= createFrames());

/** The folded state. undefined until the first frame. */
export function useCore(): () => SpaceView | undefined {
  const f = useFrames();
  return () => f.frame?.state;
}

export function useSessionsMap(): Accessor<ReadonlyMap<string, SessionView>> {
  const f = useFrames();
  const idx = frameIndices.get(f);
  if (idx) return idx.sessionsById;
  return () => {
    const list = f.frame?.state.sessions;
    return list && list.length > 0 ? new Map(list.map((s) => [s.id, s])) : emptySessions;
  };
}

export function useSession(id: Accessor<string | undefined>): Accessor<SessionView | undefined> {
  const byId = useSessionsMap();
  return () => {
    const key = id();
    return key !== undefined ? byId().get(key) : undefined;
  };
}

export function useIssue(id: Accessor<string | undefined>): Accessor<Issue | undefined> {
  const f = useFrames();
  const idx = frameIndices.get(f);
  const byId: Accessor<ReadonlyMap<string, Issue>> = idx
    ? idx.issuesById
    : () => {
        const list = f.frame?.state.issues;
        return list && list.length > 0 ? new Map(list.map((i) => [i.id, i])) : emptyIssues;
      };
  return () => {
    const key = id();
    return key !== undefined ? byId().get(key) : undefined;
  };
}

export function useThreadOwner(thread: Accessor<Channel>): Accessor<SessionView | undefined> {
  const f = useFrames();
  const idx = frameIndices.get(f);
  return () => {
    const c = thread();
    if (c.subjectId === undefined) return undefined;
    if (c.subjectKind === "talk") {
      return idx ? idx.sessionsById().get(c.subjectId) : f.frame?.state.sessions.find((s) => s.id === c.subjectId);
    }
    if (c.subjectKind === "issue") {
      return idx ? idx.sessionsByIssue().get(c.subjectId) : f.frame?.state.sessions.findLast((s) => s.issue === c.subjectId);
    }
    return undefined;
  };
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
