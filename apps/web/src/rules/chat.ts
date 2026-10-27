// The chat's words: channels and threads, feeds and unread counts, names to @, the clocks, money (spentText) and a
// helper's phase. Nothing here folds facts: it only reads the chat the server sent.

import { wording } from "@vibevalley/protocol/words";
import { rulesWording } from "./words";
import {
  type Chat,
  type ChatMessage,
  type Conversation,
  everyone,
  type Issue,
  orchestratorAgent,
  ownerId,
  type Phase,
  type Session,
  type Spent,
  type WorkspaceState,
} from "@vibevalley/protocol";

export const isChannel = (c: Conversation) => c.kind !== "thread";

export const generalOf = (chat: Chat | undefined) => chat?.conversations.find((c) => c.kind === "general");

export const conversationOf = (chat: Chat | undefined, id: string | undefined) => (id ? chat?.conversations.find((c) => c.id === id) : undefined);

/** The general first, then by id. */
export function channelsOf(chat: Chat | undefined): Conversation[] {
  return (chat?.conversations.filter(isChannel) ?? []).sort((a, b) => {
    if (a.kind === "general") return -1;
    if (b.kind === "general") return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** The channel a conversation is in: itself, a thread's channel, else the general. */
export function channelOf(chat: Chat | undefined, c: Conversation | undefined) {
  if (!c) return generalOf(chat);
  if (isChannel(c)) return c;
  return conversationOf(chat, c.channel) ?? generalOf(chat);
}

export const channelName = (c: Conversation | undefined) => (c?.kind === "channel" ? (c.name ?? "") : wording().general);

/** A channel as it is said in a line: #name, the general one by its label (田头, Farm chat). */
export const channelLabel = (c: Conversation | undefined) => (c?.kind === "channel" ? `#${c.name ?? ""}` : wording().general);

/** Where the page shows a conversation: the general is /chat. */
export const chatPath = (c: Conversation | undefined) => (!c || c.kind === "general" ? "/chat" : `/chat/${c.id}`);

const findLast = <T>(xs: T[] | undefined, test: (x: T) => boolean) => {
  if (!xs) return undefined;
  for (let i = xs.length - 1; i >= 0; i--) if (test(xs[i]!)) return xs[i];
  return undefined;
};

/** One thread per issue, kept across the sessions that work it. */
export const issueThreadOf = (chat: Chat | undefined, issue: string) =>
  findLast(chat?.conversations, (c) => c.subjectKind === "issue" && c.subjectId === issue);

/** The one way from a session to its thread: through its issue; a session sent for no issue has a talk thread of its own. */
export function jobThreadOf(chat: Chat | undefined, session: Session) {
  if (session.issue) return issueThreadOf(chat, session.issue);
  return findLast(chat?.conversations, (c) => c.subjectKind === "talk" && c.subjectId === session.id);
}

/** Whom a thread's words are for now: the session working its issue, or a talk thread's own session. */
export function threadOwnerOf(thread: Conversation, sessions: Session[]) {
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
export function threadTitle(thread: Conversation, issues: Issue[] = [], sessions: Session[] = []) {
  switch (thread.subjectKind) {
    case "issue": {
      const issue = issues.find((i) => i.id === thread.subjectId);
      return issue ? head(issue.title) : rulesWording().chat.issueThread;
    }
    case "graph":
      return rulesWording().chat.planThread(thread.subjectId ?? "");
    case "talk":
    case undefined: {
      if (thread.subjectKind === "talk" && thread.subjectId) {
        const session = sessions.find((h) => h.id === thread.subjectId);
        return rulesWording().chat.talkThread(session?.name ?? thread.title ?? thread.subjectId);
      }
      return thread.title || rulesWording().chat.thread;
    }
  }
}

export const unreadIn = (c: Conversation) => c.unread ?? 0;

export const unreadTotal = (chat: Chat | undefined) => (chat?.conversations ?? []).reduce((n, c) => n + unreadIn(c), 0);

/** The number a receipt for this conversation carries, or undefined with nothing unread. */
export const newestUnread = (c: Conversation) => (unreadIn(c) > 0 ? c.lastNumber : undefined);

/** A channel's own unread and its threads'; threads without a channel count under the general. */
export const unreadUnder = (chat: Chat | undefined, channel: Conversation) =>
  (chat?.conversations ?? [])
    .filter((c) => c.id === channel.id || c.channel === channel.id || (channel.kind === "general" && c.kind === "thread" && !c.channel))
    .reduce((n, c) => n + unreadIn(c), 0);

/** A page of a conversation read at a time (data/rooms.ts). */
export const chatPage = 50;

/** Where a thread's parent message is: its channel's, or the general's for a thread without one. */
export function parentAt(chat: Chat | undefined, thread: Conversation) {
  if (thread.kind !== "thread" || thread.parentNumber === undefined) return undefined;
  const conversation = thread.channel ?? generalOf(chat)?.id;
  return conversation ? { conversation, number: thread.parentNumber } : undefined;
}

export interface FeedItem {
  message: ChatMessage;
  /** The thread hanging under this message. */
  thread?: Conversation;
  /** Same sender as the row before, within five minutes on the same day: no header of its own. */
  continues: boolean;
  /** Set on the first row of a day. */
  day?: string;
}

/** A sender's messages this close together share one header. */
const runMs = 5 * 60000;

const senderOf = (m: ChatMessage) => (m.kind === "notice" ? "" : m.from);

/** The rows of a conversation's messages, with their day lines and grouping; filter keeps the messages containing it (any
 * case). */
export function feedOf(chat: Chat | undefined, said: readonly ChatMessage[], filter = "", now = new Date()): FeedItem[] {
  const threads = new Map<string, Conversation>();
  for (const c of chat?.conversations ?? []) if (c.kind === "thread" && c.parent) threads.set(c.parent, c);
  const q = filter.trim().toLowerCase();
  const messages = said.filter((m) => !q || m.text.toLowerCase().includes(q));
  let day = "";
  return messages.map((m, i) => {
    const label = dayLabel(m.at, now);
    const before = messages[i - 1];
    const item: FeedItem = {
      message: m,
      thread: threads.get(m.id),
      continues: !!before && senderOf(before) === senderOf(m) && senderOf(m) !== "" && m.at - before.at < runMs && dayLabel(before.at, now) === label,
    };
    if (label !== day) {
      day = label;
      item.day = label;
      item.continues = false;
    }
    return item;
  });
}

/** The orchestrator's dots in a conversation: it is thinking or writing its answer there, as the server says. */
export function orchestratorTyping(state: WorkspaceState | undefined, conversation: Conversation | undefined): "thinking" | "speaking" | undefined {
  if (!state || !conversation || state.orchestratorConversation !== conversation.id) return undefined;
  return state.orchestrator === "thinking" || state.orchestrator === "speaking" ? state.orchestrator : undefined;
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

function dayLabel(at: number, now = new Date()) {
  const d = new Date(Math.round(at));
  if (sameDay(d, now)) return rulesWording().time.today;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return rulesWording().time.yesterday;
  return rulesWording().time.monthDay(d.getMonth() + 1, d.getDate());
}

/** 12-hour, two digits: 下午03:07, 03:07 PM. */
export function workbenchClock(at: number) {
  const d = new Date(Math.round(at));
  const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return rulesWording().time.clock(d.getHours() < 12, String(h12).padStart(2, "0"), String(d.getMinutes()).padStart(2, "0"));
}

// The server says money the same way (protocol.Yuan, SpentText) in what it writes to the chat.
export const yuan = (cny: number) => (cny > 0 && cny < 0.01 ? rulesWording().money.underCent : `¥${cny.toFixed(2)}`);

const wan = (n: number) => (n >= 10000 ? rulesWording().big(n, n >= 100000 ? 0 : 1) : `${Math.round(n)}`);

export const spentText = (spent: Spent) =>
  [...(spent.cny !== undefined ? [rulesWording().money.about(yuan(spent.cny))] : []), `${wan(spent.tokens)} token`].join(" · ");

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
  [orchestratorAgent]: rulesWording().chat.mention.orchestrator,
  [ownerId]: rulesWording().chat.mention.owner,
  [everyone]: rulesWording().chat.mention.everyone,
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
  { token: mentionOf[orchestratorAgent]!, name: rulesWording().card.orchestrator, note: rulesWording().chat.orchestratorNote },
  ...(sessions.length > 1 ? [{ token: mentionOf[everyone]!, name: rulesWording().chat.everyone, note: rulesWording().chat.everyoneNote }] : []),
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
