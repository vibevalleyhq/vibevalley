import { readFile } from "node:fs/promises";

import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { attachmentMax } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";

import { ApiError, BizCode, refuseIn } from "#/base/errors.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import { type PublicFetch, publicHttps } from "#/infra/publicHttp.ts";
import type { Time } from "#/infra/time.ts";
import type { Attachment } from "#/modules/attachment/attachment.ts";

import { audioResultMax, type StagedAudioResult } from "./input.ts";
import { bodyChunks, inTime } from "./job.ts";
import { validateSpeechBytes } from "./validateSpeechBytes.ts";

const refused = refuseIn(BizCode.MediaRefused);

export interface AudioSavedResult {
  readonly attachment?: T.Attachment;
  readonly resultInput: T.MediaInputReference | null;
  readonly metadata?: NonNullable<T.MediaSpeechJob["metadata"]>;
}

export interface MediaInputs {
  /** Staged against the quota; disposing of it removes the file and gives the reservation back. */
  readonly stageResult: (
    name: string,
    format: T.MediaAudioFormat,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ) => Promise<StagedAudioResult & AsyncDisposable>;
  readonly storeResult: (staged: StagedAudioResult, holder: string, retainSource?: boolean) => Promise<T.MediaInputReference>;
  readonly release: (holder: string) => Promise<void>;
  readonly delete: (id: string) => Promise<void>;
}

export interface AudioStreamDeps {
  readonly files: Attachment;
  readonly log: Logger;
  readonly clock: Time;
}

export interface AudioDownloadDeps extends AudioStreamDeps {
  readonly publicFetch: PublicFetch;
}

const types: Record<T.MediaAudioFormat, readonly string[]> = {
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  mp3: ["audio/mpeg", "audio/mp3"],
  flac: ["audio/flac", "audio/x-flac"],
  aac: ["audio/aac", "audio/aacp"],
  opus: ["audio/opus", "audio/ogg", "application/ogg"],
  pcm: ["audio/pcm", "audio/l16", "application/octet-stream"],
};
const Length = z.coerce.number().int().min(1).max(audioResultMax);
const failed = () => refused(t("server.media.speechDownloadFailed"));
const downloadMs = 300_000;

export const releaseAudioResult = (deps: { readonly log: Logger }, id: string, saved: AudioSavedResult, inputs: MediaInputs) =>
  bestEffort(deps.log, "Media audio result rollback is pending", async () => {
    if (!saved.resultInput) return;
    await inputs.release(id);
    await inputs.delete(saved.resultInput.id);
  });

/** source kept as the job's result: an attachment when it is small enough, else a pinned input. Only the staging is
 * stopped by the signal: a result once staged is kept. */
export async function saveAudioStream(
  deps: AudioStreamDeps,
  id: string,
  format: T.MediaAudioFormat,
  source: AsyncIterable<Uint8Array>,
  inputs: MediaInputs,
  name: string = `moss-${id}.${format}`,
  signal?: AbortSignal,
): Promise<AudioSavedResult> {
  let retained: AudioSavedResult | undefined;
  try {
    await using staged = await inputs.stageResult(name, format, source, signal);
    const metadata = staged.metadata ? { metadata: staged.metadata } : {};
    if (staged.size > attachmentMax) {
      const resultInput = await inputs.storeResult(staged, id);
      retained = { resultInput, ...metadata };
      return retained;
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(staged.path);
    } catch (e) {
      deps.log.warn(`media: staged audio for ${id} could not be read`, e);
      throw failed();
    }
    if (!validateSpeechBytes(buffer, format)) throw failed();
    const attachment = await deps.files.attach({ name: staged.name, type: staged.mime, data: buffer.toString("base64") });
    return { attachment, resultInput: null, ...metadata };
  } catch (e) {
    if (retained) await releaseAudioResult(deps, id, retained, inputs);
    throw e;
  }
}

/** The bytes of a download, held to the size the vendor declared and to audioResultMax; anything off is failed(). */
async function* checked(response: Response, length: number | undefined, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let size = 0;
  try {
    for await (const chunk of bodyChunks(response, signal)) {
      size += chunk.byteLength;
      if (size > audioResultMax || (length !== undefined && size > length)) throw failed();
      yield chunk;
    }
  } catch (e) {
    if (signal.aborted || e instanceof ApiError) throw e;
    throw failed();
  }
  if (length !== undefined && size !== length) throw failed();
}

/** Generated audio fetched from the vendor's public address and kept; past 300 seconds it is failed(). */
export async function saveAudioResult(
  deps: AudioDownloadDeps,
  id: string,
  address: string,
  format: T.MediaAudioFormat,
  inputs: MediaInputs,
  signal?: AbortSignal,
): Promise<AudioSavedResult> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    // An address that is not a URL is a download that cannot be made.
    throw failed();
  }
  if (!publicHttps(url)) throw failed();
  return inTime(
    async (within) => {
      let response: Response;
      try {
        response = await deps.publicFetch(url, { headers: { accept: types[format].join(", ") }, redirect: "manual", signal: within });
      } catch (e) {
        if (within.aborted) throw e;
        deps.log.warn(`media: audio for ${id} could not be fetched`, e);
        throw failed();
      }
      if (response.status !== 200 || !types[format].includes(response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "")) {
        await response.body?.cancel().catch(() => undefined);
        throw failed();
      }
      const declared = response.headers.get("content-length");
      let length: number | undefined;
      if (declared !== null) {
        const got = Length.safeParse(declared);
        if (!got.success) {
          await response.body?.cancel().catch(() => undefined);
          throw failed();
        }
        length = got.data;
      }
      try {
        return await saveAudioStream(deps, id, format, checked(response, length, within), inputs, undefined, within);
      } catch (e) {
        // Given up before the body was read (a deadline while staging began): it is let go here, not left open.
        if (!response.bodyUsed) await response.body?.cancel().catch(() => undefined);
        throw e;
      }
    },
    downloadMs,
    { clock: deps.clock, signal, timedOut: failed },
  );
}
