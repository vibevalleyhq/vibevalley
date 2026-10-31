// Where the owner has read to in a channel: moved on as a shown channel's messages are drawn (markRead), moved back by
// 标为未读 (markUnread). Both are sets, sent as intents (base/intent.ts) that queue while the state stream is lost and
// settle when the frame's channel has its read where it was put. A failure is said in the error tone; a mark unread
// that failed also lets go of its hold, so the channel reads as read again rather than looking marked when it is not.

import { type Accessor, createEffect, createSignal } from "solid-js";

import type { Channel, StateFrame } from "@vibevalley/protocol";

import { api } from "@/base/api";
import { defineIntent, type Intent, type Intents, sendReplacing, useIntents } from "@/base/intent";

import { newestUnread } from "./unread";

export interface ReadMark {
  readonly channel: string;
  readonly number: number;
}

const readIn = (frame: StateFrame | undefined, id: string) => frame?.state.chat?.channels.find((c) => c.id === id)?.read;

/** The server puts read just before the message (never below 0): settled once the frame's read is there or before. */
const unreadUpTo = (number: number) => Math.max(0, number - 1);

const readMark = defineIntent<ReadMark, void>({
  send: (r) => api.channel.markRead({ id: r.channel, number: r.number }),
  confirmed: (frame, i) => (readIn(frame, i.input.channel) ?? 0) >= i.input.number,
  whileLost: "queue",
  timeoutMs: 20_000,
});

export const unreadMark = defineIntent<ReadMark, void>({
  send: (r) => api.channel.markUnread({ id: r.channel, number: r.number }),
  confirmed: (frame, i) => (readIn(frame, i.input.channel) ?? 0) <= unreadUpTo(i.input.number),
  whileLost: "queue",
  timeoutMs: 20_000,
});

const sameChannel = (a: ReadMark, b: ReadMark) => a.channel === b.channel;

// Channels the owner marked unread while looking at them: they stay unread until the owner leaves and comes back.
const [held, setHeld] = createSignal<ReadonlySet<string>>(new Set());
const release = (channel: string) => setHeld((h) => new Set([...h].filter((c) => c !== channel)));

/** The owner's read in a channel goes back to just before this message, and the shown list leaves it so. */
export function markUnread(intents: Intents<ReadMark, void>, mark: ReadMark, say: (reason: string) => void) {
  setHeld((h) => new Set([...h, mark.channel]));
  void sendReplacing(intents, mark, sameChannel).done.then((end) => {
    if (end?.status !== "failed") return;
    intents.drop(end.key);
    release(mark.channel);
    say(end.reason ?? "");
  });
}

/** A channel with the owner's mark unread on its way laid over its read; the same object with none. */
export function markedRead(c: Channel, unreads: readonly Intent<ReadMark, void>[]): Channel {
  const mark = unreads.findLast((u) => u.input.channel === c.id);
  if (!mark) return c;
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
      const number = c && !held().has(c.id) ? newestUnread(c) : undefined;
      // A string, so the same channel and number again is equal and posts nothing.
      return c && number !== undefined ? `${c.id}\n${number}` : undefined;
    },
    (read) => {
      if (!read) return;
      const [id = "", n = ""] = read.split("\n");
      void sendReplacing(reads, { channel: id, number: Number(n) }, sameChannel).done.then((end) => {
        if (end?.status !== "failed") return;
        reads.drop(end.key);
        say(end.reason ?? "");
      });
    },
  );
}
