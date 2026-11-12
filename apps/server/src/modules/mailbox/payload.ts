import { createHash } from "node:crypto";

import { z } from "zod";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { compactCard } from "#/base/clip.ts";
import { jsonOf } from "#/base/json.ts";

import type { Envelope, Handed } from "./envelope.ts";
import * as MS from "./schema.ts";
import type { Trigger, TriggerAddressing, TriggerContext, TriggerMeta, TriggerSource } from "./shapes.ts";

export type InputContext = TriggerContext;
export interface DeliveryPayload {
  readonly note?: string;
  readonly trigger: Trigger;
  readonly context: InputContext;
  readonly channelType: T.ChannelType;
}

const Payload = z.object({
  note: z.exactOptional(z.string()),
  trigger: MS.Trigger,
  context: MS.TriggerContext,
  channelType: S.ChannelType,
}) satisfies z.ZodType<DeliveryPayload, S.Wire<DeliveryPayload>>;
export const readPayload = jsonOf(Payload, "mailbox_delivery.payload_json");

export interface TriggerInput {
  /** A channel message's own id, so its trigger and its deliveries share it; otherwise made from source and key. */
  readonly id?: string;
  readonly source: TriggerSource;
  /** What makes this occurrence unique within its source: the same key is the same trigger. */
  readonly key: string;
  readonly actor: T.Actor;
  readonly text: string;
  readonly threads: readonly string[];
  readonly addressed: TriggerAddressing;
  readonly replyChannel?: string;
  readonly replyTo?: string;
  readonly picked?: Trigger["picked"];
  readonly meta?: Omit<TriggerMeta, "issue"> & { readonly issue?: string };
  readonly at: number;
  readonly data?: unknown;
}

export interface SourceEvent extends TriggerInput {
  readonly selfEcho?: boolean;
}

export const triggerOf = (input: TriggerInput): Trigger => {
  const id =
    input.id ??
    createHash("sha256")
      .update(JSON.stringify([input.source, input.key]))
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
  readonly trigger: Trigger;
  readonly payload: { readonly text: string; readonly data: unknown };
}

export interface KnownGitHubEvent {
  readonly key: string;
  readonly routed: boolean;
  readonly botRoundKey?: string;
  readonly botRound?: number;
}

export const deliveryScope = (channel: string, issue?: string) => (issue ? `issue:${issue}` : `channel:${channel}`);

export function triggerPayload(trigger: Trigger, issue?: string, note?: string): DeliveryPayload {
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

export function inputOf({ envelope_id, payload }: { readonly envelope_id: string; readonly payload: DeliveryPayload }): Envelope {
  const { trigger, context } = payload;
  return {
    ...context,
    id: envelope_id,
    originTrigger: trigger.id,
    from: trigger.actor.id,
    actor: trigger.actor,
    name: trigger.actor.name ?? trigger.actor.id,
    text: [payload.note, trigger.card.truncated || context.number === 0 ? `${trigger.card.summary}\n${trigger.card.readUri}` : trigger.card.summary]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export function inputContext({ id: _id, from: _from, actor: _actor, name: _name, text: _text, originTrigger: _origin, ...context }: Envelope): InputContext {
  return context;
}

export const orchestratorSource = (source: TriggerSource): Handed["source"] => {
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
