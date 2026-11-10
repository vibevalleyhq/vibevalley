import { Effect } from "effect";

import { jsonText } from "#/base/json.ts";
import { Db } from "#/infra/db.ts";
import type { InsertDelivery } from "#/mailbox/mailbox.ts";
import * as qd from "#db/mailbox_delivery.sql.ts";
import * as qr from "#db/mailbox_trigger.sql.ts";

/** A delivery written and routed as Mailbox commits one, and nothing after: what a stop between commit and hand-off
 * leaves for Mailbox.restore. An existing row stays as it is. */
export const committedDelivery = (input: InsertDelivery) =>
  Effect.gen(function* () {
    const db = yield* Db;
    const payloadJson = yield* jsonText(input.row.payload);
    const written = db.run(
      qd.insertDelivery({
        session_id: input.session,
        envelope_id: input.row.envelope_id,
        scope: input.row.scope,
        channel_id: input.row.channel_id || null,
        message_id: input.row.message_id,
        source: input.row.source,
        urgency: input.row.urgency,
        reason: input.row.reason,
        wakes: input.row.wakes,
        held_by: input.row.held_by,
        payload_json: payloadJson,
        created_at: input.row.created_at,
      }),
    );
    const routed = db.run(qr.markRouted({ envelope_id: input.row.payload.trigger.id, scope: input.row.scope, routed_at: input.row.created_at }));
    yield* db.inTx(Effect.all([written, routed], { discard: true }));
  });
