import type * as T from "@vibevalley/protocol";

import { compareText, or } from "#/base/order.ts";
import { actorOfParticipant, type ChannelHearers, type Meta, metaOf, targetOf, channelType } from "#/modules/mailbox/envelope.ts";
import type { InputContext, TriggerInput } from "#/modules/mailbox/payload.ts";
import type { TriggerSource } from "#/modules/mailbox/shapes.ts";

import { chatNamed } from "./mentions.ts";

export { targetOf };
/** The database keeps them all. the state these many. */
export const keepChannels = 100;

const isTop = (c: T.Channel) => c.type !== "thread";

const emptyChat = (): T.Chat => ({ channels: [], userMentions: [] });

export const withUserMentions = (chat: T.Chat | undefined, userMentions: T.Chat["userMentions"]): T.Chat => ({ ...(chat ?? emptyChat()), userMentions });

/** A message said: news when its number is past what the state knows of its channel, or when the state does not keep that channel. */
export const withMessage = (chat: T.Chat | undefined, m: T.ChatMessage): [T.Chat | undefined, boolean] => {
  const c = chat?.channels.find((x) => x.id === m.channel);
  if (!chat || !c) return [chat, true];
  if (m.number <= (c.lastNumber ?? 0)) return [chat, false];
  return [{ ...chat, channels: chat.channels.map((x) => (x === c ? { ...c, lastNumber: m.number } : x)) }, true];
};

/** Beyond keepChannels the quietest threads go; the channels always stay. */
export const withChannel = (chat: T.Chat | undefined, c: T.Channel): T.Chat => {
  const base = chat ?? emptyChat();
  let all = base.channels.filter((x) => x.id !== c.id);
  all.push(c);
  const byID = (a: T.Channel, b: T.Channel) => compareText(a.id, b.id);
  if (all.length <= keepChannels) return { ...base, channels: all.toSorted(byID) };
  const top = (x: T.Channel) => (isTop(x) ? 1 : 0);
  const ranked = [...all].toSorted((a, b) => or(top(b) - top(a), (b.lastNumber ?? 0) - (a.lastNumber ?? 0)));
  const keep = new Set(ranked.slice(0, keepChannels).map((x) => x.id));
  all = all.filter((x) => keep.has(x.id)).toSorted(byID);
  return { ...base, channels: all };
};

type SearchHas = "file" | "image" | "link";

export interface SearchQuery {
  readonly words: string;
  /** A participant's id, or a name to match. */
  readonly from?: string;
  readonly in?: string;
  readonly has: readonly SearchHas[];
  /** Before the day it names (that day left out), and from the day it names on: epoch ms, at the server's midnight. */
  readonly before?: number;
  readonly after?: number;
}

const filterPattern = /(?:^|\s)(from|in|has|before|after):(\S+)/giu;

const dayPattern = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u;

/** A filter that does not read stays among the words. */
export function parseSearch(text: string): SearchQuery {
  let from: string | undefined;
  let inName: string | undefined;
  let before: number | undefined;
  let after: number | undefined;
  const has: SearchHas[] = [];
  const words = text
    .replace(filterPattern, (whole, key: string, value: string) => {
      const day = dayPattern.exec(value);
      // The day's midnight in this machine's zone.
      const at = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : undefined;
      switch (key.toLowerCase()) {
        case "from":
          from = chatNamed[value.replace(/^@/u, "")] ?? value.replace(/^@/u, "");
          return " ";
        case "in":
          inName = value.replace(/^#/u, "");
          return " ";
        case "has":
          if (value === "file" || value === "image" || value === "link") {
            if (!has.includes(value)) has.push(value);
            return " ";
          }
          return whole;
        case "before":
          if (at === undefined) return whole;
          before = at;
          return " ";
        case "after":
          if (at === undefined) return whole;
          after = at;
          return " ";
        default:
          return whole;
      }
    })
    .replace(/\s+/gu, " ")
    .trim();
  return {
    words,
    has,
    ...(from !== undefined ? { from } : {}),
    ...(inName !== undefined ? { in: inName } : {}),
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

const sourceByPurpose: Record<NonNullable<Meta["ingressSource"]>, TriggerSource> = {
  issue: "workbench",
  cron: "cron",
  patrol: "patrol",
  connector: "connector",
  voice: "voice",
  github: "github",
};

/** A committed channel message as the one trigger Mailbox routes, and what it needs to fan it out. */
/** The trigger a channel message is recorded as: its own id, its words, where it was said and who it is for. */
export const channelTrigger = (fact: ChannelHearers, context: InputContext): TriggerInput => {
  const meta = metaOf(fact.row.meta);
  const source = meta.ingressSource ? sourceByPurpose[meta.ingressSource] : "channel";
  const input: TriggerInput = {
    id: fact.row.envelope_id,
    key: fact.row.envelope_id,
    source,
    actor: actorOfParticipant(fact.row.sender_kind, fact.row.sender_role, fact.row.sender_id, fact.row.name),
    addressed: fact.addressed
      ? "direct"
      : fact.audience.mentions.length > 0
        ? "mention"
        : fact.row.channel_type === "thread" && fact.audience.threadOwner
          ? "thread_owner"
          : "unaddressed",
    threads: [`channel:${fact.row.channel_id}`, ...(fact.row.subject_kind === "issue" && fact.row.subject_id ? [`issue:${fact.row.subject_id}`] : [])],
    ...(fact.row.reply_number === null ? {} : { replyTo: `${fact.row.channel_id}:${fact.row.reply_number}` }),
    replyChannel: fact.row.channel_id,
    text: fact.row.body,
    meta: {
      ...(meta.issue ? { issue: meta.issue } : {}),
      ...(meta.ingressRecipient ? { ingressRecipient: meta.ingressRecipient } : {}),
      ...(meta.trigger ? { trigger: meta.trigger } : {}),
      channelMessageId: fact.row.envelope_id,
      inputContext: context,
      channelType: channelType(fact.row.channel_type),
    },
    at: fact.row.created_at,
    data: { kind: "channel_message", message: fact.row.envelope_id, channel: fact.row.channel_id },
  };
  return input;
};
