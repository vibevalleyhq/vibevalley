// The chat in the core state.

import { type Chat, type ChatMessage, type Channel, type OwnerMention, ownerId } from "@vibevalley/protocol";
import { compareText, or } from "@/base/order.ts";
/** The database keeps them all; the state these many. What is said in them is the rooms' (Channels.follow). */
export const keepChannels = 100;

export const isTop = (c: Channel) => c.type !== "thread";

const emptyChat = (): Chat => ({ channels: [], ownerMentions: [] });

export const withOwnerMentions = (chat: Chat | undefined, ownerMentions: OwnerMention[]): Chat => ({ ...(chat ?? emptyChat()), ownerMentions });

/** A message said: news when its number is past what the state knows of its channel, or when the state does not
 * keep that channel (the game and the owner's other channels hear of it all the same); its channel's
 * lastNumber moves to it. A message said before, again (a restart's), is no news. */
export function withMessage(chat: Chat | undefined, m: ChatMessage): [Chat | undefined, boolean] {
  const c = chat?.channels.find((x) => x.id === m.channel);
  if (!chat || !c) return [chat, true];
  if (m.number <= (c.lastNumber ?? 0)) return [chat, false];
  return [{ ...chat, channels: chat.channels.map((x) => (x === c ? { ...c, lastNumber: m.number } : x)) }, true];
}

/** Beyond keepChannels the quietest threads go; the channels always stay. */
export function withChannel(chat: Chat | undefined, c: Channel): Chat {
  const base = chat ?? emptyChat();
  let all = base.channels.filter((x) => x.id !== c.id);
  all.push(c);
  const byID = (a: Channel, b: Channel) => compareText(a.id, b.id);
  if (all.length <= keepChannels) return { ...base, channels: all.toSorted(byID) };
  const top = (x: Channel) => (isTop(x) ? 1 : 0);
  const ranked = [...all].toSorted((a, b) => or(top(b) - top(a), (b.lastNumber ?? 0) - (a.lastNumber ?? 0)));
  const keep = new Set(ranked.slice(0, keepChannels).map((x) => x.id));
  all = all.filter((x) => keep.has(x.id)).toSorted(byID);
  return { ...base, channels: all };
}

/** A channel is #<name> (#general), a thread #<its channel's name>:<the number of the message it hangs under>, and a
 * direct channel @owner: only its peer reads an address, and the one there with it is the owner. */
export function targetOf(c: Pick<Channel, "type" | "rootNumber" | "name">, channelName: string): string {
  if (c.type === "direct") return "@" + ownerId;
  if (c.type === "thread" && c.rootNumber !== undefined) return "#" + channelName + ":" + c.rootNumber;
  return "#" + (c.name ?? channelName);
}

export const defaultOf = (chat: Chat | undefined) => chat?.channels.find((c) => c.default);

export const channelOf = (chat: Chat | undefined, id: string) => chat?.channels.find((c) => c.id === id);

export function topOf(chat: Chat | undefined, c: Channel | undefined): Channel | undefined {
  if (!c) return defaultOf(chat);
  if (isTop(c)) return c;
  return channelOf(chat, c.parent ?? "") ?? defaultOf(chat);
}

export const addressOf = (chat: Chat | undefined, c: Channel) => targetOf(c, topOf(chat, c)?.name ?? "");

export const noticeBatchMs = 3_000;
