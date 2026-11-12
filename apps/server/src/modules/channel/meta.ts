import { z } from "zod";

import type * as T from "@vibevalley/protocol";
import { type Wire } from "@vibevalley/protocol/schema";
import * as S from "@vibevalley/protocol/schema";

import { storedJsonOrUndefined, valueOf } from "#/base/json.ts";

/** How words said aloud came in: typed by dictation, said in a conversation, or sent through the voice API. */
const VoiceModeValues = ["dictated", "conversation", "api"] as const;
const IngressSourceValues = ["issue", "cron", "patrol", "connector", "voice", "github"] as const;

/** The profile and repo the user picked for what they said. */
export interface Picked {
  readonly agent?: string;
  readonly repo?: string;
}

/** What a message carries besides its words (channel_message.meta): what it is about, how it came in and for whom. */
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
  ingressSource?: (typeof IngressSourceValues)[number];
  ingressRecipient?: string;
  issue?: T.IssueId;
  trigger?: T.RunTrigger;
  responsePort?: string;
  voiceMode?: (typeof VoiceModeValues)[number];
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

export const channelType = (type: string): T.ChannelType => S.ChannelType.safeParse(type).data ?? "channel";

/** What an agent reads of a message besides who said what where: its reply, edits, files, artifact, quotes and how it came in. */
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
