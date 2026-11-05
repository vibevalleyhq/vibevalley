// Finding a channel in the chat the frame carries; the server and the page look it up the same way.

import type { Channel, Chat } from "../shapes";

/** The channel words go to when none is named. */
export const defaultOf = (chat: Chat | undefined): Channel | undefined => chat?.channels.find((c) => c.default);

/** A channel by its id; none when no id is given. */
export const channelOf = (chat: Chat | undefined, id: string | undefined): Channel | undefined => (id ? chat?.channels.find((c) => c.id === id) : undefined);

/** What an @name may follow: anything but a Latin letter, a digit, _ or @, so a@b.com names no one while 问@w3 does
 * (Chinese runs on without spaces). The server reads mentions with it and the page opens its menu with it. */
export const mentionLead = String.raw`(?<![\p{Script=Latin}\p{N}_@])`;
