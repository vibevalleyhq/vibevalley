import { MossEngine } from "@vibevalley/ai/realtime/moss";
import { type MossEvent, type MossMessages, type MossPhase, type MossQos, type MossSetup, type MossTurn, noQos } from "@vibevalley/ai/realtime/moss-session";
import { t } from "@vibevalley/i18n";
import { mossLinePath } from "@vibevalley/protocol";
import { mossInRate, mossOutRate } from "@vibevalley/provider/moss";
import { visionBufferedBytes, visionFrameBytes } from "@vibevalley/provider/moss/vision";

import type { VoiceDriver } from "./contract.ts";
import { openMossRelayBridge, type MossRelayBridge } from "./moss-worker.ts";
import { mossCaptureWorkletCode, mossPlaybackWorkletCode } from "./moss-worklets.ts";
import { canCapture, localRelayHost, VisualCapture, type VisualSource } from "./visual-capture.ts";

let captureUrl: string | undefined;
let playbackUrl: string | undefined;

export class MossLine implements VoiceDriver<MossSetup, "user" | "moss"> {
  private static active: MossLine | undefined;
  phase: MossPhase = "idle";
  problem: string | undefined;
  muted = false;
  micLevel = 0;
  mossLevel = 0;
  turns: MossTurn[] = [];
  events: MossEvent[] = [];
  qos: MossQos = noQos();
  version = 0;
  visualSource: VisualSource | undefined;
  visualProblem: string | undefined;

  private generation = 0;
  private mediaGeneration: number | undefined;
  private bridge: MossRelayBridge | undefined;
  private tick: number | undefined;
  private mic: { stream: MediaStream; context: AudioContext; node: AudioWorkletNode } | undefined;
  private out: { context: AudioContext; node: AudioWorkletNode } | undefined;
  private releasePendingMedia: (() => void) | undefined;
  private readonly engine: MossEngine;
  private readonly messages: MossMessages;
  private readonly listeners = new Set<() => void>();
  private readonly visual = new VisualCapture({
    ready: () => this.phase === "live" && (this.bridge?.bufferedAmount() ?? Infinity) < visionBufferedBytes,
    maxBytes: () => visionFrameBytes,
    frame: (bytes) => {
      if (this.visualSource) this.engine.videoFrame(bytes, this.visualSource);
    },
    failed: (problem) => {
      this.stopVisual();
      this.visualProblem = problem;
      this.syncFromEngine();
    },
  });

  constructor(messages: MossMessages) {
    this.messages = messages;
    this.engine = new MossEngine({
      sendText: (json) => this.bridge?.sendText(json),
      sendBinary: (bytes) => this.bridge?.sendBinary(bytes),
      bufferedAmount: () => this.bridge?.bufferedAmount() ?? 0,
      nowSeconds: () => this.out?.context.currentTime ?? performance.now() / 1000,
      nowMs: () => performance.now(),
      onReadyForMedia: () => void this.openMedia(),
      onEnqueueAudio: (piece, pcm) => this.bridge?.enqueuePlayback(piece.chunk, piece.run, piece.turn, pcm),
      onCutAudio: (run, turn) => this.bridge?.cutPlayback(run, turn),
      onChange: () => this.syncFromEngine(),
      onEnd: () => this.stop(this.engine.problem),
    });
  }

