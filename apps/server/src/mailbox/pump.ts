import { Clock, Effect } from "effect";

import { isBusy } from "@vibevalley/protocol/rules";

import type { Session } from "#/session/session.ts";
import type { Delivered, Consumed, Returned, LaunchActivity } from "#/session/signals.ts";

import type { DeliveryRow } from "./deliveries.ts";

interface PumpPorts<Message> {
  readonly pending: (session: string) => readonly DeliveryRow[];
  readonly hand: (session: string, envelope: string, launch: string, at: number) => Effect.Effect<void>;
  readonly consume: (session: string, envelope: string, at: number) => Effect.Effect<void>;
  readonly returnHanded: (session: string) => Effect.Effect<readonly string[]>;
  readonly handBack: (session: string, envelope: string) => Effect.Effect<void>;
  readonly dropSession: (session: string, why: string) => Effect.Effect<void>;
  readonly breakerSpoke: (session: string) => void;
  readonly breakerFailed: (session: string) => { readonly count: number; readonly tripped: boolean };
  readonly breakerOpen: (session: string) => boolean;
  readonly readyInputs: (recipient: string, rows: readonly DeliveryRow[]) => readonly DeliveryRow[];
  readonly closed: () => boolean;
  readonly isHosted: (id: string) => boolean;
  readonly message: (row: DeliveryRow) => Message;
  readonly wakeInput: (recipient: string, rows: readonly DeliveryRow[], messages: readonly Message[]) => Effect.Effect<string>;
  readonly handToHost: (recipient: string, messages: readonly Message[], primary: DeliveryRow) => Effect.Effect<void>;
  readonly consumedMessages: (recipient: string, envelopes: readonly string[]) => Effect.Effect<void>;
  readonly breakerNotice: (recipient: string, failed: number) => Effect.Effect<void>;
  readonly later: (key: string, ms: number, effect: () => Effect.Effect<void>) => void;
  readonly noticeBatchMs: number;
  readonly retryWakeMs: number;
}

interface Pump {
  readonly kick: (recipient: string) => Effect.Effect<void>;
  readonly activity: (activity: LaunchActivity) => Effect.Effect<void>;
  readonly consumed: (input: Consumed) => Effect.Effect<void>;
  readonly returned: (input: Returned) => Effect.Effect<void>;
}

export const makePump = <Message>(sessions: Session["Service"], ports: PumpPorts<Message>): Pump => {
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

  const deliver = (recipient: string, text: string, rows: readonly DeliveryRow[]): Effect.Effect<Delivered> => {
    const first = rows.findLast((row) => row.payload.trigger.actor.kind === "owner") ?? rows.find((row) => row.wakes && row.held_by === null) ?? rows[0];
    if (!first) return Effect.succeed({ kind: "refused", reason: "empty" });
    return sessions.deliver(recipient, text, {
      trigger:
        first.payload.trigger.meta.trigger !== undefined
          ? { ...first.payload.trigger.meta.trigger, message: first.envelope_id }
          : { kind: "comment", message: first.envelope_id, ...(first.channel_id ? { channel: first.channel_id } : {}) },
      envelopeIds: rows.map((row) => row.envelope_id),
      byOwnerComment: rows.some((row) => row.payload.trigger.actor.kind === "owner"),
    });
  };

  const kick = Effect.fnUntraced(function* (recipient: string): Effect.fn.Return<void> {
    const rows = ports.readyInputs(recipient, ports.pending(recipient));
    if (held(recipient)) return;
    const waking = rows.filter((row) => row.wakes && row.held_by === null && row.state === "pending");
    if (ports.isHosted(recipient)) {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.forEach(
        Map.groupBy(waking, (row) => row.scope),
        ([scope, allowed]) =>
          Effect.gen(function* () {
            const grouped = rows.filter((row) => row.scope === scope && row.state === "pending");
            const primary = allowed.findLast((row) => row.payload.trigger.actor.kind === "owner") ?? allowed[0];
            if (!primary) return;
            const messages = grouped.map(ports.message);
            yield* Effect.forEach(grouped, (row) => ports.hand(recipient, row.envelope_id, `orchestrator:${row.envelope_id}`, now), { discard: true });
            yield* ports.handToHost(recipient, messages, primary);
          }),
        { discard: true },
      );
      return;
    }
    const session = sessions.sessionOf(recipient);
    if (!session) return yield* ports.dropSession(recipient, "left");
    if (isBusy(session)) {
      if (rows.some((row) => row.state === "pending" && row.held_by === null)) ports.later(`notice:${recipient}`, ports.noticeBatchMs, () => notify(recipient));
      return;
    }
    if (waking.length === 0 || ports.breakerOpen(recipient)) return;
    const batch = rows.filter((row) => row.state === "pending");
    const messages = batch.map(ports.message);
    const wakeInput2 = yield* ports.wakeInput(recipient, batch, messages);
    const delivered = yield* deliver(recipient, wakeInput2, batch);
    if (delivered.kind === "refused") return yield* Effect.logInfo(`mailbox: ${recipient} not woken: ${delivered.reason}`);
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(batch, (row) => ports.hand(recipient, row.envelope_id, delivered.launch ?? "", now), { discard: true });
  });

  const notify = Effect.fnUntraced(function* (recipient: string): Effect.fn.Return<void> {
    if (held(recipient)) return;
    const session = sessions.sessionOf(recipient);
    if (!session) return;
    if (!isBusy(session)) return yield* kick(recipient);
    const rows = ports.readyInputs(recipient, ports.pending(recipient)).filter((row) => row.state === "pending" && row.urgency !== "queue");
    if (!rows.some((row) => row.urgency === "steer" && row.held_by === null)) return;
    const wakeInput2 = yield* ports.wakeInput(recipient, rows, rows.map(ports.message));
    const delivered = yield* deliver(recipient, wakeInput2, rows);
    if (delivered.kind === "refused") return;
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(rows, (row) => ports.hand(recipient, row.envelope_id, delivered.launch ?? "", now), { discard: true });
  });

  const activity = Effect.fnUntraced(function* (activity: LaunchActivity): Effect.fn.Return<void> {
    if (ports.closed()) return;
    switch (activity._tag) {
      case "Spoke":
        ports.breakerSpoke(activity.id);
        return;
      case "Settling":
        return;
      case "HandedOff":
      case "Ended": {
        const rolled = yield* ports.returnHanded(activity.id);
        if (rolled.length > 0) {
          if (!activity.spoke) {
            const { count, tripped } = ports.breakerFailed(activity.id);
            if (tripped) yield* ports.breakerNotice(activity.id, count);
          }
          ports.later(`wake:${activity.id}`, ports.retryWakeMs, () => kick(activity.id));
          return;
        }
        return yield* kick(activity.id);
      }
      case "Closed":
        yield* ports.returnHanded(activity.id);
        return;
      case "Compacting":
        hold(activity.id, "compacting", activity.on);
        if (!activity.on && !held(activity.id)) yield* kick(activity.id);
        return;
    }
  });

  return {
    kick,
    activity,
    consumed: (input) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const accepted = new Set(input.envelopeIds);
        const messages = ports.pending(input.session).flatMap((row) => (accepted.has(row.envelope_id) && row.message_id !== null ? [row.message_id] : []));
        yield* Effect.forEach(input.envelopeIds, (id) => ports.consume(input.session, id, now), { discard: true });
        yield* ports.consumedMessages(input.session, messages);
      }),
    returned: (input) => Effect.forEach(input.envelopeIds, (id) => ports.handBack(input.session, id), { discard: true }),
  };
};
