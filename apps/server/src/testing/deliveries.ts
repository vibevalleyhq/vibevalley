import { jsonText } from "#/base/json.ts";
import type { Db } from "#/infra/db.ts";
import type { InsertDelivery } from "#/modules/session/mailbox.ts";
import * as qd from "#db/session_delivery.sql.ts";
import * as qr from "#db/session_trigger.sql.ts";

/** A delivery written and routed as the session module commits one, and nothing after: what a stop between commit and hand-off
 * leaves for Mailbox.restore. An existing row stays as it is. */
export async function committedDelivery(db: Db, input: InsertDelivery): Promise<void> {
  const payloadJson = jsonText(input.row.payload);
  await db.tx(async () => {
    await qd.insertDelivery(db.sql, {
      session_id: input.session,
      envelope_id: input.row.envelope_id,
      trigger_id: input.row.payload.trigger.id || null,
      actor_kind: input.row.payload.trigger.actor.kind,
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
    });
    await qr.markRouted(db.sql, { envelope_id: input.row.payload.trigger.id, scope: input.row.scope, routed_at: input.row.created_at });
  });
}

export const allOpenDeliveries = (db: Db) => qd.allOpenDeliveries(db.sql);
