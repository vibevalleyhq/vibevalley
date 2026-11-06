import { Option, Schema } from "effect";

import type { VoiceTurn } from "../core/contract.ts";

export type Speaker = "you" | "orchestrator";

export interface Caption {
  readonly speaker: Speaker;
  readonly turn: number;
  text: string;
  done: boolean;
  /** When it was done, by the page's clock. */
  doneAt?: number;
  interrupted: boolean;
}

/** Maps Agora RTC captions onto the unified core `VoiceTurn` contract. */
export function voiceTurnsOfCaptions(turns: readonly Caption[]): VoiceTurn<"owner" | "orchestrator">[] {
  return turns.map((c) => ({
    who: c.speaker === "you" ? "owner" : "orchestrator",
    key: String(c.turn),
    text: c.text,
    done: c.done,
  }));
}

/** A line said on a call as the farm chat has it: whose, and its words. */
export interface SpokenLine {
  readonly speaker: Speaker;
  readonly text: string;
}

/** How long a finished turn's caption waits for its line in the farm chat before it goes. */
export const captionLinger = 8_000;

/** The captions to draw live in the farm chat during a call, before their turns are lines there. */
export function liveCaptions(turns: readonly Caption[], spoken: readonly SpokenLine[], now: number): Caption[] {
  return turns.filter((c) => {
    if (!c.text.trim()) return false;
    if (!c.done) return true;
    if (c.doneAt !== undefined && now - c.doneAt > captionLinger) return false;
    return !spoken.some((l) => l.speaker === c.speaker && l.text.trim() === c.text.trim());
  });
}

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

export class LiveCaptions {
  static readonly keep = 8;
  readonly turns: Caption[] = [];
  agentState: string | undefined = undefined;
  /** Said once per turn. */
  onHeard?: (text: string) => void;
  /** The orchestrator's words of a turn, once the turn is over or talked over: what it got to say. */
  onAnswered?: (text: string) => void;
  private readonly chunks = new Map<string, Map<number, string>>();
  private readonly heard = new Set<number>();
  private readonly answered = new Set<number>();

  feed(packet: string) {
    const m = this.assemble(packet);
    return m ? this.apply(m) : false;
  }

  apply(m: CaptionMessage) {
    const turn = m.turn_id !== undefined ? Math.trunc(m.turn_id) : 0;
    const status = m.turn_status ?? 0;
    switch (m.object) {
      case "user.transcription":
        this.put("you", turn, m.text ?? "", m.final === true || status !== 0);
        return true;
      case "assistant.transcription":
        this.put("orchestrator", turn, m.text ?? "", status !== 0);
        return true;
      case "message.state":
        this.agentState = m.state;
        return true;
      case "message.interrupt": {
        const c = this.find("orchestrator", turn);
        if (!c) return false;
        if (!c.done) c.doneAt = Date.now();
        c.done = true;
        c.interrupted = true;
        this.answer(c);
        return true;
      }
      default:
        return false;
    }
  }

  clear() {
    this.agentState = undefined;
    this.heard.clear();
    this.answered.clear();
    this.turns.length = 0;
    this.chunks.clear();
  }

  private put(speaker: Speaker, turn: number, text: string, done: boolean) {
    const c = this.find(speaker, turn);
    if (!c) {
      this.turns.push({ speaker, turn, text, done, ...(done ? { doneAt: Date.now() } : {}), interrupted: false });
      if (this.turns.length > LiveCaptions.keep) this.turns.shift();
    } else if (!c.interrupted) {
      c.text = text;
      if (done && !c.done) c.doneAt = Date.now();
      c.done = done;
    }
    if (speaker === "you" && done && text.trim() && !this.heard.has(turn)) {
      this.heard.add(turn);
      this.onHeard?.(text);
    }
    const said = this.find(speaker, turn);
    if (speaker === "orchestrator" && done && said) this.answer(said);
  }

  private answer(c: Caption) {
    if (c.text.trim() && !this.answered.has(c.turn)) {
      this.answered.add(c.turn);
      this.onAnswered?.(c.text);
    }
  }

  private find(speaker: Speaker, turn: number) {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const entry = this.turns[i];
      if (entry && entry.speaker === speaker && entry.turn === turn) return entry;
    }
    return undefined;
  }

  private assemble(packet: string): CaptionMessage | undefined {
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
