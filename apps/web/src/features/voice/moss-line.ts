import { MossEngine } from "@vibevalley/ai/realtime/moss";
import { type MossEvent, type MossMessages, type MossPhase, type MossQos, type MossSetup, type MossTurn, noQos } from "@vibevalley/ai/realtime/moss-session";
import { mossLinePath } from "@vibevalley/protocol";
import { mossInRate, mossOutRate } from "@vibevalley/provider/moss";

import type { VoiceDriver } from "./contract.ts";
import { openMossRelayBridge, type MossRelayBridge } from "./moss-worker.ts";
import { mossCaptureWorkletCode, mossPlaybackWorkletCode } from "./moss-worklets.ts";

let captureUrl: string | undefined;
let playbackUrl: string | undefined;

// Transfer audio ports directly: PCM must not pass through the UI thread.
export class MossLine implements VoiceDriver<MossSetup, "owner" | "moss"> {
  phase: MossPhase = "idle";
  problem: string | undefined = undefined;
  muted = false;
  micLevel = 0;
  mossLevel = 0;
  turns: MossTurn[] = [];
  events: MossEvent[] = [];
  qos: MossQos = noQos();
  version = 0;

  private bridge: MossRelayBridge | undefined = undefined;
  private tick: ReturnType<typeof setInterval> | undefined = undefined;
  private mic: { stream: MediaStream; context: AudioContext; node: AudioWorkletNode } | undefined = undefined;
  private out: { context: AudioContext; node: AudioWorkletNode } | undefined = undefined;
  private readonly engine: MossEngine;
  private readonly listeners = new Set<() => void>();
  private readonly messages: MossMessages;

  constructor(messages: MossMessages) {
    this.messages = messages;
    this.engine = new MossEngine({
      sendText: (json) => this.bridge?.sendText(json),
      sendBinary: (bytes) => this.bridge?.sendBinary(bytes),
      bufferedAmount: () => this.bridge?.bufferedAmount() ?? 0,
      nowSeconds: () => this.out?.context.currentTime ?? performance.now() / 1000,
      nowMs: () => performance.now(),
      onReadyForMedia: () => void this.openMedia(),
      onEnqueueAudio: () => {},
      onCutAudio: (run, turn) => this.bridge?.cutPlayback(run, turn),
      onChange: () => this.syncFromEngine(),
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
    this.problem = this.engine.problem;
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
    this.engine.begin(setup);
    this.tick = setInterval(() => this.engine.measure(), 1000);
    const url = new URL(mossLinePath, location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const bridge = openMossRelayBridge(url.href, {
      onOpen: () => this.engine.socketOpened(),
      onText: (data) => this.engine.socketText(data),
      onBinary: (data) => this.engine.socketBinary(data),
      onAudioMeta: (byteLength, samples, level) => {
        this.engine.socketBinary(new ArrayBuffer(samples > 0 ? samples * 2 : byteLength));
        this.engine.outLevelChanged(level, this.engine.qos.aheadMs);
      },
      onMicSent: (byteLength, level) => this.engine.micSentFromWorker(byteLength, level),
      onChunkEnded: (chunk, run, _turn, aheadMs) => this.engine.chunkEndedById(chunk, run, aheadMs),
      onOutLevel: (level, aheadMs) => this.engine.outLevelChanged(level, aheadMs),
      onClose: (opened, code, reason) => {
        if (this.bridge !== bridge) return;
        if (!opened)
          void fetch(url.href.replace(/^ws/u, "http"))
            .then((r) => r.text())
            .then(
              (why) => this.stop(why || this.messages.closed()),
              () => this.stop(this.messages.closed()),
            );
        else this.stop(code === 1000 || this.phase === "ending" ? undefined : reason || this.messages.closed());
      },
    });
    this.bridge = bridge;
  }

  private async openMedia(): Promise<void> {
    try {
      const outContext = new AudioContext({ sampleRate: mossOutRate });
      await outContext.audioWorklet.addModule((playbackUrl ??= URL.createObjectURL(new Blob([mossPlaybackWorkletCode], { type: "text/javascript" }))));
      const outNode = new AudioWorkletNode(outContext, "vibevalley-moss-playback", { outputChannelCount: [1] });
      outNode.connect(outContext.destination);
      this.out = { context: outContext, node: outNode };

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      const inContext = new AudioContext({ sampleRate: mossInRate });
      await inContext.audioWorklet.addModule((captureUrl ??= URL.createObjectURL(new Blob([mossCaptureWorkletCode], { type: "text/javascript" }))));
      if (this.phase !== "connecting") {
        stream.getTracks().forEach((x) => x.stop());
        void inContext.close();
        void outContext.close();
        this.out = undefined;
        return;
      }
      const inNode = new AudioWorkletNode(inContext, "vibevalley-moss-capture", { channelCount: 1 });
      inContext.createMediaStreamSource(stream).connect(inNode);
      inNode.connect(inContext.destination);
      this.mic = { stream, context: inContext, node: inNode };

      const captureChannel = new MessageChannel();
      const playbackChannel = new MessageChannel();
      inNode.port.postMessage({ type: "connect", port: captureChannel.port1 }, [captureChannel.port1]);
      outNode.port.postMessage({ type: "connect", port: playbackChannel.port1 }, [playbackChannel.port1]);
      this.bridge?.attachWorkletPorts(captureChannel.port2, playbackChannel.port2);

      this.engine.mediaOpened();
    } catch (e) {
      this.stop(e instanceof Error && e.name === "NotAllowedError" ? this.messages.noMic() : this.messages.formatError(e));
    }
  }

  mute(on: boolean): void {
    if (this.phase !== "live" || this.muted === on) return;
    this.mic?.node.port.postMessage({ type: "mute", muted: on });
    this.engine.mute(on);
  }

  end(): void {
    if (this.phase === "idle" || this.phase === "ending") return;
    this.phase = "ending";
    this.stop();
  }

  private stop(problem?: string): void {
    clearInterval(this.tick);
    this.tick = undefined;
    const bridge = this.bridge;
    this.bridge = undefined;
    bridge?.close();
    this.mic?.stream.getTracks().forEach((x) => x.stop());
    void this.mic?.context.close();
    this.mic = undefined;
    void this.out?.context.close();
    this.out = undefined;
    this.engine.reset(problem);
  }
}