  get inputLevel(): number {
    return this.micLevel;
  }
  get outputLevel(): number {
    return this.mossLevel;
  }

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };

  private syncFromEngine(): void {
    this.phase = this.engine.phase;
    this.problem = this.engine.problem?.startsWith("live_") === true ? t("web.voice.moss.requestFailed") : this.engine.problem;
    this.muted = this.engine.muted;
    this.micLevel = this.engine.micLevel;
    this.mossLevel = this.engine.mossLevel;
    this.turns = this.engine.turns;
    this.events = this.engine.events;
    this.qos = this.engine.qos;
    this.version++;
    for (const f of this.listeners) f();
  }

  async start(setup: MossSetup): Promise<void> {
    if (this.phase !== "idle") return;
    if (!localRelayHost(location.hostname)) {
      this.engine.reset(t("web.voice.moss.localOnly"));
      return;
    }
    if (MossLine.active && MossLine.active !== this) {
      this.engine.reset(t("web.voice.moss.busy"));
      return;
    }
    MossLine.active = this;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.visualProblem = undefined;
    this.engine.begin(setup);
    document.addEventListener("visibilitychange", this.background);
    window.addEventListener("pagehide", this.leave);
    this.tick = window.setInterval(() => {
      this.bridge?.measure();
      this.engine.measure();
    }, 1000);
    const url = new URL(mossLinePath, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    try {
      this.bridge = openMossRelayBridge(url.href, {
        onOpen: () => {
          if (current()) this.engine.socketOpened();
        },
        onText: (data) => {
          if (current()) this.engine.socketText(data);
        },
        onBinary: (data) => {
          if (current()) this.engine.socketBinary(data);
        },
        onMicSent: (byteLength, level) => {
          if (current()) this.engine.micSentFromWorker(byteLength, level);
        },
        onChunkEnded: (chunk, run, _turn, aheadMs) => {
          if (current()) this.engine.chunkEndedById(chunk, run, aheadMs);
        },
        onOutLevel: (level, aheadMs) => {
          if (current()) this.engine.outLevelChanged(level, aheadMs);
        },
        onAudioStopped: (run, turn, partialMs) => {
          if (current()) this.engine.audioStopped(run, turn, partialMs);
        },
        onClose: (opened, code, reason) => {
          if (!current()) return;
          if (!opened)
            void fetch(url.href.replace(/^ws/u, "http"))
              .then((response) => response.text())
              .then(
                (why) => {
                  if (current()) this.stop(why || this.messages.closed());
                },
                () => {
                  if (current()) this.stop(this.messages.closed());
                },
              );
          else this.stop(code === 1000 || this.phase === "ending" ? undefined : reason || this.messages.closed());
        },
      });
    } catch (error) {
      if (current()) this.stop(this.messages.formatError(error));
    }
  }

  private async openMedia(): Promise<void> {
    const generation = this.generation;
    if (this.mediaGeneration === generation || this.phase !== "connecting") return;
    this.mediaGeneration = generation;
    const current = () => generation === this.generation && this.phase === "connecting";
    let stream: MediaStream | undefined;
    let input: AudioContext | undefined;
    let output: AudioContext | undefined;
    let installed = false;
    const release = () => {
      stream?.getTracks().forEach((track) => track.stop());
      if (input && input.state !== "closed") void input.close();
      if (output && output.state !== "closed") void output.close();
    };
    this.releasePendingMedia = release;
    try {
      output = new AudioContext({ sampleRate: mossOutRate });
      await output.audioWorklet.addModule((playbackUrl ??= URL.createObjectURL(new Blob([mossPlaybackWorkletCode], { type: "text/javascript" }))));
      if (!current()) return;
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (!current()) return;
      input = new AudioContext({ sampleRate: mossInRate });
      await input.audioWorklet.addModule((captureUrl ??= URL.createObjectURL(new Blob([mossCaptureWorkletCode], { type: "text/javascript" }))));
      if (!current()) return;
      const outNode = new AudioWorkletNode(output, "vibevalley-moss-playback", { outputChannelCount: [1] });
      outNode.connect(output.destination);
      const inNode = new AudioWorkletNode(input, "vibevalley-moss-capture", { channelCount: 1 });
      input.createMediaStreamSource(stream).connect(inNode);
      inNode.connect(input.destination);
      this.out = { context: output, node: outNode };
      this.mic = { stream, context: input, node: inNode };
      const captureChannel = new MessageChannel();
      const playbackChannel = new MessageChannel();
      inNode.port.postMessage({ type: "connect", port: captureChannel.port1 }, [captureChannel.port1]);
      outNode.port.postMessage({ type: "connect", port: playbackChannel.port1 }, [playbackChannel.port1]);
      this.bridge?.attachWorkletPorts(captureChannel.port2, playbackChannel.port2);
      for (const track of stream.getTracks())
        track.addEventListener(
          "ended",
          () => {
            if (generation === this.generation) this.stop(this.messages.noMic());
          },
          { once: true },
        );
      installed = true;
      this.engine.mediaOpened();
      this.bridge?.setMic(true);
    } catch (error) {
      if (generation === this.generation)
        this.stop(error instanceof Error && error.name === "NotAllowedError" ? this.messages.noMic() : this.messages.formatError(error));
    } finally {
      if (!installed) release();
      if (this.releasePendingMedia === release) this.releasePendingMedia = undefined;
    }
  }

  mute(on: boolean): void {
    if (this.phase !== "live" || this.muted === on) return;
    this.bridge?.setMic(!on);
    this.mic?.node.port.postMessage({ type: "mute", muted: on });
    this.engine.mute(on);
  }

  async startVisual(source: VisualSource): Promise<void> {
    if (this.phase !== "live" || this.visualSource) return;
    if (!canCapture(source)) {
      this.visualProblem = t("web.voice.vision.unavailable");
      this.syncFromEngine();
      return;
    }
    this.visualProblem = undefined;
    this.visualSource = source;
    this.engine.videoState(source, true);
    this.engine.videoFocus(source);
    this.syncFromEngine();
    await this.visual.start(source);
  }

  stopVisual(): void {
    this.visual.stop();
    if (this.visualSource) this.engine.videoState(this.visualSource, false);
    this.visualSource = undefined;
    this.syncFromEngine();
  }

  private background = () => {
    if (document.hidden) this.end();
  };
  private leave = () => this.end();

  end(): void {
    if (this.phase === "idle") return;
    this.stop();
  }

  private stop(problem?: string): void {
    this.generation++;
    if (MossLine.active === this) MossLine.active = undefined;
    this.releasePendingMedia?.();
    this.releasePendingMedia = undefined;
    this.stopVisual();
    clearInterval(this.tick);
    this.tick = undefined;
    document.removeEventListener("visibilitychange", this.background);
    window.removeEventListener("pagehide", this.leave);
    const bridge = this.bridge;
    this.bridge = undefined;
    bridge?.setMic(false);
    bridge?.close();
    this.mic?.node.disconnect();
    this.mic?.stream.getTracks().forEach((track) => track.stop());
    if (this.mic?.context.state !== "closed") void this.mic?.context.close();
    this.mic = undefined;
    this.out?.node.disconnect();
    if (this.out?.context.state !== "closed") void this.out?.context.close();
    this.out = undefined;
    this.engine.reset(problem);
  }
}
