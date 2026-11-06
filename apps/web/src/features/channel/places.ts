import { t } from "@vibevalley/i18n";
import { type Chat, type ChatMessage, type Channel, type Issue, type Session, type SpaceState } from "@vibevalley/protocol";
import { channelOf, defaultOf } from "@vibevalley/protocol/rules";

import { compareText, or, spelled } from "#/base/search.ts";

const isTop = (c: Channel) => c.type !== "thread";

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

interface ChannelGroup {
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

export interface LinkedMessage {
  readonly channel: string;
  readonly number: number;
}

const farmLink = /https?:\/\/([^/\s]+)\/chat(?:\/([0-9a-f-]{36}))?\?m=(\d+)/gu;

/** The farm messages a text links to, once each, at most three: a link to a channel the chat knows, from any address the farm is reached at (a phone has its own). */
export function linkedMessages(text: string, chat: Chat | undefined, host: string): LinkedMessage[] {
  const out: LinkedMessage[] = [];
  for (const m of text.matchAll(farmLink)) {
    const channel = m[2] ? channelOf(chat, m[2])?.id : m[1] === host ? defaultOf(chat)?.id : undefined;
    const number = Number(m[3]);
    if (channel && !out.some((l) => l.channel === channel && l.number === number)) out.push({ channel, number });
  }
  return out.slice(0, 3);
}

export const unreadIn = (c: Channel) => c.unread ?? 0;

export const unreadTotal = (chat: Chat | undefined) => (chat?.channels ?? []).reduce((n, c) => n + unreadIn(c), 0);

/** The number a receipt for this channel carries, or undefined with nothing unread. */
export const newestUnread = (c: Channel) => (unreadIn(c) > 0 ? c.lastNumber : undefined);

export const unreadUnder = (chat: Chat | undefined, channel: Channel) =>
  (chat?.channels ?? []).filter((c) => c.id === channel.id || c.parent === channel.id).reduce((n, c) => n + unreadIn(c), 0);

const findLast = <T>(xs: readonly T[] | undefined, test: (x: T) => boolean) => xs?.findLast(test);

/** One thread per issue, kept across the sessions that work it. */
export const issueThreadOf = (chat: Chat | undefined, issue: string) => findLast(chat?.channels, (c) => c.subjectKind === "issue" && c.subjectId === issue);

/** The one way from a session to its thread: through its issue; a session sent for no issue has a talk thread of its own. */
export function sessionThreadOf(chat: Chat | undefined, session: Session) {
  if (session.issue) return issueThreadOf(chat, session.issue);
  return findLast(chat?.channels, (c) => c.subjectKind === "talk" && c.subjectId === session.id);
}

export function threadOwnerOf<S extends Session>(thread: Channel, sessions: readonly S[]): S | undefined {
  switch (thread.subjectKind) {
    case "issue":
      return findLast(sessions, (h) => h.issue === thread.subjectId);
    case "talk":
      return sessions.find((h) => h.id === thread.subjectId);
    // Only issues and talks have an owner.
    default:
      return undefined;
  }
}

const head = (text: string) => {
  const flat = text.replace(/\s+/gu, " ");
  return flat.length > 24 ? flat.slice(0, 24) : flat;
};

/** Named by the issue, so the name holds after its sessions leave. */
export function threadTitle(thread: Channel, issues: Issue[] = [], sessions: Session[] = []) {
  switch (thread.subjectKind) {
    case "issue": {
      const issue = issues.find((i) => i.id === thread.subjectId);
      return issue ? head(issue.title) : t("web.channel.names.issueThread");
    }
    case "talk":
    default: {
      if (thread.subjectKind === "talk" && thread.subjectId) {
        const session = sessions.find((h) => h.id === thread.subjectId);
        return t("web.channel.names.talkThread", { who: session?.name || thread.title || (thread.subjectId ?? "") });
      }
      return thread.title || t("web.channel.names.thread");
    }
  }
}

/** A page of a channel read at a time (features/channel/follow.ts). */
export const chatPage = 50;

interface FeedItem {
  message: ChatMessage;
  /** The thread hanging under this message. */
  thread?: Channel;
  /** Same sender as the row before, within five minutes on the same day: no header of its own. */
  continues: boolean;
  /** Set on the first row of a day. */
  day?: string;
}

/** A sender's messages this close together share one header. */
const runMs = 5 * 60000;

const senderOf = (m: ChatMessage) => (m.kind === "notice" ? "" : m.from);

/** filter keeps the messages containing it, in any case. */
export function feedOf(chat: Chat | undefined, said: readonly ChatMessage[], filter = "", now = new Date()): FeedItem[] {
  const threads = new Map<string, Channel>();
  for (const c of chat?.channels ?? []) if (c.type === "thread" && c.root) threads.set(c.root, c);
  const q = filter.trim().toLowerCase();
  const messages = said.filter((m) => !q || m.text.toLowerCase().includes(q));
  let day = "";
  return messages.map((m, i) => {
    const label = dayLabel(m.at, now);
    const before = messages[i - 1];
    const thread = threads.get(m.id);
    const item: FeedItem = {
      message: m,
      ...(thread ? { thread } : {}),
      // A reply shows who says it above the line it answers.
      continues:
        !!before &&
        m.replyTo === undefined &&
        senderOf(before) === senderOf(m) &&
        senderOf(m) !== "" &&
        m.at - before.at < runMs &&
        dayLabel(before.at, now) === label,
    };
    if (label !== day) {
      day = label;
      item.day = label;
      item.continues = false;
    }
    return item;
  });
}

/** An orchestrator's dots in a channel: one is thinking or writing its answer there, as the server says. */
export function orchestratorTyping(
  state: SpaceState | undefined,
  channel: Channel | undefined,
): { readonly agent: string; readonly mood: "thinking" | "speaking"; readonly since?: number } | undefined {
  if (!channel) return undefined;
  for (const session of state?.sessions ?? []) {
    const phase = session.phase;
    if (session.role === "orchestrator" && session.channel === channel.id && phase._tag === "working")
      return { agent: session.agent, mood: phase.doing.action === "speaking_text" ? "speaking" : "thinking", since: phase.since };
  }
  return undefined;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function dayLabel(at: number, now = new Date()) {
  const d = new Date(Math.round(at));
  if (sameDay(d, now)) return t("web.base.time.today");
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return t("web.base.time.yesterday");
  return t("web.base.time.monthDay", { month: d.getMonth() + 1, day: d.getDate() });
}

/** 12-hour, two digits: 03:07 PM. */
export function workbenchClock(at: number) {
  const d = new Date(Math.round(at));
  const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return t("web.base.time.clock", { am: d.getHours() < 12, hh: String(h12).padStart(2, "0"), mm: String(d.getMinutes()).padStart(2, "0") });
}

export interface SwitchTarget {
  readonly kind: "channel" | "direct" | "thread" | "profile" | "note" | "notes";
  /** The channel's id. a profile's id for one with no direct channel yet. */
  readonly id: string;
  readonly label: string;
  /** Where it is or what picking it does: a channel's group, a thread's channel. */
  readonly hint: string;
  readonly unread: number;
  /** When it was last talked in, newest first among equals. */
  readonly at: number;
}

const switchMax = 12;

/** The places for what is typed: `#` keeps channels and threads, `@` direct channels and profiles. */
export function switchTargets(
  chat: Chat | undefined,
  query: string,
  named: { readonly issues?: Issue[]; readonly sessions?: Session[]; readonly profiles?: readonly { id: string; name: string }[] } = {},
): SwitchTarget[] {
  const all = (chat?.channels ?? []).filter((c) => c.archived === undefined);
  const at = (c: Channel) => c.last?.at ?? c.at;
  const peers = new Set(all.filter((c) => c.type === "direct").map((c) => c.peer));
  const targets: SwitchTarget[] = [
    ...all.map((c): SwitchTarget => {
      switch (c.type) {
        case "channel":
          return { kind: "channel", id: c.id, label: `#${channelName(c)}`, hint: c.category, unread: unreadUnder(chat, c), at: at(c) };
        case "direct":
          return { kind: "direct", id: c.id, label: `@${channelName(c)}`, hint: t("web.channel.switcher.direct"), unread: unreadIn(c), at: at(c) };
        case "thread":
          return {
            kind: "thread",
            id: c.id,
            label: threadTitle(c, named.issues, named.sessions),
            hint: channelLabel(topOf(chat, c)),
            unread: unreadIn(c),
            at: at(c),
          };
      }
    }),
    ...(named.profiles ?? [])
      .filter((p) => !peers.has(`profile:${p.id}`))
      .map((p): SwitchTarget => ({ kind: "profile", id: p.id, label: `@${p.name}`, hint: t("web.channel.switcher.newDirect"), unread: 0, at: 0 })),
  ];
  // ＃ and ＠ are what a Chinese input method types for # and @.
  const typed = query.trim().toLowerCase().replace(/^＃/u, "#").replace(/^＠/u, "@");
  const only = typed.startsWith("#") ? "hash" : typed.startsWith("@") ? "at" : undefined;
  const words = only ? typed.slice(1) : typed;
  const kept = targets.filter((target) => {
    if (only === "hash" && target.kind !== "channel" && target.kind !== "thread") return false;
    if (only === "at" && target.kind !== "direct" && target.kind !== "profile") return false;
    return spelled(target.label, words);
  });
  const starts = (target: SwitchTarget) => (words !== "" && target.label.toLowerCase().replace(/^[#@]/u, "").startsWith(words) ? 0 : 1);
  return kept.toSorted((a, b) => or(starts(a) - starts(b), b.unread - a.unread, b.at - a.at, compareText(a.id, b.id))).slice(0, switchMax);
}
