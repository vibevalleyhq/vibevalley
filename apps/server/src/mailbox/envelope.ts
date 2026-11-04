import { Effect, Option, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { ownerId } from "@vibevalley/protocol";
import { type Wire } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { jsonOrNone } from "@/base/json.ts";
import type { Db } from "@/infra/db.ts";

import { inboxOf } from "../../db/generated/channel.sql.ts";

export interface Meta {
  run?: string;
  mentions?: string[];
  session?: T.SessionId;
  outcome?: T.Outcome;
  spent?: T.Spent;
  code?: string;
  /** Said on a call: the orchestrator heard it there, so it wakes no one here. */
  spoken?: boolean;
  attachments?: T.Attachment[];
  embeds?: T.Embed[];
  /** The artifact it announces, as it was then (artifact/). */
  artifact?: T.ArtifactCard;
  /** The blocks it points at, as they read when it was sent. */
  blocks?: readonly T.QuotedBlock[];
  picked?: Picked;
  ingressSource?: "issue" | "cron" | "patrol" | "connector" | "voice" | "github";
  ingressRecipient?: string;
  issue?: string;
  trigger?: T.RunTrigger;
  responsePort?: string;
  voiceMode?: "dictated" | "conversation" | "api";
}

const MetaSchema: Schema.Codec<Meta, Wire<Meta>> = Schema.Struct({
  run: Schema.optionalKey(Schema.String),
  mentions: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  session: Schema.optionalKey(S.SessionId),
  outcome: Schema.optionalKey(S.Outcome),
  spent: Schema.optionalKey(S.Spent),
  code: Schema.optionalKey(Schema.String),
  spoken: Schema.optionalKey(Schema.Boolean),
  attachments: Schema.optionalKey(Schema.mutable(Schema.Array(S.Attachment))),
  embeds: Schema.optionalKey(Schema.mutable(Schema.Array(S.Embed))),
  artifact: Schema.optionalKey(S.ArtifactCard),
  blocks: Schema.optionalKey(Schema.mutable(Schema.Array(S.QuotedBlock))),
  picked: Schema.optionalKey(Schema.Struct({ agent: Schema.optionalKey(Schema.String), project: Schema.optionalKey(Schema.String) })),
  ingressSource: Schema.optionalKey(Schema.Literals(["issue", "cron", "patrol", "connector", "voice", "github"])),
  ingressRecipient: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(S.RunTrigger),
  responsePort: Schema.optionalKey(Schema.String),
  voiceMode: Schema.optionalKey(Schema.Literals(["dictated", "conversation", "api"])),
});

/** Anything unreadable is no meta. */
export const metaOf = (raw: unknown): Meta =>
  (typeof raw === "string" ? jsonOrNone(MetaSchema)(raw) : Option.getOrUndefined(Schema.decodeUnknownOption(MetaSchema)(raw))) ?? {};

/** As Go's omitempty writes it: nothing empty kept. */
export const metaText = (m: Meta | undefined) =>
  m === undefined
    ? null
    : JSON.stringify(
        Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0))),
      );

export const senderKind = (kind: string): T.ActorKind => (kind === "owner" || kind === "orchestrator" || kind === "session" ? kind : "system");
export const channelType = (type: string): T.ChannelType => (type === "thread" || type === "direct" ? type : "channel");

export const inboxMore = (
  row: { readonly meta: string | null; readonly reply_number: number | null; readonly edited_at?: number | null; readonly deleted_at?: number | null },
  filesAt: (id: string) => string,
) => {
  const meta = metaOf(row.meta);
  const files = meta.attachments ?? [];
  return {
    ...(row.reply_number !== null ? { replyTo: row.reply_number } : {}),
    ...(row.edited_at != null && row.edited_at !== 0 ? { edited: true } : {}),
    ...(row.deleted_at != null && row.deleted_at !== 0 ? { deleted: true } : {}),
    ...(files.length > 0 ? { attachments: files.map((f) => ({ name: f.name, path: filesAt(f.id) })) } : {}),
    ...(meta.artifact && (row.deleted_at == null || row.deleted_at === 0)
      ? { artifact: { id: meta.artifact.id, title: meta.artifact.title, version: meta.artifact.version } }
      : {}),
    ...(meta.blocks && meta.blocks.length > 0 && (row.deleted_at == null || row.deleted_at === 0) ? { blocks: meta.blocks } : {}),
    ...(meta.picked ? { picked: meta.picked } : {}),
    ...(meta.responsePort ? { responsePort: meta.responsePort } : {}),
    ...(meta.voiceMode ? { voiceMode: meta.voiceMode } : {}),
  };
};

