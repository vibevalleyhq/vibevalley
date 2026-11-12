import type { Clock } from "@vibevalley/async";
import { isBusy } from "@vibevalley/protocol/rules";

import type { Logger } from "#/infra/log.ts";
import type { Session } from "#/modules/session/session.ts";
import { type Consumed, type Delivered, DeliveryRefused, type LaunchActivity, type Returned } from "#/modules/session/signals.ts";

import type { DeliveryRow } from "./deliveries.ts";

interface PumpPorts<Message> {
  readonly pending: (session: string) => readonly DeliveryRow[];
  readonly hand: (session: string, envelope: string, launch: string, at: number) => Promise<void>;
  readonly consume: (session: string, envelope: string, at: number) => Promise<void>;
  readonly returnHanded: (session: string) => Promise<readonly string[]>;
  readonly handBack: (session: string, envelope: string) => Promise<void>;
  readonly dropSession: (session: string, why: string) => Promise<void>;
  readonly breakerSpoke: (session: string) => void;
  readonly breakerFailed: (session: string) => { readonly count: number; readonly tripped: boolean };
  readonly breakerOpen: (session: string) => boolean;
  readonly readyInputs: (recipient: string, rows: readonly DeliveryRow[]) => readonly DeliveryRow[];
  readonly closed: () => boolean;
  readonly isHosted: (id: string) => boolean;
  readonly message: (row: DeliveryRow) => Message;
  readonly wakeInput: (recipient: string, rows: readonly DeliveryRow[], messages: readonly Message[]) => Promise<string>;
  readonly handToHost: (recipient: string, messages: readonly Message[], primary: DeliveryRow) => Promise<void>;
  readonly consumedMessages: (recipient: string, envelopes: readonly string[]) => Promise<void>;
  readonly breakerNotice: (recipient: string, failed: number) => Promise<void>;
  readonly later: (key: string, ms: number, effect: () => Promise<void>) => void;
  readonly noticeBatchMs: number;
  readonly retryWakeMs: number;
}

interface Pump {
  readonly kick: (recipient: string) => Promise<void>;
  readonly activity: (activity: LaunchActivity) => Promise<void>;
  readonly consumed: (input: Consumed) => Promise<void>;
  readonly returned: (input: Returned) => Promise<void>;
}

