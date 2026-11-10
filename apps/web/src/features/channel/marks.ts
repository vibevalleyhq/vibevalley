import { type Accessor, createEffect, createMemo } from "solid-js";

import { type Channel, type Chat, type ChatMessage, type Notify, userId, type StateFrame } from "@vibevalley/protocol";

import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { defineAtom } from "#/state/atom.ts";
import { defineIntent, type Intent, type Intents, sendReplacing, useIntents } from "#/state/intent.ts";

import { type Followed, followed, useFollowed } from "./follow";
import { newestUnread } from "./places";

export interface ReactionMark {
  /** The message's channel: the copy that shows the reaction is followed there. */
  readonly channel: string;
  readonly id: ChatMessage["id"];
  readonly emoji: string;
  readonly on: boolean;
}

export interface PinMark {
  readonly channel: string;
  readonly id: ChatMessage["id"];
  readonly on: boolean;
  /** When it was pressed: the pin's time until the server's copy has its own. */
  readonly at: number;
}

const copyOf = (channel: string, id: string) => followed.get(channel).messages.find((m) => m.id === id);

const reacted = (m: Pick<ChatMessage, "reactions">, emoji: string) => m.reactions.some((r) => r.emoji === emoji && r.by.includes(userId));

export const reactionSet = defineIntent<ReactionMark, ChatMessage>({
  send: (r) => api.channel.reaction.set({ id: r.id, emoji: r.emoji, on: r.on }),
  confirmed: (_frame, i) => {
    const m = copyOf(i.input.channel, i.input.id);
    return m !== undefined && reacted(m, i.input.emoji) === i.input.on;
  },
  watch: (r, changed) => followed.subscribe(r.channel, changed),
  // A set: sent again once the stream is back, it changes nothing more than the first would have.
  whileLost: "queue",
  timeoutMs: 20_000,
});

export const pinSet = defineIntent<PinMark, ChatMessage>({
  send: (p) => api.channel.pin.set({ id: p.id, on: p.on }),
  confirmed: (_frame, i) => {
    const m = copyOf(i.input.channel, i.input.id);
    return m !== undefined && (m.pinned !== undefined) === i.input.on;
  },
  watch: (p, changed) => followed.subscribe(p.channel, changed),
  whileLost: "queue",
  timeoutMs: 20_000,
});

export interface ArchiveMark {
  readonly id: string;
  readonly on: boolean;
  readonly at: number;
}

export interface NotifyMark {
  readonly id: string;
  readonly notify: Notify;
}

const channelIn = (frame: StateFrame | undefined, id: string) => frame?.state.chat?.channels.find((c) => c.id === id);

export interface ReadMark {
  readonly channel: string;
  readonly number: number;
}

/** The server puts read just before the message (never below 0): settled once the frame's read is there or before. */
const unreadUpTo = (number: number) => Math.max(0, number - 1);

const readMark = defineIntent<ReadMark, void>({
  send: (r) => api.channel.markRead({ id: r.channel, number: r.number }),
  confirmed: (frame, i) => (channelIn(frame, i.input.channel)?.read ?? 0) >= i.input.number,
  whileLost: "queue",
  timeoutMs: 20_000,
});

export const unreadMark = defineIntent<ReadMark, void>({
  send: (r) => api.channel.markUnread({ id: r.channel, number: r.number }),
  confirmed: (frame, i) => (channelIn(frame, i.input.channel)?.read ?? 0) <= unreadUpTo(i.input.number),
  whileLost: "queue",
  timeoutMs: 20_000,
});

const sameChannel = (a: ReadMark, b: ReadMark) => a.channel === b.channel;

// Channels the user marked unread while looking at them: they stay unread until the user leaves and comes back.
const held = defineAtom<ReadonlySet<string>>(new Set());
const release = (channel: string) => held.update((h) => new Set([...h].filter((c) => c !== channel)));

/** The user's read in a channel goes back to just before this message, and the shown list leaves it so. */
export function markUnread(intents: Intents<ReadMark, void>, mark: ReadMark, say: (reason: string) => void) {
  held.update((h) => new Set([...h, mark.channel]));
  setMark(intents, mark, sameChannel, (reason) => {
    release(mark.channel);
    say(reason);
  });
}

/** A channel with the user's mark unread on its way laid over its read; the same object with none. */
export function markedRead(c: Channel, unreads: readonly Intent<ReadMark, void>[]): Channel {
  const mark = unreads.findLast((u) => u.input.channel === c.id);
  if (mark === undefined) return c;
  const read = unreadUpTo(mark.input.number);
  return (c.read ?? 0) <= read ? c : { ...c, read };
}

/** A shown channel is read: the newest unread number goes to the server once it is drawn; `say` tells a refusal. */
export function useMarkRead(channel: Accessor<Channel | undefined>, say: (reason: string) => void) {
  const reads = useIntents(readMark);
  createEffect(
    () => channel()?.id,
    (id) => () => {
      if (id) release(id);
    },
  );
  createEffect(
    () => {
      const c = channel();
      const number = c && !held.get().has(c.id) ? newestUnread(c) : undefined;
      // A string, so the same channel and number again is equal and posts nothing.
      return c && number !== undefined ? `${c.id}\n${number}` : undefined;
    },
    (read) => {
      if (!read) return;
      const [id = "", n = ""] = read.split("\n");
      setMark(reads, { channel: id, number: Number(n) }, sameChannel, say);
    },
  );
}

