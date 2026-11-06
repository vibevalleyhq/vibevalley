import { type Cause, Effect, Schema } from "effect";
import { HttpBody, HttpClient, type HttpClientError } from "effect/http";

import { float32RmsLevel } from "../core/contract.ts";

export const dictateRate = 16000;

/** MOSS's transcription (platform.mosi.cn/docs/reference/transcriptions): OpenAI's /audio/transcriptions, with the same key as MOSS Live. */
export const mossTranscription = { url: "https://api.mosi.cn/v1", model: "moss-transcribe-1.0" } as const;

/** OpenAI's own cap on one recording. */
const dictateMaxBytes = 25 << 20;

const dictateFormats: Record<string, string> = {
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

const DictationResponseSchema = Schema.fromJsonString(
  Schema.Struct({
    text: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) })),
  }),
);

// An AudioWorklet's module, as a script of its own: it hands the microphone's samples on in runs of 4096, so the page
// is not woken every 128.
export const dictateWorkletCode = `registerProcessor("vibevalley-capture", class extends AudioWorkletProcessor {
  run = new Float32Array(4096);
  at = 0;
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples)
      for (const s of samples) {
        this.run[this.at++] = s;
        if (this.at === this.run.length) {
          this.port.postMessage(this.run);
          this.run = new Float32Array(4096);
          this.at = 0;
        }
      }
    return true;
  }
});`;

/** Mono 16-bit PCM in a WAV file. */
function wavOf(samples: Float32Array, sampleRate = dictateRate): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Uint8Array(out.buffer);
}

const base64Of = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Concatenates recorded Float32Array chunks and encodes them as a base64 WAV string; undefined when no samples were recorded. */
export function encodeWavBase64(chunks: readonly Float32Array[], sampleRate = dictateRate): string | undefined {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  if (total === 0) return undefined;
  const all = new Float32Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return base64Of(wavOf(all, sampleRate));
}

/** How loud the microphone is now, 0 to 1 (its RMS, lifted so speech fills most of it). */
export const rmsLevel = float32RmsLevel;

/** Dictated words at the caret, or at the end: a space only between two Latin words, as Chinese runs on without one. */
export function insertDictated(value: string, start: number, end: number, words: string) {
  const before = value.slice(0, start);
  const ascii = /[A-Za-z0-9]/u;
  const gap = before && ascii.test(before.at(-1) ?? "") && ascii.test(words[0] ?? "") ? " " : "";
  const inserted = gap + words;
  return { value: before + inserted + value.slice(end), caret: start + inserted.length };
}

export type TranscriptionFailure =
  | { readonly _tag: "UnsupportedFormat"; readonly format: string }
  | { readonly _tag: "EmptyAudio" }
  | { readonly _tag: "AudioTooLong" }
  | { readonly _tag: "Unreachable"; readonly why: string }
  | { readonly _tag: "Cut"; readonly why: string }
  | { readonly _tag: "HttpStatus"; readonly status: number; readonly detail: string }
  | { readonly _tag: "InvalidResponse" };

const errorMessage = (u: unknown): string => (u instanceof Error ? u.message : String(u));

/** What an HTTP call's failure says: the network's own words (refused, reset), not the client's wrapper. */
const causeText = (e: HttpClientError.HttpClientError | Cause.TimeoutError) =>
  e._tag === "HttpClientError" && "cause" in e.reason && e.reason.cause !== undefined ? errorMessage(e.reason.cause) : e.message;

/** Validates base64 audio, posts multipart/form-data to `/audio/transcriptions`, and decodes the JSON response via Schema. */
export const transcribeAudio = Effect.fn("Voice.transcribeAudio")(function* (input: {
  readonly url: string;
  readonly model: string;
  readonly key: string;
  readonly audio64: string;
  readonly format: string;
}): Effect.fn.Return<{ readonly text: string }, TranscriptionFailure, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;
  const format = input.format.trim().replace(/^\./u, "").toLowerCase();
  const kind = dictateFormats[format];
  if (!kind) return yield* Effect.fail<TranscriptionFailure>({ _tag: "UnsupportedFormat", format });
  const audio = Buffer.from(input.audio64, "base64");
  if (audio.length === 0 || audio.toString("base64").replace(/=+$/u, "") !== input.audio64.replace(/=+$/u, "").replace(/\s/gu, ""))
    return yield* Effect.fail<TranscriptionFailure>({ _tag: "EmptyAudio" });
  if (audio.length > dictateMaxBytes) return yield* Effect.fail<TranscriptionFailure>({ _tag: "AudioTooLong" });

  const form = new FormData();
  form.append("file", new Blob([audio], { type: kind }), `dictation.${format}`);
  form.append("model", input.model);
  form.append("response_format", "json");

  const res = yield* httpClient
    .post(input.url + "/audio/transcriptions", {
      headers: input.key ? { authorization: "Bearer " + input.key } : {},
      body: HttpBody.formData(form),
    })
    .pipe(
      Effect.timeout("120 seconds"),
      Effect.mapError((e): TranscriptionFailure => ({ _tag: "Unreachable", why: causeText(e) })),
    );
  const raw = (yield* res.text.pipe(Effect.mapError((e): TranscriptionFailure => ({ _tag: "Cut", why: causeText(e) })))).slice(0, 1 << 20);
  const got = Schema.decodeOption(DictationResponseSchema)(raw);
  const detail = got._tag === "Some" ? got.value.error?.message : undefined;
  if (res.status < 200 || res.status >= 300)
    return yield* Effect.fail<TranscriptionFailure>({
      _tag: "HttpStatus",
      status: res.status,
      detail: [...(detail || raw.trim())].slice(0, 200).join(""),
    });
  if (got._tag === "None") return yield* Effect.fail<TranscriptionFailure>({ _tag: "InvalidResponse" });
  return { text: (got.value.text ?? "").trim() };
});
