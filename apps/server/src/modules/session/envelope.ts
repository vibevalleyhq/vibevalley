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

/** What the mailbox reads of the chat, told by the layer above it (the watch): the default channel, and a participant's
 * unread (`channel`: the one it is in), newest first. */
export interface ChatView {
  readonly defaultChannel: () => string;
  readonly unreadOf: (participant: string, channel: string) => Promise<readonly UnreadRow[]>;
}

/** A session's input waiting to be handed to it, as the layer above judges it: the issue it is for (its own, or the
 * session's), whether the user said it, and whether it is still pending (not handed yet). */
export interface WaitingInput {
  readonly issue?: string;
  readonly fromUser: boolean;
  readonly pending: boolean;
}

/** Which of a session's waiting inputs may be handed to it now, one answer per input, as the layer above decides (the
 * issues); until told, all of them. */
export type Readiness = (inputs: readonly WaitingInput[]) => readonly boolean[];

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

/** How a delivery reaches a busy session: stop it, steer its turn, wait for the next, or wait to be read with the rest. */
export type Urgency = "interrupt" | "steer" | "queue" | "digest";

/** A session that hears a routed trigger, as the layer above worked it out: why, whether it wakes, what held it back. */
export interface Hearer {
  readonly session: string;
  readonly reason: DeliveryReason;
  readonly wakes: boolean;
  readonly heldBy?: HeldBy;
  readonly role: T.AgentRole;
  readonly event: DeliveryEvent;
}

/** A session a routed trigger is delivered to, as the layer above picked it (Session.route). */
export interface Delivery {
  readonly session: string;
  /** Why, whether it wakes and what held it back, as the watch heard it; else addressed, waking unless a digest. */
  readonly heard?: Pick<Hearer, "reason" | "wakes" | "heldBy">;
  /** What the session is (its profile's role when not given) and what the delivery is to it: its urgency follows. */
  readonly role?: T.AgentRole;
  readonly event?: DeliveryEvent;
  readonly urgency?: Urgency;
  /** The issue it is for: where it counts (payload.ts deliveryScope), and what the run that takes it took. */
  readonly issue?: string;
  /** The session it went to before: that delivery is dropped as reassigned. */
  readonly previous?: string;
  /** Its own id when not the trigger's: an input handed back goes to another session as a second delivery. */
  readonly id?: string;
  /** Said to the session with it. */
  readonly note?: string;
  /** Read in the routing transaction: false leaves this one out. */
  readonly prepare?: () => Promise<boolean>;
  /** Written in the routing transaction, with the delivery. */
  readonly commit?: () => Promise<void>;
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
