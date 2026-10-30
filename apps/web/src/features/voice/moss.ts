// What the MOSS Live line works out without touching audio or the socket (mossLine.ts wires it up): the turns' words as
// MOSS revises them, and the account of the answer's playback MOSS needs told back. MOSS sends only so far ahead of what
// was played: every piece played is reported (playback.chunk.completed), a run played to its end too (playback.completed),
// and a run cut off with how far it got (playback.stopped).

/** One side's words in a turn; done once MOSS has settled them. */
export interface MossTurn {
  readonly who: "owner" | "moss";
  readonly key: string;
  readonly text: string;
  readonly done: boolean;
}

/**
 * The turns with a turn's words so far (MOSS sends them whole each time); a new turn starts a new line. The owner's
 * first updates come before MOSS has named the turn: the line takes the name when it comes.
 */
export function heard(turns: readonly MossTurn[], who: MossTurn["who"], key: string, text: string, done: boolean): MossTurn[] {
  if (text === "") return [...turns];
  let last: MossTurn | undefined;
  for (const x of turns) if (x.who === who && !x.done && (x.key === "" || key === "" || x.key === key)) last = x;
  if (!last) return [...turns, { who, key, text, done }];
  return turns.map((x) => (x === last ? { ...x, key: key || x.key, text, done } : x));
}

/** 0..100 from a frame's loudness. */
export function levelOf(pcm: Int16Array) {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const s of pcm) sum += (s / 0x8000) ** 2;
  return Math.min(100, Math.round(Math.sqrt(sum / pcm.length) * 300));
}

/** A piece of the answer as MOSS announced it (response.audio.context). */
export interface Piece {
  readonly chunk: string;
  readonly run: string;
  readonly turn: string;
}

/** A piece put on the output's clock: from at (seconds), ms long. */
export interface Queued extends Piece {
  readonly at: number;
  readonly ms: number;
}

/** What to tell MOSS about playback, as its actions. */
export type PlaybackAction =
  | { readonly action: "playback.chunk.completed"; readonly chunk_id: string; readonly run_id: string; readonly turn_id: string }
  | { readonly action: "playback.completed"; readonly run_id: string; readonly turn_id: string }
  | { readonly action: "playback.stopped"; readonly run_id: string; readonly turn_id: string; readonly played_audio_ms: number };

/**
 * The answer's playback, on the output's clock (now, in seconds): pieces queue one after another, and each run (one
 * answer) is reported once it has been both sent whole and played, or cut off.
 */
export class Playback {
  playing: Queued[] = [];
  /** Times the answer ran dry: a piece came after the one before it in the same run had finished. */
  gaps = 0;
  private nextAt = 0;
  private lastRun = "";
  /** Per run: the ms played to the end, and whether MOSS has sent all of it. */
  private runs = new Map<string, { ms: number; sent: boolean; turn: string }>();

  /** Puts a piece seconds long after what is queued, or now if nothing is. */
  queue(piece: Piece, seconds: number, now: number): Queued {
    if (piece.run === this.lastRun && this.nextAt > 0 && now > this.nextAt) this.gaps++;
    this.lastRun = piece.run;
    const at = Math.max(this.nextAt, now);
    this.nextAt = at + seconds;
    const queued = { ...piece, at, ms: seconds * 1000 };
    this.playing.push(queued);
    if (!this.runs.has(piece.run)) this.runs.set(piece.run, { ms: 0, sent: false, turn: piece.turn });
    return queued;
  }

  /** The audio already here and not yet played, ms. */
  aheadMs(now: number) {
    return Math.max(0, Math.round((this.nextAt - now) * 1000));
  }

  /** A piece played to its end; nothing if it was cut off before. */
  ended(q: Queued): PlaybackAction[] {
    if (!this.playing.includes(q)) return [];
    this.playing = this.playing.filter((p) => p !== q);
    const run = this.runs.get(q.run);
    if (run) run.ms += q.ms;
    return [{ action: "playback.chunk.completed", chunk_id: q.chunk, run_id: q.run, turn_id: q.turn }, ...this.finished(q.run)];
  }

  /** MOSS has sent all of a run (response.audio.done). */
  sent(run: string, turn: string): PlaybackAction[] {
    const r = this.runs.get(run) ?? { ms: 0, sent: false, turn };
    r.sent = true;
    this.runs.set(run, r);
    return this.finished(run);
  }

  /** The owner talked over a run, or MOSS stopped it: the pieces to stop now, and how far it got. */
  cut(run: string, turn: string, now: number): { stop: Queued[]; actions: PlaybackAction[] } {
    const stop = this.playing.filter((p) => p.run === run);
    if (stop.length === 0 && !this.runs.has(run)) return { stop, actions: [] };
    let ms = this.runs.get(run)?.ms ?? 0;
    for (const p of stop) if (now > p.at) ms += Math.min(p.ms, (now - p.at) * 1000);
    this.playing = this.playing.filter((p) => p.run !== run);
    this.nextAt = 0;
    this.runs.delete(run);
    return { stop, actions: [{ action: "playback.stopped", run_id: run, turn_id: turn, played_audio_ms: Math.round(ms) }] };
  }

  clear() {
    this.playing = [];
    this.gaps = 0;
    this.nextAt = 0;
    this.lastRun = "";
    this.runs.clear();
  }

  private finished(run: string): PlaybackAction[] {
    const r = this.runs.get(run);
    if (r?.sent !== true || this.playing.some((p) => p.run === run)) return [];
    this.runs.delete(run);
    return [{ action: "playback.completed", run_id: run, turn_id: r.turn }];
  }
}
