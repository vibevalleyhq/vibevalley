import { recordOf } from "#/base/dom.tsx";

type Speaker = "you" | "orchestrator";

interface Caption {
  readonly speaker: Speaker;
  readonly turn: number;
  text: string;
  done: boolean;
  /** When it was done, by the page's clock. */
  doneAt?: number;
  interrupted: boolean;
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

type Message = Record<string, unknown>;

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

  apply(m: Message) {
    const turn = typeof m.turn_id === "number" ? Math.trunc(m.turn_id) : 0;
    const status = typeof m.turn_status === "number" ? m.turn_status : 0;
    switch (m.object) {
      case "user.transcription":
        // Ends on `final`, or on turn_status as the official quickstart reads it.
        this.put("you", turn, typeof m.text === "string" ? m.text : "", m.final === true || status !== 0);
        return true;
      case "assistant.transcription":
        this.put("orchestrator", turn, typeof m.text === "string" ? m.text : "", status !== 0);
        return true;
      case "message.state":
        this.agentState = typeof m.state === "string" ? m.state : undefined;
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

  private assemble(packet: string): Message | undefined {
    const parts = packet.split("|");
    if (parts.length !== 4) {
      // Not chunked: a plain JSON message.
      try {
        return recordOf(JSON.parse(packet));
      } catch {
        return undefined;
      }
    }
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
      return recordOf(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
      return undefined;
    }
  }
}
