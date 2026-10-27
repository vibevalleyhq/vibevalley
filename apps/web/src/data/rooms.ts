// What is said in each conversation the page shows, framework-free: its newest page read once (channel.history), then
// its room followed from the last number (data/gateway.ts), older pages on asking. A room stays read after nobody
// shows it, and its follower comes back from where it left off. The farm's reports are a feed of their own.

import type { ChatMessage, RoomEvent } from "@vibevalley/protocol";
import { type Accessor, createEffect, createSignal } from "solid-js";
import { chatPage } from "../rules/chat";
import { api } from "./api";
import { followReports, followRoom } from "./gateway";

export interface Room {
  /** By number, oldest first. */
  readonly messages: readonly ChatMessage[];
  /** The first message is among them. */
  readonly complete: boolean;
  /** The newest page has been read. */
  readonly ready: boolean;
}

const empty: Room = { messages: [], complete: false, ready: false };

/** A message is not changed once written: a number seen again keeps the copy there is. */
export function merged(was: readonly ChatMessage[], more: readonly ChatMessage[]): ChatMessage[] {
  const by = new Map(was.map((m) => [m.number, m]));
  for (const m of more) if (!by.has(m.number)) by.set(m.number, m);
  return [...by.values()].sort((a, b) => a.number - b.number);
}

/** Following again after the line broke or the farm ended it. */
const againMs = 1000;

interface Entry {
  room: Room;
  readonly listeners: Set<() => void>;
  stop?: () => void;
  retry?: ReturnType<typeof setTimeout>;
  /** Moves on each start and stop: a late answer to an earlier one is dropped. */
  epoch: number;
}

const entries = new Map<string, Entry>();

const entryOf = (id: string) => {
  let e = entries.get(id);
  if (!e) entries.set(id, (e = { room: empty, listeners: new Set(), epoch: 0 }));
  return e;
};

const set = (e: Entry, room: Room) => {
  e.room = room;
  for (const l of e.listeners) l();
};

const halt = (e: Entry) => {
  e.epoch++;
  clearTimeout(e.retry);
  e.stop?.();
  e.stop = undefined;
};

function again(id: string, e: Entry) {
  e.stop = undefined;
  if (e.listeners.size === 0) return;
  clearTimeout(e.retry);
  e.retry = setTimeout(() => void (e.listeners.size > 0 && start(id, e)), againMs);
}

function onEvent(id: string, e: Entry, ev: RoomEvent) {
  switch (ev._tag) {
    case "Message":
      return set(e, { ...e.room, messages: merged(e.room.messages, [ev.message]) });
    case "Reset":
      // Too far behind to catch up: the newest page again, and on from there.
      halt(e);
      set(e, empty);
      return void start(id, e);
  }
}

async function start(id: string, e: Entry) {
  const epoch = ++e.epoch;
  if (!e.room.ready) {
    const page = await api.channel.history({ id, limit: chatPage }).catch(() => undefined);
    if (epoch !== e.epoch) return;
    if (!page) return again(id, e);
    set(e, { messages: merged(e.room.messages, page), complete: page.length < chatPage, ready: true });
  }
  e.stop = followRoom(
    id,
    e.room.messages.at(-1)?.number ?? 0,
    (ev) => onEvent(id, e, ev),
    () => again(id, e),
  );
}

export const rooms = {
  get: (id: string): Room => entries.get(id)?.room ?? empty,
  /** Followed while anyone listens. */
  subscribe(id: string, listener: () => void): () => void {
    const e = entryOf(id);
    e.listeners.add(listener);
    if (e.listeners.size === 1) void start(id, e);
    return () => {
      e.listeners.delete(listener);
      if (e.listeners.size === 0) halt(e);
    };
  },
  async loadOlder(id: string) {
    const e = entryOf(id);
    if (e.room.complete) return;
    const page = await api.channel.history({ id, before: e.room.messages[0]?.number, limit: chatPage });
    set(e, { ...e.room, messages: merged(e.room.messages, page), complete: page.length < chatPage });
  },
  /** A message by its place, from a room read or read once for it: a thread's parent. */
  message(conversation: string, number: number, listener: () => void): ChatMessage | undefined {
    const shown = entries.get(conversation)?.room.messages.find((m) => m.number === number);
    if (shown) return shown;
    const key = `${conversation}:${number}`;
    if (!singles.has(key)) {
      singles.set(key, undefined);
      void api.channel
        .history({ id: conversation, before: number + 1, limit: 1 })
        .then((page) => {
          singles.set(
            key,
            page.find((m) => m.number === number),
          );
          listener();
        })
        .catch(() => singles.delete(key));
    }
    return singles.get(key);
  },
};

const singles = new Map<string, ChatMessage | undefined>();

/** The room of a conversation while it is shown; empty with none. */
export function useRoom(id: Accessor<string | undefined>): Accessor<Room> {
  const [room, setRoom] = createSignal<Room>(empty);
  createEffect(id, (at) => {
    if (!at) return void setRoom(empty);
    setRoom(rooms.get(at));
    return rooms.subscribe(at, () => setRoom(rooms.get(at)));
  });
  return room;
}

/** A message by its place (a thread's parent) while it is shown. */
export function useMessage(at: Accessor<{ conversation: string; number: number } | undefined>): Accessor<ChatMessage | undefined> {
  const [message, setMessage] = createSignal<ChatMessage | undefined>(undefined);
  createEffect(at, (p) => {
    if (!p) return setMessage(undefined);
    const read = () => setMessage(rooms.message(p.conversation, p.number, read));
    read();
    // The room may come to have it as it is read.
    return rooms.subscribe(p.conversation, read);
  });
  return message;
}

/** How many reports the farm's log keeps. */
const logKeep = 80;

let reports: readonly ChatMessage[] = [];
const reportListeners = new Set<() => void>();
let stopReports: (() => void) | undefined;
let reportsRetry: ReturnType<typeof setTimeout> | undefined;

function startReports() {
  stopReports = followReports(
    reports.at(-1)?.id,
    (ev) => {
      if (ev._tag === "Reset") reports = [];
      else if (!reports.some((m) => m.id === ev.message.id)) reports = [...reports, ev.message].slice(-logKeep);
      for (const l of reportListeners) l();
    },
    () => {
      stopReports = undefined;
      if (reportListeners.size > 0) reportsRetry = setTimeout(() => void (reportListeners.size > 0 && startReports()), againMs);
    },
  );
}

/** The farm's turn reports, oldest first, while shown. */
export function useReports(): Accessor<readonly ChatMessage[]> {
  const [got, setGot] = createSignal<readonly ChatMessage[]>(reports);
  createEffect(
    () => true,
    () => {
      const listener = () => setGot(reports);
      reportListeners.add(listener);
      if (reportListeners.size === 1) startReports();
      setGot(reports);
      return () => {
        reportListeners.delete(listener);
        if (reportListeners.size > 0) return;
        clearTimeout(reportsRetry);
        stopReports?.();
        stopReports = undefined;
      };
    },
  );
  return got;
}
