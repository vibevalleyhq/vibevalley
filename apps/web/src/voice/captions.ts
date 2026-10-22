// The live captions of a call, from the conversational AI agent's messages on the RTC data
// stream (the server starts it with data_channel 'datastream'). A message comes in chunks, `id|part|parts|base64`,
// 1-based; put together and decoded, it is JSON with an `object`:
//   user.transcription       what you said so far in a turn; `final` when the turn is over
//   assistant.transcription  what the assistant has said so far; `turn_status` 0 while it is still talking
//   message.interrupt        you talked over the assistant: its turn `turn_id` stops there
//   message.state            the agent's state: idle, listening, thinking, speaking, silent
// Every message of a turn carries the whole text so far, so a turn's caption is replaced, never appended to.

export type Speaker = "you" | "assistant";

export interface Caption {
  readonly speaker: Speaker;
  readonly turn: number;
  text: string;
  done: boolean;
  interrupted: boolean;
}

type Message = Record<string, unknown>;

export class LiveCaptions {
  static readonly keep = 8;
  readonly turns: Caption[] = [];
  agentState?: string;
  /** Said once per turn. */
  onHeard?: (text: string) => void;
  /** The assistant's words of a turn, once the turn is over or talked over: what it got to say. */
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
        this.put("assistant", turn, typeof m.text === "string" ? m.text : "", status !== 0);
        return true;
      case "message.state":
        this.agentState = typeof m.state === "string" ? m.state : undefined;
        return true;
      case "message.interrupt": {
        const c = this.find("assistant", turn);
        if (!c) return false;
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
      this.turns.push({ speaker, turn, text, done, interrupted: false });
      if (this.turns.length > LiveCaptions.keep) this.turns.shift();
    } else if (!c.interrupted) {
      c.text = text;
      c.done = done;
    }
    if (speaker === "you" && done && text.trim() && !this.heard.has(turn)) {
      this.heard.add(turn);
      this.onHeard?.(text);
    }
    if (speaker === "assistant" && done) this.answer(this.find(speaker, turn)!);
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
