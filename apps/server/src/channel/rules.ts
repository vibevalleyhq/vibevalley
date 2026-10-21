// Who hears a message and how it is put to them: the chat's rules, held to their
// recorded cases (rules.test.ts).

import { type Conversation, everyone, generalName, managerAgent, type MessageKind, type Outcome, type SenderKind } from "@vibevalley/protocol";
import { hopLimit, type InboxMessage, messageLine, summaryConversations, wakeMessages } from "@vibevalley/protocol/rules";

const chatNamed: Readonly<Record<string, string>> = { 管家: managerAgent, 主人: "user", 所有人: everyone };

export const mentionOf: Readonly<Record<string, string>> = { [managerAgent]: "@管家", user: "@主人", [everyone]: "@所有人" };

const chatFence = /```[\s\S]*?```/g;
const chatTick = /`[^`\n]*`/g;
const chatMention = /(^|[^\p{L}\p{N}_@])@(w[0-9]+|管家|主人|所有人)/gu;

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
  if (!channelNamePattern.test(name)) return "频道名只能是字母、数字、汉字、- 和 _，最多 24 个字";
  if (taken.includes(name)) return "已经有叫 " + name + " 的频道了";
  return "";
}

export type ChatTarget = { readonly kind: "channel"; readonly name: string } | { readonly kind: "thread"; readonly parent: number };

const int64Max = 9223372036854775807n;

/** A channel's name, or a thread's parent number; a number past int64 is not one. */
export function parseChatTarget(target: string): ChatTarget | undefined {
  const t = target.trim().replace(/^#/, "");
  const m = chatThreadTarget.exec(t);
  if (m) return BigInt(m[1]!) > int64Max ? undefined : { kind: "thread", parent: Number(m[1]) };
  return channelNamePattern.test(t) ? { kind: "channel", name: t } : undefined;
}

export type DeliveryReason = "mention" | "everyone" | "own_thread" | "follower" | "general" | "dispatch" | "addressed" | "graph";
export type HeldBy = "hop_limit" | "cooldown" | "wake_breaker";

export interface Delivery {
  readonly recipient: string;
  readonly reason: DeliveryReason;
  readonly wakes: boolean;
  readonly heldBy?: HeldBy;
}

export interface AudienceInput {
  readonly from: string;
  readonly fromKind: SenderKind;
  readonly kind: MessageKind;
  readonly mentions: readonly string[];
  /** Only its kind is read. */
  readonly conversation: Pick<Conversation, "kind">;
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

/** Who hears a message: named first (the strongest reason wins), then the thread's owner and followers, or the channel's. */
export function chatAudience(i: AudienceInput): Delivery[] {
  const out: Delivery[] = [];
  if (i.kind === "notice" || i.kind === "dispatch" || i.fromKind === "system" || i.spoken) return out;
  const byAgent = i.fromKind === "agent" || i.fromKind === "manager";
  const present = i.present ?? i.sessions ?? [];
  let hops = i.hops;
  const add = (recipient: string, reason: DeliveryReason, wakes: boolean) => {
    if (recipient === i.from || out.some((d) => d.recipient === recipient)) return;
    if (recipient !== managerAgent && !present.includes(recipient)) return;
    let heldBy: HeldBy | undefined;
    if (wakes && byAgent && hops >= hopLimit) heldBy = "hop_limit";
    else if (wakes && byAgent && recipient !== managerAgent && (i.cooling ?? []).includes(recipient)) heldBy = "cooldown";
    else if (wakes && i.fromKind !== "user" && (i.broken ?? []).includes(recipient)) heldBy = "wake_breaker";
    if (wakes && byAgent && !heldBy) hops++;
    out.push({ recipient, reason, wakes, ...(heldBy ? { heldBy } : {}) });
  };

  if (i.kind === "report") {
    if (!i.forTask) add(managerAgent, "addressed", i.outcome === "failed");
    return out;
  }
  const mentions = i.mentions ?? [];
  for (const m of mentions) {
    if (m === everyone) {
      if (i.fromKind === "user") for (const h of i.sessions ?? []) add(h, "everyone", true);
    } else if (m !== "user") add(m, "mention", true);
  }
  const thread = i.conversation.kind === "thread";
  const owner = thread ? (i.threadOwner ?? "") : "";
  if (i.fromKind === "user") {
    if (owner) add(owner, "own_thread", true);
    if (thread) for (const f of i.followers ?? []) add(f, "follower", true);
    else {
      if (!mentions.some((m) => m !== "user")) add(managerAgent, "addressed", true);
      for (const h of i.sessions ?? []) add(h, "general", false);
    }
  } else if (owner) add(owner, "own_thread", true);
  return out;
}

export const hopLimitText = (limit: number) => `帮工之间已经来回 ${limit} 次了，先停一停：等主人说一句再接着叫人。`;

export interface UnreadRow {
  readonly target: string;
  readonly unread: number;
  readonly mentionsYou: boolean;
  readonly latest?: string;
}

const rowText = (r: UnreadRow) => `${r.target} ${r.unread} 条` + (r.mentionsYou ? "（提到了你）" : "") + (r.latest ? "，最后是 " + r.latest : "");

/** What a session woken for messages is told: the newest few for it, and what else is unread elsewhere. */
export function wakeInput(messages: readonly InboxMessage[], others: readonly UnreadRow[]): string {
  const shown = messages.slice(Math.max(0, messages.length - wakeMessages));
  const more = messages.length > shown.length ? `（这里是最新的 ${shown.length} 条）` : "";
  const lines = [`[${generalName}消息] 有 ${messages.length} 条给你的新消息${more}：`, ...shown.map(messageLine)];
  if (others.length > 0) lines.push("", "别处还有没读的（只读不回，除非直接问到你）：", ...others.slice(0, summaryConversations).map((r) => "- " + rowText(r)));
  lines.push("", "要回就用 channel_say，target 照抄；要看前面的上下文用 read_chat。不用回的就不回。");
  return lines.join("\n");
}

/** What a busy session is told of messages it has not read. */
export const busyNotice = (rows: readonly UnreadRow[]) =>
  `[${generalName}提示] 有新消息还没读：${rows.slice(0, summaryConversations).map(rowText).join("；")}。方便的时候用 read_chat 读；不读不代表没事。`;
