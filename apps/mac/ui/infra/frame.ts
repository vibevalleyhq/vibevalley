import { cleanup, signal, type Accessor } from "nsh";

import {
  defaultOrchestrator,
  type BoardSlice,
  type Channel,
  type CollabSlice,
  type FarmFrame,
  type InboxSlice,
  type Issue,
  type LiveEvent,
  type OpsSlice,
  type SessionsSlice,
  type SessionView,
  type SliceKind,
} from "@vibevalley/protocol";
import { isOrchestratorSession, sessionIssueId, sessionProfile } from "@vibevalley/protocol/rules";
import { createSliceStore, type LinkState } from "@vibevalley/protocol/store";

import { createContext, useContext } from "./solid";
import { onTransportChange, transport, type SliceMap } from "./transport";

export type Link = LinkState;

export interface Slices {
  readonly slice: <K extends SliceKind>(kind: K) => Accessor<SliceMap[K] | undefined>;
  readonly refresh: (kind: SliceKind) => void;
  readonly link: Accessor<Link>;
  readonly sessionsById: Accessor<ReadonlyMap<string, SessionView>>;
  readonly sessionsByIssue: Accessor<ReadonlyMap<string, SessionView>>;
  readonly issuesById: Accessor<ReadonlyMap<string, Issue>>;
}

export interface SlicesSource {
  readonly get: <K extends SliceKind>(kind: K) => SliceMap[K] | undefined;
  readonly subscribe: (kind: SliceKind, listener: () => void) => () => void;
  readonly refresh: (kind: SliceKind) => void;
  readonly link: () => Link;
  readonly subscribeLink: (listener: () => void) => () => void;
}

const sliceStore = createSliceStore(() => transport());

onTransportChange(() => {
  sliceStore.reconnectAll();
});

export const slices: SlicesSource = {
  get: sliceStore.get,
  subscribe: sliceStore.subscribe,
  refresh: sliceStore.refresh,
  link: sliceStore.link,
  subscribeLink: sliceStore.subscribeLink,
};

export const SlicesContext = createContext<Slices>();

const emptySessions = new Map<string, SessionView>();
const emptyIssues = new Map<string, Issue>();

interface SliceSlot<T> {
  accessor: Accessor<T | undefined> | undefined;
  readonly ensure: () => Accessor<T | undefined>;
}

