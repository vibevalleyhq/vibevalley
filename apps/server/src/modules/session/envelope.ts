import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { type Trigger, type TriggerContext } from "./shapes.ts";

export const actorOfParticipant = (kind: T.ActorKind, role: T.AgentRole | null, id: string, name?: string): T.Actor =>
  kind === "agent"
    ? { kind: "agent", id, role: role ?? "worker", ...(name !== undefined ? { name } : {}) }
    : { kind, id, ...(name !== undefined ? { name } : {}) };

export const channelType = (type: string): T.ChannelType => S.ChannelType.safeParse(type).data ?? "channel";

export interface Picked {
  readonly agent?: string;
  readonly repo?: string;
}

export interface Envelope extends TriggerContext {
  readonly id: string;
  readonly originTrigger?: string;
  readonly from: string;
  readonly actor: T.Actor;
  readonly name: string;
  readonly text: string;
}

export interface UnreadRow {
  readonly target: string;
  readonly unread: number;
  readonly mentionsYou: boolean;
  readonly latest?: string;
}

export const summaryChannels = 20;

/** What the mailbox reads of the chat, told by the layer above it (the watch): the default channel, the orchestrator a
 * place's words that name no one go to, and a participant's unread (`channel`: the one it is in), newest first. */
export interface ChatView {
  readonly defaultChannel: () => string;
  readonly orchestratorIn: (channel: string) => string;
  readonly unreadOf: (participant: string, channel: string) => Promise<readonly UnreadRow[]>;
}

/** What the mailbox reads of the issues, told by the layer above it (the issues): those on the board, and whether one
 * is kept at all (an issue off the board still owns its threads). */
export interface IssueView {
  readonly issues: () => readonly T.Issue[];
  readonly exists: (id: string) => Promise<boolean>;
}

type StoredMessageKind = "chat" | "dispatch" | "report" | "notice";

export interface ChannelEnvelopeRow {
  readonly envelope_id: string;
  readonly number: number;
  readonly channel_id: string;
  readonly sender_id: string;
  readonly kind: StoredMessageKind;
  readonly body: string;
  readonly meta: string | null;
  readonly reply_number: number | null;
  readonly created_at: number;
  readonly name: string;
  readonly sender_kind: T.ActorKind;
  readonly sender_role: T.AgentRole | null;
  readonly channel_type: string;
  readonly root_id: string | null;
  readonly root_number: number | null;
  readonly subject_kind: string | null;
  readonly subject_id: string | null;
  readonly channel_name: string | null;
}

/** Why a delivery reaches its session. */
export type DeliveryReason = "mention" | "everyone" | "own_thread" | "member" | "channel" | "direct" | "addressed";
/** Which brake held a delivery back from waking its session (watch/brakes.ts). */
export type HeldBy = "hop_limit" | "cooldown" | "wake_breaker";
/** What a delivery is to its session: how urgent it is follows from this (routing.ts urgencyOf). */
export type DeliveryEvent = "stop" | "conversation" | "mention" | "assignment" | "review" | "ci_failed" | "report_attention" | "report_progress" | "ambient";

/** A session that hears a routed trigger, as the layer above worked it out: why, whether it wakes, what held it back. */
export interface Hearer {
  readonly session: string;
  readonly reason: DeliveryReason;
  readonly wakes: boolean;
  readonly heldBy?: HeldBy;
  readonly role: T.AgentRole;
  readonly event: DeliveryEvent;
}

/** A source's event taken in: its trigger (none for the farm's own echo). */
export interface Accepted {
  readonly trigger?: Trigger;
}

/** The wakes of agents' words since the user last spoke, as the deliveries kept them: what the brakes start from. */
export interface AgentWakes {
  /** Per routing scope (payload.ts deliveryScope), the deliveries that woke a session since the user's newest there. */
  readonly scopes: readonly { readonly scope: string; readonly n: number }[];
  /** Per session, when an agent's words last woke it. */
  readonly sessions: readonly { readonly session: string; readonly at: number }[];
}

export interface Handed {
  readonly _tag: "Handed";
  readonly agent: string;
  readonly channel: string;
  readonly type: T.ChannelType;
  readonly target: string;
  readonly messages: Envelope[];
  readonly source?: "issue" | "cron" | "patrol";
  readonly issue?: string;
  readonly by?: T.RunTrigger;
}
