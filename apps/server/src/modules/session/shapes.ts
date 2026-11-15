import type * as T from "@vibevalley/protocol";

import type { CardAttachment, CompactCard, ParentPreview, QuotedBlock } from "#/base/clip.ts";
import type { CriterionCheck } from "#/base/questions.ts";

export type { CardAttachment, CompactCard, ParentPreview, QuotedBlock };

export type ChannelType = T.Channel["type"];
export type Doing = Extract<T.Phase, { _tag: "working" }>["doing"];
export type SessionClose = Extract<T.Phase, { _tag: "closed" }>["closed"];
export type ToolConnection = NonNullable<T.Session["toolConnections"]>[number];
export type Machine = T.SpaceState["machines"][number];

export const IssueReportMemoryScopeValues = ["repo", "all"] as const;
type IssueReportMemoryScope = (typeof IssueReportMemoryScopeValues)[number];

export interface IssueReportMemory {
  text: string;
  scope: IssueReportMemoryScope;
}

export interface IssueReport {
  summary: string;
  questions: T.Question[];
  checks: CriterionCheck[];
  remember: IssueReportMemory[];
  prSubmit: boolean;
  answer?: T.IssueAnswer;
}

export const TriggerSourceValues = ["workbench", "channel", "connector", "voice", "github", "cron", "patrol"] as const;
export type TriggerSource = (typeof TriggerSourceValues)[number];

export const TriggerAddressingValues = ["direct", "mention", "thread_owner", "unaddressed"] as const;
export type TriggerAddressing = (typeof TriggerAddressingValues)[number];

export const GithubTriggerEventValues = ["ci", "review", "comment"] as const;
export type GithubTriggerEvent = (typeof GithubTriggerEventValues)[number];

export const VoiceModeValues = ["dictated", "conversation", "api"] as const;
/** "conversation": on a call. */
export type VoiceMode = (typeof VoiceModeValues)[number];

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
  readonly issue?: T.IssueId;
  readonly ingressRecipient?: string;
  readonly trigger?: T.RunTrigger;
  readonly dispatch?: boolean;
  readonly cron?: string;
  readonly repo?: string;
  readonly pr?: number;
  readonly kind?: GithubTriggerEvent;
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
  readonly actor: T.Actor;
  readonly addressed: TriggerAddressing;
  readonly threads: readonly string[];
  readonly replyTo?: string;
  readonly replyChannel?: string;
  readonly picked?: { readonly agent?: string; readonly repo?: string };
  readonly card: CompactCard;
  readonly meta: TriggerMeta;
  readonly at: number;
}
