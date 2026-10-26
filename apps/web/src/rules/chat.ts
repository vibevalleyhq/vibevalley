// The chat's words: channels and threads, feeds and unread counts, names to @, the clocks, money (spentText) and a
// helper's phase. Nothing here folds facts: it only reads the chat the server sent.

import {
  type Chat,
  type ChatMessage,
  type Conversation,
  everyone,
  generalName,
  type Issue,
  orchestratorAgent,
  ownerId,
  type Phase,
  type Session,
  type Spent,
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

export const channelName = (c: Conversation | undefined) => (c?.kind === "channel" ? (c.name ?? "") : generalName);

/** A channel as it is said in a line: #name, the general one 田头. */
export const channelLabel = (c: Conversation | undefined) => (c?.kind === "channel" ? `#${c.name ?? ""}` : generalName);

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

/** An issue's thread is named by the issue, so the name holds after its sessions leave. */
export function threadTitle(chat: Chat | undefined, thread: Conversation, issues: Issue[] = [], sessions: Session[] = []) {
  switch (thread.subjectKind) {
    case "issue": {
      const issue = issues.find((i) => i.id === thread.subjectId);
      return issue ? head(issue.title) : "工单串";
    }
    case "graph":
      return `计划 ${thread.subjectId ?? ""}`;
    case "talk":
    case undefined: {
      if (thread.subjectKind === "talk" && thread.subjectId) {
        const session = sessions.find((h) => h.id === thread.subjectId);
        const said = messagesIn(chat, thread.id).find((m) => m.from === thread.subjectId)?.name;
        return `${session?.name ?? said ?? thread.subjectId}的串`;
      }
      const parent = parentOf(chat, thread);
      return parent ? head(parent.text) : "串";
    }
  }
}

export const messagesIn = (chat: Chat | undefined, conversation: string) => chat?.messages.filter((m) => m.conversation === conversation) ?? [];

export const unreadIn = (chat: Chat | undefined, c: Conversation) =>
  messagesIn(chat, c.id).filter((m) => m.number > (c.read ?? 0) && m.fromKind !== "owner" && m.kind !== "notice" && m.final).length;

export const unreadTotal = (chat: Chat | undefined) => (chat?.conversations ?? []).reduce((n, c) => n + unreadIn(chat, c), 0);

/** The number a receipt for this conversation carries, or undefined with nothing unread. */
export function newestUnread(chat: Chat | undefined, c: Conversation) {
  if (unreadIn(chat, c) === 0) return undefined;
  return findLast(messagesIn(chat, c.id), (m) => m.final && m.number > (c.read ?? 0))?.number;
}

/** A channel's own unread and its threads'; threads without a channel count under the general. */
export const unreadUnder = (chat: Chat | undefined, channel: Conversation) =>
  (chat?.conversations ?? [])
    .filter((c) => c.id === channel.id || c.channel === channel.id || (channel.kind === "general" && c.kind === "thread" && !c.channel))
    .reduce((n, c) => n + unreadIn(chat, c), 0);

/** The pages of older messages read for a conversation; complete when the first message is among them. */
export interface Loaded {
  messages: ChatMessage[];
  complete: boolean;
}

export const chatPage = 50;

export function mergeLoaded(was: Loaded | undefined, more: ChatMessage[], complete: boolean): Loaded {
  const all = new Map((was?.messages ?? []).map((m) => [m.id, m]));
  for (const m of more) all.set(m.id, m);
  return { messages: [...all.values()].sort((a, b) => a.number - b.number), complete: complete || (was?.complete ?? false) };
}

/** The state's messages over the loaded pages: the state's copy of a message is the newer. */
export function messagesOf(chat: Chat | undefined, conversation: string, more?: Loaded) {
  const all = new Map((more?.messages ?? []).map((m) => [m.id, m]));
  for (const m of messagesIn(chat, conversation)) all.set(m.id, m);
  return [...all.values()].sort((a, b) => a.number - b.number);
}

export function parentOf(chat: Chat | undefined, thread: Conversation, more?: Loaded) {
  const p = thread.parent;
  if (!p) return undefined;
  return chat?.messages.find((m) => m.id === p) ?? more?.messages.find((m) => m.id === p);
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

/** The rows of a conversation, with their day lines and grouping; filter keeps the messages containing it (any case). */
export function feedOf(chat: Chat | undefined, conversation: string, more?: Loaded, filter = "", now = new Date()): FeedItem[] {
  const threads = new Map<string, Conversation>();
  for (const c of chat?.conversations ?? []) if (c.kind === "thread" && c.parent) threads.set(c.parent, c);
  const q = filter.trim().toLowerCase();
  const messages = messagesOf(chat, conversation, more).filter((m) => !q || m.text.toLowerCase().includes(q));
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

/** The orchestrator's dots: it thinks, in a channel, and has not answered the last word yet. */
export const waitingForOrchestrator = (orchestrator: string | undefined, conversation: Conversation | undefined, messages: ChatMessage[]) =>
  orchestrator === "thinking" && conversation?.kind !== "thread" && messages.length > 0 && messages[messages.length - 1]!.from !== orchestratorAgent;

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function dayLabel(at: number, now = new Date()) {
  const d = new Date(Math.round(at));
  if (sameDay(d, now)) return "今天";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return "昨天";
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** zh-CN, 12-hour, two digits: 下午03:07. */
export function workbenchClock(at: number) {
  const d = new Date(Math.round(at));
  const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return `${d.getHours() < 12 ? "上午" : "下午"}${String(h12).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// The server says money the same way (protocol.Yuan, SpentText) in what it writes to the chat.
export const yuan = (cny: number) => (cny > 0 && cny < 0.01 ? "不到 ¥0.01" : `¥${cny.toFixed(2)}`);

const wan = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万` : `${Math.round(n)}`);

export const spentText = (spent: Spent) => [...(spent.cny !== undefined ? [`约 ${yuan(spent.cny)}`] : []), `${wan(spent.tokens)} token`].join(" · ");

const span = (ms: number) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} 秒` : `${Math.round(ms / 60000)} 分钟`);

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

export const mentionOf: Record<string, string> = { [orchestratorAgent]: "@管家", [ownerId]: "@主人", [everyone]: "@所有人" };

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
  { token: mentionOf[orchestratorAgent]!, name: "管家", note: "派活、拆计划、问进度" },
  ...(sessions.length > 1 ? [{ token: mentionOf[everyone]!, name: "所有人", note: "叫醒在场的每个帮工" }] : []),
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
