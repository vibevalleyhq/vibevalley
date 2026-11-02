import type * as T from "@vibevalley/protocol";

import { compactCard } from "@/base/card.ts";
import { type ChannelRouteFact, metaOf, senderKind } from "@/base/chat.ts";
import type { ChannelMail } from "@/mailbox/mailbox.ts";
import type { InputContext } from "@/mailbox/payload.ts";

const sourceByPurpose: Record<NonNullable<ChannelRouteFact["purpose"]>, T.TriggerSource> = {
  issue: "workbench",
  cron: "cron",
  patrol: "patrol",
  connector: "connector",
  voice: "voice",
  github: "github",
};

const ingressActorKind = (raw: string): T.TriggerActorKind => {
  switch (senderKind(raw)) {
    case "owner":
      return "owner";
    case "session":
      return "session";
    case "orchestrator":
      return "orchestrator";
    case "system":
      return "system";
  }
};

/** A committed channel message as the one trigger Mailbox routes, and what it needs to fan it out. */
export const channelInput = (fact: ChannelRouteFact, context: InputContext): { readonly trigger: T.Trigger; readonly mail: ChannelMail } => {
  const meta = metaOf(fact.row.meta);
  const source = fact.purpose ? sourceByPurpose[fact.purpose] : "channel";
  const trigger: T.Trigger = {
    id: fact.row.envelope_id,
    source,
    actor: { kind: ingressActorKind(fact.row.sender_kind), id: fact.row.sender_id, name: fact.row.name },
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
    card: compactCard(fact.row.body, `vv://trigger/${fact.row.envelope_id}`, 600),
    meta: { ...meta, channelMessageId: fact.row.envelope_id, inputContext: context, channelType: fact.row.channel_type },
    at: fact.row.created_at,
  };
  return {
    trigger,
    mail: {
      row: fact.row,
      audience: fact.audience,
      ...(fact.addressed ? { addressed: { recipient: fact.addressed, reason: "addressed", wakes: true } } : {}),
      roles: fact.roles,
      kinds: fact.kinds,
      ...(fact.outcome === undefined ? {} : { outcome: fact.outcome }),
    },
  };
};
