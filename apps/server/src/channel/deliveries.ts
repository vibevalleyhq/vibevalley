// The deliveries still open (pending, announced, handed), as the chat keeps them in memory: what each recipient has
// coming, with what its inbox shows of each. Seen and dropped ones leave it. Each change is written to channel_delivery
// first and told here after, doing what its query does (the comments name it); the chat reloads it when a transaction
// fails and once it has put back what was handed when the server stopped (RollbackAll). Only the chat writes the table.

import type * as qd from "../../db/generated/channel_delivery.sql.ts";

export type DeliveryRow = Omit<qd.AllOpenDeliveriesResult, "recipient_id">;

export class Deliveries {
  private open = new Map<string, Map<string, DeliveryRow>>();

  /** Rows as AllOpenDeliveries gives them. */
  load(rows: readonly qd.AllOpenDeliveriesResult[]) {
    this.open.clear();
    for (const { recipient_id, ...row } of rows) this.inserted(recipient_id, row);
  }

  /** What is open for a recipient, by message. */
  of(recipient: string): DeliveryRow[] {
    return [...(this.open.get(recipient)?.values() ?? [])].sort((a, b) => (a.message_id < b.message_id ? -1 : a.message_id > b.message_id ? 1 : 0));
  }

  /** InsertDelivery: one already there stays as it is. */
  inserted(recipient: string, row: DeliveryRow) {
    let held = this.open.get(recipient);
    if (!held) this.open.set(recipient, (held = new Map<string, DeliveryRow>()));
    if (!held.has(row.message_id)) held.set(row.message_id, row);
  }

  private move(recipient: string, message: string, from: readonly string[], to: Partial<DeliveryRow>) {
    const r = this.open.get(recipient)?.get(message);
    if (r && from.includes(r.state)) this.open.get(recipient)!.set(message, { ...r, ...to });
  }

  /** MarkAnnounced. */
  announced(recipient: string, message: string, launch: string) {
    this.move(recipient, message, ["pending", "announced"], { state: "announced", launch });
  }

  /** MarkHanded. */
  handed(recipient: string, message: string, launch: string) {
    this.move(recipient, message, ["pending", "announced"], { state: "handed", launch });
  }

  /** RollbackHanded. */
  handedBack(recipient: string) {
    for (const r of this.of(recipient)) if (r.state === "handed") this.move(recipient, r.message_id, ["handed"], { state: "pending", launch: null });
  }

  /** RollbackAnnounced. */
  announcedBack(recipient: string, launch: string) {
    for (const r of this.of(recipient))
      if (r.state === "announced" && r.launch === launch) this.move(recipient, r.message_id, ["announced"], { state: "pending", launch: null });
  }

  /** SeenOne, SeenHanded (with the ids it returned): seen, so no longer open. */
  seen(recipient: string, message: string) {
    this.open.get(recipient)?.delete(message);
  }

  /** SeenUpTo. */
  seenUpTo(recipient: string, channel: string, upto: number) {
    for (const r of this.of(recipient)) if (r.channel_id === channel && r.number <= upto) this.seen(recipient, r.message_id);
  }

  /** DropOpen. */
  dropped(recipient: string) {
    this.open.delete(recipient);
  }
}
