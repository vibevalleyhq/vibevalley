import { onSettled } from "solid-js";

import { dictateRate, encodeWavBase64, float32RmsLevel as rmsLevel } from "@vibevalley/ai/audio";
import { t } from "@vibevalley/i18n";

import { createExternal } from "#/base/external.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { ready, useSettings } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";

import { dictateWorkletCode, insertDictated } from "./dictation-input.ts";

export type DictationPhase = "idle" | "recording" | "transcribing";
export type DictationState = "unset" | DictationPhase;

let captureUrl: string | undefined;

interface Recording {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  /** What the meter reads: the microphone's last few milliseconds. */
  readonly meter: AnalyserNode;
  readonly chunks: Float32Array[];
  readonly onWords: (words: string) => void;
}

class Dictation {
  phase: DictationPhase = "idle";
  problem = "";
  version = 0;
  /** When the recording asked for the microphone (performance.now()); 0 when not recording. */
  startedAt = 0;
  private recording: Recording | undefined = undefined;
  private readonly samples = new Float32Array(512);
  /** Whose recording the problem is about: that field's box says it. */
  private blamed: object | undefined = undefined;
  /** The field it was started from: the words go there, or nowhere once it is gone. */
  private owner: object | undefined = undefined;
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private releasePending: (() => void) | undefined;
  private background = () => {
    if (document.hidden && this.owner) this.release(this.owner);
  };
  private leave = () => {
    if (this.owner) this.release(this.owner);
  };

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };

  /** problem: "" clears it; left out, it stays. */
  private set(phase: DictationPhase, problem?: string) {
    this.phase = phase;
    if (problem !== undefined) this.problem = problem;
    if (this.problem === "") this.blamed = undefined;
    this.version++;
    for (const f of this.listeners) f();
  }

  /** Starts for `owner`, or stops and transcribes when it is recording; a second field may stop it, not take it over. */
  async toggle(owner: object, onWords: (words: string) => void) {
    if (this.phase === "transcribing") return;
    if (this.phase === "recording") return this.finish();
    const generation = ++this.generation;
    document.addEventListener("visibilitychange", this.background);
    window.addEventListener("pagehide", this.leave);
    this.owner = owner;
    this.startedAt = performance.now();
    this.set("recording", "");
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    const drop = () => {
      stream?.getTracks().forEach((t) => t.stop());
      if (context && context.state !== "closed") void context.close();
    };
    this.releasePending = drop;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (generation !== this.generation) return drop();
      context = new AudioContext({ sampleRate: dictateRate });
      await context.audioWorklet.addModule((captureUrl ??= URL.createObjectURL(new Blob([dictateWorkletCode], { type: "text/javascript" }))));
      // After every wait: the field may have been released, or another may have stopped it, meanwhile.
      if (generation !== this.generation) return drop();
      const node = new AudioWorkletNode(context, "vibevalley-capture", { channelCount: 1 });
      const chunks: Float32Array[] = [];
      node.port.onmessage = (e: MessageEvent<Float32Array>) => chunks.push(e.data);
      const source = context.createMediaStreamSource(stream);
      source.connect(node);
      const meter = context.createAnalyser();
      meter.fftSize = this.samples.length;
      source.connect(meter);
      // Connected on to the output (it writes silence there), as a node nobody pulls may not be run.
      node.connect(context.destination);
      this.recording = { stream, context, node, meter, chunks, onWords };
      this.releasePending = undefined;
      for (const track of stream.getTracks())
        track.addEventListener(
          "ended",
          () => {
            if (generation === this.generation) this.cancel(owner);
          },
          { once: true },
        );
    } catch (e) {
      drop();
      if (generation !== this.generation) return;
      this.close();
      this.owner = undefined;
      this.startedAt = 0;
      this.blamed = owner;
      this.set(
        "idle",
        e instanceof Error && e.name === "NotAllowedError" ? t("web.voice.dictation.noMic") : t("web.voice.dictation.cannot", { why: reasonOf(e) }),
      );
    } finally {
      if (this.releasePending === drop) this.releasePending = undefined;
    }
  }

  /** Whether `owner` started what is going on now: the field whose box shows it. */
  owns(owner: object) {
    return this.owner === owner;
  }

  /** How loud the microphone is now, 0 to 1 (its RMS, lifted so speech fills most of it); 0 when not recording. */
  level(): number {
    const r = this.recording;
    if (!r) return 0;
    r.meter.getFloatTimeDomainData(this.samples);
    return rmsLevel(this.samples);
  }

  /** Stops and transcribes what `owner` started. */
  done(owner: object) {
    if (this.owner === owner && this.phase === "recording") void this.finish();
  }

  /** Stops what `owner` started and drops it, untranscribed. */
  cancel(owner: object) {
    if (this.owner !== owner || this.phase !== "recording") return;
    this.generation++;
    this.owner = undefined;
    this.close();
    this.set("idle", "");
  }

  /** Why the last recording `owner` started failed; "" when it did not, or another field's did. */
  problemFor(owner: object) {
    return this.blamed === owner ? this.problem : "";
  }

  /** The owner has read why the last one failed. */
  dismiss() {
    if (this.problem !== "") this.set(this.phase, "");
  }

  /** The field it was started for is gone: what it hears goes nowhere. */
  release(owner: object) {
    if (this.owner !== owner) return;
    this.generation++;
    this.owner = undefined;
    this.close();
    this.set("idle");
  }

  private close() {
    document.removeEventListener("visibilitychange", this.background);
    window.removeEventListener("pagehide", this.leave);
    this.releasePending?.();
    this.releasePending = undefined;
    const r = this.recording;
    this.recording = undefined;
    this.startedAt = 0;
    if (!r) return;
    r.node.disconnect();
    r.meter.disconnect();
    r.stream.getTracks().forEach((t) => t.stop());
    void r.context.close();
  }

  private async finish() {
    const generation = ++this.generation;
    const r = this.recording;
    const owner = this.owner;
    this.close();
    if (!r) {
      this.owner = undefined;
      return this.set("idle");
    }
    this.set("transcribing");
    try {
      const audio = encodeWavBase64(r.chunks);
      if (!audio) throw new Error(t("web.voice.dictation.nothing"));
      const said = await api.voice.dictate({ audio, format: "wav" });
      if (generation !== this.generation) return;
      if (this.owner === owner && said.text) r.onWords(said.text);
      this.set("idle", "");
    } catch (e) {
      if (generation !== this.generation) return;
      this.blamed = owner;
      this.set("idle", reasonOf(e));
    } finally {
      if (generation === this.generation) this.owner = undefined;
    }
  }
}

