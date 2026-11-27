import {
  type BoardSlice,
  type CollabSlice,
  type FarmFrame,
  type InboxSlice,
  type OpsSlice,
  type Session,
  type SessionEvent,
  type SessionInteractionRequest,
  type SessionPermissionRequest,
  type SessionsSlice,
  type SessionWatchEvent,
  type SliceKind,
  SliceKindValues,
} from "../index";

export type LinkState = "connecting" | "open" | "lost";

export interface SliceMap {
  readonly board: BoardSlice;
  readonly sessions: SessionsSlice;
  readonly collab: CollabSlice;
  readonly inbox: InboxSlice;
  readonly ops: OpsSlice;
  readonly farm: FarmFrame;
}

export interface SliceSubscriptionTransport {
  readonly slice: <K extends SliceKind>(kind: K, on: (data: SliceMap[K]) => void) => () => void;
}

export interface SliceStore {
  readonly get: <K extends SliceKind>(kind: K) => SliceMap[K] | undefined;
  readonly subscribe: (kind: SliceKind, listener: () => void) => () => void;
  readonly refresh: (kind: SliceKind) => void;
  readonly link: () => LinkState;
  readonly subscribeLink: (listener: () => void) => () => void;
  readonly reconnectAll: () => void;
}

interface SliceChannel<T> {
  value: T | undefined;
  readonly listeners: Set<() => void>;
  stop: (() => void) | undefined;
  readonly connect: () => void;
  readonly disconnect: () => boolean;
}

/** Platform-agnostic refcounted 6-slice subscription store shared by desktop and mobile clients. */
export function createSliceStore(getTransport: () => SliceSubscriptionTransport): SliceStore {
  let currentLink: LinkState = "connecting";
  const linkListeners = new Set<() => void>();

  const setLink = (next: LinkState): void => {
    if (currentLink === next) return;
    currentLink = next;
    for (const listener of [...linkListeners]) listener();
  };

  const makeChannel = <K extends SliceKind>(kind: K): SliceChannel<SliceMap[K]> => {
    const channel: SliceChannel<SliceMap[K]> = {
      value: undefined,
      listeners: new Set(),
      stop: undefined,
      connect: () => {
        channel.stop?.();
        channel.stop = getTransport().slice(kind, (data) => {
          channel.value = data;
          setLink("open");
          for (const listener of [...channel.listeners]) listener();
        });
      },
      disconnect: () => {
        if (!channel.stop) return false;
        channel.stop();
        channel.stop = undefined;
        channel.value = undefined;
        for (const listener of [...channel.listeners]) listener();
        return true;
      },
    };
    return channel;
  };

  const channels: { readonly [K in SliceKind]: SliceChannel<SliceMap[K]> } = {
    board: makeChannel("board"),
    sessions: makeChannel("sessions"),
    collab: makeChannel("collab"),
    inbox: makeChannel("inbox"),
    ops: makeChannel("ops"),
    farm: makeChannel("farm"),
  };

  return {
    get: <K extends SliceKind>(kind: K): SliceMap[K] | undefined => channels[kind].value,
    subscribe: (kind: SliceKind, listener: () => void): (() => void) => {
      const channel = channels[kind];
      channel.listeners.add(listener);
      if (!channel.stop) channel.connect();
      return () => {
        channel.listeners.delete(listener);
        if (channel.listeners.size > 0) return;
        channel.stop?.();
        channel.stop = undefined;
        channel.value = undefined;
      };
    },
    refresh: (kind: SliceKind): void => {
      const channel = channels[kind];
      if (channel.listeners.size === 0) return;
      channel.connect();
    },
    link: (): LinkState => currentLink,
    subscribeLink: (listener: () => void): (() => void) => {
      linkListeners.add(listener);
      return () => {
        linkListeners.delete(listener);
      };
    },
    reconnectAll: (): void => {
      const active: SliceKind[] = [];
      for (const kind of SliceKindValues) {
        if (channels[kind].disconnect()) active.push(kind);
      }
      setLink("connecting");
      for (const kind of active) channels[kind].connect();
    },
  };
}

export interface SessionWatchState {
  readonly session?: Session;
  readonly events: readonly SessionEvent[];
  readonly pendingPermissions: readonly SessionPermissionRequest[];
  readonly pendingInteractions: readonly SessionInteractionRequest[];
  readonly missing: boolean;
}

export const EMPTY_SESSION_WATCH_STATE: SessionWatchState = {
  events: [],
  pendingPermissions: [],
  pendingInteractions: [],
  missing: false,
};

/** Merges session transcript events by `(seq, revision)`, sorted ascending by `seq`. */
export function mergeSessionEvents(existing: readonly SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] {
  const bySeq = new Map<number, SessionEvent>();
  for (const event of existing) bySeq.set(event.seq, event);
  for (const event of incoming) {
    const prev = bySeq.get(event.seq);
    if (!prev || event.revision >= prev.revision) {
      bySeq.set(event.seq, event);
    }
  }
  return [...bySeq.values()].toSorted((a, b) => a.seq - b.seq);
}

function upsertByRequestId<T extends { readonly requestId: string }>(list: readonly T[], req: T): T[] {
  const next = list.filter((item) => item.requestId !== req.requestId);
  next.push(req);
  return next;
}

/** Pure reducer folding a `SessionWatchEvent` into `SessionWatchState`. */
export function applySessionWatchEvent(prev: SessionWatchState, event: SessionWatchEvent): SessionWatchState {
  switch (event.kind) {
    case "state":
      return {
        ...prev,
        session: event.session,
        pendingPermissions: event.pendingPermissions,
        pendingInteractions: event.pendingInteractions,
        missing: false,
      };
    case "history":
      return {
        ...prev,
        events: mergeSessionEvents(prev.events, event.events),
      };
    case "event": {
      const nextEvents = mergeSessionEvents(prev.events, [event.event]);
      let nextPermissions = prev.pendingPermissions;
      let nextInteractions = prev.pendingInteractions;
      if (event.event.type === "permission/request" && event.event.permission) {
        nextPermissions = upsertByRequestId(nextPermissions, event.event.permission);
      } else if (event.event.type === "permission/resolved" && event.event.permission) {
        const resolvedId = event.event.permission.requestId;
        nextPermissions = nextPermissions.filter((item) => item.requestId !== resolvedId);
      } else if (event.event.type === "interaction/request" && event.event.interaction) {
        nextInteractions = upsertByRequestId(nextInteractions, event.event.interaction);
      } else if (event.event.type === "interaction/resolved" && event.event.interactionResolution) {
        const resolvedId = event.event.interactionResolution.requestId;
        nextInteractions = nextInteractions.filter((item) => item.requestId !== resolvedId);
      }
      return {
        ...prev,
        events: nextEvents,
        pendingPermissions: nextPermissions,
        pendingInteractions: nextInteractions,
      };
    }
    case "missing":
      return {
        ...prev,
        missing: true,
      };
  }
}
