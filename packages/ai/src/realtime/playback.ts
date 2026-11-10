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
  private runs = new Map<string, { sent: boolean; turn: string }>();
  private readonly finishedRuns = new Set<string>();

  /** Puts a piece seconds long after what is queued, or now if nothing is. */
  queue(piece: Piece, seconds: number, now: number): Queued {
    if (piece.run === this.lastRun && this.nextAt > 0 && now > this.nextAt) this.gaps++;
    this.lastRun = piece.run;
    const at = Math.max(this.nextAt, now);
    this.nextAt = at + seconds;
    const queued = { ...piece, at, ms: seconds * 1000 };
    this.playing.push(queued);
    if (!this.runs.has(piece.run)) this.runs.set(piece.run, { sent: false, turn: piece.turn });
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
    return [{ action: "playback.chunk.completed", chunk_id: q.chunk, run_id: q.run, turn_id: q.turn }, ...this.finished(q.run)];
  }

  /** Sample-accurate worklet completion by chunk and run ID. */
  endedById(chunk: string, run: string): PlaybackAction[] {
    const found = this.playing.find((p) => p.chunk === chunk && p.run === run);
    return found ? this.ended(found) : [];
  }

  /** MOSS has sent all of a run (response.audio.done). */
  sent(run: string, turn: string): PlaybackAction[] {
    if (this.finishedRuns.has(run)) return [];
    const r = this.runs.get(run) ?? { sent: false, turn };
    if (r.turn !== turn) return [];
    r.sent = true;
    this.runs.set(run, r);
    return this.finished(run);
  }

  /** The user talked over a run, or MOSS stopped it: the pieces to stop now, and how far it got on the clock. */
  cut(run: string, turn: string, now: number): { stop: Queued[]; actions: PlaybackAction[] } {
    const stop = this.playing.filter((p) => p.run === run);
    if (stop.length === 0 && !this.runs.has(run)) return { stop, actions: [] };
    const actions: PlaybackAction[] = [];
    let partial = 0;
    for (const p of stop) {
      const played = Math.max(0, (now - p.at) * 1000);
      if (played >= p.ms) actions.push({ action: "playback.chunk.completed", chunk_id: p.chunk, run_id: run, turn_id: turn });
      else if (played > 0) partial = played;
    }
    this.playing = this.playing.filter((p) => p.run !== run);
    this.nextAt = this.playing.reduce((end, p) => Math.max(end, p.at + p.ms / 1000), 0);
    this.runs.delete(run);
    this.finishedRuns.add(run);
    actions.push({ action: "playback.stopped", run_id: run, turn_id: turn, played_audio_ms: Math.round(partial) });
    return { stop, actions };
  }

  /** Sample-accurate cut when the audio worklet reports the exact partial ms played in the interrupted chunk. */
  cutSampleAccurate(run: string, turn: string, partialPlayedMs: number): { stop: Queued[]; actions: PlaybackAction[] } {
    const stop = this.playing.filter((p) => p.run === run);
    if (stop.length === 0 && !this.runs.has(run)) return { stop, actions: [] };
    const partial = Number.isFinite(partialPlayedMs) ? Math.min(stop[0]?.ms ?? 0, Math.max(0, partialPlayedMs)) : 0;
    this.playing = this.playing.filter((p) => p.run !== run);
    this.nextAt = this.playing.reduce((end, p) => Math.max(end, p.at + p.ms / 1000), 0);
    this.runs.delete(run);
    this.finishedRuns.add(run);
    return { stop, actions: [{ action: "playback.stopped", run_id: run, turn_id: turn, played_audio_ms: Math.round(partial) }] };
  }

  clear(): void {
    this.playing = [];
    this.gaps = 0;
    this.nextAt = 0;
    this.lastRun = "";
    this.runs.clear();
    this.finishedRuns.clear();
  }

  private finished(run: string): PlaybackAction[] {
    const r = this.runs.get(run);
    if (r?.sent !== true || this.playing.some((p) => p.run === run)) return [];
    this.runs.delete(run);
    this.finishedRuns.add(run);
    return [{ action: "playback.completed", run_id: run, turn_id: r.turn }];
  }
}
