import { Deferred, Effect, Schema, Stream } from "effect";

import type { TriggerActorKind, TriggerSource } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { compactCard } from "@/base/card.ts";
import { Channel } from "@/channel/chat.ts";
import { type ChannelRouteFact, metaOf, senderKind } from "@/channel/contracts.ts";
import { Db } from "@/infra/db.ts";
import { Mailbox, type HearChannel } from "@/mailbox/mailbox.ts";
import { inputContext, type InputContext } from "@/mailbox/payload.ts";

import * as q from "../../db/generated/ingress_trigger.sql.ts";

const sourceByPurpose: Record<NonNullable<ChannelRouteFact["purpose"]>, TriggerSource> = {
  issue: "workbench",
  cron: "cron",
  patrol: "patrol",
  connector: "connector",
  voice: "voice",
  github: "github",
};

const ingressActorKind = (raw: string): TriggerActorKind => {
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

const channelInput = (fact: ChannelRouteFact, context: InputContext): HearChannel => {
  const meta = metaOf(fact.row.meta);
  const source = fact.purpose ? sourceByPurpose[fact.purpose] : "channel";
  return {
    envelope: {
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
    },
    row: fact.row,
    audience: fact.audience,
    ...(fact.addressed ? { addressed: { recipient: fact.addressed, reason: "addressed", wakes: true } } : {}),
    roles: fact.roles,
    kinds: fact.kinds,
    ...(fact.outcome === undefined ? {} : { outcome: fact.outcome }),
  };
};

export const channelInputs = Effect.gen(function* () {
  const chat = yield* Channel;
  const mailbox = yield* Mailbox;
  const db = yield* Db;
  const encode = Schema.encodeEffect(Schema.fromJsonString(S.Trigger));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(S.Trigger));
  yield* Effect.forkScoped(
    Stream.runForEach(yield* chat.routing, (call) =>
      Effect.gen(function* () {
        const fact = call.fact;
        const input = channelInput(fact, inputContext(chat.deliveryMessage(fact.row)));
        yield* db.run(
          q.recordTrigger({
            id: input.envelope.id,
            source: input.envelope.source,
            source_key: fact.row.envelope_id,
            occurred_at: input.envelope.at,
            trigger_json: yield* encode(input.envelope),
            payload_json: JSON.stringify({
              text: fact.row.body,
              data: { kind: "channel_message", message: fact.row.envelope_id, channel: fact.row.channel_id },
            }),
          }),
        );
        const stored = yield* db.one(q.triggerById({ id: input.envelope.id }));
        if (!stored) return yield* Effect.die(new Error("Recorded channel trigger is missing"));
        const result = yield* mailbox.routeChannel({ ...input, envelope: yield* decode(stored.trigger_json) });
        yield* Deferred.succeed(call.reply, result);
      }).pipe(Effect.orDie),
    ),
  );
});
