import { createHash } from "node:crypto";

import { Effect, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { compactCard } from "#/base/clip.ts";
import { refused } from "#/base/errors.ts";
import { type Db, causeMessage } from "#/infra/db.ts";
import { senderKind } from "#/mailbox/envelope.ts";
import type { InboxMessage, OrchestratorNews } from "#/mailbox/envelope.ts";
import * as qr from "#db/mailbox_trigger.sql.ts";

export type InputContext = T.TriggerContext;
export interface DeliveryPayload {
  readonly note?: string;
  readonly trigger: T.Trigger;
  readonly context: InputContext;
  readonly channelType: T.ChannelType;
}

const Payload: Schema.Codec<DeliveryPayload, S.Wire<DeliveryPayload>> = Schema.Struct({
  note: Schema.optionalKey(Schema.String),
  trigger: S.Trigger,
  context: S.TriggerContext,
  channelType: S.ChannelType,
});
export const readPayload = Schema.decodeUnknownSync(Schema.fromJsonString(Payload));

export interface TriggerInput {
  readonly source: T.TriggerSource;
  /** What makes this occurrence unique within its source: the same key is the same trigger. */
  readonly key: string;
  readonly actor: T.TriggerActor;
  readonly text: string;
  readonly threads: readonly string[];
  readonly addressed: T.TriggerAddressing;
  readonly replyChannel?: string;
  readonly replyTo?: string;
  readonly picked?: T.Trigger["picked"];
  readonly meta?: T.TriggerMeta;
  readonly at: number;
  readonly data?: unknown;
}

export const triggerOf = (input: TriggerInput): T.Trigger => {
  const id = createHash("sha256")
    .update(JSON.stringify([input.source, input.key]))
    .digest("hex");
  return {
    id,
    source: input.source,
    actor: input.actor,
    addressed: input.addressed,
    threads: [...new Set(input.threads)],
    card: compactCard(input.text, `vv://trigger/${id}`, 600),
    meta: input.meta ?? {},
    at: input.at,
    ...(input.replyChannel === undefined ? {} : { replyChannel: input.replyChannel }),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    ...(input.picked === undefined ? {} : { picked: input.picked }),
  };
};

/** A source's trigger as Ingress encoded it, kept once by (source, key): an event read again is the trigger it was. */
export const keepSourceTrigger = (db: Db["Service"], row: qr.RecordTriggerParams) => db.run(qr.recordTrigger(row));

/** A kept trigger's words and payload, as they were written. */
export const keptTrigger = (db: Db["Service"], id: string) => db.one(qr.triggerById({ id }));

/** The events already kept for one pull request: their keys, whether routed, and the bot's review rounds. */
export const knownGitHubEvents = (db: Db["Service"], project: string, pr: number) => db.run(qr.knownGitHubEvents({ project, pr_number: pr }));

/** The caller's transaction includes this row, so it can advance its source cursor atomically. */
export const recordTrigger = (db: Db["Service"], input: TriggerInput) =>
  Effect.gen(function* () {
    const trigger = triggerOf(input);
    yield* db
      .attempt(
        qr.recordTrigger({
          id: trigger.id,
          source: trigger.source,
          source_key: input.key,
          occurred_at: trigger.at,
          trigger_json: JSON.stringify(trigger),
          payload_json: JSON.stringify({ text: input.text, data: input.data ?? null }),
        }),
      )
      .pipe(Effect.mapError((cause) => refused(causeMessage(cause))));
    return trigger;
  });

export const keepChannelTrigger = (db: Db["Service"], trigger: T.Trigger, body: string, channelId: string) =>
  Effect.gen(function* () {
    yield* db.run(
      qr.recordTrigger({
        id: trigger.id,
        source: trigger.source,
        source_key: trigger.id,
        occurred_at: trigger.at,
        trigger_json: JSON.stringify(trigger),
        payload_json: JSON.stringify({
          text: body,
          data: { kind: "channel_message", message: trigger.id, channel: channelId },
        }),
      }),
    );
    const saved = yield* db.one(qr.triggerById({ id: trigger.id }));
    return saved ? yield* Schema.decodeEffect(Schema.fromJsonString(S.Trigger))(saved.trigger_json) : trigger;
  });

export const unroutedCronTriggers = (db: Db["Service"], after: number) => db.run(qr.unroutedCronTriggers({ after }));

export const deliveryScope = (channel: string, issue?: string) => (issue ? `issue:${issue}` : `channel:${channel}`);

export function triggerPayload(trigger: T.Trigger, issue?: string, note?: string): DeliveryPayload {
  const { issue: _sourceIssue, inputContext, channelType, ...sourceMeta } = trigger.meta;
  const meta = trigger.meta;
  return {
    ...(note ? { note } : {}),
    trigger: {
      ...trigger,
      meta: {
        ...sourceMeta,
        ...(issue ? { issue } : {}),
      },
    },
    context: inputContext ?? {
      number: 0,
      target: trigger.card.readUri,
      ...(trigger.picked ? { picked: trigger.picked } : {}),
      ...(meta.responsePort ? { responsePort: meta.responsePort } : {}),
      ...(meta.voiceMode ? { voiceMode: meta.voiceMode } : {}),
    },
    channelType: channelType ?? "channel",
  };
}

export function inputOf({ envelope_id, payload }: { readonly envelope_id: string; readonly payload: DeliveryPayload }): InboxMessage {
  const { trigger, context } = payload;
  return {
    ...context,
    id: envelope_id,
    originTrigger: trigger.id,
    from: trigger.actor.id,
    fromKind: senderKind(trigger.actor.kind),
    name: trigger.actor.name ?? trigger.actor.id,
    text: [payload.note, trigger.card.truncated || context.number === 0 ? `${trigger.card.summary}\n${trigger.card.readUri}` : trigger.card.summary]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function inputContext({
  id: _id,
  from: _from,
  fromKind: _kind,
  name: _name,
  text: _text,
  originTrigger: _origin,
  ...context
}: InboxMessage): InputContext {
  return context;
}

export const orchestratorSource = (source: T.TriggerSource): OrchestratorNews["source"] => {
  switch (source) {
    case "cron":
    case "patrol":
      return source;
    case "workbench":
      return "issue";
    case "channel":
    case "connector":
    case "voice":
    case "github":
      return undefined;
  }
};
