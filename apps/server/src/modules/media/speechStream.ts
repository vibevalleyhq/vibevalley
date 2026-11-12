import { timeoutError } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { BizCode, refuseIn } from "#/base/errors.ts";
import { bestEffort } from "#/infra/log.ts";
import type { SpeechEvent } from "#/modules/provider/vendors.ts";

import { type AudioStreamDeps, releaseAudioResult, saveAudioStream, type MediaInputs } from "./audioResult.ts";
import { inTime, untilAborted } from "./job.ts";

const refused = refuseIn(BizCode.MediaRefused);
const streamMs = 5 * 60_000;

export interface SpeechStreamSaved {
  attachment?: T.Attachment;
  resultInput: T.MediaInputReference | null;
  metadata: NonNullable<T.MediaSpeechJob["metadata"]>;
  usage?: T.MediaAudioUsage;
  complete: boolean;
}
export interface SpeechStreamPorts {
  inputs: MediaInputs;
  task: (id: string) => Promise<void>;
  /** Waits while the page is behind: the vendor's stream is read no faster than the page takes it. */
  emit: (event: T.MediaSpeechEvent, signal?: AbortSignal) => Promise<void>;
  save: (result: SpeechStreamSaved) => Promise<void>;
}

/** The vendor's spoken PCM relayed to the page as it comes and kept whole (or as much as came) as a WAV. Past five
 * minutes it stops with a TimeoutError; stopped or failed, what came so far is still kept. */
export async function receiveSpeechStream(
  deps: AudioStreamDeps,
  id: string,
  events: (signal: AbortSignal) => AsyncIterable<SpeechEvent>,
  ports: SpeechStreamPorts,
  signal: AbortSignal,
): Promise<void> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let sequence = 0;
  let pending: Uint8Array = new Uint8Array(0);
  let format: { sampleRate: number; channels: number; bitDepth: number } | undefined;
  let usage: T.MediaAudioUsage | undefined;
  let duration: number | undefined;
  let complete = false;
  /** What came so far, kept; only the staging is stopped by the signal, and a result the job will not take is let go. */
  const save = async (stop?: AbortSignal) => {
    if (!format || size === 0) return;
    const actual = format;
    const block = format.channels * 2;
    const length = size - (size % block);
    if (length === 0) return;
    const bytes = Buffer.allocUnsafe(44);
    bytes.write("RIFF", 0);
    bytes.writeUInt32LE(36 + length, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(format.channels, 22);
    bytes.writeUInt32LE(format.sampleRate, 24);
    bytes.writeUInt32LE(format.sampleRate * block, 28);
    bytes.writeUInt16LE(block, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(length, 40);
    async function* source() {
      yield bytes;
      let remaining = length;
      for (const chunk of chunks) {
        const part = chunk.subarray(0, remaining);
        remaining -= part.byteLength;
        yield part;
      }
    }
    const saved = await saveAudioStream(deps, id, "wav", source(), ports.inputs, `moss-${id}${complete ? "" : "-partial"}.wav`, stop);
    try {
      await ports.save({
        ...saved,
        metadata: {
          source: complete && duration !== undefined ? "provider" : "file",
          sampleRate: actual.sampleRate,
          channels: actual.channels,
          bitDepth: 16,
          duration: complete && duration !== undefined ? duration : length / (actual.sampleRate * block),
        },
        ...(usage === undefined ? {} : { usage }),
        complete,
      });
    } catch (e) {
      await releaseAudioResult(deps, id, saved, ports.inputs);
      throw e;
    }
  };
  const take = async (event: SpeechEvent, within: AbortSignal) => {
    switch (event.type) {
      case "task.created":
        await ports.task(event.taskId);
        return;
      case "speech.created":
        if (event.bitDepth !== 16) throw refused(t("server.media.speechInvalid"));
        format = { sampleRate: event.sampleRate, channels: event.channels, bitDepth: event.bitDepth };
        await ports.emit({ type: "format", sampleRate: event.sampleRate, channels: event.channels, bitDepth: 16 }, within);
        return;
      case "speech.audio.delta": {
        if (!format || size + event.audio.byteLength > 128 * 1024 * 1024 - 44) throw refused(t("server.media.speechInvalid"));
        const block = format.channels * 2;
        chunks.push(event.audio);
        size += event.audio.byteLength;
        const joined = pending.byteLength === 0 ? event.audio : Buffer.concat([pending, event.audio]);
        const available = joined.byteLength - (joined.byteLength % block);
        pending = joined.slice(available);
        const step = Math.floor(32768 / block) * block;
        for (let offset = 0; offset < available; offset += step) {
          const part = joined.subarray(offset, Math.min(available, offset + step));
          await ports.emit(
            { type: "audio", sequence: sequence++, audio: Buffer.from(part.buffer, part.byteOffset, part.byteLength).toString("base64") },
            within,
          );
        }
        return;
      }
      case "speech.audio.done":
        if (size === 0 || pending.byteLength !== 0) throw refused(t("server.media.speechInvalid"));
        usage = event.usage;
        duration = event.durationSeconds;
        complete = true;
        return;
    }
  };
  try {
    await inTime(
      async (within) => {
        for await (const event of untilAborted(events(within), within)) await take(event, within);
      },
      streamMs,
      { clock: deps.clock, signal, timedOut: () => timeoutError(streamMs, "the speech stream") },
    );
  } catch (e) {
    if (signal.aborted) {
      await bestEffort(deps.log, "Partial speech stream could not be saved", () => save());
      throw e;
    }
    await save(signal);
    throw e;
  }
  await save(signal);
  await ports.emit({ type: "done" }, signal);
}
