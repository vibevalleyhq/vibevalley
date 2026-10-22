// The live captions of a call, from the conversational AI agent's messages on the RTC data
// stream (the server starts it with data_channel 'datastream'). A message comes in chunks, `id|part|parts|base64`,
// 1-based; put together and decoded, it is JSON with an `object`:
//   user.transcription       what you said so far in a turn; `final` when the turn is over
//   orchestrator.transcription  what the orchestrator has said so far; `turn_status` 0 while it is still talking
//   message.interrupt        you talked over the orchestrator: its turn `turn_id` stops there
//   message.state            the agent's state: idle, listening, thinking, speaking, silent
// Every message of a turn carries the whole text so far, so a turn's caption is replaced, never appended to.

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

/** A line said on a call as 田头 has it: whose, and its words. */
export interface SpokenLine {
  readonly speaker: Speaker;
  readonly text: string;
}

/** How long a finished turn's caption waits for its line in 田头 before it goes. */
export const captionLinger = 8_000;

/** The captions to draw live in 田头 during a call, before their turns are lines there: every turn still being said, and a
 * finished one until 田头 has its words or captionLinger passes. The orchestrator's are left out when it answers on the
 * line: its words go into 田头 as it says them, and would show twice. */
export function liveCaptions(
  turns: readonly Caption[],
  answeredBy: "orchestrator" | "agora" | undefined,
  spoken: readonly SpokenLine[],
  now: number,
): Caption[] {
  return turns.filter((c) => {
    if (c.speaker === "orchestrator" && answeredBy !== "agora") return false;
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
  agentState?: string;
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
    if (speaker === "orchestrator" && done) this.answer(this.find(speaker, turn)!);
  }

  private answer(c: Caption) {
    if (c.text.trim() && !this.answered.has(c.turn)) {
      this.answered.add(c.turn);
      this.onAnswered?.(c.text);
    }
  }

  private find(speaker: Speaker, turn: number) {
    for (let i = this.turns.length - 1; i >= 0; i--) if (this.turns[i]!.speaker === speaker && this.turns[i]!.turn === turn) return this.turns[i];
    return undefined;
  }

  private assemble(packet: string): Message | undefined {
    const parts = packet.split("|");
    if (parts.length !== 4) {
      // Not chunked: a plain JSON message.
      try {
        const decoded: unknown = JSON.parse(packet);
        return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? (decoded as Message) : undefined;
      } catch {
        return undefined;
      }
    }
    const [id, index, total, data] = parts as [string, string, string, string];
    const i = /^\d+$/.test(index) ? Number(index) : NaN;
    const n = total === "???" ? undefined : /^\d+$/.test(total) ? Number(total) : NaN;
    if (!(i >= 1) || (n !== undefined && (!(n >= 1) || i > n))) return undefined;
    let got = this.chunks.get(id);
    if (!got) this.chunks.set(id, (got = new Map()));
    got.set(i, data);
    if (n === undefined || got.size < n) return undefined;
    this.chunks.delete(id);
    try {
      const joined = Array.from({ length: n }, (_, k) => got.get(k + 1) ?? "").join("");
      const bytes = Uint8Array.from(atob(joined), (c) => c.charCodeAt(0));
      const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
      return decoded && typeof decoded === "object" && !Array.isArray(decoded) ? (decoded as Message) : undefined;
    } catch {
      return undefined;
    }
  }
}
