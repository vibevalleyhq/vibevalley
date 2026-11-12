import { z } from "zod";

import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, userId } from "@vibevalley/protocol";
import { type Wire } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { storedJsonOrUndefined, valueOf } from "#/base/json.ts";

import { type Trigger, type TriggerContext, VoiceModeValues } from "./shapes.ts";

const IngressSourceValues = ["issue", "cron", "patrol", "connector", "voice", "github"] as const;

export interface Meta {
  run?: string;
  mentions?: string[];
  session?: T.SessionId;
  outcome?: T.Outcome;
  spent?: T.Spent;
  code?: string;
  /** Spoken on a voice call: already heard by the orchestrator, so do not wake again. */
  spoken?: boolean;
  attachments?: T.Attachment[];
  embeds?: T.Embed[];
  artifact?: T.ArtifactCard;
  blocks?: readonly T.QuotedBlock[];
  picked?: Picked;
  ingressSource?: "issue" | "cron" | "patrol" | "connector" | "voice" | "github";
  ingressRecipient?: string;
  issue?: T.IssueId;
  trigger?: T.RunTrigger;
  responsePort?: string;
  voiceMode?: "dictated" | "conversation" | "api";
}

const MetaSchema = z.object({
  run: z.exactOptional(z.string()),
  mentions: z.exactOptional(z.array(z.string())),
  session: z.exactOptional(S.SessionId),
  outcome: z.exactOptional(S.Outcome),
  spent: z.exactOptional(S.Spent),
  code: z.exactOptional(z.string()),
  spoken: z.exactOptional(z.boolean()),
  attachments: z.exactOptional(z.array(S.Attachment)),
  embeds: z.exactOptional(z.array(S.Embed)),
  artifact: z.exactOptional(S.ArtifactCard),
  blocks: z.exactOptional(z.array(S.QuotedBlock)),
  picked: z.exactOptional(z.object({ agent: z.exactOptional(z.string()), repo: z.exactOptional(z.string()) })),
  ingressSource: z.exactOptional(z.enum(IngressSourceValues)),
  ingressRecipient: z.exactOptional(z.string()),
  issue: z.exactOptional(S.IssueId),
  trigger: z.exactOptional(S.RunTrigger),
  responsePort: z.exactOptional(z.string()),
  voiceMode: z.exactOptional(z.enum(VoiceModeValues)),
}) satisfies z.ZodType<Meta, Wire<Meta>>;

const decodeMetaText = storedJsonOrUndefined(MetaSchema, "channel_message.meta");
const decodeMetaValue = valueOf(MetaSchema, "channel_message.meta");
export const metaOf = (raw: unknown): Meta => (raw == null ? {} : typeof raw === "string" ? (decodeMetaText(raw) ?? {}) : decodeMetaValue(raw));

/** Omits empty strings, false, and empty arrays to match Go omitempty snapshots. */
export const metaText = (m: Meta | undefined) =>
  m === undefined
    ? null
    : JSON.stringify(
        Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0))),
      );

export const actorOfParticipant = (kind: T.ActorKind, role: T.AgentRole | null, id: string, name?: string): T.Actor =>
  kind === "agent"
    ? { kind: "agent", id, role: role ?? "worker", ...(name !== undefined ? { name } : {}) }
    : { kind, id, ...(name !== undefined ? { name } : {}) };

export const channelType = (type: string): T.ChannelType => S.ChannelType.safeParse(type).data ?? "channel";

export const envelopeMore = (
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

export function targetOf(c: Pick<T.Channel, "type" | "rootNumber" | "name">, channelName: string): string {
  if (c.type === "direct") return "@" + userId;
  if (c.type === "thread" && c.rootNumber !== undefined) return "#" + channelName + ":" + c.rootNumber;
  return "#" + (c.name ?? channelName);
}

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

/** The channels a participant has unread words in, as a wake-up and an inbox list them: the first summaryChannels of
 * the unread rows (channel.sql's unreadOf), in their order. */
export const unreadSummaryOf = (
  rows: readonly {
    readonly type: string;
    readonly root_number: number | null;
    readonly channel_name: string;
    readonly unread: number;
    readonly mentions_you: boolean;
    readonly latest_sender_name: string | null;
  }[],
): UnreadRow[] =>
  rows.slice(0, summaryChannels).map((row) => ({
    target: targetOf({ type: channelType(row.type), ...(row.root_number !== null ? { rootNumber: row.root_number } : {}) }, row.channel_name || ""),
    unread: row.unread,
    mentionsYou: row.mentions_you,
    ...(row.latest_sender_name ? { latest: row.latest_sender_name } : {}),
  }));

/** Identical text from the same sender and channel within this window is treated as a retry. */
export const retryWindowMs = 60_000;

export const heldShown = 3;

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

/** Direct channel peer if orchestrator; otherwise defaultOrchestrator if a member, first orchestrator member, or defaultOrchestrator. */
export const orchestratorIn = (place: {
  readonly top: { readonly type: string; readonly peer_id: string | null } | undefined;
  readonly members: readonly string[];
  readonly isOrchestrator: (agent: string) => boolean;
}): string => {
  const { top, members, isOrchestrator } = place;
  if (top?.type === "direct") return top.peer_id !== null && isOrchestrator(top.peer_id) ? top.peer_id : defaultOrchestrator;
  if (members.includes(defaultOrchestrator)) return defaultOrchestrator;
  return members.find(isOrchestrator) ?? defaultOrchestrator;
};

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
