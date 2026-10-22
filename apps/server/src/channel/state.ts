// The chat in the core state.

import { type Chat, type ChatMessage, type Conversation, generalName, type OwnerMention } from "@vibevalley/protocol";
import { compareText } from "../base/text.ts";

/** The database keeps them all; the state these many. */
export const keepMessages = 300;
export const keepConversations = 100;

export const isChannel = (c: Conversation) => c.kind !== "thread";

const emptyChat = (): Chat => ({ conversations: [], messages: [] });

export const withOwnerMentions = (chat: Chat | undefined, ownerMentions: OwnerMention[]): Chat => ({ ...(chat ?? emptyChat()), ownerMentions });

export const messagesIn = (chat: Chat | undefined, conversation: string) => (chat?.messages ?? []).filter((m) => m.conversation === conversation);

const lastN = <T>(list: readonly T[], n: number) => list.slice(Math.max(0, list.length - n));

export function withMessage(chat: Chat | undefined, m: ChatMessage): Chat {
  const base = chat ?? emptyChat();
  const messages = [...(base.messages ?? [])];
  const i = messages.findIndex((x) => x.id === m.id);
  if (i >= 0) messages[i] = m;
  else {
    messages.push(m);
    messages.sort((a, b) => compareText(a.id, b.id));
  }
  return { ...base, messages: lastN(messages, keepMessages) };
}

/** Beyond keepConversations the quietest go, never a channel. */
export function withConversation(chat: Chat | undefined, c: Conversation): Chat {
  const base = chat ?? emptyChat();
  let all = (base.conversations ?? []).filter((x) => x.id !== c.id);
  all.push(c);
  const byID = (a: Conversation, b: Conversation) => compareText(a.id, b.id);
  if (all.length <= keepConversations) return { ...base, conversations: all.sort(byID) };
  const channel = (x: Conversation) => (isChannel(x) ? 1 : 0);
  const ranked = [...all].sort((a, b) => channel(b) - channel(a) || (b.lastNumber ?? 0) - (a.lastNumber ?? 0));
  const keep = new Set(ranked.slice(0, keepConversations).map((x) => x.id));
  all = all.filter((x) => keep.has(x.id)).sort(byID);
  return { ...base, conversations: all };
}

/** A channel is #<name> (#田头), a thread #<its channel>:<the number of the message it hangs under>. channelName undefined: the general channel. */
export function targetOf(c: Conversation, channelName: string | undefined): string {
  if (c.kind === "thread" && c.parentNumber !== undefined) return "#" + (channelName ?? generalName) + ":" + c.parentNumber;
  if (c.name !== undefined) return "#" + c.name;
  return "#" + generalName;
}

export const generalOf = (chat: Chat | undefined) => chat?.conversations?.find((c) => c.kind === "general");

export const conversationOf = (chat: Chat | undefined, id: string) => chat?.conversations?.find((c) => c.id === id);

export function channelOf(chat: Chat | undefined, c: Conversation | undefined): Conversation | undefined {
  if (!c) return generalOf(chat);
  if (isChannel(c)) return c;
  return conversationOf(chat, c.channel ?? "") ?? generalOf(chat);
}

export const addressOf = (chat: Chat | undefined, c: Conversation) => targetOf(c, channelOf(chat, c)?.name);

export const noticeBatchMs = 3_000;
