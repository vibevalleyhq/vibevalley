import { z } from "zod";

import type { Clock } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";

import { Inconsistent } from "#/base/errors.ts";
import { jsonOf, jsonText } from "#/base/json.ts";
import { type Db, SqlError, causeMessage } from "#/infra/db.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import * as qd from "#db/session_delivery.sql.ts";
import * as qr from "#db/session_trigger.sql.ts";

import type { Deliveries, DeliveryDraft, DeliveryRow } from "./deliveries.ts";
import { channelType, type Delivery } from "./envelope.ts";
import { type Lifecycle, NotRecorded } from "./lifecycle.ts";
import type { InsertDelivery, TalkRow } from "./mailbox.ts";
import { deliveryScope, triggerPayload } from "./payload.ts";
import { deliveryDraftOf, urgencyOf } from "./routing.ts";
import * as S from "./schema.ts";
import type { Trigger } from "./shapes.ts";

interface WorkOptions {
  readonly writtenLocked: <A>(work: () => Promise<A>) => Promise<A>;
  readonly stored: (session: string, row: DeliveryRow) => void;
  readonly defaultChannel: () => Promise<string>;
  readonly open: Deliveries;
}

const readTrigger = jsonOf(S.Trigger, "mailbox.trigger_json");

export interface WorkDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly session: Lifecycle;
  readonly agent: Agent;
}

/** A write that could not be kept, as NotRecorded: what a session's start stops on and reports. */
const notRecorded = (e: unknown): unknown => (e instanceof SqlError || e instanceof z.ZodError ? new NotRecorded(causeMessage(e), { cause: e }) : e);

