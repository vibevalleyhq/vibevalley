import { createHash } from "node:crypto";

import { Effect, Schema } from "effect";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { compactCard } from "@/base/card.ts";
import type { Db } from "@/infra/db.ts";

import * as qr from "../../db/generated/ingress_trigger.sql.ts";

export interface TriggerInput {
  readonly source: T.TriggerSource;
  /** What makes this occurrence unique within its source: the same key is the same trigger. */
  readonly key: string;
  readonly actor: T.TriggerActor;
  readonly text: string;
  readonly threads: readonly string[];
  readonly addressed: T.TriggerAddressing;
  readonly replyChannel?: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly at: number;
  readonly data?: unknown;
}

const encodeTrigger = Schema.encodeEffect(Schema.fromJsonString(S.Trigger));

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
  };
};

/** The trigger row is written where the caller's transaction is: a crash before routing leaves it for Ingress to replay. */
export const recordTrigger = (db: Db["Service"], input: TriggerInput) =>
  Effect.gen(function* () {
    const trigger = triggerOf(input);
    yield* db.run(
      qr.recordTrigger({
        id: trigger.id,
        source: trigger.source,
        source_key: input.key,
        occurred_at: trigger.at,
        trigger_json: yield* encodeTrigger(trigger).pipe(Effect.orDie),
        payload_json: JSON.stringify({ text: input.text, data: input.data ?? null }),
      }),
    );
    return trigger;
  });
