import { computed, effect, lifecycle, platform, signal, UrlScheme, wakeCount, type Accessor } from "nsh";
import { Haptics, type HapticImpact, type HapticNotification } from "nsh/mobile";

import { t } from "@vibevalley/i18n";
import type {
  BoardSlice,
  CollabSlice,
  InboxItem,
  InboxSlice,
  RemotePlatform,
  Session,
  SessionEvent,
  SessionInteractionRequest,
  SessionPermissionRequest,
  SessionsSlice,
  SessionWatchEvent,
} from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import {
  createHttpRemoteTransport,
  normalizeServerUrl,
  pairWithServer,
  parsePairUrl,
  type HttpRemoteTransport,
  type RemoteConnectionState,
  type RemoteEnvelope,
} from "@vibevalley/protocol/remote";
import { SessionWatchEvent as SessionWatchEventSchema } from "@vibevalley/protocol/schema";

import {
  clearAllNotifications,
  encodeInboxNotificationId,
  encodeInteractionNotificationId,
  encodePermissionNotificationId,
  isHighPriorityInboxKind,
  requestNotificationPermissionSafe,
  showLocalNotification,
  syncAppBadge,
} from "./notifications";
import { clearCredentials, createSecureTokenStore, loadCredentials, saveCredentials, type SecureTokenStore, type StoredCredentials } from "./storage";

export interface SessionWatchState {
  readonly session?: Session;
  readonly events: readonly SessionEvent[];
  readonly pendingPermissions: readonly SessionPermissionRequest[];
  readonly pendingInteractions: readonly SessionInteractionRequest[];
  readonly missing: boolean;
}

export interface PendingPermissionItem {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly request: SessionPermissionRequest;
}

export interface PendingInteractionItem {
  readonly sessionId: string;
  readonly sessionName: string;
  readonly request: SessionInteractionRequest;
}

export interface RemoteSessionOptions {
  readonly fetch?: typeof fetch;
  readonly tokenStore?: SecureTokenStore;
}

export interface RemoteSession {
  readonly credentials: Accessor<StoredCredentials | undefined>;
  readonly ready: Accessor<boolean>;
  readonly connectionState: Accessor<RemoteConnectionState>;
  readonly pairing: Accessor<boolean>;
  readonly pairError: Accessor<string | undefined>;
  readonly inbox: Accessor<InboxSlice | undefined>;
  readonly collab: Accessor<CollabSlice | undefined>;
  readonly sessions: Accessor<SessionsSlice | undefined>;
  readonly board: Accessor<BoardSlice | undefined>;
  readonly pendingPermissions: Accessor<readonly PendingPermissionItem[]>;
  readonly pendingInteractions: Accessor<readonly PendingInteractionItem[]>;
  readonly sessionWatchState: (sessionId: string) => SessionWatchState;
  readonly ensureSessionWatch: (sessionId: string) => () => void;
  readonly pair: (rawUrl: string, code: string, deviceName: string) => Promise<boolean>;
  readonly disconnect: () => Promise<void>;
  readonly call: (op: string, payload?: unknown, options?: { readonly signal?: AbortSignal }) => Promise<RemoteEnvelope>;
  readonly subscribe: (name: string, payload: unknown, on: (event: unknown) => void, ended: (why: RemoteEnvelope | null) => void) => () => void;
  readonly dispose: () => void;
}

const EMPTY_WATCH_STATE: SessionWatchState = {
  events: [],
  pendingPermissions: [],
  pendingInteractions: [],
  missing: false,
};

export function hapticNotification(kind: HapticNotification): void {
  try {
    Haptics.notification(kind);
  } catch {
    // Haptics are unavailable in headless tests or non-mobile hosts.
  }
}

export function hapticImpact(style: HapticImpact = "light"): void {
  try {
    Haptics.impact(style);
  } catch {
    // Haptics are unavailable in headless tests or non-mobile hosts.
  }
}

export function hapticSelection(): void {
  try {
    Haptics.selection();
  } catch {
    // Haptics are unavailable in headless tests or non-mobile hosts.
  }
}

