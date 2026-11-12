import { z } from "zod";

import { BizCode, Inconsistent, refuseIn } from "#/base/errors.ts";
import { jsonOf, jsonText } from "#/base/json.ts";
import { causeMessage, type Db, SqlError } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import * as q from "#db/mailbox_trigger.sql.ts";

import { type KnownGitHubEvent, type TriggerInput, type TriggerResource, triggerOf } from "./payload.ts";
import * as S from "./schema.ts";
import type { Trigger } from "./shapes.ts";

const refused = refuseIn(BizCode.ChannelRefused);

const Payload = z.object({ text: z.string(), data: z.unknown() });
const decodeTrigger = jsonOf(S.Trigger);
const decodePayload = jsonOf(Payload);

export interface TriggerJournal {
  readonly readTrigger: (id: string) => Promise<TriggerResource | undefined>;
  readonly recordTrigger: (input: TriggerInput) => Promise<Trigger>;
  readonly knownGitHubEvents: (repo: string, pr: number) => Promise<readonly KnownGitHubEvent[]>;
  readonly replayCronTriggers: (consume: (trigger: Trigger, data: unknown) => Promise<void>) => Promise<void>;
}

export function triggerJournal(deps: { readonly db: Db; readonly log: Logger }): TriggerJournal {
  const { db, log } = deps;
  const readTrigger = async (id: string) => {
    const row = await q.triggerById(db.sql, { id });
    return row ? { trigger: decodeTrigger(row.trigger_json), payload: decodePayload(row.payload_json) } : undefined;
  };

  // No routing or background task here: the source cursor and this record must share the caller's transaction.
  const keep = async (trigger: Trigger, key: string, payload: TriggerResource["payload"]): Promise<Trigger> => {
    try {
      await q.recordTrigger(db.sql, {
        id: trigger.id,
        source: trigger.source,
        source_key: key,
        occurred_at: trigger.at,
        trigger_json: jsonText(S.Trigger.parse(trigger)),
        payload_json: jsonText(payload),
      });
      const saved = await q.triggerById(db.sql, { id: trigger.id });
      if (saved === undefined) throw new Inconsistent(`trigger ${trigger.id} was not kept`);
      return decodeTrigger(saved.trigger_json);
    } catch (e) {
      // What the caller is told: the database's failure, or a trigger that does not fit its shape.
      if (e instanceof SqlError || e instanceof z.ZodError || e instanceof SyntaxError) throw refused(causeMessage(e));
      throw e;
    }
  };

  return {
    readTrigger,
    recordTrigger: (input) => keep(triggerOf(input), input.key, { text: input.text, data: input.data ?? null }),
    knownGitHubEvents: async (repo, pr) => {
      const rows = await q.knownGitHubEvents(db.sql, { repo, pr_number: pr });
      return rows.map((row) => ({
        key: row.source_key,
        routed: row.routed,
        ...(row.bot_round_key === null ? {} : { botRoundKey: row.bot_round_key }),
        ...(row.bot_round === null ? {} : { botRound: row.bot_round }),
      }));
    },
    replayCronTriggers: async (consume) => {
      let after = 0;
      while (true) {
        const rows = await q.unroutedCronTriggers(db.sql, { after });
        const last = rows.at(-1);
        if (!last) return;
        for (const row of rows)
          await bestEffort(log, `mailbox: replay cron ${row.id}`, async () => {
            const trigger = decodeTrigger(row.trigger_json);
            const payload = decodePayload(row.payload_json);
            await consume(trigger, payload.data);
          });
        after = last.seq;
      }
    },
  };
}
