import { Schema } from "effect";

import { mossLinePath } from "@vibevalley/protocol";

export const mossRealtimeUrl = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";

export const mossInRate = 16000;
export const mossOutRate = 48000;
export const mossFrameSamples = 320;

// An AudioWorklet's module, as a script of its own: the microphone in 20 ms frames of 16-bit PCM.
export const mossCaptureWorkletCode = `registerProcessor("vibevalley-moss-capture", class extends AudioWorkletProcessor {
  run = new Int16Array(${mossFrameSamples});
  at = 0;
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples)
      for (const s of samples) {
        this.run[this.at++] = Math.max(-1, Math.min(1, s)) * 0x7fff;
        if (this.at === this.run.length) {
          this.port.postMessage(this.run.buffer, [this.run.buffer]);
          this.run = new Int16Array(${mossFrameSamples});
          this.at = 0;
        }
      }
    return true;
  }
});`;
let captureUrl: string | undefined;

export const MossErrorObjectSchema = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
});

export const MossEventPayloadSchema = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  turn: Schema.optionalKey(Schema.String),
  turn_id: Schema.optionalKey(Schema.String),
  chunk_id: Schema.optionalKey(Schema.String),
  run_id: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Union([Schema.String, MossErrorObjectSchema])),
});

export const MossFrameSchema = Schema.fromJsonString(
  Schema.Struct({
    action: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(MossErrorObjectSchema),
    data: Schema.optionalKey(MossEventPayloadSchema),
  }),
);

export const decodeMossFrame = Schema.decodeUnknownOption(MossFrameSchema);

/** The message of a refusal's JSON body ({ error: { message } }), or the body itself, cut short. */
export const mossErrorMessage = (body: string): string => {
  const decoded = decodeMossFrame(body);
  const msg = decoded._tag === "Some" ? decoded.value.error?.message : undefined;
  return msg ? msg : body.slice(0, 200);
};

/** One side's words in a turn; done once MOSS has settled them. */
export interface MossTurn {
  readonly who: "owner" | "moss";
  readonly key: string;
  readonly text: string;
  readonly done: boolean;
}

/** The turns with a turn's words so far (MOSS sends them whole each time). a new turn starts a new line. */
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

/** The answer's playback, on the output's clock (now, in seconds). */
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

export type MossPhase = "idle" | "connecting" | "live" | "ending";

/** An action sent or an event received, as JSON; the noisy ones (words as they grow, audio announcements) are left out. */
export interface MossEvent {
  readonly up: boolean;
  readonly text: string;
}

/** How the line is doing, worked out once a second from what passed on it. */
export interface MossQos {
  /** kbit/s over the last second, both ways, audio and JSON together. */
  upKbps: number;
  downKbps: number;
  /** Microphone frames sent in the last second: 50 when capture and the socket keep up. */
  framesPerSecond: number;
  /** Bytes the socket holds that have not gone out yet: grows when the way up is too slow. */
  backlog: number;
  /** The answer's audio already here and not yet played, ms. */
  aheadMs: number;
  /** Times the answer ran dry: a piece came after the one before had finished playing, in the same answer. */
  gaps: number;
  /** From the end of the owner's words (input.speech.stopped) to MOSS's first sound arriving, ms: the last and the mean. */
  replyMs?: number;
  replyMeanMs?: number;
  replies: number;
  /** Answers MOSS stopped itself, by the reason it gave (response.audio.stop). */
  stops: Record<string, number>;
}

export const noQos = (): MossQos => ({ upKbps: 0, downKbps: 0, framesPerSecond: 0, backlog: 0, aheadMs: 0, gaps: 0, replies: 0, stops: {} });

export interface MossSetup {
  readonly persona: string;
  readonly instructions: string;
}

export interface MossMessages {
  readonly closed: () => string;
  readonly noMic: () => string;
  readonly formatError: (e: unknown) => string;
}

const noisy = new Set(["input.transcript.updated", "output.transcript.updated", "response.audio.context", "playback.chunk.completed"]);

export class MossLine {
  phase: MossPhase = "idle";
  problem: string | undefined = undefined;
  muted = false;
  micLevel = 0;
  mossLevel = 0;
  turns: MossTurn[] = [];
  events: MossEvent[] = [];
  qos: MossQos = noQos();
  version = 0;