export const makePump = <Message>(deps: { readonly session: Session; readonly clock: Clock; readonly log: Logger }, ports: PumpPorts<Message>): Pump => {
  const { session: sessions, clock, log } = deps;
  const holds = new Map<string, Set<"compacting">>();
  const held = (session: string) => (holds.get(session)?.size ?? 0) > 0;
  const hold = (session: string, reason: "compacting", on: boolean) => {
    const reasons = holds.get(session) ?? new Set();
    if (on) {
      reasons.add(reason);
      holds.set(session, reasons);
    } else {
      reasons.delete(reason);
      if (reasons.size === 0) holds.delete(session);
    }
  };

  /** What came of handing rows to recipient; refused says why it was not woken. */
  const deliver = async (recipient: string, text: string, rows: readonly DeliveryRow[]): Promise<Delivered | { readonly refused: string }> => {
    const first = rows.findLast((row) => row.payload.trigger.actor.kind === "user") ?? rows.find((row) => row.wakes && row.held_by === null) ?? rows[0];
    if (!first) return { refused: "empty" };
    try {
      return await sessions.deliver(recipient, text, {
        trigger:
          first.payload.trigger.meta.trigger !== undefined
            ? { ...first.payload.trigger.meta.trigger, message: first.envelope_id }
            : { kind: "comment", message: first.envelope_id, ...(first.channel_id ? { channel: first.channel_id } : {}) },
        envelopeIds: rows.map((row) => row.envelope_id),
        byUserComment: rows.some((row) => row.payload.trigger.actor.kind === "user"),
      });
    } catch (e) {
      if (e instanceof DeliveryRefused) return { refused: e.reason };
      throw e;
    }
  };

  const kick = async (recipient: string): Promise<void> => {
    const rows = ports.readyInputs(recipient, ports.pending(recipient));
    if (held(recipient)) return;
    const waking = rows.filter((row) => row.wakes && row.held_by === null && row.state === "pending");
    if (ports.isHosted(recipient)) {
      const now = clock.now();
      for (const [scope, allowed] of Map.groupBy(waking, (row) => row.scope)) {
        const grouped = rows.filter((row) => row.scope === scope && row.state === "pending");
        const primary = allowed.findLast((row) => row.payload.trigger.actor.kind === "user") ?? allowed[0];
        if (!primary) continue;
        const messages = grouped.map(ports.message);
        for (const row of grouped) await ports.hand(recipient, row.envelope_id, `orchestrator:${row.envelope_id}`, now);
        await ports.handToHost(recipient, messages, primary);
      }
      return;
    }
    const session = sessions.sessionOf(recipient);
    if (!session) return ports.dropSession(recipient, "left");
    if (isBusy(session)) {
      if (rows.some((row) => row.state === "pending" && row.held_by === null)) ports.later(`notice:${recipient}`, ports.noticeBatchMs, () => notify(recipient));
      return;
    }
    if (waking.length === 0 || ports.breakerOpen(recipient)) return;
    const batch = rows.filter((row) => row.state === "pending");
    const messages = batch.map(ports.message);
    const input = await ports.wakeInput(recipient, batch, messages);
    const delivered = await deliver(recipient, input, batch);
    if ("refused" in delivered) {
      log.info(`mailbox: ${recipient} not woken: ${delivered.refused}`);
      return;
    }
    const now = clock.now();
    for (const row of batch) await ports.hand(recipient, row.envelope_id, delivered.launch, now);
  };

  const notify = async (recipient: string): Promise<void> => {
    if (held(recipient)) return;
    const session = sessions.sessionOf(recipient);
    if (!session) return;
    if (!isBusy(session)) return kick(recipient);
    const rows = ports.readyInputs(recipient, ports.pending(recipient)).filter((row) => row.state === "pending" && row.urgency !== "queue");
    if (!rows.some((row) => row.urgency === "steer" && row.held_by === null)) return;
    const input = await ports.wakeInput(recipient, rows, rows.map(ports.message));
    const delivered = await deliver(recipient, input, rows);
    if ("refused" in delivered) return;
    const now = clock.now();
    for (const row of rows) await ports.hand(recipient, row.envelope_id, delivered.launch, now);
  };

  const activity = async (activity: LaunchActivity): Promise<void> => {
    if (ports.closed()) return;
    switch (activity._tag) {
      case "Spoke":
        ports.breakerSpoke(activity.id);
        return;
      case "Settling":
        return;
      case "HandedOff":
      case "Ended": {
        const rolled = await ports.returnHanded(activity.id);
        if (rolled.length > 0) {
          if (!activity.spoke) {
            const { count, tripped } = ports.breakerFailed(activity.id);
            if (tripped) await ports.breakerNotice(activity.id, count);
          }
          ports.later(`wake:${activity.id}`, ports.retryWakeMs, () => kick(activity.id));
          return;
        }
        return kick(activity.id);
      }
      case "Closed":
        await ports.returnHanded(activity.id);
        return;
      case "Compacting":
        hold(activity.id, "compacting", activity.on);
        if (!activity.on && !held(activity.id)) await kick(activity.id);
        return;
    }
  };

  return {
    kick,
    activity,
    consumed: async (input) => {
      const now = clock.now();
      const accepted = new Set(input.envelopeIds);
      const messages = ports.pending(input.session).flatMap((row) => (accepted.has(row.envelope_id) && row.message_id !== null ? [row.message_id] : []));
      for (const id of input.envelopeIds) await ports.consume(input.session, id, now);
      await ports.consumedMessages(input.session, messages);
    },
    returned: async (input) => {
      for (const id of input.envelopeIds) await ports.handBack(input.session, id);
    },
  };
};