export function defaultDeviceName(): string {
  switch (platform.os) {
    case "ios":
      return "iPhone";
    case "android":
      return "Android";
    case "macos":
    case "windows":
    case "linux":
    case "web":
      return "Mobile";
  }
}

function currentRemotePlatform(): RemotePlatform {
  switch (platform.os) {
    case "ios":
      return "ios";
    case "android":
      return "android";
    case "macos":
    case "windows":
    case "linux":
    case "web":
      return "other";
  }
}

function isValidHttpUrl(url: string): boolean {
  if (url === "") return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "";
  } catch {
    return false;
  }
}

function mergeSessionEvents(existing: readonly SessionEvent[], incoming: readonly SessionEvent[]): SessionEvent[] {
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

function upsertPermission(list: readonly SessionPermissionRequest[], req: SessionPermissionRequest): SessionPermissionRequest[] {
  const next = list.filter((item) => item.requestId !== req.requestId);
  next.push(req);
  return next;
}

function upsertInteraction(list: readonly SessionInteractionRequest[], req: SessionInteractionRequest): SessionInteractionRequest[] {
  const next = list.filter((item) => item.requestId !== req.requestId);
  next.push(req);
  return next;
}

function applySessionWatchEvent(prev: SessionWatchState, event: SessionWatchEvent): SessionWatchState {
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
        nextPermissions = upsertPermission(nextPermissions, event.event.permission);
      } else if (event.event.type === "permission/resolved" && event.event.permission) {
        const resolvedId = event.event.permission.requestId;
        nextPermissions = nextPermissions.filter((item) => item.requestId !== resolvedId);
      } else if (event.event.type === "interaction/request" && event.event.interaction) {
        nextInteractions = upsertInteraction(nextInteractions, event.event.interaction);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createRemoteSession(options?: RemoteSessionOptions): RemoteSession {
  const tokenStore = options?.tokenStore ?? createSecureTokenStore();
  const credentials = signal<StoredCredentials | undefined>(undefined);
  const ready = signal(false);
  const connectionState = signal<RemoteConnectionState>("offline");
  const pairing = signal(false);
  const pairError = signal<string | undefined>(undefined);
  const inbox = signal<InboxSlice | undefined>(undefined);
  const collab = signal<CollabSlice | undefined>(undefined);
  const sessions = signal<SessionsSlice | undefined>(undefined);
  const board = signal<BoardSlice | undefined>(undefined);
  const watchMap = signal<Readonly<Record<string, SessionWatchState>>>({});

  let transport: HttpRemoteTransport | undefined;
  let sliceStops: (() => void)[] = [];
  const watchRefs = new Map<string, { count: number; stop: () => void }>();
  const bgWatchStops = new Map<string, () => void>();
  const pendingTasks = new Set<Promise<unknown>>();
  const notifiedIds = new Set<string>();
  const watchedBefore = new Set<string>();
  let inboxBootstrapped = false;
  let transportSuspended = false;
  let disposed = false;
  let deepLinkStarted = false;

  const trackTask = <T>(promise: Promise<T>): Promise<T> => {
    pendingTasks.add(promise);
    void promise.finally(() => {
      pendingTasks.delete(promise);
    });
    return promise;
  };

  const sessionNameFor = (sessionId: string): string => {
    const watchName = watchMap()[sessionId]?.session?.name;
    if (watchName) return watchName;
    const listName = (sessions()?.sessions ?? []).find((s) => s.id === sessionId)?.name;
    return listName ?? sessionId;
  };

  const notifyPermissionRequest = (sessionId: string, req: SessionPermissionRequest, sessionName?: string) => {
    const id = encodePermissionNotificationId(sessionId, req.requestId);
    if (notifiedIds.has(id)) return;
    notifiedIds.add(id);
    const title = sessionName ?? sessionNameFor(sessionId);
    void trackTask(showLocalNotification({ id, title, body: req.summary || req.tool }));
  };

  const notifyInteractionRequest = (sessionId: string, req: SessionInteractionRequest, sessionName?: string) => {
    const id = encodeInteractionNotificationId(sessionId, req.requestId);
    if (notifiedIds.has(id)) return;
    notifiedIds.add(id);
    const title = sessionName ?? sessionNameFor(sessionId);
    void trackTask(showLocalNotification({ id, title, body: req.question }));
  };

  const notifyInboxItem = (item: InboxItem) => {
    if (!isHighPriorityInboxKind(item.kind)) return;
    const id = encodeInboxNotificationId(item);
    if (notifiedIds.has(id)) return;
    notifiedIds.add(id);
    void trackTask(
      showLocalNotification({
        id,
        title: item.words.title || item.who,
        body: item.words.body || item.text,
      }),
    );
  };

  const processInboxNotifications = (frame: InboxSlice) => {
    if (!inboxBootstrapped) {
      inboxBootstrapped = true;
      for (const item of frame.items) {
        notifiedIds.add(encodeInboxNotificationId(item));
      }
      return;
    }
    for (const item of frame.items) {
      notifyInboxItem(item);
    }
  };

  const processWatchNotifications = (sessionId: string, event: SessionWatchEvent) => {
    switch (event.kind) {
      case "state": {
        const seenSession = watchedBefore.has(sessionId);
        watchedBefore.add(sessionId);
        for (const req of event.pendingPermissions) {
          if (seenSession) notifyPermissionRequest(sessionId, req, event.session.name);
          else notifiedIds.add(encodePermissionNotificationId(sessionId, req.requestId));
        }
        for (const req of event.pendingInteractions) {
          if (seenSession) notifyInteractionRequest(sessionId, req, event.session.name);
          else notifiedIds.add(encodeInteractionNotificationId(sessionId, req.requestId));
        }
        break;
      }
      case "event":
        if (event.event.type === "permission/request" && event.event.permission) {
          notifyPermissionRequest(sessionId, event.event.permission);
        } else if (event.event.type === "interaction/request" && event.event.interaction) {
          notifyInteractionRequest(sessionId, event.event.interaction);
        }
        break;
      case "history":
      case "missing":
        break;
    }
  };

  const updateWatchState = (sessionId: string, updater: (prev: SessionWatchState) => SessionWatchState) => {
    watchMap.update((current) => {
      const prev = current[sessionId] ?? EMPTY_WATCH_STATE;
      return { ...current, [sessionId]: updater(prev) };
    });
  };

  const ensureSessionWatch = (sessionId: string): (() => void) => {
    if (disposed || !transport) return () => {};
    const existing = watchRefs.get(sessionId);
    if (existing) {
      existing.count++;
    } else {
      const activeTransport = transport;
      const stop = activeTransport.subscribe(
        "session.watch",
        { id: sessionId },
        (raw) => {
          if (disposed || transport !== activeTransport) return;
          const parsed = SessionWatchEventSchema.safeParse(raw);
          if (parsed.success) {
            updateWatchState(sessionId, (prev) => applySessionWatchEvent(prev, parsed.data));
            processWatchNotifications(sessionId, parsed.data);
          }
        },
        () => {
          // Subscription ended; state stays cached until explicitly closed or re-opened.
        },
      );
      watchRefs.set(sessionId, { count: 1, stop });
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      const entry = watchRefs.get(sessionId);
      if (!entry) return;
      entry.count--;
      if (entry.count <= 0) {
        watchRefs.delete(sessionId);
        entry.stop();
      }
    };
  };

  const reconcileBackgroundWatches = () => {
    if (disposed || !transport) return;
    const desired = new Set<string>();
    const sessionList = sessions()?.sessions ?? [];
    for (const s of sessionList) {
      if (s.phase._tag === "working") desired.add(s.id);
    }
    const inboxItems = inbox()?.items ?? [];
    for (const item of inboxItems) {
      switch (item.target.kind) {
        case "session":
          desired.add(item.target.id);
          break;
        case "runtime":
          if (item.target.sessionId !== undefined) desired.add(item.target.sessionId);
          break;
        case "issue":
        case "chat":
          break;
      }
    }
    for (const [id, stop] of [...bgWatchStops.entries()]) {
      if (!desired.has(id)) {
        bgWatchStops.delete(id);
        stop();
      }
    }
    for (const id of desired) {
      if (!bgWatchStops.has(id)) {
        bgWatchStops.set(id, ensureSessionWatch(id));
      }
    }
  };

  const teardownTransport = () => {
    for (const stop of bgWatchStops.values()) stop();
    bgWatchStops.clear();
    for (const entry of watchRefs.values()) entry.stop();
    watchRefs.clear();
    for (const stop of sliceStops) stop();
    sliceStops = [];
    if (transport) {
      transport.close();
      transport = undefined;
    }
    transportSuspended = false;
    inboxBootstrapped = false;
    notifiedIds.clear();
    watchedBefore.clear();
    inbox.set(undefined);
    collab.set(undefined);
    sessions.set(undefined);
    board.set(undefined);
    watchMap.set({});
  };

  const connectWith = (creds: StoredCredentials) => {
    teardownTransport();
    if (disposed) return;
    connectionState.set("connecting");
    const next = createHttpRemoteTransport({
      baseUrl: creds.baseUrl,
      token: creds.token,
      ...(options?.fetch ? { fetch: options.fetch } : {}),
      onConnectionChange: (state) => {
        if (!disposed) connectionState.set(state);
      },
    });
    if (lifecycle() === "background") {
      transportSuspended = true;
      next.suspend();
    } else {
      transportSuspended = false;
    }
    transport = next;
    sliceStops = [
      next.slice("inbox", (frame) => {
        if (disposed || transport !== next) return;
        inbox.set(frame);
        processInboxNotifications(frame);
        reconcileBackgroundWatches();
      }),
      next.slice("collab", (frame) => {
        if (disposed || transport !== next) return;
        collab.set(frame);
      }),
      next.slice("sessions", (frame) => {
        if (disposed || transport !== next) return;
        sessions.set(frame);
        reconcileBackgroundWatches();
      }),
      next.slice("board", (frame) => {
        if (disposed || transport !== next) return;
        board.set(frame);
      }),
    ];
  };

  const pair = async (rawUrl: string, code: string, deviceName: string): Promise<boolean> => {
    const normalizedUrl = normalizeServerUrl(rawUrl);
    const trimmedCode = code.trim();
    const trimmedName = deviceName.trim();
    if (!isValidHttpUrl(normalizedUrl) || trimmedCode === "" || trimmedName === "") {
      pairError.set(t("web.remote.mobile.invalidInput"));
      hapticNotification("error");
      return false;
    }

    pairing.set(true);
    pairError.set(undefined);
    try {
      const result = await pairWithServer(
        normalizedUrl,
        {
          code: trimmedCode,
          deviceName: trimmedName,
          platform: currentRemotePlatform(),
        },
        options?.fetch,
      );
      if (disposed) return false;
      const stored: StoredCredentials = {
        baseUrl: normalizedUrl,
        token: result.token,
        deviceName: result.device.name || trimmedName,
        serverName: result.serverName,
      };
      await saveCredentials(stored, tokenStore);
      if (disposed) return false;
      credentials.set(stored);
      connectWith(stored);
      void trackTask(requestNotificationPermissionSafe());
      hapticNotification("success");
      return true;
    } catch (err: unknown) {
      if (!disposed) {
        pairError.set(err instanceof Error ? err.message : String(err));
        hapticNotification("error");
      }
      return false;
    } finally {
      if (!disposed) pairing.set(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    teardownTransport();
    await clearCredentials(tokenStore);
    void trackTask(syncAppBadge(0));
    void trackTask(clearAllNotifications());
    if (disposed) return;
    credentials.set(undefined);
    pairError.set(undefined);
    connectionState.set("offline");
  };

  const call: RemoteSession["call"] = async (op, payload, callOptions) => {
    if (!transport) {
      return {
        bizCode: BizCode.ServiceUnavailable,
        message: t("web.remote.state.offline"),
      };
    }
    const envelope = await transport.call(op, payload, callOptions);
    if (envelope.bizCode === 0 && isRecord(payload) && typeof payload.id === "string" && typeof payload.requestId === "string") {
      const targetId = payload.id;
      const reqId = payload.requestId;
      if (op === "session.respondPermission") {
        updateWatchState(targetId, (prev) => ({
          ...prev,
          pendingPermissions: prev.pendingPermissions.filter((item) => item.requestId !== reqId),
        }));
      } else if (op === "session.respondInteraction") {
        updateWatchState(targetId, (prev) => ({
          ...prev,
          pendingInteractions: prev.pendingInteractions.filter((item) => item.requestId !== reqId),
        }));
      }
    }
    return envelope;
  };

  const subscribe: RemoteSession["subscribe"] = (name, payload, on, ended) => {
    if (!transport) {
      queueMicrotask(() => {
        if (!disposed) {
          ended({
            bizCode: BizCode.ServiceUnavailable,
            message: t("web.remote.state.offline"),
          });
        }
      });
      return () => {};
    }
    return transport.subscribe(name, payload, on, ended);
  };

  const pendingPermissions = computed<readonly PendingPermissionItem[]>(() => {
    const map = watchMap();
    const names = new Map<string, string>((sessions()?.sessions ?? []).map((s) => [s.id, s.name] as const));
    const items: PendingPermissionItem[] = [];
    for (const [sessionId, state] of Object.entries(map)) {
      const sessionName = state.session?.name ?? names.get(sessionId) ?? sessionId;
      for (const request of state.pendingPermissions) {
        items.push({ sessionId, sessionName, request });
      }
    }
    return items;
  });

  const pendingInteractions = computed<readonly PendingInteractionItem[]>(() => {
    const map = watchMap();
    const names = new Map<string, string>((sessions()?.sessions ?? []).map((s) => [s.id, s.name] as const));
    const items: PendingInteractionItem[] = [];
    for (const [sessionId, state] of Object.entries(map)) {
      const sessionName = state.session?.name ?? names.get(sessionId) ?? sessionId;
      for (const request of state.pendingInteractions) {
        items.push({ sessionId, sessionName, request });
      }
    }
    return items;
  });

  const unreadInboxCount = computed<number>(() => pendingPermissions().length + pendingInteractions().length + (inbox()?.items.length ?? 0));

  let lastBadgeSynced: number | undefined;
  effect(() => {
    const isPaired = credentials() !== undefined;
    const count = isPaired ? unreadInboxCount() : 0;
    if (disposed || count === lastBadgeSynced) return;
    lastBadgeSynced = count;
    void trackTask(syncAppBadge(count));
  });

  effect(() => {
    const state = lifecycle();
    if (disposed) return;
    if (state === "background") {
      if (!transportSuspended) {
        transportSuspended = true;
        transport?.suspend();
      }
      return;
    }
    if (state === "active" && transportSuspended) {
      transportSuspended = false;
      transport?.resume();
    }
  });

  let lastWakeCount = wakeCount();
  effect(() => {
    const count = wakeCount();
    if (disposed || count === lastWakeCount) return;
    lastWakeCount = count;
    if (lifecycle() !== "background") {
      transportSuspended = false;
      transport?.resume();
    }
  });

  const sessionWatchState = (sessionId: string): SessionWatchState => watchMap()[sessionId] ?? EMPTY_WATCH_STATE;

  const stopUrlScheme = UrlScheme.on("open", ({ url }) => {
    const parsed = parsePairUrl(url);
    if (!parsed) return;
    deepLinkStarted = true;
    void trackTask(pair(parsed.url, parsed.code, defaultDeviceName()));
  });

  void trackTask(
    loadCredentials(tokenStore).then((stored) => {
      if (disposed) return;
      if (stored && !deepLinkStarted && credentials() === undefined) {
        credentials.set(stored);
        connectWith(stored);
      }
      ready.set(true);
    }),
  );

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopUrlScheme();
    teardownTransport();
  };

  return {
    credentials,
    ready,
    connectionState,
    pairing,
    pairError,
    inbox,
    collab,
    sessions,
    board,
    pendingPermissions,
    pendingInteractions,
    sessionWatchState,
    ensureSessionWatch,
    pair,
    disconnect,
    call,
    subscribe,
    dispose,
  };
}
