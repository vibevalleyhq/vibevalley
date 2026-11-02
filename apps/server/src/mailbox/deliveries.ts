import type * as qd from "../../db/generated/mailbox_delivery.sql.ts";
import { readPayload, type DeliveryPayload } from "./payload.ts";

export type DeliveryRow = Omit<qd.AllOpenDeliveriesResult, "session_id" | "payload_json"> & { readonly payload: DeliveryPayload };
export type DeliveryDraft = Omit<DeliveryRow, "position">;

export class Deliveries {
  private open = new Map<string, Map<string, DeliveryRow>>();

  /** Rows as AllOpenDeliveries gives them. */
  load(rows: readonly qd.AllOpenDeliveriesResult[]) {
    this.open.clear();
    for (const { session_id, payload_json, ...row } of rows) this.inserted(session_id, { ...row, payload: readPayload(payload_json) });
  }

  /** What is open for a session, by envelope. */
  of(recipient: string): DeliveryRow[] {
    return [...(this.open.get(recipient)?.values() ?? [])].toSorted((a, b) => a.position - b.position);
  }

  /** InsertDelivery: one already there stays as it is. */
  inserted(recipient: string, row: DeliveryRow) {
    let held = this.open.get(recipient);
    if (!held) this.open.set(recipient, (held = new Map<string, DeliveryRow>()));
    if (!held.has(row.envelope_id)) held.set(row.envelope_id, row);
  }

  private move(recipient: string, message: string, from: readonly string[], to: Partial<DeliveryRow>) {
    const mine = this.open.get(recipient);
    const r = mine?.get(message);
    if (mine && r && from.includes(r.state)) mine.set(message, { ...r, ...to });
  }

  /** MarkHanded. */
  released(recipient: string, message: string) {
    this.move(recipient, message, ["pending"], { wakes: true, reason: "addressed" });
  }

  handed(recipient: string, message: string, launch: string) {
    this.move(recipient, message, ["pending"], { state: "handed", launch });
  }

  /** RollbackHanded. */
  handedBack(recipient: string) {
    for (const r of this.of(recipient)) if (r.state === "handed") this.move(recipient, r.envelope_id, ["handed"], { state: "pending", launch: null });
  }

  /** RollbackOne. */
  handedBackOne(recipient: string, message: string) {
    this.move(recipient, message, ["handed"], { state: "pending", launch: null });
  }

  /** Terminal deliveries leave the open queue. */
  remove(recipient: string, message: string) {
    this.open.get(recipient)?.delete(message);
  }

  /** DropOpen. */
  dropped(recipient: string) {
    this.open.delete(recipient);
  }
}
