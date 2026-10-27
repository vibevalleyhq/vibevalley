// The chat page's reads beyond the channels it follows (features/channel/follow.ts).

import { type Accessor, createEffect } from "solid-js";

import type { Channel } from "@vibevalley/protocol";
import { api } from "../../base/api";
import { newestUnread } from "./rules";

/** A shown channel is read: the newest unread number goes to the server once it is drawn. */
export function useMarkRead(channel: Accessor<Channel | undefined>) {
  createEffect(
    () => {
      const c = channel();
      const number = c ? newestUnread(c) : undefined;
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
