import type { AgentRole } from "../agent/shapes";
import type { QuotedBlock } from "../artifact/shapes";
import type { ChannelType } from "../channel/shapes";
import type { IssueId } from "../common/shapes";
import type { RunTrigger } from "../session/shapes";

export const TriggerSourceValues = ["workbench", "channel", "connector", "voice", "github", "cron", "patrol"] as const;
export type TriggerSource = (typeof TriggerSourceValues)[number];

export const TriggerActorKindValues = ["owner", "collaborator", "bot", "ci", "agent", "system"] as const;
export type TriggerActorKind = (typeof TriggerActorKindValues)[number];

export const TriggerAddressingValues = ["direct", "mention", "thread_owner", "unaddressed"] as const;
export type TriggerAddressing = (typeof TriggerAddressingValues)[number];

export const TriggerKindValues = ["ci", "review", "comment"] as const;
export type TriggerKind = (typeof TriggerKindValues)[number];

export const VoiceModeValues = ["dictated", "conversation", "api"] as const;
/** "conversation": on a call. */
export type VoiceMode = (typeof VoiceModeValues)[number];

export interface TriggerActor {
  readonly kind: TriggerActorKind;
  readonly id: string;
  /** The agent's role, when kind is agent. */
  readonly role?: AgentRole;
  readonly name?: string;
}

export interface CardAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly readUri: string;
}

export interface ParentPreview {
  readonly id: string;
  readonly from: string;
  readonly preview: string;
  readonly readUri: string;
}

export interface CompactCard {
  readonly summary: string;
  readonly totalChars: number;
  readonly truncated: boolean;
  readonly readUri: string;
  readonly attachments?: readonly CardAttachment[];
  readonly parentPreview?: ParentPreview;
}

export interface TriggerContext {
  readonly number: number;
  readonly target: string;
  readonly replyTo?: number;
  readonly edited?: boolean;
  readonly deleted?: boolean;
  readonly attachments?: readonly { readonly name: string; readonly path: string }[];
  readonly artifact?: { readonly id: string; readonly title: string; readonly version: number };
  readonly blocks?: readonly QuotedBlock[];
  readonly picked?: { readonly agent?: string; readonly repo?: string };
  readonly responsePort?: string;
  readonly voiceMode?: VoiceMode;
}

export interface TriggerMeta {
  readonly issue?: IssueId;
  readonly ingressRecipient?: string;
  readonly trigger?: RunTrigger;
  readonly dispatch?: boolean;
  readonly cron?: string;
  readonly repo?: string;
  readonly pr?: number;
  readonly kind?: TriggerKind;
  readonly head?: string;
  readonly fingerprint?: string;
  readonly failed?: boolean;
  readonly botRound?: number;
  readonly botRoundKey?: string;
  readonly channelMessageId?: string;
  readonly inputContext?: TriggerContext;
  readonly channelType?: ChannelType;
  readonly responsePort?: string;
  readonly voiceMode?: VoiceMode;
}

export interface Trigger {
  readonly id: string;
  readonly source: TriggerSource;
  readonly actor: TriggerActor;
  readonly addressed: TriggerAddressing;
  readonly threads: readonly string[];
  readonly replyTo?: string;
  readonly replyChannel?: string;
  readonly picked?: { readonly agent?: string; readonly repo?: string };
  readonly card: CompactCard;
  readonly meta: TriggerMeta;
  readonly at: number;
}
