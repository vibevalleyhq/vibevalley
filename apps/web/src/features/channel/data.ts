// The chat page's reads beyond the channels it follows (features/channel/follow.ts).

import { type Accessor, createEffect, createSignal } from "solid-js";

import type { Channel } from "@vibevalley/protocol";
import { api } from "../../base/api";
import { newestUnread } from "./rules";

// Channels the owner marked unread while looking at them: they stay unread until the owner leaves and comes back.
const [held, setHeld] = createSignal<ReadonlySet<string>>(new Set());

/** The owner's read in a channel goes back to just before this message, and the shown list leaves it so. */
export async function markUnread(channel: string, number: number) {
  setHeld((h) => new Set([...h, channel]));
  await api.channel.markUnread({ id: channel, number });
}

/** A shown channel is read: the newest unread number goes to the server once it is drawn. */
export function useMarkRead(channel: Accessor<Channel | undefined>) {
  createEffect(
    () => channel()?.id,
    (id) => () => {
      if (id) setHeld((h) => new Set([...h].filter((c) => c !== id)));
    },
  );
  createEffect(
    () => {
      const c = channel();
      const number = c && !held().has(c.id) ? newestUnread(c) : undefined;
      // A string, so the same channel and number again is equal and posts nothing.
      return c && number !== undefined ? JSON.stringify([c.id, number]) : undefined;
    },
    (read) => {
      if (!read) return;
      const [id, number] = JSON.parse(read) as [string, number];
      api.channel.markRead({ id, number }).catch(() => {});
    },
  );
}
