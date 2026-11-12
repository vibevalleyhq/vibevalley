import { z } from "zod";

import { Actor, ChannelType, IssueId, QuotedBlock, RunTrigger, type Wire } from "@vibevalley/protocol/schema";

import type * as T from "./shapes.ts";
import { GithubTriggerEventValues, TriggerAddressingValues, TriggerSourceValues, VoiceModeValues } from "./shapes.ts";

type Codec<A> = z.ZodType<A, Wire<A>>;

const CardAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  readUri: z.string(),
}) satisfies Codec<T.CardAttachment>;

const ParentPreviewSchema = z.object({
  id: z.string(),
  from: z.string(),
  preview: z.string(),
  readUri: z.string(),
}) satisfies Codec<T.ParentPreview>;

const CompactCard = z.object({
  summary: z.string(),
  totalChars: z.number(),
  truncated: z.boolean(),
  readUri: z.string(),
  attachments: z.exactOptional(z.array(CardAttachmentSchema)),
  parentPreview: z.exactOptional(ParentPreviewSchema),
}) satisfies Codec<T.CompactCard>;

const Picked = z.object({ agent: z.exactOptional(z.string()), repo: z.exactOptional(z.string()) });

export const TriggerContext = z.object({
  number: z.number().int(),
  target: z.string(),
  replyTo: z.exactOptional(z.number().int()),
  edited: z.exactOptional(z.boolean()),
  deleted: z.exactOptional(z.boolean()),
  attachments: z.exactOptional(z.array(z.object({ name: z.string(), path: z.string() }))),
  artifact: z.exactOptional(z.object({ id: z.string(), title: z.string(), version: z.number().int() })),
  blocks: z.exactOptional(z.array(QuotedBlock)),
  picked: z.exactOptional(Picked),
  responsePort: z.exactOptional(z.string()),
  voiceMode: z.exactOptional(z.enum(VoiceModeValues)),
}) satisfies Codec<T.TriggerContext>;

const TriggerMeta = z.object({
  issue: z.exactOptional(IssueId),
  ingressRecipient: z.exactOptional(z.string()),
  trigger: z.exactOptional(RunTrigger),
  dispatch: z.exactOptional(z.boolean()),
  cron: z.exactOptional(z.string()),
  repo: z.exactOptional(z.string()),
  pr: z.exactOptional(z.number().int()),
  kind: z.exactOptional(z.enum(GithubTriggerEventValues)),
  head: z.exactOptional(z.string()),
  fingerprint: z.exactOptional(z.string()),
  failed: z.exactOptional(z.boolean()),
  botRound: z.exactOptional(z.number().int()),
  botRoundKey: z.exactOptional(z.string()),
  channelMessageId: z.exactOptional(z.string()),
  inputContext: z.exactOptional(TriggerContext),
  channelType: z.exactOptional(ChannelType),
  responsePort: z.exactOptional(z.string()),
  voiceMode: z.exactOptional(z.enum(VoiceModeValues)),
}) satisfies Codec<T.TriggerMeta>;

export const Trigger = z.object({
  id: z.string(),
  source: z.enum(TriggerSourceValues),
  actor: Actor,
  addressed: z.enum(TriggerAddressingValues),
  threads: z.array(z.string()),
  replyTo: z.exactOptional(z.string()),
  replyChannel: z.exactOptional(z.string()),
  picked: z.exactOptional(Picked),
  card: CompactCard,
  meta: TriggerMeta,
  at: z.number(),
}) satisfies Codec<T.Trigger>;
