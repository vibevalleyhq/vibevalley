import { type Chat, type Channel } from "@vibevalley/protocol";
const isTop = (c: Channel) => c.type !== "thread";

export const defaultOf = (chat: Chat | undefined) => chat?.channels.find((c) => c.default);

export const channelOf = (chat: Chat | undefined, id: string | undefined) => (id ? chat?.channels.find((c) => c.id === id) : undefined);

/** As the sidebar lists them, the server's order: the default first, then by position (the unplaced after), then by id. */
const bySidebar = (a: Channel, b: Channel) => {
  if (a.default !== b.default) return a.default ? -1 : 1;
  const pa = a.position ?? Number.MAX_SAFE_INTEGER;
  const pb = b.position ?? Number.MAX_SAFE_INTEGER;
  if (pa !== pb) return pa - pb;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

export const topsOf = (chat: Chat | undefined): Channel[] =>
  (chat?.channels.filter((c) => c.type === "channel" && c.archived === undefined) ?? []).toSorted(bySidebar);

export const archivedOf = (chat: Chat | undefined): Channel[] =>
  (chat?.channels.filter((c) => c.type === "channel" && c.archived !== undefined) ?? []).toSorted((a, b) => (b.archived ?? 0) - (a.archived ?? 0));

export interface ChannelGroup {
  /** None for the channels in no group, which come first. */
  readonly category?: string;
  readonly channels: readonly Channel[];
}

/** The sidebar's groups in the order their first channel comes. */
export function groupsOf(channels: readonly Channel[]): ChannelGroup[] {
  const loose = channels.filter((c) => !c.category);
  const named = new Map<string, Channel[]>();
  for (const c of channels) if (c.category) named.set(c.category, [...(named.get(c.category) ?? []), c]);
  return [...(loose.length > 0 || named.size === 0 ? [{ channels: loose }] : []), ...[...named].map(([category, cs]) => ({ category, channels: cs }))];
}

/** A channel's threads, newest message first; archived ones only when asked. */
export const threadsIn = (chat: Chat | undefined, channel: Channel, archived = false): Channel[] =>
  (chat?.channels.filter((c) => c.type === "thread" && c.parent === channel.id && (c.archived !== undefined) === archived) ?? []).toSorted(
    (a, b) => (b.last?.at ?? b.at) - (a.last?.at ?? a.at),
  );

export function pointedAt(path: string): number | undefined {
  const m = /[?&]m=(\d+)/u.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** The channel a channel is in: itself, or a thread's channel; the default when none is given. */
export function topOf(chat: Chat | undefined, c: Channel | undefined) {
  if (!c) return defaultOf(chat);
  if (isTop(c)) return c;
  return channelOf(chat, c.parent) ?? defaultOf(chat);
}

export const directsOf = (chat: Chat | undefined): Channel[] =>
  (chat?.channels.filter((c) => c.type === "direct") ?? []).toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A direct channel is named by its peer, which the server puts in its title. */
export const channelName = (c: Channel | undefined) => (c?.type === "direct" ? c.title : (c?.name ?? ""));

export const channelLabel = (c: Channel | undefined) => (c?.type === "direct" ? channelName(c) : `#${channelName(c)}`);

export const chatPath = (c: Channel | undefined) => (!c || c.default ? "/chat" : `/chat/${c.id}`);

export const messagePath = (c: Channel | undefined, number: number) => `${chatPath(c)}?m=${number}`;

/** Where a thread's parent message is: its channel's, or the general's for a thread without one. */
export function parentAt(chat: Chat | undefined, thread: Channel) {
  if (thread.type !== "thread" || thread.rootNumber === undefined) return undefined;
  const channel = thread.parent ?? defaultOf(chat)?.id;
  return channel ? { channel, number: thread.rootNumber } : undefined;
}
