// What the owner has not read: in a channel, under a channel's threads, in all.

import { type Chat, type Channel } from "@vibevalley/protocol";
export const unreadIn = (c: Channel) => c.unread ?? 0;

export const unreadTotal = (chat: Chat | undefined) => (chat?.channels ?? []).reduce((n, c) => n + unreadIn(c), 0);

/** The number a receipt for this channel carries, or undefined with nothing unread. */
export const newestUnread = (c: Channel) => (unreadIn(c) > 0 ? c.lastNumber : undefined);

/** A channel's own unread and its threads'; threads without a channel count under the general. */
export const unreadUnder = (chat: Chat | undefined, channel: Channel) =>
  (chat?.channels ?? []).filter((c) => c.id === channel.id || c.parent === channel.id).reduce((n, c) => n + unreadIn(c), 0);
