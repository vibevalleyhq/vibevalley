import { t } from "@vibevalley/i18n";

import { type Chat, type ChatMessage, type Channel, type WorkspaceState } from "@vibevalley/protocol";
/** A page of a channel read at a time (features/channel/follow.ts). */
export const chatPage = 50;

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
  state: WorkspaceState | undefined,
  channel: Channel | undefined,
): { readonly agent: string; readonly mood: "thinking" | "speaking"; readonly since?: number } | undefined {
  if (!channel) return undefined;
  for (const [agent, now] of Object.entries(state?.orchestrators ?? {}))
    if (now.channel === channel.id && (now.state === "thinking" || now.state === "speaking"))
      return { agent, mood: now.state, ...(now.since !== undefined ? { since: now.since } : {}) };
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

/** 12-hour, two digits: 下午03:07, 03:07 PM. */
export function workbenchClock(at: number) {
  const d = new Date(Math.round(at));
  const h12 = d.getHours() % 12 === 0 ? 12 : d.getHours() % 12;
  return t("web.base.time.clock", { am: d.getHours() < 12, hh: String(h12).padStart(2, "0"), mm: String(d.getMinutes()).padStart(2, "0") });
}