/** The deliveries' writes: a routed trigger's, a hire's first inputs, a direct talk's, and an input handed. */
export function makeWorkMailbox(deps: WorkDeps, options: WorkOptions) {
  const { db, clock, session: sessions, agent: agents } = deps;
  const { writtenLocked, stored, defaultChannel, open } = options;

  const writeDelivery = (input: InsertDelivery) =>
    qd.insertDelivery(db.sql, {
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
      payload_json: jsonText(input.row.payload),
      created_at: input.row.created_at,
    });
  const markRoute = async (input: InsertDelivery) => {
    const receipt = await qr.markRouted(db.sql, {
      envelope_id: input.row.payload.trigger.id,
      scope: input.row.scope,
      routed_at: input.row.created_at,
    });
    if (receipt === undefined) throw new Inconsistent(`trigger ${input.row.payload.trigger.id} was routed before it was recorded`);
    return receipt;
  };

  /** trigger written to each of inputs that its prepare lets through, with its commit, in one transaction. */
  const forward = (trigger: Trigger, inputs: readonly Delivery[]): Promise<void> =>
    writtenLocked(async () => {
      const at = clock.now();
      const entries: { input: Delivery; row: DeliveryDraft }[] = [];
      for (const input of inputs) {
        const channel = sessions.sessionOf(input.session)?.channel ?? (await defaultChannel());
        const role = input.role ?? agents.agent(input.session)?.role ?? "worker";
        entries.push({ input, row: deliveryDraftOf(trigger, input, { channel, role, at }) });
      }
      await db.tx(async () => {
        const committed: ({ input: Delivery; row: DeliveryDraft; added: qd.InsertDeliveryResult[] } | undefined)[] = [];
        for (const { input, row } of entries) {
          if (input.prepare && !(await input.prepare())) {
            committed.push(undefined);
            continue;
          }
          if (input.previous) await qd.dropReassigned(db.sql, { session_id: input.previous, envelope_id: trigger.id });
          const added = await writeDelivery({ session: input.session, row });
          await input.commit?.();
          await markRoute({ session: input.session, row });
          committed.push({ input, row, added });
        }
        await db.afterCommit(() => {
          for (const entry of committed) {
            if (!entry) continue;
            if (entry.input.previous) open.remove(entry.input.previous, trigger.id);
            for (const added of entry.added) stored(entry.input.session, { ...entry.row, position: added.position });
          }
        });
      });
    });

  const registerInitialInputs = (session: T.Session, launch: string, inputs: readonly Trigger[]): Promise<void> =>
    writtenLocked(async () => {
      const at = clock.now();
      const fallback = await defaultChannel();
      const destination = (trigger: Trigger) => trigger.replyChannel ?? session.channel ?? fallback;
      const rows: DeliveryDraft[] = inputs.map((trigger) => ({
        envelope_id: trigger.id,
        scope: deliveryScope(destination(trigger), session.issue),
        message_id: null,
        channel_id: destination(trigger),
        source: trigger.source,
        urgency: "queue",
        reason: "initial",
        wakes: true,
        held_by: null,
        state: "handed",
        launch,
        created_at: at,
        payload: triggerPayload(trigger, session.issue),
      }));
      try {
        await db.tx(async () => {
          const committed: { added: qd.InsertDeliveryResult[]; row: DeliveryDraft }[] = [];
          for (const row of rows) {
            const added = await writeDelivery({ session: session.id, row });
            await qd.markHanded(db.sql, { session_id: session.id, envelope_id: row.envelope_id, launch, handed_at: at });
            await markRoute({ session: session.id, row });
            committed.push({ added, row });
          }
          await db.afterCommit(() => {
            for (const entry of committed) for (const added of entry.added) stored(session.id, { ...entry.row, position: added.position });
          });
        });
      } catch (e) {
        throw notRecorded(e);
      }
    });

  const hand = (session: string, envelope: string, launch: string, at: number): Promise<void> =>
    writtenLocked(() =>
      db.tx(async () => {
        await qd.markHanded(db.sql, { session_id: session, envelope_id: envelope, launch, handed_at: at });
        await db.afterCommit(() => open.handed(session, envelope, launch));
      }),
    );

  const registerTalk = (session: string, launch: string, at: number, rows: readonly TalkRow[]): Promise<void> =>
    writtenLocked(async () => {
      const prepared: DeliveryDraft[] = [];
      for (const talk of rows) {
        const recorded = await qr.triggerById(db.sql, { id: talk.row.envelope_id });
        if (!recorded) throw new Inconsistent(`talk ${talk.row.envelope_id} has no recorded trigger`);
        let trigger: Trigger;
        try {
          trigger = readTrigger(recorded.trigger_json);
        } catch (e) {
          throw new NotRecorded(causeMessage(e), { cause: e });
        }
        const urgency = urgencyOf({ source: trigger.source, actor: "user", recipient: "worker", event: "conversation", canSteer: true });
        prepared.push({
          envelope_id: talk.row.envelope_id,
          scope: deliveryScope(talk.row.channel_id, talk.row.subject_kind === "issue" ? (talk.row.subject_id ?? undefined) : undefined),
          message_id: talk.row.envelope_id,
          channel_id: talk.row.channel_id,
          source: trigger.source,
          urgency,
          reason: "direct",
          wakes: true,
          held_by: null,
          state: "handed",
          launch,
          created_at: at,
          payload: {
            trigger,
            context: talk.context,
            channelType: channelType(talk.row.channel_type),
          },
        });
      }
      try {
        await db.tx(async () => {
          const committed: { added: qd.InsertDeliveryResult[]; row: DeliveryDraft }[] = [];
          for (const row of prepared) {
            const added = await writeDelivery({ session, row });
            await qd.markHanded(db.sql, { session_id: session, envelope_id: row.envelope_id, launch, handed_at: at });
            await markRoute({ session, row });
            committed.push({ row, added });
          }
          await db.afterCommit(() => {
            for (const entry of committed) for (const added of entry.added) stored(session, { ...entry.row, position: added.position });
          });
        });
      } catch (e) {
        throw notRecorded(e);
      }
    });

  const isRouted = async (trigger: string): Promise<boolean> => (await qr.isRouted(db.sql, { envelope_id: trigger }))?.routed === true;

  return {
    isRouted,
    forward,
    registerInitialInputs,
    registerTalk,
    hand,
  };
}
