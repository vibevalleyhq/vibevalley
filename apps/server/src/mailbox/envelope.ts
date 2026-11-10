import { Array as Arr, Formatter, Option, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import { defaultOrchestrator, userId } from "@vibevalley/protocol";
import { type Wire } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { jsonOrNone } from "#/base/json.ts";

import { type TriggerActorKind, type TriggerContext, VoiceModeValues } from "./shapes.ts";

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
  picked: Schema.optionalKey(Schema.Struct({ agent: Schema.optionalKey(Schema.String), repo: Schema.optionalKey(Schema.String) })),
  ingressSource: Schema.optionalKey(Schema.Literals(IngressSourceValues)),
  ingressRecipient: Schema.optionalKey(Schema.String),
  issue: Schema.optionalKey(S.IssueId),
  trigger: Schema.optionalKey(S.RunTrigger),
  responsePort: Schema.optionalKey(Schema.String),
  voiceMode: Schema.optionalKey(Schema.Literals(VoiceModeValues)),
});

export const metaOf = (raw: unknown): Meta =>
  (typeof raw === "string" ? jsonOrNone(MetaSchema)(raw) : Option.getOrUndefined(Schema.decodeUnknownOption(MetaSchema)(raw))) ?? {};

/** Omits empty strings, false, and empty arrays to match Go omitempty snapshots. */
export const metaText = (m: Meta | undefined) =>
  m === undefined
    ? null
    : Formatter.formatJson(
        Object.fromEntries(Object.entries(m).filter(([, v]) => v !== undefined && v !== "" && v !== false && !(Array.isArray(v) && v.length === 0))),
      );

export const speakerOf = (participant: string): { readonly fromKind: T.ActorKind; readonly fromRole?: T.AgentRole } => {
  switch (participant) {
    case "user":
      return { fromKind: "user" };
    case "orchestrator":
      return { fromKind: "agent", fromRole: "orchestrator" };
    case "session":
    case "profile":
      return { fromKind: "agent", fromRole: "worker" };
    default:
      return { fromKind: "system" };
  }
};

/** External GitHub collaborators, bots, and CI map to "system". */
export const actorKindOf = (kind: TriggerActorKind): T.ActorKind => {
  switch (kind) {
    case "user":
    case "agent":
    case "system":
      return kind;
    case "collaborator":
    case "bot":
    case "ci":
      return "system";
  }
};
export const channelType = (type: string): T.ChannelType => (Schema.is(S.ChannelType)(type) ? type : "channel");

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
  readonly fromKind: T.ActorKind;
  readonly fromRole?: T.AgentRole;
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

/** Identical text from the same sender and channel within this window is treated as a retry. */
export const retryWindowMs = 60_000;

export const heldShown = 3;

type StoredMessageKind = "chat" | "dispatch" | "report" | "notice";
type StoredSenderKind = "user" | "orchestrator" | "session" | "profile" | "system";

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

/** Direct channel peer if orchestrator; otherwise defaultOrchestrator if a member, first orchestrator member, or defaultOrchestrator. */
export const orchestratorIn = (place: {
  readonly top: { readonly type: string; readonly peer_id: string | null } | undefined;
  readonly members: readonly string[];
  readonly isOrchestrator: (agent: string) => boolean;
}): string => {
  const { top, members, isOrchestrator } = place;
  if (top?.type === "direct") return top.peer_id !== null && isOrchestrator(top.peer_id) ? top.peer_id : defaultOrchestrator;
  if (Arr.contains(members, defaultOrchestrator)) return defaultOrchestrator;
  return Option.getOrElse(Arr.findFirst(members, isOrchestrator), () => defaultOrchestrator);
};

export interface ChannelAudience {
  readonly from: string;
  readonly fromKind: T.ActorKind;
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
