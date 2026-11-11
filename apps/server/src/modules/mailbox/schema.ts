import { Schema } from "effect";

import { Actor, ChannelType, IssueId, QuotedBlock, RunTrigger, type Wire } from "@vibevalley/protocol/schema";

import type * as T from "./shapes.ts";
import { GithubTriggerEventValues, TriggerAddressingValues, TriggerSourceValues, VoiceModeValues } from "./shapes.ts";

const CardAttachmentSchema: Schema.Codec<T.CardAttachment, Wire<T.CardAttachment>> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  readUri: Schema.String,
});

const ParentPreviewSchema: Schema.Codec<T.ParentPreview, Wire<T.ParentPreview>> = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  preview: Schema.String,
  readUri: Schema.String,
});

export const CompactCard: Schema.Codec<T.CompactCard, Wire<T.CompactCard>> = Schema.Struct({
  summary: Schema.String,
  totalChars: Schema.Finite,
  truncated: Schema.Boolean,
  readUri: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(CardAttachmentSchema)),
  parentPreview: Schema.optionalKey(ParentPreviewSchema),
});

export const TriggerContext: Schema.Codec<T.TriggerContext, Wire<T.TriggerContext>> = Schema.Struct({
  number: Schema.Int,
  target: Schema.String,
  replyTo: Schema.optionalKey(Schema.Int),
  edited: Schema.optionalKey(Schema.Boolean),
  deleted: Schema.optionalKey(Schema.Boolean),
  attachments: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String }))),
  artifact: Schema.optionalKey(Schema.Struct({ id: Schema.String, title: Schema.String, version: Schema.Int })),
  blocks: Schema.optionalKey(Schema.Array(QuotedBlock)),
  picked: Schema.optionalKey(Schema.Struct({ agent: Schema.optionalKey(Schema.String), repo: Schema.optionalKey(Schema.String) })),
  responsePort: Schema.optionalKey(Schema.String),
  voiceMode: Schema.optionalKey(Schema.Literals(VoiceModeValues)),
});

export const TriggerMeta: Schema.Codec<T.TriggerMeta, Wire<T.TriggerMeta>> = Schema.Struct({
  issue: Schema.optionalKey(IssueId),
  ingressRecipient: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(RunTrigger),
  dispatch: Schema.optionalKey(Schema.Boolean),
  cron: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  pr: Schema.optionalKey(Schema.Int),
  kind: Schema.optionalKey(Schema.Literals(GithubTriggerEventValues)),
  head: Schema.optionalKey(Schema.String),
  fingerprint: Schema.optionalKey(Schema.String),
  failed: Schema.optionalKey(Schema.Boolean),
  botRound: Schema.optionalKey(Schema.Int),
  botRoundKey: Schema.optionalKey(Schema.String),
  channelMessageId: Schema.optionalKey(Schema.String),
  inputContext: Schema.optionalKey(TriggerContext),
  channelType: Schema.optionalKey(ChannelType),
  responsePort: Schema.optionalKey(Schema.String),
  voiceMode: Schema.optionalKey(Schema.Literals(VoiceModeValues)),
});

export const Trigger: Schema.Codec<T.Trigger, Wire<T.Trigger>> = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(TriggerSourceValues),
  actor: Actor,
  addressed: Schema.Literals(TriggerAddressingValues),
  threads: Schema.Array(Schema.String),
  replyTo: Schema.optionalKey(Schema.String),
  replyChannel: Schema.optionalKey(Schema.String),
  picked: Schema.optionalKey(Schema.Struct({ agent: Schema.optionalKey(Schema.String), repo: Schema.optionalKey(Schema.String) })),
  card: CompactCard,
  meta: TriggerMeta,
  at: Schema.Finite,
});