/** The page's one recorder. */
export const dictation = new Dictation();

/** One field's hold on the page's recorder: the words go into it at its caret, for the user to read before sending. */
export function useDictation(field: {
  input: () => HTMLTextAreaElement | HTMLInputElement | undefined;
  value: () => string;
  onValue: (v: string, caret: number) => void;
}) {
  const version = createExternal(dictation.subscribe, () => dictation.version);
  const me = {};
  onSettled(() => () => dictation.release(me));
  // Unknown until the settings are read; the server says what is missing then.
  const settings = useSettings();
  const router = useRouter();
  const off = () => ready(settings, undefined)?.readiness.dictation.ready === false;
  const toggle = () =>
    // Like an event handler, it reads the field as it is when the words come.
    void dictation.toggle(me, (words) => {
      const el = field.input();
      const now = field.value();
      const start = el?.selectionStart ?? now.length;
      const end = el?.selectionEnd ?? now.length;
      const next = insertDictated(now, start, end, words);
      field.onValue(next.value, next.caret);
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(next.caret, next.caret);
      });
    });
  return {
    state: (): DictationState => (off() ? "unset" : (version(), dictation.phase)),
    /** This field started what is going on now. */
    mine: () => (version(), dictation.owns(me)),
    problem: () => (version(), dictation.problemFor(me)),
    toggle,
    done: () => dictation.done(me),
    cancel: () => dictation.cancel(me),
    dismiss: () => dictation.dismiss(),
    setUp: () => router.navigate("/settings/dictation"),
  };
}

export type Dictating = ReturnType<typeof useDictation>;

/** What a box's key does while its field listens: Esc drops the recording, Enter stops it and fills in the words. Gives
 * true when it took the key. */
export function dictationKey(d: Dictating, e: KeyboardEvent): boolean {
  if (e.isComposing || !d.mine() || d.state() !== "recording") return false;
  if (e.key === "Escape") d.cancel();
  else if (e.key === "Enter" && !e.shiftKey) d.done();
  else return false;
  e.preventDefault();
  e.stopPropagation();
  return true;
}