/** Per-slice reactive signals backed by `source`; each slice subscribes lazily on first use. */
export function createSlices(source: SlicesSource = slices): Slices {
  const disposers: (() => void)[] = [];

  const linkSig = signal<Link>(source.link());
  disposers.push(source.subscribeLink(() => linkSig.set(source.link())));

  cleanup(() => {
    for (const off of disposers) off();
    disposers.length = 0;
  });

  function makeSlot<K extends SliceKind>(kind: K): SliceSlot<SliceMap[K]> {
    const slot: SliceSlot<SliceMap[K]> = {
      accessor: undefined,
      ensure: () => {
        if (slot.accessor) return slot.accessor;
        const sig = signal<SliceMap[K] | undefined>(source.get(kind), { equals: false });
        const off = source.subscribe(kind, () => sig.set(source.get(kind)));
        disposers.push(off);
        const read: Accessor<SliceMap[K] | undefined> = () => sig();
        slot.accessor = read;
        return read;
      },
    };
    return slot;
  }

  const slots: { readonly [K in SliceKind]: SliceSlot<SliceMap[K]> } = {
    board: makeSlot("board"),
    sessions: makeSlot("sessions"),
    collab: makeSlot("collab"),
    inbox: makeSlot("inbox"),
    ops: makeSlot("ops"),
    farm: makeSlot("farm"),
  };

  function ensureSlice<K extends SliceKind>(kind: K): Accessor<SliceMap[K] | undefined> {
    return slots[kind].ensure();
  }

  let lastSessions: readonly SessionView[] | undefined;
  let sessionsById: ReadonlyMap<string, SessionView> = emptySessions;
  let sessionsByIssue: ReadonlyMap<string, SessionView> = emptySessions;
  let lastIssues: readonly Issue[] | undefined;
  let issuesById: ReadonlyMap<string, Issue> = emptyIssues;

  const syncSessions = () => {
    const list = ensureSlice("sessions")()?.sessions;
    if (list !== lastSessions) {
      if (list && list.length > 0) {
        const byId = new Map<string, SessionView>();
        const byIssue = new Map<string, SessionView>();
        for (const s of list) {
          byId.set(s.id, s);
          const issueId = sessionIssueId(s);
          if (issueId !== undefined) byIssue.set(issueId, s);
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
    const list = ensureSlice("board")()?.issues;
    if (list !== lastIssues) {
      issuesById = list && list.length > 0 ? new Map(list.map((i) => [i.id, i])) : emptyIssues;
      lastIssues = list;
    }
  };

  return {
    slice: ensureSlice,
    refresh: (kind: SliceKind): void => {
      ensureSlice(kind);
      source.refresh(kind);
    },
    link: () => linkSig(),
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
  };
}

let shared: Slices | undefined;
const useSlices = (): Slices => useContext(SlicesContext) ?? (shared ??= createSlices());

function useSlice<K extends SliceKind>(kind: K): Accessor<SliceMap[K] | undefined> {
  return useSlices().slice(kind);
}

export const useBoardSlice = (): Accessor<BoardSlice | undefined> => useSlice("board");
export const useSessionsSlice = (): Accessor<SessionsSlice | undefined> => useSlice("sessions");
export const useCollabSlice = (): Accessor<CollabSlice | undefined> => useSlice("collab");
export const useInboxSlice = (): Accessor<InboxSlice | undefined> => useSlice("inbox");
export const useOpsSlice = (): Accessor<OpsSlice | undefined> => useSlice("ops");
export const useFarmSlice = (): Accessor<FarmFrame | undefined> => useSlice("farm");
export const useLink = (): Accessor<Link> => useSlices().link;

export function useRefreshSlice(kind: SliceKind): () => void {
  const s = useSlices();
  return () => s.refresh(kind);
}

export function useSessionsMap(): Accessor<ReadonlyMap<string, SessionView>> {
  return useSlices().sessionsById;
}

export function useSession(id: Accessor<string | undefined>): Accessor<SessionView | undefined> {
  const byId = useSessionsMap();
  return () => {
    const key = id();
    return key !== undefined ? byId().get(key) : undefined;
  };
}

export function useIssue(id: Accessor<string | undefined>): Accessor<Issue | undefined> {
  const byId = useSlices().issuesById;
  return () => {
    const key = id();
    return key !== undefined ? byId().get(key) : undefined;
  };
}

export function useThreadOwner(thread: Accessor<Channel>): Accessor<SessionView | undefined> {
  const s = useSlices();
  return () => {
    const c = thread();
    if (c.subjectId === undefined) return undefined;
    if (c.subjectKind === "talk") return s.sessionsById().get(c.subjectId);
    if (c.subjectKind === "issue") return s.sessionsByIssue().get(c.subjectId);
    return undefined;
  };
}

export type OrchestratorMood = "idle" | "listening" | "thinking" | "speaking";

const orchestratorSession = (sessions: readonly SessionView[] | undefined, agent = defaultOrchestrator) =>
  sessions?.find((session) => isOrchestratorSession(session) && sessionProfile(session) === agent);

export function orchestratorMood(sessions: readonly SessionView[] | undefined, agent = defaultOrchestrator): OrchestratorMood {
  const phase = orchestratorSession(sessions, agent)?.phase;
  if (!phase || phase._tag === "closed") return "idle";
  if (phase._tag !== "working") return "listening";
  return phase.doing.action === "speaking_text" ? "speaking" : "thinking";
}

/** Listens to the live events; returns how to stop. */
export function subscribeLive(l: (e: LiveEvent) => void, connected?: () => void) {
  const off = transport().live(l);
  connected?.();
  return off;
}