  private ws: WebSocket | undefined = undefined;
  /** What passed since the last tick of the QoS clock. */
  private window = { up: 0, down: 0, frames: 0 };
  private tick: ReturnType<typeof setInterval> | undefined = undefined;
  /** When the owner's words last ended, waiting for MOSS's first sound; performance.now(). */
  private heardAt: number | undefined = undefined;
  private replyTotal = 0;
  private mic: { stream: MediaStream; context: AudioContext } | undefined = undefined;
  private out: AudioContext | undefined = undefined;
  private piece: Piece | undefined = undefined;
  private playback = new Playback();
  private sources = new Map<Queued, AudioBufferSourceNode>();
  private readonly listeners = new Set<() => void>();
  private readonly messages: MossMessages;

  constructor(messages: MossMessages) {
    this.messages = messages;
  }

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };

  private changed() {
    this.version++;
    for (const f of this.listeners) f();
  }

  private log(up: boolean, text: string) {
    this.events = [...this.events.slice(-199), { up, text }];
  }

  private tell(actions: readonly PlaybackAction[]) {
    for (const a of actions) this.send(a);
  }

  private send(action: { readonly action: string } & Record<string, unknown>) {
    const text = JSON.stringify(action);
    this.ws?.send(text);
    this.window.up += text.length;
    if (!noisy.has(action.action)) this.log(true, text);
    this.changed();
  }

  async start(setup: MossSetup) {
    if (this.phase !== "idle") return;
    this.phase = "connecting";
    this.problem = undefined;
    this.turns = [];
    this.events = [];
    this.qos = noQos();
    this.replyTotal = 0;
    this.window = { up: 0, down: 0, frames: 0 };
    this.tick = setInterval(() => this.measure(), 1000);
    this.changed();
    const url = new URL(mossLinePath, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.send({ action: "attach_session" });
    };
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      this.window.down += typeof e.data === "string" ? e.data.length : e.data.byteLength;
      if (typeof e.data === "string") this.event(e.data, setup);
      else this.audio(e.data);
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      // Refused before it opened (no key, not the farm's page): the server said why over plain HTTP.
      if (!opened)
        void fetch(url.href.replace(/^ws/u, "http"))
          .then((r) => r.text())
          .then(
            (why) => this.stop(why || this.messages.closed()),
            () => this.stop(this.messages.closed()),
          );
      else this.stop(e.code === 1000 || this.phase === "ending" ? undefined : e.reason || this.messages.closed());
    };
  }

  private event(data: string, setup: MossSetup) {
    const decoded = decodeMossFrame(data);
    if (decoded._tag === "None") return;
    const m = decoded.value;
    const action = m.action ?? "";
    if (!noisy.has(action)) this.log(false, data);
    const d = m.data ?? {};
    const text = d.text ?? "";
    switch (action) {
      case "session_attached": {
        const persona = setup.persona.trim();
        this.send({ action: "session.update", session: { ...(persona ? { persona: { prompt: persona } } : {}), instructions: setup.instructions.trim() } });
        break;
      }
      case "session.updated":
        if (typeof d.error === "string" && d.error !== "") this.problem = d.error;
        if (this.phase === "connecting") void this.open();
        break;
      case "input.transcript.updated":
      case "input.transcript.done":
        this.words("owner", d.turn ?? "", text, action.endsWith("done"));
        break;
      case "output.transcript.updated":
      case "output.transcript.done":
        this.words("moss", d.turn_id ?? "", text, action.endsWith("done"));
        break;
      case "response.audio.context":
        this.piece = { chunk: d.chunk_id ?? "", run: d.run_id ?? "", turn: d.turn_id ?? "" };
        break;
      case "response.audio.done":
        this.tell(this.playback.sent(d.run_id ?? "", d.turn_id ?? ""));
        break;
      case "input.speech.stopped":
        this.heardAt = performance.now();
        break;
      case "response.audio.stop": {
        const reason = d.reason || "?";
        this.qos.stops[reason] = (this.qos.stops[reason] ?? 0) + 1;
        this.cut(d.run_id ?? "", d.turn_id ?? "");
        break;
      }
      case "response.interrupted":
        // Cut off, an answer never gets its output.transcript.done: what it got to say is here.
        this.words("moss", d.turn_id ?? "", text, true);
        this.cut(d.run_id ?? "", d.turn_id ?? "");
        break;
      case "error": {
        const e = d.error;
        this.problem = typeof e === "string" ? e : (e?.message ?? data);
        break;
      }
      default:
        break;
    }
    this.changed();
  }

  private words(who: MossTurn["who"], key: string, text: string, done: boolean) {
    this.turns = heard(this.turns, who, key, text, done);
  }

  private async open() {
    try {
      this.out = new AudioContext({ sampleRate: mossOutRate });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const context = new AudioContext({ sampleRate: mossInRate });
      await context.audioWorklet.addModule((captureUrl ??= URL.createObjectURL(new Blob([mossCaptureWorkletCode], { type: "text/javascript" }))));
      if (this.phase !== "connecting") {
        stream.getTracks().forEach((x) => x.stop());
        void context.close();
        return;
      }
      const node = new AudioWorkletNode(context, "vibevalley-moss-capture", { channelCount: 1 });
      node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const pcm = new Int16Array(e.data);
        this.micLevel = this.muted ? 0 : levelOf(pcm);
        // Muted, MOSS still hears silence: it wants the line kept going.
        const bytes = new Uint8Array(1 + e.data.byteLength);
        if (!this.muted) bytes.set(new Uint8Array(e.data), 1);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(bytes);
          this.window.up += bytes.length;
          this.window.frames++;
        }
        this.changed();
      };
      context.createMediaStreamSource(stream).connect(node);
      // Connected on to the output (it writes nothing there), as a node nobody pulls may not be run.
      node.connect(context.destination);
      this.mic = { stream, context };
      this.send({ action: "media.mode", binary_protocol: "tagged-v1" });
      this.send({ action: "mic_state", enabled: true });
      this.phase = "live";
    } catch (e) {
      this.stop(e instanceof Error && e.name === "NotAllowedError" ? this.messages.noMic() : this.messages.formatError(e));
    }
    this.changed();
  }

  private audio(data: ArrayBuffer) {
    const out = this.out;
    const piece = this.piece;
    this.piece = undefined;
    if (!out || !piece) return;
    const pcm = new Int16Array(data, 0, Math.floor(data.byteLength / 2));
    this.mossLevel = levelOf(pcm);
    if (this.heardAt !== undefined) {
      const ms = performance.now() - this.heardAt;
      this.heardAt = undefined;
      this.replyTotal += ms;
      this.qos.replies++;
      this.qos.replyMs = Math.round(ms);
      this.qos.replyMeanMs = Math.round(this.replyTotal / this.qos.replies);
    }
    const buffer = out.createBuffer(1, pcm.length, mossOutRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) samples[i] = (pcm[i] ?? 0) / 0x8000;
    const source = out.createBufferSource();
    source.buffer = buffer;
    source.connect(out.destination);
    const queued = this.playback.queue(piece, buffer.duration, out.currentTime);
    this.qos.gaps = this.playback.gaps;
    this.sources.set(queued, source);
    source.start(queued.at);
    source.onended = () => {
      this.sources.delete(queued);
      this.tell(this.playback.ended(queued));
      if (this.playback.playing.length === 0) this.mossLevel = 0;
    };
  }

  /** The owner talked over it, or MOSS stopped: what is still playing stops now, and how far it got is said. */
  private cut(run: string, turn: string) {
    const { stop, actions } = this.playback.cut(run, turn, this.out?.currentTime ?? 0);
    for (const q of stop) this.silence(q);
    if (actions.length > 0) this.mossLevel = 0;
    this.tell(actions);
  }

  private silence(q: Queued) {
    const source = this.sources.get(q);
    this.sources.delete(q);
    if (!source) return;
    source.onended = null;
    source.stop();
  }

  mute(on: boolean) {
    if (this.phase !== "live" || this.muted === on) return;
    this.muted = on;
    this.send({ action: "mic_state", enabled: !on });
  }

  end() {
    if (this.phase === "idle" || this.phase === "ending") return;
    this.phase = "ending";
    this.ws?.close(1000);
    this.stop();
  }

  private measure() {
    const out = this.out;
    this.qos = {
      ...this.qos,
      upKbps: Math.round((this.window.up * 8) / 1000),
      downKbps: Math.round((this.window.down * 8) / 1000),
      framesPerSecond: this.window.frames,
      backlog: this.ws?.bufferedAmount ?? 0,
      aheadMs: out ? this.playback.aheadMs(out.currentTime) : 0,
    };
    this.window = { up: 0, down: 0, frames: 0 };
    this.changed();
  }

  private stop(problem?: string) {
    clearInterval(this.tick);
    this.tick = undefined;
    this.heardAt = undefined;
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(1000);
    this.mic?.stream.getTracks().forEach((x) => x.stop());
    void this.mic?.context.close();
    this.mic = undefined;
    for (const q of this.playback.playing) this.silence(q);
    this.playback.clear();
    void this.out?.close();
    this.out = undefined;
    this.piece = undefined;
    this.micLevel = 0;
    this.mossLevel = 0;
    this.muted = false;
    if (problem) this.problem = problem;
    this.phase = "idle";
    this.changed();
  }
}
