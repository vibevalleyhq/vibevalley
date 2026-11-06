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

/** The answer's playback, on the output's clock (now, in seconds) or driven by sample-accurate worklet events. */
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
  aheadMs(now: number): number {
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

  /** Sample-accurate worklet completion by chunk and run ID. */
  endedById(chunk: string, run: string): PlaybackAction[] {
    const found = this.playing.find((p) => p.chunk === chunk && p.run === run);
    return found ? this.ended(found) : [];
  }

  /** MOSS has sent all of a run (response.audio.done). */
  sent(run: string, turn: string): PlaybackAction[] {
    const r = this.runs.get(run) ?? { ms: 0, sent: false, turn };
    r.sent = true;
    this.runs.set(run, r);
    return this.finished(run);
  }

  /** The owner talked over a run, or MOSS stopped it: the pieces to stop now, and how far it got on the clock. */
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

  /** Sample-accurate cut when the audio worklet reports the exact partial ms played in the interrupted chunk. */
  cutSampleAccurate(run: string, turn: string, partialPlayedMs: number): { stop: Queued[]; actions: PlaybackAction[] } {
    const stop = this.playing.filter((p) => p.run === run);
    if (stop.length === 0 && !this.runs.has(run)) return { stop, actions: [] };
    const completedMs = this.runs.get(run)?.ms ?? 0;
    const activeBudgetMs = stop.reduce((acc, p) => acc + p.ms, 0);
    const totalMs = completedMs + Math.min(activeBudgetMs, Math.max(0, partialPlayedMs));
    this.playing = this.playing.filter((p) => p.run !== run);
    this.nextAt = 0;
    this.runs.delete(run);
    return { stop, actions: [{ action: "playback.stopped", run_id: run, turn_id: turn, played_audio_ms: Math.round(totalMs) }] };
  }

  clear(): void {
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
