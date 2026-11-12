import { transcribe, type TranscriptionEndEvent, type TranscriptionModel } from "ai";

import { TranscriptionFormat } from "@vibevalley/provider/transcription";

/** A recording in a format transcription does not take. */
export class UnsupportedFormat extends Error {
  override readonly name = "UnsupportedFormat";
  readonly _tag = "UnsupportedFormat";
  readonly format: string;
  constructor(format: string) {
    super(`unsupported audio format: ${format}`);
    this.format = format;
  }
}

/** No audio, or not base64. */
export class EmptyAudio extends Error {
  override readonly name = "EmptyAudio";
  readonly _tag = "EmptyAudio";
  constructor() {
    super("the audio is empty");
  }
}

export class AudioTooLong extends Error {
  override readonly name = "AudioTooLong";
  readonly _tag = "AudioTooLong";
  constructor() {
    super("the audio is longer than 25 MiB");
  }
}

/** The model call failed; cause is its own failure, as it threw it. */
export class TranscriptionFailed extends Error {
  override readonly name = "TranscriptionFailed";
  readonly _tag = "TranscriptionFailed";
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

/** The recording, checked before any model is called; a bad one throws UnsupportedFormat, EmptyAudio or AudioTooLong. */
export async function transcriptionAudio(audio64: string, given: string): Promise<{ readonly audio: Buffer; readonly format: TranscriptionFormat }> {
  const format = given.trim().replace(/^\./u, "").toLowerCase();
  const decoded = TranscriptionFormat.safeParse(format);
  if (!decoded.success) throw new UnsupportedFormat(format);
  const audio = Buffer.from(audio64, "base64");
  if (audio.length === 0 || audio.toString("base64").replace(/=+$/u, "") !== audio64.replace(/=+$/u, "").replace(/\s/gu, "")) throw new EmptyAudio();
  if (audio.length > 25 << 20) throw new AudioTooLong();
  return { audio, format: decoded.data };
}

/** One model call, no retries; the signal goes to the model. */
export async function transcribeAudio(model: Exclude<TranscriptionModel, string>, audio: Uint8Array, signal?: AbortSignal) {
  // Core 7.0.164 emits usage in onEnd but omits it from TranscriptionResult.
  let usage: TranscriptionEndEvent["usage"];
  let result: Awaited<ReturnType<typeof transcribe>>;
  try {
    result = await transcribe({
      model,
      audio,
      // Core reads a signal it is given; one never aborted when the caller has none.
      abortSignal: signal ?? new AbortController().signal,
      maxRetries: 0,
      telemetry: {
        recordInputs: false,
        recordOutputs: false,
        integrations: [
          {
            onEnd: (event: TranscriptionEndEvent) => {
              usage = event.usage;
            },
          },
        ],
      },
    });
  } catch (cause) {
    throw new TranscriptionFailed(cause);
  }
  return { ...result, usage };
}
