import { Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { metaOf, senderKind } from "@/channel/contracts.ts";
import type { InboxMessage } from "@/channel/wake.ts";

export type InputContext = Omit<InboxMessage, "id" | "from" | "fromKind" | "name" | "text" | "originTrigger">;
export interface DeliveryPayload {
  readonly note?: string;
  readonly trigger: T.Trigger;
  readonly context: InputContext;
  readonly channelType: T.ChannelType;
}

const InputContextSchema: Schema.Codec<InputContext, S.Wire<InputContext>> = Schema.Struct({
  number: Schema.Int,
  target: Schema.String,
  replyTo: Schema.optionalKey(Schema.Int),
  edited: Schema.optionalKey(Schema.Boolean),
  deleted: Schema.optionalKey(Schema.Boolean),
  attachments: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.String, path: Schema.String }))),
  artifact: Schema.optionalKey(Schema.Struct({ id: Schema.String, title: Schema.String, version: Schema.Int })),
  blocks: Schema.optionalKey(Schema.Array(S.QuotedBlock)),
  picked: Schema.optionalKey(Schema.Struct({ agent: Schema.optionalKey(Schema.String), project: Schema.optionalKey(Schema.String) })),
  responsePort: Schema.optionalKey(Schema.String),
  voiceMode: Schema.optionalKey(Schema.Literals(["dictated", "conversation", "api"])),
});
const Payload: Schema.Codec<DeliveryPayload, S.Wire<DeliveryPayload>> = Schema.Struct({
  note: Schema.optionalKey(Schema.String),
  trigger: S.Trigger,
  context: InputContextSchema,
  channelType: S.ChannelType,
});
export const readPayload = Schema.decodeUnknownSync(Schema.fromJsonString(Payload));

export const deliveryScope = (channel: string, issue?: string) => (issue ? `issue:${issue}` : `channel:${channel}`);

export function triggerPayload(trigger: T.Trigger, issue?: string, note?: string): DeliveryPayload {
  const { issue: _sourceIssue, ingressSource: _sourcePurpose, ...sourceMeta } = trigger.meta;
  const meta = metaOf(JSON.stringify(trigger.meta));
  return {
    ...(note ? { note } : {}),
    trigger: {
      ...trigger,
      meta: {
        ...sourceMeta,
        ...(trigger.source === "channel" ? {} : { ingressSource: trigger.source === "workbench" ? "issue" : trigger.source }),
        ...(issue ? { issue } : {}),
      },
    },
    context:
      trigger.meta.inputContext !== undefined
        ? Schema.decodeUnknownSync(InputContextSchema)(trigger.meta.inputContext)
        : {
            number: 0,
            target: trigger.card.readUri,
            ...(trigger.picked ? { picked: trigger.picked } : {}),
            ...(meta.responsePort ? { responsePort: meta.responsePort } : {}),
            ...(meta.voiceMode ? { voiceMode: meta.voiceMode } : {}),
          },
    channelType: trigger.meta.channelType !== undefined ? Schema.decodeUnknownSync(S.ChannelType)(trigger.meta.channelType) : "channel",
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
