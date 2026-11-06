import { Schema } from "effect";

import { QuotedBlock } from "../artifact/schema";
import { ChannelType } from "../channel/schema";
import type { Codec } from "../codec";
import { RunTrigger } from "../session/schema";
import * as T from "../shapes";
import { TriggerAddressingValues, TriggerKindValues, VoiceModeValues } from "./shapes";

const CardAttachmentSchema: Codec<T.CardAttachment> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  mimeType: Schema.String,
  readUri: Schema.String,
});

const ParentPreviewSchema: Codec<T.ParentPreview> = Schema.Struct({
  id: Schema.String,
  from: Schema.String,
  preview: Schema.String,
  readUri: Schema.String,
});

export const CompactCard: Codec<T.CompactCard> = Schema.Struct({
  summary: Schema.String,
  totalChars: Schema.Finite,
  truncated: Schema.Boolean,
  readUri: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(CardAttachmentSchema)),
  parentPreview: Schema.optionalKey(ParentPreviewSchema),
});

export const TriggerContext: Codec<T.TriggerContext> = Schema.Struct({
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

export const TriggerMeta: Codec<T.TriggerMeta> = Schema.Struct({
  issue: Schema.optionalKey(Schema.String),
  ingressRecipient: Schema.optionalKey(Schema.String),
  trigger: Schema.optionalKey(RunTrigger),
  dispatch: Schema.optionalKey(Schema.Boolean),
  cron: Schema.optionalKey(Schema.String),
  repo: Schema.optionalKey(Schema.String),
  pr: Schema.optionalKey(Schema.Int),
  kind: Schema.optionalKey(Schema.Literals(TriggerKindValues)),
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

export const Trigger: Codec<T.Trigger> = Schema.Struct({
  id: Schema.String,
  source: Schema.Literals(T.TriggerSourceValues),
  actor: Schema.Struct({ kind: Schema.Literals(T.TriggerActorKindValues), id: Schema.String, name: Schema.optionalKey(Schema.String) }),
  addressed: Schema.Literals(TriggerAddressingValues),
  threads: Schema.Array(Schema.String),
  replyTo: Schema.optionalKey(Schema.String),
  replyChannel: Schema.optionalKey(Schema.String),
  picked: Schema.optionalKey(Schema.Struct({ agent: Schema.optionalKey(Schema.String), repo: Schema.optionalKey(Schema.String) })),
  card: CompactCard,
  meta: TriggerMeta,
  at: Schema.Finite,
});