/** Where a message is: a channel by #name, a thread by its channel's name and the number of its root message, the
 * owner's direct channel as @owner. */
export function targetOf(c: Pick<T.Channel, "type" | "rootNumber" | "name">, channelName: string): string {
  if (c.type === "direct") return "@" + ownerId;
  if (c.type === "thread" && c.rootNumber !== undefined) return "#" + channelName + ":" + c.rootNumber;
  return "#" + (c.name ?? channelName);
}

/** What the owner picked beside a message in the farm's form: the profile and the project the work is for. */
export interface Picked {
  readonly agent?: string;
  readonly project?: string;
}

export interface InboxMessage extends T.TriggerContext {
  readonly id: string;
  readonly originTrigger?: string;
  readonly from: string;
  readonly fromKind: T.ActorKind;
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

/** What a participant has not read, as the mailbox and the channel both report it. */
export const unreadSummaryOf = (db: Db["Service"], participant: string, channel: string): Effect.Effect<UnreadRow[]> =>
  Effect.map(db.run(inboxOf({ participant, channel })), (rows) =>
    rows.slice(0, summaryChannels).map((r) => ({
      target: targetOf({ type: channelType(r.type), ...(r.root_number !== null ? { rootNumber: r.root_number } : {}) }, r.channel_name || ""),
      unread: r.unread ?? 0,
      mentionsYou: r.mentions_you === true,
      ...(r.latest_sender_name ? { latest: r.latest_sender_name } : {}),
    })),
  );

/** The same words from the same sender in the same place this soon again are a retry, not a new message. */
export const retryWindowMs = 60_000;

export const heldShown = 3;

/** The chat's stored message as the mailbox reads it: who said it, where, and when. */
type StoredMessageKind = "chat" | "dispatch" | "report" | "notice";
type StoredSenderKind = "owner" | "orchestrator" | "session" | "profile" | "system";

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
  readonly sender_kind: StoredSenderKind;
  readonly channel_type: string;
  readonly root_id: string | null;
  readonly root_number: number | null;
  readonly subject_kind: string | null;
  readonly subject_id: string | null;
  readonly channel_name: string | null;
}

/** Collaboration facts from which Mailbox computes audience, brakes, urgency and the durable deliveries. */
export interface ChannelAudience {
  readonly from: string;
  readonly fromKind: T.ActorKind;
  readonly kind: T.MessageKind;
  readonly mentions: readonly string[];
  readonly channel: Pick<T.Channel, "type" | "peer">;
  readonly orchestrator: string;
  readonly orchestrators: readonly string[];
  readonly threadOwner?: string;
  readonly sessions: readonly string[];
  readonly present?: readonly string[] | null;
  readonly followers: readonly string[];
  readonly outcome?: T.Outcome;
  readonly spoken?: boolean;
}

export interface ChannelRouteInput {
  readonly row: ChannelEnvelopeRow;
  readonly audience: ChannelAudience;
  readonly addressed?: string;
  readonly roles: Readonly<Record<string, T.AgentRole>>;
  readonly outcome?: T.Outcome;
}

export interface ChannelRouteResult {
  readonly heldNotice: string;
}

/** What came to an orchestrator in one channel, to wake it with. */
export interface OrchestratorNews {
  /** The orchestrator it came to, by its profile id. */
  readonly agent: string;
  readonly channel: string;
  readonly type: T.ChannelType;
  readonly target: string;
  readonly messages: InboxMessage[];
  readonly source?: "issue" | "cron" | "patrol";
  readonly issue?: string;
  readonly by?: T.RunTrigger;
}
