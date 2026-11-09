import { createHash } from "node:crypto";

import { Formatter, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { compactCard } from "#/base/clip.ts";
import { senderKind } from "#/mailbox/envelope.ts";
import type { InboxMessage, OrchestratorNews } from "#/mailbox/envelope.ts";

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
  readonly meta?: Omit<T.TriggerMeta, "issue"> & { readonly issue?: string };
  readonly at: number;
  readonly data?: unknown;
}

export const triggerOf = (input: TriggerInput): T.Trigger => {
  const id = createHash("sha256")
    .update(Formatter.formatJson([input.source, input.key]))
    .digest("hex");
  const { issue, ...restMeta } = input.meta ?? {};
  return {
    id,
    source: input.source,
    actor: input.actor,
    addressed: input.addressed,
    threads: [...new Set(input.threads)],
    card: compactCard(input.text, `vv://trigger/${id}`, 600),
    meta: { ...restMeta, ...(issue !== undefined ? { issue: S.issueId(issue) } : {}) },
    at: input.at,
    ...(input.replyChannel === undefined ? {} : { replyChannel: input.replyChannel }),
    ...(input.replyTo === undefined ? {} : { replyTo: input.replyTo }),
    ...(input.picked === undefined ? {} : { picked: input.picked }),
  };
};

export interface TriggerResource {
  readonly trigger: T.Trigger;
  readonly payload: { readonly text: string; readonly data: unknown };
}

export interface KnownGitHubEvent {
  readonly key: string;
  readonly routed: boolean;
  readonly botRoundKey?: string;
  readonly botRound?: number;
}

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
        ...(issue ? { issue: S.issueId(issue) } : {}),
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
