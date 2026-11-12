import { actorOfParticipant, type ChannelHearers, type Meta, metaOf, channelType } from "#/modules/session/envelope.ts";
import type { InputContext, TriggerInput } from "#/modules/session/payload.ts";
import type { TriggerSource } from "#/modules/session/shapes.ts";

const sourceByPurpose: Record<NonNullable<Meta["ingressSource"]>, TriggerSource> = {
  issue: "workbench",
  cron: "cron",
  patrol: "patrol",
  connector: "connector",
  voice: "voice",
  github: "github",
};

/** The trigger a channel message is recorded as: its own id, its words, where it was said and who it is for. */
export const channelTrigger = (fact: ChannelHearers, context: InputContext): TriggerInput => {
  const meta = metaOf(fact.row.meta);
  const source = meta.ingressSource ? sourceByPurpose[meta.ingressSource] : "channel";
  const input: TriggerInput = {
    id: fact.row.envelope_id,
    key: fact.row.envelope_id,
    source,
    actor: actorOfParticipant(fact.row.sender_kind, fact.row.sender_role, fact.row.sender_id, fact.row.name),
    addressed: fact.addressed
      ? "direct"
      : fact.audience.mentions.length > 0
        ? "mention"
        : fact.row.channel_type === "thread" && fact.audience.threadOwner
          ? "thread_owner"
          : "unaddressed",
    threads: [`channel:${fact.row.channel_id}`, ...(fact.row.subject_kind === "issue" && fact.row.subject_id ? [`issue:${fact.row.subject_id}`] : [])],
    ...(fact.row.reply_number === null ? {} : { replyTo: `${fact.row.channel_id}:${fact.row.reply_number}` }),
    replyChannel: fact.row.channel_id,
    text: fact.row.body,
    meta: {
      ...(meta.issue ? { issue: meta.issue } : {}),
      ...(meta.ingressRecipient ? { ingressRecipient: meta.ingressRecipient } : {}),
      ...(meta.trigger ? { trigger: meta.trigger } : {}),
      channelMessageId: fact.row.envelope_id,
      inputContext: context,
      channelType: channelType(fact.row.channel_type),
    },
    at: fact.row.created_at,
    data: { kind: "channel_message", message: fact.row.envelope_id, channel: fact.row.channel_id },
  };
  return input;
};
