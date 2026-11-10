import { Effect, Schema } from "effect";

import { type ApiError, refused } from "#/base/errors.ts";
import { causeMessage, Db } from "#/infra/db.ts";
import { bestEffort } from "#/infra/log.ts";
import * as q from "#db/mailbox_trigger.sql.ts";

import { type KnownGitHubEvent, type TriggerInput, type TriggerResource, triggerOf } from "./payload.ts";
import * as S from "./schema.ts";
import type { Trigger } from "./shapes.ts";

const Payload = Schema.Struct({ text: Schema.String, data: Schema.Unknown });
const encodeTrigger = Schema.encodeEffect(Schema.fromJsonString(S.Trigger));
const decodeTrigger = Schema.decodeEffect(Schema.fromJsonString(S.Trigger));
const encodePayload = Schema.encodeEffect(Schema.fromJsonString(Payload));
const decodePayload = Schema.decodeEffect(Schema.fromJsonString(Payload));

export const triggerJournal = Effect.gen(function* () {
  const db = yield* Db;
  const readTrigger = Effect.fn("Mailbox.readTrigger")(function* (id: string) {
    const row = yield* db.one(q.triggerById({ id }));
    return row ? { trigger: yield* decodeTrigger(row.trigger_json), payload: yield* decodePayload(row.payload_json) } : undefined;
  });

  // No routing or new fiber here: the source cursor and this record must share the caller's transaction.
  const keep = Effect.fnUntraced(
    function* (trigger: Trigger, key: string, payload: TriggerResource["payload"]) {
      yield* db.attempt(
        q.recordTrigger({
          id: trigger.id,
          source: trigger.source,
          source_key: key,
          occurred_at: trigger.at,
          trigger_json: yield* encodeTrigger(trigger),
          payload_json: yield* encodePayload(payload),
        }),
      );
      const saved = yield* db.attempt(q.triggerById({ id: trigger.id }));
      return yield* decodeTrigger(saved.trigger_json);
    },
    Effect.mapError((cause) => cause.pipe(causeMessage, refused)),
  );

  return {
    readTrigger,
    recordTrigger: Effect.fn("Mailbox.recordTrigger")((input: TriggerInput) =>
      keep(triggerOf(input), input.key, { text: input.text, data: input.data ?? null }),
    ),
    knownGitHubEvents: Effect.fn("Mailbox.knownGitHubEvents")(function* (repo: string, pr: number): Effect.fn.Return<readonly KnownGitHubEvent[]> {
      const rows = yield* db.run(q.knownGitHubEvents({ repo, pr_number: pr }));
      return rows.map((row) => ({
        key: row.source_key,
        routed: row.routed,
        ...(row.bot_round_key === null ? {} : { botRoundKey: row.bot_round_key }),
        ...(row.bot_round === null ? {} : { botRound: row.bot_round }),
      }));
    }),
    replayCronTriggers: Effect.fn("Mailbox.replayCronTriggers")(function* (
      consume: (trigger: Trigger, data: unknown) => Effect.Effect<void, ApiError | Schema.SchemaError>,
    ) {
      let after = 0;
      while (true) {
        const rows = yield* db.run(q.unroutedCronTriggers({ after }));
        const last = rows.at(-1);
        if (!last) return;
        yield* Effect.forEach(
          rows,
          (row) =>
            Effect.gen(function* () {
              const trigger = yield* decodeTrigger(row.trigger_json);
              const payload = yield* decodePayload(row.payload_json);
              yield* consume(trigger, payload.data);
            }).pipe(bestEffort(`mailbox: replay cron ${row.id}`)),
          { discard: true },
        );
        after = last.seq;
      }
    }),
  };
});
