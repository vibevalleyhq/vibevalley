// The chat page's reads beyond the rooms (features/channel/rooms.ts).

import { type Accessor, createEffect } from "solid-js";

import type { Conversation } from "@vibevalley/protocol";
import { api } from "../../base/api";
import { newestUnread } from "./rules";

/** A shown conversation is read: the newest unread number goes to the server once it is drawn. */
export function useMarkRead(conversation: Accessor<Conversation | undefined>) {
  createEffect(
    () => {
      const c = conversation();
      const number = c ? newestUnread(c) : undefined;
      // A string, so the same conversation and number again is equal and posts nothing.
      return c && number !== undefined ? JSON.stringify([c.id, number]) : undefined;
    },
    (read) => {
      if (!read) return;
      const [id, number] = JSON.parse(read) as [string, number];
      api.channel.markRead({ id, body: { number } }).catch(() => {});
    },
  );
}
