// The chat's words: channels and threads, feeds and unread counts, names to @, the clocks and a helper's
// phase. Nothing here folds facts: it only reads the chat the server sent.

import { chatWording } from "./words";
import { appWording } from "../../base/words";
import { wording } from "@vibevalley/protocol/words";
import {
  type Chat,
  type ChatMessage,
  type Channel,
  everyone,
  type Issue,
  orchestratorAgent,
  ownerId,
  type Phase,
  type Session,
  type WorkspaceState,
} from "@vibevalley/protocol";

export const isTop = (c: Channel) => c.type !== "thread";

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

/** The channels in the sidebar: not archived. */
export const topsOf = (chat: Chat | undefined): Channel[] =>
  (chat?.channels.filter((c) => c.type === "channel" && c.archived === undefined) ?? []).sort(bySidebar);

/** The archived channels, newest archived first. */
export const archivedOf = (chat: Chat | undefined): Channel[] =>
  (chat?.channels.filter((c) => c.type === "channel" && c.archived !== undefined) ?? []).sort((a, b) => (b.archived ?? 0) - (a.archived ?? 0));

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
  (chat?.channels.filter((c) => c.type === "thread" && c.parent === channel.id && (c.archived !== undefined) === archived) ?? []).sort(
    (a, b) => (b.last?.at ?? b.at) - (a.last?.at ?? a.at),
  );

/** The number a message address points at, from the page's path. */
export function pointedAt(path: string): number | undefined {
  const m = /[?&]m=(\d+)/.exec(path);
  return m ? Number(m[1]) : undefined;
}

/** The channel a channel is in: itself, or a thread's channel; the default when none is given. */
export function topOf(chat: Chat | undefined, c: Channel | undefined) {
  if (!c) return defaultOf(chat);
  if (isTop(c)) return c;
  return channelOf(chat, c.parent) ?? defaultOf(chat);
}

export const directsOf = (chat: Chat | undefined): Channel[] =>
  (chat?.channels.filter((c) => c.type === "direct") ?? []).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** A direct channel is named by its peer, which the server puts in its title. */
export const channelName = (c: Channel | undefined) => (c?.type === "direct" ? (c.title ?? "") : (c?.name ?? ""));

export const channelLabel = (c: Channel | undefined) => (c?.type === "direct" ? channelName(c) : `#${channelName(c)}`);

export const chatPath = (c: Channel | undefined) => (!c || c.default ? "/chat" : `/chat/${c.id}`);

/** Where a message is: its channel's address and its number, which the list scrolls to and lights up. */
export const messagePath = (c: Channel | undefined, number: number) => `${chatPath(c)}?m=${number}`;

const findLast = <T>(xs: T[] | undefined, test: (x: T) => boolean) => {
  if (!xs) return undefined;
  for (let i = xs.length - 1; i >= 0; i--) if (test(xs[i]!)) return xs[i];
  return undefined;
};

/** One thread per issue, kept across the sessions that work it. */
export const issueThreadOf = (chat: Chat | undefined, issue: string) => findLast(chat?.channels, (c) => c.subjectKind === "issue" && c.subjectId === issue);

/** The one way from a session to its thread: through its issue; a session sent for no issue has a talk thread of its own. */
export function jobThreadOf(chat: Chat | undefined, session: Session) {
  if (session.issue) return issueThreadOf(chat, session.issue);
  return findLast(chat?.channels, (c) => c.subjectKind === "talk" && c.subjectId === session.id);
}

/** Whom a thread's words are for now: the session working its issue, or a talk thread's own session. */
export function threadOwnerOf(thread: Channel, sessions: Session[]) {
  switch (thread.subjectKind) {
    case "issue":
      return findLast(sessions, (h) => h.issue === thread.subjectId);
    case "talk":
      return sessions.find((h) => h.id === thread.subjectId);
    case "graph":
    case undefined:
      return undefined;
  }
}

const head = (text: string) => {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > 24 ? flat.slice(0, 24) : flat;
};

/** An issue's thread is named by the issue, so the name holds after its sessions leave; the others by the server's title. */
export function threadTitle(thread: Channel, issues: Issue[] = [], sessions: Session[] = []) {
  switch (thread.subjectKind) {
    case "issue": {
      const issue = issues.find((i) => i.id === thread.subjectId);
      return issue ? head(issue.title) : chatWording().names.issueThread;
    }
    case "graph":
      return chatWording().names.planThread(thread.subjectId ?? "");
    case "talk":
    case undefined: {
      if (thread.subjectKind === "talk" && thread.subjectId) {
        const session = sessions.find((h) => h.id === thread.subjectId);
        return chatWording().names.talkThread(session?.name ?? thread.title ?? thread.subjectId);
      }
      return thread.title || chatWording().names.thread;
    }
  }
}

