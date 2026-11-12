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

export interface ChannelAudience {
  readonly from: string;
  readonly actor: T.Actor;
  readonly kind: T.MessageKind;
  readonly mentions: readonly string[];
  readonly channel: Pick<T.Channel, "type" | "peer">;
  readonly orchestrator: string;
  readonly channelMembers: readonly string[];
  readonly orchestrators: readonly string[];
  readonly threadOwner?: string;
  readonly sessions: readonly string[];
  readonly present?: readonly string[] | null;
  readonly members: readonly string[];
  readonly outcome?: T.Outcome;
  readonly spoken?: boolean;
}

export interface ChannelHearers {
  readonly row: ChannelEnvelopeRow;
  readonly audience: ChannelAudience;
  readonly addressed?: string;
  readonly roles: Readonly<Record<string, T.AgentRole>>;
  readonly outcome?: T.Outcome;
}

export interface ChannelRouteResult {
  readonly heldNotice: string;
}

/** A source's event taken in: its trigger (none for the farm's own echo) and what its routing said. */
export interface Accepted extends ChannelRouteResult {
  readonly trigger?: Trigger;
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
