// Who hears a message and how it is put to them: the chat's rules, held to their
// recorded cases (rules.test.ts).

import { channelWording } from "./words.ts";
import { type Channel, everyone, orchestratorAgent, ownerId, type MessageKind, type Outcome, type ActorKind } from "@vibevalley/protocol";

// The chat's own names for who is not a helper, as people and models write them: in Chinese, and in English.
const chatNamed: Readonly<Record<string, string>> = {
  管家: orchestratorAgent,
  主人: ownerId,
  所有人: everyone,
  manager: orchestratorAgent,
  owner: ownerId,
  everyone,
};

/** How a mention of who is not a helper is written, in the owner's words. */
export const mentionOf = (id: string): string | undefined => channelWording().mention[id];

const chatFence = /```[\s\S]*?```/g;
const chatTick = /`[^`\n]*`/g;
const chatMention = /(^|[^\p{L}\p{N}_@])@(w[0-9]+|管家|主人|所有人|manager|owner|everyone)/gu;

/** Code is not prose: a mention inside backticks or a fence names no one. A name ends where its token ends, so `@w3你看` names w3. */
export function mentionsIn(text: string): string[] {
  const prose = text.replace(chatFence, " ").replace(chatTick, " ");
  const found: string[] = [];
  for (const m of prose.matchAll(chatMention)) {
    const id = chatNamed[m[2]!] ?? m[2]!;
    if (!found.includes(id)) found.push(id);
  }
  return found;
}

/** No #, : or spaces, so an address reads back. */
const channelNamePattern = /^[\p{L}\p{N}_-]{1,24}$/u;
const chatThreadTarget = /^[\p{L}\p{N}_-]{1,24}:([0-9]+)$/u;

export function channelNameProblem(name: string, taken: readonly string[]): string {
  if (!channelNamePattern.test(name)) return channelWording().channelName;
  if (taken.includes(name)) return channelWording().channelTaken(name);
  return "";
}

export type ChatTarget =
  | { readonly kind: "channel"; readonly name: string }
  | { readonly kind: "thread"; readonly root: number }
  | { readonly kind: "direct"; readonly peer: string };

const chatDirectTarget = /^@(\S+)$/u;

const int64Max = 9223372036854775807n;

/** A channel's name, a thread's parent number, or @ the one a direct channel is with; a number past int64 is not one. */
export function parseChatTarget(target: string): ChatTarget | undefined {
  const direct = chatDirectTarget.exec(target.trim());
  if (direct) return { kind: "direct", peer: chatNamed[direct[1]!] ?? direct[1]! };
  const t = target.trim().replace(/^#/, "");
  const m = chatThreadTarget.exec(t);
  if (m) return BigInt(m[1]!) > int64Max ? undefined : { kind: "thread", root: Number(m[1]) };
  return channelNamePattern.test(t) ? { kind: "channel", name: t } : undefined;
}

export type DeliveryReason = "mention" | "everyone" | "own_thread" | "follower" | "channel" | "direct" | "dispatch" | "addressed" | "graph";
export type HeldBy = "hop_limit" | "cooldown" | "wake_breaker";

export interface Delivery {
  readonly recipient: string;
  readonly reason: DeliveryReason;
  readonly wakes: boolean;
  readonly heldBy?: HeldBy;
}

export interface AudienceInput {
  readonly from: string;
  readonly fromKind: ActorKind;
  readonly kind: MessageKind;
  readonly mentions: readonly string[];
  /** Only its type and a direct channel's peer are read. */
  readonly channel: Pick<Channel, "type" | "peer">;
  /** In a thread, the session its words are for: the one working the thread's issue now, "" when none is. */
  readonly threadOwner?: string;
  readonly sessions: readonly string[];
  /** sessions when undefined. */
  readonly present?: readonly string[] | null;
  readonly followers: readonly string[];
  readonly hops: number;
  readonly cooling: readonly string[];
  readonly broken: readonly string[];
  readonly outcome?: Outcome;
  readonly forTask?: boolean;
  readonly spoken?: boolean;
}

/** Who hears a message: in a direct channel the owner's words wake the peer and no one else hears anything; elsewhere
 * who is named first (the strongest reason wins), then the thread's owner and followers, or the channel's. */
export function chatAudience(i: AudienceInput): Delivery[] {
  const out: Delivery[] = [];
  if (i.kind === "notice" || i.kind === "dispatch" || i.fromKind === "system" || i.spoken) return out;
  const byAgent = i.fromKind === "session" || i.fromKind === "orchestrator";
  const present = i.present ?? i.sessions ?? [];
  let hops = i.hops;
  const add = (recipient: string, reason: DeliveryReason, wakes: boolean) => {
    if (recipient === i.from || out.some((d) => d.recipient === recipient)) return;
    if (recipient !== orchestratorAgent && !present.includes(recipient)) return;
    let heldBy: HeldBy | undefined;
    if (wakes && byAgent && hops >= hopLimit) heldBy = "hop_limit";
    else if (wakes && byAgent && recipient !== orchestratorAgent && (i.cooling ?? []).includes(recipient)) heldBy = "cooldown";
    else if (wakes && i.fromKind !== "owner" && (i.broken ?? []).includes(recipient)) heldBy = "wake_breaker";
    if (wakes && byAgent && !heldBy) hops++;
    out.push({ recipient, reason, wakes, ...(heldBy ? { heldBy } : {}) });
  };

  if (i.channel.type === "direct") {
    if (i.fromKind === "owner" && i.channel.peer) add(i.channel.peer, "direct", true);
    return out;
  }
  if (i.kind === "report") {
    if (!i.forTask) add(orchestratorAgent, "addressed", i.outcome === "failed");
    return out;
  }
  const mentions = i.mentions ?? [];
  for (const m of mentions) {
    if (m === everyone) {
      if (i.fromKind === "owner") for (const h of i.sessions ?? []) add(h, "everyone", true);
    } else if (m !== ownerId) add(m, "mention", true);
  }
  const thread = i.channel.type === "thread";
  const owner = thread ? (i.threadOwner ?? "") : "";
  if (i.fromKind === "owner") {
    if (owner) add(owner, "own_thread", true);
    if (thread) for (const f of i.followers ?? []) add(f, "follower", true);
    else {
      if (!mentions.some((m) => m !== ownerId)) add(orchestratorAgent, "addressed", true);
      for (const h of i.sessions ?? []) add(h, "channel", false);
    }
  } else if (owner) add(owner, "own_thread", true);
  return out;
}

export const hopLimitText = (limit: number) => channelWording().hopLimit(limit);

export interface UnreadRow {
  readonly target: string;
  readonly unread: number;
  readonly mentionsYou: boolean;
  readonly latest?: string;
}

/** Counted since the person last spoke in the channel. */
export const hopLimit = 4;

export const agentWakeCooldownMs = 60_000;

/** Past this, only the person wakes the session. */
export const wakeBreaker = 3;

export const wakeMessages = 3;

export const summaryChannels = 20;

/** The same words from the same sender in the same place this soon again are a retry, not a new message. */
export const retryWindowMs = 60_000;

export const heldShown = 3;

/** A message as the orchestrator and a session read it. */
export interface InboxMessage {
  readonly id: string;
  readonly number: number;
  readonly target: string;
  readonly from: string;
  readonly fromKind: ActorKind;
  readonly name: string;
  readonly text: string;
  readonly replyTo?: number;
  readonly edited?: boolean;
  readonly deleted?: boolean;
  /** Files said with it, where they are on this computer. */
  readonly attachments?: readonly { readonly name: string; readonly path: string }[];
}

export type SearchHas = "file" | "image" | "link";

/** What a search asks for: its words, and the filters written among them. */
export interface SearchQuery {
  readonly words: string;
  /** A participant's id, or a name to match. */
  readonly from?: string;
  /** A channel's name. */
  readonly in?: string;
  readonly has: readonly SearchHas[];
  /** Before the day it names (that day left out), and from the day it names on: epoch ms, at the server's midnight. */
  readonly before?: number;
  readonly after?: number;
}

const filterPattern = /(?:^|\s)(from|in|has|before|after):(\S+)/giu;
const dayPattern = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;

/** The filters written in a search (from:, in:, has:, before:, after:) and the words around them; one that does not
 * read stays among the words. */
export function parseSearch(text: string): SearchQuery {
  let from: string | undefined;
  let inName: string | undefined;
  let before: number | undefined;
  let after: number | undefined;
  const has: SearchHas[] = [];
  const words = text
    .replace(filterPattern, (whole, key: string, value: string) => {
      const day = dayPattern.exec(value);
      const at = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime() : undefined;
      switch (key.toLowerCase()) {
        case "from":
          from = chatNamed[value.replace(/^@/, "")] ?? value.replace(/^@/, "");
          return " ";
        case "in":
          inName = value.replace(/^#/, "");
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
    .replace(/\s+/g, " ")
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
