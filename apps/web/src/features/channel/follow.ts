// What is said in each channel the page shows, framework-free: its newest page read once (channel.message.list), then
// followed from the newest revision it has (base/gateway.ts), older pages on asking. A channel stays read after nobody shows
// it, and its follower comes back from where it left off. The farm's reports are a feed of their own.

import { type Accessor, createEffect, createSignal } from "solid-js";

import type { ChatMessage, ChannelEvent } from "@vibevalley/protocol";
import { omitUndefined } from "@vibevalley/protocol/rules";

import { api } from "@/base/api";
import { followReports, followChannel } from "@/base/gateway";

import { chatPage } from "./feed";
export interface Followed {
  /** By number, oldest first. */
  readonly messages: readonly ChatMessage[];
  /** The first message is among them. */
  readonly complete: boolean;
  /** The newest page has been read. */
  readonly ready: boolean;
}

const empty: Followed = { messages: [], complete: false, ready: false };

function merged(was: readonly ChatMessage[], more: readonly ChatMessage[]): ChatMessage[] {
  const by = new Map(was.map((m) => [m.number, m]));
  for (const m of more) {
    const had = by.get(m.number);
    if (!had || m.revision > had.revision) by.set(m.number, m);
  }
  return [...by.values()].toSorted((a, b) => a.number - b.number);
}

/** Where a channel's follower goes on from: the newest change it has. */
const revisionOf = (messages: readonly ChatMessage[]) => messages.reduce((n, m) => Math.max(n, m.revision), 0);

/** Following again after the line broke or the farm ended it. */
const againMs = 1000;

interface Entry {
  followed: Followed;
  readonly listeners: Set<() => void>;
  stop: (() => void) | undefined;
  retry?: ReturnType<typeof setTimeout>;
  /** Moves on each start and stop: a late answer to an earlier one is dropped. */
  epoch: number;
}

const entries = new Map<string, Entry>();

const entryOf = (id: string) => {
  let e = entries.get(id);
  if (!e) entries.set(id, (e = { followed: empty, listeners: new Set(), epoch: 0, stop: undefined }));
  return e;
};

const set = (e: Entry, followed: Followed) => {
  e.followed = followed;
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

function onEvent(id: string, e: Entry, ev: ChannelEvent) {
  switch (ev._tag) {
    case "Message": {
      // A change to a message older than the pages read is read with them when they are.
      const first = e.followed.messages[0]?.number;
      if (!e.followed.complete && first !== undefined && ev.message.number < first) return;
      return set(e, { ...e.followed, messages: merged(e.followed.messages, [ev.message]) });
    }
    case "Reset":
      // Too far behind to catch up: the newest page again, and on from there.
      halt(e);
      set(e, empty);
      return void start(id, e);
  }
}

async function start(id: string, e: Entry) {
  const epoch = ++e.epoch;
  if (!e.followed.ready) {
    const page = await api.channel.message.list({ id, limit: chatPage }).catch(() => undefined);
    if (epoch !== e.epoch) return;
    if (!page) return again(id, e);
    set(e, { messages: merged(e.followed.messages, page), complete: page.length < chatPage, ready: true });
  }
  e.stop = followChannel(
    id,
    revisionOf(e.followed.messages),
    (ev) => onEvent(id, e, ev),
    () => again(id, e),
  );
}

export const followed = {
  get: (id: string): Followed => entries.get(id)?.followed ?? empty,
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
    if (e.followed.complete) return;
    const page = await api.channel.message.list(omitUndefined({ id, before: e.followed.messages[0]?.number, limit: chatPage }));
    set(e, { ...e.followed, messages: merged(e.followed.messages, page), complete: page.length < chatPage });
  },
  /** A message by its place, from a channel followed or read once for it: a thread's root. */
  message(channel: string, number: number, listener: () => void): ChatMessage | undefined {
    const shown = entries.get(channel)?.followed.messages.find((m) => m.number === number);
    if (shown) return shown;
    const key = `${channel}:${number}`;
    // Everyone who asks while it is read is told once it is in, not only the first.
    const waiting = waiters.get(key);
    if (waiting) waiting.add(listener);
    else if (!singles.has(key)) {
      waiters.set(key, new Set([listener]));
      void api.channel.message
        .list({ id: channel, before: number + 1, limit: 1 })
        .then(
          (page) =>
            singles.set(
              key,
              page.find((m) => m.number === number),
            ),
          () => {},
        )
        .finally(() => {
          const told = waiters.get(key) ?? new Set();
          waiters.delete(key);
          for (const l of told) l();
        });
    }
    return singles.get(key);
  },
};

const singles = new Map<string, ChatMessage | undefined>();
const waiters = new Map<string, Set<() => void>>();

/** A channel's messages while it is shown; empty with none. */
export function useFollowed(id: Accessor<string | undefined>): Accessor<Followed> {
  const [said, setFollowed] = createSignal<Followed>(empty);
  createEffect(id, (at) => {
    if (!at) return void setFollowed(empty);
    setFollowed(followed.get(at));
    return followed.subscribe(at, () => setFollowed(followed.get(at)));
  });
  return said;
}

/** A message by its place (a thread's parent) while it is shown. */
export function useMessage(at: Accessor<{ channel: string; number: number } | undefined>): Accessor<ChatMessage | undefined> {
  const [message, setMessage] = createSignal<ChatMessage | undefined>(undefined);
  createEffect(at, (p) => {
    if (!p) return setMessage(undefined);
    const read = () => setMessage(followed.message(p.channel, p.number, read));
    read();
    // The channel may come to have it as it is read.
    return followed.subscribe(p.channel, read);
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