export const archiveSet = defineIntent<ArchiveMark, void>({
  send: (a) => api.channel.archive.set({ id: a.id, on: a.on }),
  confirmed: (frame, i) => {
    const c = channelIn(frame, i.input.id);
    return c !== undefined && (c.archived !== undefined) === i.input.on;
  },
  whileLost: "queue",
  timeoutMs: 20_000,
});

export const notifySet = defineIntent<NotifyMark, void>({
  send: (n) => api.channel.notify.set({ id: n.id, notify: n.notify }),
  confirmed: (frame, i) => (channelIn(frame, i.input.id)?.notify ?? "all") === i.input.notify,
  whileLost: "queue",
  timeoutMs: 20_000,
});

/**
 * A mark set again before the first showed replaces it (sendReplacing); a failed one is let go and said, so the user
 * sees the server's state again and why.
 */
export function setMark<I, R>(intents: Intents<I, R>, input: I, same: (a: I, b: I) => boolean, say: (reason: string) => void) {
  void sendReplacing(intents, input, same).done.then((end) => {
    if (end?.phase !== "failed") return;
    intents.drop(end.key);
    say(end.fault.reason);
  });
}

export const sameReaction = (a: ReactionMark, b: ReactionMark) => a.id === b.id && a.emoji === b.emoji;
export const sameMessage = (a: { readonly id: string }, b: { readonly id: string }) => a.id === b.id;

function withReaction(m: ChatMessage, emoji: string, on: boolean): ChatMessage {
  if (reacted(m, emoji) === on) return m;
  const had = m.reactions.some((r) => r.emoji === emoji);
  const reactions = on
    ? had
      ? m.reactions.map((r) => (r.emoji === emoji ? { ...r, by: [...r.by, userId] } : r))
      : [...m.reactions, { emoji, by: [userId] }]
    : m.reactions.flatMap((r) => (r.emoji !== emoji ? [r] : r.by.length > 1 ? [{ ...r, by: r.by.filter((b) => b !== userId) }] : []));
  return { ...m, reactions };
}

/** The messages with the user's reactions and pins on their way laid over them; a message with none is the same object. */
export function markedMessages(
  messages: readonly ChatMessage[],
  reactions: readonly Intent<ReactionMark, ChatMessage>[],
  pins: readonly Intent<PinMark, ChatMessage>[],
): readonly ChatMessage[] {
  if (reactions.length === 0 && pins.length === 0) return messages;
  return messages.map((m) => {
    let shown = m;
    for (const r of reactions) if (r.input.id === m.id) shown = withReaction(shown, r.input.emoji, r.input.on);
    const pin = pins.findLast((p) => p.input.id === m.id);
    if (pin !== undefined && (shown.pinned !== undefined) !== pin.input.on) {
      const { pinned: _, ...rest } = shown;
      shown = pin.input.on ? { ...rest, pinned: pin.input.at } : rest;
    }
    return shown;
  });
}

/** A channel's messages while it is shown, with the user's reactions and pins on their way. */
export function useMarkedFollowed(id: Accessor<string | undefined>): Accessor<Followed> {
  const said = useFollowed(id);
  const reactions = useIntents(reactionSet);
  const pins = useIntents(pinSet);
  return createMemo(() => {
    const f = said();
    const messages = markedMessages(f.messages, reactions.list(), pins.list());
    return messages === f.messages ? f : { ...f, messages };
  });
}

interface ChannelMarks {
  readonly archives: readonly Intent<ArchiveMark, void>[];
  readonly notifies: readonly Intent<NotifyMark, void>[];
  readonly unreads: readonly Intent<ReadMark, void>[];
}

/** A channel with the user's archive, notify and unread choices on their way laid over it; the same object with none. */
export function markedChannel(c: Channel, marks: ChannelMarks): Channel {
  let shown = markedRead(c, marks.unreads);
  const archive = marks.archives.findLast((a) => a.input.id === c.id);
  if (archive && (shown.archived !== undefined) !== archive.input.on) {
    const { archived: _, ...rest } = shown;
    shown = archive.input.on ? { ...rest, archived: archive.input.at } : rest;
  }
  const notify = marks.notifies.findLast((n) => n.input.id === c.id);
  if (notify && (shown.notify ?? "all") !== notify.input.notify) shown = { ...shown, notify: notify.input.notify };
  return shown;
}

/** The frame's chat with the user's channel marks on their way; the same object with none. */
function markedChat(chat: Chat | undefined, marks: ChannelMarks): Chat | undefined {
  if (!chat || (marks.archives.length === 0 && marks.notifies.length === 0 && marks.unreads.length === 0)) return chat;
  return { ...chat, channels: chat.channels.map((c) => markedChannel(c, marks)) };
}

/** The chat as the chat page shows it: the frame's, with the user's channel marks on their way. */
export function useMarkedChat() {
  const core = useCore();
  const archives = useIntents(archiveSet);
  const notifies = useIntents(notifySet);
  const unreads = useIntents(unreadMark);
  return () => markedChat(core()?.chat, { archives: archives.list(), notifies: notifies.list(), unreads: unreads.list() });
}

/** A choice on its way, for a control to draw (Select's state). */
export const markState = <I>(intents: readonly Intent<I, unknown>[], is: (input: I) => boolean): "pending" | undefined =>
  intents.some((i) => is(i.input) && i.phase !== "failed") ? "pending" : undefined;
