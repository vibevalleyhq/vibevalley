import { Option, Schema } from "effect";

const CaptionMessageSchema = Schema.Struct({
  object: Schema.optionalKey(Schema.String),
  turn_id: Schema.optionalKey(Schema.Finite),
  turn_status: Schema.optionalKey(Schema.Finite),
  text: Schema.optionalKey(Schema.String),
  final: Schema.optionalKey(Schema.Boolean),
  state: Schema.optionalKey(Schema.String),
});
export type CaptionMessage = typeof CaptionMessageSchema.Type;
const decodePacket = Schema.decodeUnknownOption(Schema.fromJsonString(CaptionMessageSchema));

export class CaptionPackets {
  private readonly chunks = new Map<string, Map<number, string>>();
  clear() {
    this.chunks.clear();
  }
  assemble(packet: string): CaptionMessage | undefined {
    const parts = packet.split("|");
    if (parts.length !== 4) return Option.getOrUndefined(decodePacket(packet));
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
      return Option.getOrUndefined(decodePacket(new TextDecoder().decode(bytes)));
    } catch {
      return undefined;
    }
  }
}
