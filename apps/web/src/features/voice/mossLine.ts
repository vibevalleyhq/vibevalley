import { t } from "@vibevalley/i18n";
// A line to MOSS Live for the playground: the server relays it (mossLinePath) and adds the key; this side speaks MOSS's
// protocol. Up: JSON actions, and the microphone as 20 ms frames of 16 kHz mono PCM, each behind a 0x00 byte. Down: JSON
// events, and the answer as raw 48 kHz mono PCM, each piece announced by a response.audio.context before it. MOSS sends
// only so far ahead of what was played: every piece played is reported (playback.chunk.completed), and a turn played to
// its end or cut off is said too (playback.completed, playback.stopped).

import { mossLinePath } from "@vibevalley/protocol";

export type MossPhase = "idle" | "connecting" | "live" | "ending";

/** One side's words in a turn; done once MOSS has settled them. */
export interface MossTurn {
  readonly who: "owner" | "moss";
  readonly key: string;
  readonly text: string;
  readonly done: boolean;
}

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

const noQos = (): MossQos => ({ upKbps: 0, downKbps: 0, framesPerSecond: 0, backlog: 0, aheadMs: 0, gaps: 0, replies: 0, stops: {} });

export interface MossSetup {
  readonly persona: string;
  readonly instructions: string;
}

const inRate = 16000;
const outRate = 48000;
const frame = 320;

// An AudioWorklet's module, as a script of its own: the microphone in 20 ms frames of 16-bit PCM.
const capture = `registerProcessor("vibevalley-moss-capture", class extends AudioWorkletProcessor {
  run = new Int16Array(${frame});
  at = 0;
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples)
      for (const s of samples) {
        this.run[this.at++] = Math.max(-1, Math.min(1, s)) * 0x7fff;
        if (this.at === this.run.length) {
          this.port.postMessage(this.run.buffer, [this.run.buffer]);
          this.run = new Int16Array(${frame});
          this.at = 0;
        }
      }
    return true;
  }
});`;
let captureUrl: string | undefined;

const noisy = new Set(["input.transcript.updated", "output.transcript.updated", "response.audio.context", "playback.chunk.completed"]);

interface Piece {
  readonly chunk: string;
  readonly run: string;
  readonly turn: string;
}

interface Playing extends Piece {
  readonly source: AudioBufferSourceNode;
  readonly at: number;
  readonly ms: number;
}

/** A field MOSS sends as a string; "" when it is anything else. */
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** 0..100 from a frame's loudness. */
const levelOf = (pcm: Int16Array) => {
  let sum = 0;
  for (const s of pcm) sum += (s / 0x8000) ** 2;
  return Math.min(100, Math.round(Math.sqrt(sum / pcm.length) * 300));
};

export class MossLine {
  phase: MossPhase = "idle";
  problem?: string;
  muted = false;
  micLevel = 0;
  mossLevel = 0;
  turns: MossTurn[] = [];
  events: MossEvent[] = [];
  qos: MossQos = noQos();
  version = 0;

  private ws?: WebSocket;
  /** What passed since the last tick of the QoS clock. */
  private window = { up: 0, down: 0, frames: 0 };
  private tick?: ReturnType<typeof setInterval>;
  /** When the owner's words last ended, waiting for MOSS's first sound; performance.now(). */
  private heardAt?: number;
  private replyTotal = 0;
  /** The answer the last piece belonged to, to tell running dry inside an answer from a new one starting. */
  private lastRun = "";
  private mic?: { stream: MediaStream; context: AudioContext };
  private out?: AudioContext;
  private nextAt = 0;
  private piece?: Piece;
  private playing: Playing[] = [];
  /** Per run: the ms played to the end, and whether MOSS has sent all of it. */
  private played = new Map<string, { ms: number; sent: boolean; turn: string }>();
  private readonly listeners = new Set<() => void>();

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

