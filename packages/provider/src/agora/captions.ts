import { z } from "zod";

import { fromJson } from "../base/json.ts";

const CaptionMessageSchema = z.object({
  object: z.exactOptional(z.string()),
  turn_id: z.exactOptional(z.number()),
  turn_status: z.exactOptional(z.number()),
  text: z.exactOptional(z.string()),
  final: z.exactOptional(z.boolean()),
  state: z.exactOptional(z.string()),
});
export type CaptionMessage = z.output<typeof CaptionMessageSchema>;
const decodePacket = (text: string): CaptionMessage | undefined => fromJson(CaptionMessageSchema, text);

export class CaptionPackets {
  private readonly chunks = new Map<string, Map<number, string>>();
  clear() {
    this.chunks.clear();
  }
  assemble(packet: string): CaptionMessage | undefined {
    const parts = packet.split("|");
    if (parts.length !== 4) return decodePacket(packet);
    const [id = "", index = "", total = "", data = ""] = parts;
    const i = /^\d+$/u.test(index) ? Number(index) : NaN;
    const n = total === "???" ? undefined : /^\d+$/u.test(total) ? Number(total) : NaN;
    if (!(i >= 1) || (n !== undefined && (!(n >= 1) || i > n))) return undefined;
    let got = this.chunks.get(id);
    if (!got) this.chunks.set(id, (got = new Map<number, string>()));
    got.set(i, data);
    if (n === undefined || got.size < n) return undefined;
    this.chunks.delete(id);
    try {
      const joined = Array.from({ length: n }, (_, k) => got.get(k + 1) ?? "").join("");
      const bytes = Uint8Array.from(atob(joined), (c) => c.charCodeAt(0));
      return decodePacket(new TextDecoder().decode(bytes));
    } catch {
      // A packet that is not Base64 is noise on the data stream, dropped like any other undecodable one.
      return undefined;
    }
  }
}