export const unreadIn = (c: Channel) => c.unread ?? 0;

export const unreadTotal = (chat: Chat | undefined) => (chat?.channels ?? []).reduce((n, c) => n + unreadIn(c), 0);

/** The number a receipt for this channel carries, or undefined with nothing unread. */
export const newestUnread = (c: Channel) => (unreadIn(c) > 0 ? c.lastNumber : undefined);

/** A channel's own unread and its threads'; threads without a channel count under the general. */
export const unreadUnder = (chat: Chat | undefined, channel: Channel) =>
  (chat?.channels ?? []).filter((c) => c.id === channel.id || c.parent === channel.id).reduce((n, c) => n + unreadIn(c), 0);

/** A page of a channel read at a time (features/channel/follow.ts). */
export const chatPage = 50;

/** Where a thread's parent message is: its channel's, or the general's for a thread without one. */
export function parentAt(chat: Chat | undefined, thread: Channel) {
  if (thread.type !== "thread" || thread.rootNumber === undefined) return undefined;
  const channel = thread.parent ?? defaultOf(chat)?.id;
  return channel ? { channel, number: thread.rootNumber } : undefined;
}

export interface FeedItem {
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

/** The rows of a channel's messages, with their day lines and grouping; filter keeps the messages containing it (any
 * case). */
export function feedOf(chat: Chat | undefined, said: readonly ChatMessage[], filter = "", now = new Date()): FeedItem[] {
  const threads = new Map<string, Channel>();
  for (const c of chat?.channels ?? []) if (c.type === "thread" && c.root) threads.set(c.root, c);
  const q = filter.trim().toLowerCase();
  const messages = said.filter((m) => !q || m.text.toLowerCase().includes(q));
  let day = "";
  return messages.map((m, i) => {
    const label = dayLabel(m.at, now);
    const before = messages[i - 1];
    const item: FeedItem = {
      message: m,
      thread: threads.get(m.id),
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

/** The orchestrator's dots in a channel: it is thinking or writing its answer there, as the server says. */
export function orchestratorTyping(state: WorkspaceState | undefined, channel: Channel | undefined): "thinking" | "speaking" | undefined {
  if (!state || !channel || state.orchestratorChannel !== channel.id) return undefined;
  return state.orchestrator === "thinking" || state.orchestrator === "speaking" ? state.orchestrator : undefined;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function dayLabel(at: number, now = new Date()) {
  const d = new Date(Math.round(at));
  if (sameDay(d, now)) return appWording().time.today;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return appWording().time.yesterday;
  return appWording().time.monthDay(d.getMonth() + 1, d.getDate());
}

/** 12-hour, two digits: 下午03:07, 03:07 PM. */
export function workbenchClock(at: number) {
  const d = new Date(Math.round(at));
  const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return appWording().time.clock(d.getHours() < 12, String(h12).padStart(2, "0"), String(d.getMinutes()).padStart(2, "0"));
}

const span = (ms: number) => wording().span(ms);

/** The server's words for what the session is doing, how long it has been quiet filled in by the clock. */
export function phaseText(h: Session, now: number) {
  const words = h.phaseText ?? "";
  return h.phase._tag === "working" && h.phase.quietSince !== undefined ? words.replaceAll("{span}", span(now - h.phase.quietSince)) : words;
}

export type DotTone = "leaf" | "berry" | "wheat";

export function phaseDot(p: Phase): DotTone {
  switch (p._tag) {
    case "working":
    case "arriving":
      return "leaf";
    case "failed":
      return "berry";
    case "done":
    case "resting":
    case "closed":
      return "wheat";
  }
}

/** The sprite for a phase; undefined draws nothing. */
export function phaseIcon(p: Phase): string | undefined {
  switch (p._tag) {
    case "arriving":
      return "icon-seeds";
    case "working":
      return p.doing.action === "none" ? undefined : `act-${p.doing.action}`;
    case "done":
      return "icon-harvest";
    case "failed":
      return "icon-bug";
    case "resting":
      return "act-wait";
    case "closed":
      return p.closed === "merged" ? "icon-harvest" : "act-wait";
  }
}

export const runtimeLabel: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** A profile's role up to its first stop, at most 18 characters. */
export function roleShort(role: string) {
  const first = role.split(/[，。,.]/)[0] ?? "";
  return first.length > 18 ? first.slice(0, 18) : first;
}

export const mentionOf: Record<string, string> = {
  [orchestratorAgent]: chatWording().names.mention.orchestrator,
  [ownerId]: chatWording().names.mention.owner,
  [everyone]: chatWording().names.mention.everyone,
};

export interface Nameable {
  token: string;
  name: string;
  note: string;
  session?: Session;
}

export const menuMax = 6;

/** Everyone only when there is more than one helper. */
export const nameables = (sessions: Session[], now: number): Nameable[] => [
  ...sessions.map((h) => ({ token: `@${h.id}`, name: h.name, note: phaseText(h, now), session: h })),
  { token: mentionOf[orchestratorAgent]!, name: appWording().orchestrator, note: chatWording().names.orchestratorNote },
  ...(sessions.length > 1 ? [{ token: mentionOf[everyone]!, name: chatWording().names.everyone, note: chatWording().names.everyoneNote }] : []),
];

const typed = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_]*)$/u;

/** The @name being typed before the caret: where its @ is and what follows it. */
export function typedName(text: string, caret: number) {
  if (caret < 0 || caret > text.length) return undefined;
  const m = typed.exec(text.slice(0, caret));
  if (!m) return undefined;
  const query = m[2] ?? "";
  return { start: caret - query.length - 1, query };
}

/** By the start of the token or anywhere in the name. */
export function offeredFor(all: Nameable[], query: string) {
  const q = query.toLowerCase();
  return all.filter((n) => n.token.slice(1).toLowerCase().startsWith(q) || n.name.toLowerCase().includes(q)).slice(0, menuMax);
}

/** The text with the typed name replaced by the token and a space; the caret goes after the space. */
export function insertName(text: string, caret: number, start: number, token: string) {
  const next = `${text.slice(0, start)}${token} ${text.slice(Math.min(Math.max(caret, start), text.length))}`;
  return { text: next, caret: start + token.length + 1 };
}

/** @tokens in a message's text, as the chat draws them apart. */
export const mentionPattern = /(^|[^\p{L}\p{N}_@])(@[\p{L}\p{N}_-]+)/gu;

/** A place Ctrl+K goes to: a channel, a direct channel, a thread, or a profile not yet talked with alone. */
export interface SwitchTarget {
  readonly kind: "channel" | "direct" | "thread" | "profile";
  /** The channel's id; a profile's id for one with no direct channel yet. */
  readonly id: string;
  readonly label: string;
  /** Where it is or what picking it does: a channel's group, a thread's channel. */
  readonly hint: string;
  readonly unread: number;
  /** When it was last talked in, newest first among equals. */
  readonly at: number;
}

/** How many places the switcher lists at once. */
export const switchMax = 12;

/** The places for what is typed: `#` keeps channels and threads, `@` direct channels and profiles; the rest matches the
 * name anywhere, a name starting with it first, then the unread, then the newest talked in. Archived places are left out. */
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
          return { kind: "channel", id: c.id, label: `#${channelName(c)}`, hint: c.category ?? "", unread: unreadUnder(chat, c), at: at(c) };
        case "direct":
          return { kind: "direct", id: c.id, label: `@${channelName(c)}`, hint: chatWording().switcher.direct, unread: unreadIn(c), at: at(c) };
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
      .map((p): SwitchTarget => ({ kind: "profile", id: p.id, label: `@${p.name}`, hint: chatWording().switcher.newDirect, unread: 0, at: 0 })),
  ];
  const typed = query.trim().toLowerCase();
  const only = typed.startsWith("#") ? "hash" : typed.startsWith("@") ? "at" : undefined;
  const words = only ? typed.slice(1) : typed;
  const kept = targets.filter((t) => {
    if (only === "hash" && t.kind !== "channel" && t.kind !== "thread") return false;
    if (only === "at" && t.kind !== "direct" && t.kind !== "profile") return false;
    return t.label.toLowerCase().includes(words);
  });
  const starts = (t: SwitchTarget) => (words !== "" && t.label.toLowerCase().replace(/^[#@]/, "").startsWith(words) ? 0 : 1);
  return kept.sort((a, b) => starts(a) - starts(b) || b.unread - a.unread || b.at - a.at || compareIds(a.id, b.id)).slice(0, switchMax);
}

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A message on this farm that a message links to (its address as 复制链接 gives it). */
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