  private send(action: Record<string, unknown>) {
    const text = JSON.stringify(action);
    this.ws?.send(text);
    this.window.up += text.length;
    if (!noisy.has(String(action.action))) this.log(true, text);
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
        void fetch(url.href.replace(/^ws/, "http"))
          .then((r) => r.text())
          .then(
            (why) => this.stop(why || t("web.voice.moss.closed")),
            () => this.stop(t("web.voice.moss.closed")),
          );
      else this.stop(e.code === 1000 || this.phase === "ending" ? undefined : e.reason || t("web.voice.moss.closed"));
    };
  }

  private event(data: string, setup: MossSetup) {
    let m: { action?: string; data?: Record<string, unknown> };
    try {
      m = JSON.parse(data) as typeof m;
    } catch {
      return;
    }
    if (!noisy.has(m.action ?? "")) this.log(false, data);
    const d = m.data ?? {};
    const text = str(d.text);
    switch (m.action) {
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
        this.words("owner", str(d.turn), text, m.action.endsWith("done"));
        break;
      case "output.transcript.updated":
      case "output.transcript.done":
        this.words("moss", str(d.turn_id), text, m.action.endsWith("done"));
        break;
      case "response.audio.context":
        this.piece = { chunk: str(d.chunk_id), run: str(d.run_id), turn: str(d.turn_id) };
        break;
      case "response.audio.done":
        this.sent(str(d.run_id), str(d.turn_id));
        break;
      case "input.speech.stopped":
        this.heardAt = performance.now();
        break;
      case "response.audio.stop":
        this.qos.stops[str(d.reason) || "?"] = (this.qos.stops[str(d.reason) || "?"] ?? 0) + 1;
        this.cut(str(d.run_id), str(d.turn_id));
        break;
      case "response.interrupted":
        // Cut off, an answer never gets its output.transcript.done: what it got to say is here.
        this.words("moss", str(d.turn_id), str(d.text), true);
        this.cut(str(d.run_id), str(d.turn_id));
        break;
      case "error": {
        const e = d.error as { message?: unknown } | undefined;
        this.problem = typeof e?.message === "string" ? e.message : data;
        break;
      }
      default:
        break;
    }
    this.changed();
  }

  /** The words of a turn so far (MOSS sends them whole each time); a new turn starts a new line. The owner's first
   * updates come before MOSS has named the turn: the line takes the name when it comes. */
  private words(who: MossTurn["who"], key: string, text: string, done: boolean) {
    if (text === "") return;
    let last: MossTurn | undefined;
    for (const x of this.turns) if (x.who === who && !x.done && (x.key === "" || key === "" || x.key === key)) last = x;
    if (last) {
      this.turns = this.turns.map((x) => (x === last ? { ...x, key: key || x.key, text, done } : x));
    } else this.turns = [...this.turns, { who, key, text, done }];
  }

  private async open() {
    try {
      this.out = new AudioContext({ sampleRate: outRate });
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const context = new AudioContext({ sampleRate: inRate });
      await context.audioWorklet.addModule((captureUrl ??= URL.createObjectURL(new Blob([capture], { type: "text/javascript" }))));
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
      this.stop(e instanceof Error && e.name === "NotAllowedError" ? t("web.voice.call.noMic") : e instanceof Error ? e.message : String(e));
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
    if (piece.run === this.lastRun && this.nextAt > 0 && out.currentTime > this.nextAt) this.qos.gaps++;
    this.lastRun = piece.run;
    const buffer = out.createBuffer(1, pcm.length, outRate);
    const samples = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i]! / 0x8000;
    const source = out.createBufferSource();
    source.buffer = buffer;
    source.connect(out.destination);
    const at = Math.max(this.nextAt, out.currentTime);
    source.start(at);
    this.nextAt = at + buffer.duration;
    const playing: Playing = { ...piece, source, at, ms: buffer.duration * 1000 };
    this.playing.push(playing);
    const run = this.played.get(piece.run) ?? { ms: 0, sent: false, turn: piece.turn };
    this.played.set(piece.run, run);
    source.onended = () => {
      if (!this.playing.includes(playing)) return;
      this.playing = this.playing.filter((p) => p !== playing);
      run.ms += playing.ms;
      this.send({ action: "playback.chunk.completed", chunk_id: piece.chunk, run_id: piece.run, turn_id: piece.turn });
      if (this.playing.length === 0) this.mossLevel = 0;
      this.finished(piece.run);
    };
  }

  /** MOSS has sent all of a run: once it has all been played, say so. */
  private sent(run: string, turn: string) {
    const r = this.played.get(run) ?? { ms: 0, sent: false, turn };
    r.sent = true;
    this.played.set(run, r);
    this.finished(run);
  }

  private finished(run: string) {
    const r = this.played.get(run);
    if (!r?.sent || this.playing.some((p) => p.run === run)) return;
    this.played.delete(run);
    this.send({ action: "playback.completed", run_id: run, turn_id: r.turn });
  }

  /** The owner talked over it, or MOSS stopped: what is still playing stops now, and how far it got is said. */
  private cut(run: string, turn: string) {
    const out = this.out;
    const mine = this.playing.filter((p) => p.run === run);
    if (mine.length === 0 && !this.played.has(run)) return;
    let ms = this.played.get(run)?.ms ?? 0;
    for (const p of mine) {
      if (out && out.currentTime > p.at) ms += Math.min(p.ms, (out.currentTime - p.at) * 1000);
      p.source.onended = null;
      p.source.stop();
    }
    this.playing = this.playing.filter((p) => p.run !== run);
    this.nextAt = 0;
    this.mossLevel = 0;
    this.played.delete(run);
    this.send({ action: "playback.stopped", run_id: run, turn_id: turn, played_audio_ms: Math.round(ms) });
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
      aheadMs: out ? Math.max(0, Math.round((this.nextAt - out.currentTime) * 1000)) : 0,
    };
    this.window = { up: 0, down: 0, frames: 0 };
    this.changed();
  }

  private stop(problem?: string) {
    clearInterval(this.tick);
    this.tick = undefined;
    this.heardAt = undefined;
    this.lastRun = "";
    const ws = this.ws;
    this.ws = undefined;
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close(1000);
    this.mic?.stream.getTracks().forEach((x) => x.stop());
    void this.mic?.context.close();
    this.mic = undefined;
    for (const p of this.playing) {
      p.source.onended = null;
      p.source.stop();
    }
    this.playing = [];
    this.played.clear();
    void this.out?.close();
    this.out = undefined;
    this.nextAt = 0;
    this.piece = undefined;
    this.micLevel = 0;
    this.mossLevel = 0;
    this.muted = false;
    if (problem) this.problem = problem;
    this.phase = "idle";
    this.changed();
  }
}

/** The playground's one line. */
export const mossLine = new MossLine();
