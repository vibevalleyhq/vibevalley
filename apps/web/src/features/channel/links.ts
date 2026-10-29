// Links to the farm's own messages in a message's text: which channel and number each points at.

import { type Chat } from "@vibevalley/protocol";
import { channelOf, defaultOf } from "./places";
/** A message on this farm that a message links to, by the address its copy-link tool gives. */
export interface LinkedMessage {
  readonly channel: string;
  readonly number: number;
}

const farmLink = /https?:\/\/([^/\s]+)\/chat(?:\/([0-9a-f-]{36}))?\?m=(\d+)/g;

/** The farm messages a text links to, once each, at most three: a link to a channel the chat knows, from any address the
 * farm is reached at (a phone has its own); the default channel's, which names none, only at the page's own host. */
export function linkedMessages(text: string, chat: Chat | undefined, host: string): LinkedMessage[] {
  const out: LinkedMessage[] = [];
  for (const m of text.matchAll(farmLink)) {
    const channel = m[2] ? channelOf(chat, m[2])?.id : m[1] === host ? defaultOf(chat)?.id : undefined;
    const number = Number(m[3]);
    if (channel && !out.some((l) => l.channel === channel && l.number === number)) out.push({ channel, number });
  }
  return out.slice(0, 3);
}
