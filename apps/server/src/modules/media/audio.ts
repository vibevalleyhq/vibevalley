import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { MediaPhaseValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { BizCode, refuseIn } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import type { Db } from "#/infra/db.ts";
import { fileBlob } from "#/infra/files.ts";
import type { Logger } from "#/infra/log.ts";
import type { PublicFetch } from "#/infra/publicHttp.ts";
import type { Time } from "#/infra/time.ts";
import type { Attachment } from "#/platform/attachment/attachment.ts";
import type { Account, Provider } from "#/platform/provider/provider.ts";
import { AudioFailure } from "#/platform/provider/vendors.ts";
import * as q from "#db/media_job.sql.ts";

import { inspectAudio } from "./audioMetadata.ts";
import { type AudioSavedResult, type MediaInputs, releaseAudioResult, saveAudioResult } from "./audioResult.ts";
import { jobsOf, newJob, type Row, storedAs } from "./job.ts";
import type { Machine, Patch, Words } from "./machine.ts";
import type { MediaCaller } from "./media.ts";
import { receiveTranscriptionStream, type TranscriptionCheckpoint } from "./transcriptionStream.ts";

const refused = refuseIn(BizCode.MediaRefused);

interface AudioInputs extends MediaInputs {
  get: (id: string) => Promise<T.MediaInput>;
  content: (id: string) => Promise<{ path: string; mime: string; size: number; name: string }>;
  blob: (id: string, holder: string) => Promise<Blob>;
  pin: (ids: readonly string[], holder: string, admit: () => Promise<void>) => Promise<T.MediaInput[]>;
  release: (holder: string) => Promise<void>;
}
interface AudioRemoteFiles {
  upload: (holder: string, input: string, account: Account, signal?: AbortSignal) => Promise<string>;
  remove: (holder: string, input: string, account: Account, signal?: AbortSignal) => Promise<void>;
  list: (holder: string) => Promise<readonly { input_id: string; phase: string; remote_id: string | null }[]>;
}
interface AudioPorts {
  readonly inputs: AudioInputs;
  readonly remote: AudioRemoteFiles;
  readonly machine: Machine;
}

export interface AudioDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly attachment: Attachment;
  readonly provider: Provider;
  readonly publicFetch: PublicFetch;
}

/** The audio kinds this file runs, in media_job. */
export const audioKinds: readonly string[] = ["speakers", "voiceDesign", "clone", "transcription"];
const jobs = jobsOf({ kinds: audioKinds, phases: MediaPhaseValues });

/** Whether given has a field the Schema did not take: a request with one is refused, not trimmed. */
const hasExtra = (given: object, taken: object) => Object.keys(given).some((key) => !(key in taken));

/** Several voices, a designed voice, a cloned voice and transcription (MOSS): vendor tasks the machine follows, a clone
 * asked at once, and a transcript streamed in. What it uploads to the vendor goes again once the job is done. */
export function makeAudio(deps: AudioDeps, { inputs, remote, machine }: AudioPorts) {
  const { db, clock, provider, attachment: kept, publicFetch } = deps;
  const log = deps.log.child("media/audio");
  const audioStorage = { publicFetch, files: kept, log, clock };
  const invalid = () => refused(t("server.media.audioInvalid"));
  const corrupt = () => refused(t("server.media.corrupt"));
  const words: Words = {
    unknown: t("server.media.audioUnknown"),
    rejected: t("server.media.audioRejected"),
    paused: t("server.media.audioPollingPaused"),
    downloadFailed: t("server.media.speechDownloadFailed"),
    accountChanged: t("server.media.audioAccountChanged"),
    noResume: t("server.media.audioPollingPaused"),
  };
  const request = (row: Row) => storedAs(S.MediaAudioRequest, corrupt)(row.request);
  const view = async (given: Row): Promise<T.MediaAudioJob> => {
    const row = jobs.one(given);
    if (row === undefined) throw corrupt();
    const input = request(row);
    const attachment = row.attachment === null ? undefined : storedAs(S.Attachment, corrupt)(row.attachment);
    const uploaded = row.phase === "ready" || row.phase === "failed" ? await remote.list(row.id) : [];
    const base = {
      id: row.id,
      model: row.model,
      connection: row.connection,
      revision: row.revision,
      source: storedAs(S.MediaSource, corrupt)(row.source),
      phase: row.phase,
      phaseText: t(`server.media.phase.${row.phase}`),
      problem: row.problem,
      format: row.result_format,
      contentType: row.content_type,
      ...(row.metadata === null ? {} : { metadata: storedAs(S.MediaAudioMetadata, corrupt)(row.metadata) }),
      ...(row.usage === null ? {} : { usage: storedAs(S.MediaAudioUsage, corrupt)(row.usage) }),
      input: row.input === null ? null : storedAs(S.MediaInputReference, corrupt)(row.input),
      resultInput: row.result_input === null ? null : storedAs(S.MediaInputReference, corrupt)(row.result_input),
      ...(attachment ? { attachment } : {}),
      previewInput: row.preview_input,
      result: row.result === null ? null : storedAs(S.MediaAudioResult, corrupt)(row.result),
      canCancel: machine.active(row.phase),
      canRetryDownload: row.assets_released === 0 && row.result_url !== null && (row.phase === "download_failed" || row.phase === "canceled"),
      canResume:
        row.assets_released === 0 &&
        !(input.kind === "transcription" && input.streaming === true) &&
        row.remote_task !== null &&
        row.result_url === null &&
        row.result === null &&
        (row.phase === "unknown" || row.phase === "canceled"),
      canCleanup: uploaded.some((file) => file.remote_id !== null && file.phase !== "deleted"),
      canRelease: !machine.active(row.phase) && row.assets_released === 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    switch (input.kind) {
      case "speakers":
        return { ...base, kind: input.kind, request: input, prompt: input.segments.map((segment) => `${segment.speaker}: ${segment.text}`).join("\n") };
      case "voiceDesign":
        return { ...base, kind: input.kind, request: input, prompt: input.text };
      case "clone":
        return { ...base, kind: input.kind, request: input, prompt: input.name ?? "" };
      case "transcription":
        return { ...base, kind: input.kind, request: input, prompt: base.input?.name ?? "" };
    }
  };
  const get = async (id: string) => view(await machine.found(id, audioKinds));
  const originalAccount = async (row: Row): Promise<Account> => {
    const account = await provider.account({ connection: row.connection, model: row.model });
    if (account.fingerprint !== row.fingerprint) throw refused(words.accountChanged);
    return { ...account, revision: row.revision };
  };

  /** What it uploaded to the vendor goes, and the input it read unless it made something of it. */
  const clean = async (id: string) => {
    const row = await machine.found(id, audioKinds);
    if (row.phase !== "ready" && row.phase !== "failed" && !(row.phase === "canceled" && row.remote_task === null)) return;
    const uploaded = await remote.list(id);
    if (row.phase === "canceled" && uploaded.length > 0) return;
    if (uploaded.some((file) => file.remote_id === null && (file.phase === "unknown" || file.phase === "uploading"))) return;
    for (const file of uploaded) if (file.phase !== "deleted") await remote.remove(id, file.input_id, await originalAccount(row));
    // Saved results retain their source until the user explicitly releases local assets.
    if (row.input !== null && row.result === null) await inputs.release(id);
    if (row.problem === t("server.media.audioCleanupPending")) await machine.change(id, ["ready", "failed", "canceled"], { problem: "" });
    else await machine.publish();
  };
  const cleanSafely = (id: string) =>
    machine.cleaning.with(async () => {
      try {
        await clean(id);
      } catch (e) {
        log.warn(`media: audio ${id} cleanup is pending`, e);
        await machine.change(id, ["ready", "failed", "canceled"], { problem: t("server.media.audioCleanupPending") });
      }
    });

  const submit = async (id: string, signal: AbortSignal) => {
    if (!(await machine.change(id, ["queued"], { phase: "generating" }))) return;
    const asked = await machine.found(id);
    const input = request(asked);
    // Past this point the vendor may have been asked: a failure no longer says the job never ran.
    let attempted = false;
    /** Checks the key once more, right before the vendor is asked. */
    const lastLook = async () => {
      await originalAccount(await machine.found(id));
    };
    try {
      const current = await machine.found(id);
      const account = await originalAccount(current);
      if (input.kind === "clone") {
        const blob = await inputs.blob(input.input, id);
        const metadata = await inspectAudio(blob).catch(() => {
          throw invalid();
        });
        if (blob.size > 10_000_000 || metadata.duration > 30 || !["wav", "mp3", "m4a", "flac"].includes(metadata.format)) throw invalid();
        await lastLook();
        attempted = true;
        const voice = await account.voices.clone(
          {
            audio: blob,
            filename: `sample.${metadata.format}`,
            durationSeconds: metadata.duration,
            ...(input.name !== undefined ? { name: input.name } : {}),
          },
          signal,
        );
        // Once cloned, the voice is recorded whatever stops the job now.
        await machine.change(id, ["generating", "canceled", "unknown"], { phase: "ready", result: jsonText({ kind: "clone", voice }), problem: "" });
        return;
      }
      if (input.kind === "transcription" && input.streaming === true) {
        const fileId = await remote.upload(id, input.input, account, signal);
        await lastLook();
        attempted = true;
        await receiveTranscriptionStream(
          { clock, log },
          account.transcription.stream(
            {
              fileId,
              ...(input.diarize === undefined ? {} : { diarize: input.diarize }),
              ...(input.keyterms === undefined ? {} : { keyterms: input.keyterms }),
            },
            signal,
          ),
          {
            task: async (taskId) => {
              await machine.change(id, ["generating", "canceled"], { remote_task: taskId });
            },
            save: async (checkpoint: TranscriptionCheckpoint) => {
              const patch = { result: jsonText(checkpoint.result), usage: checkpoint.usage === undefined ? null : jsonText(checkpoint.usage) };
              if (checkpoint.complete) {
                if (!(await machine.change(id, ["generating"], { ...patch, phase: "ready", problem: "" })))
                  await machine.change(id, ["canceled", "unknown"], patch);
              } else await machine.change(id, ["generating", "canceled", "unknown"], patch);
            },
          },
          signal,
        );
        return;
      }
      let task: (within: AbortSignal) => Promise<string>;
      if (input.kind === "speakers")
        task = (within) => account.speakers.createTask({ speakers: input.speakers, segments: input.segments, format: input.format }, within);
      else if (input.kind === "voiceDesign")
        task = (within) => account.voiceDesign.createTask({ text: input.text, instruction: input.instruction, format: input.format }, within);
      else {
        const fileId = await remote.upload(id, input.input, account, signal);
        task = (within) =>
          account.transcription.createTask(
            {
              fileId,
              ...(input.diarize !== undefined ? { diarize: input.diarize } : {}),
              ...(input.keyterms !== undefined ? { keyterms: input.keyterms } : {}),
            },
            within,
          );
      }
      await lastLook();
      attempted = true;
      await machine.follow(id, task, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof AudioFailure) {
        await machine.failed(id, error.outcome, words);
        return;
      }
      log.warn(`media: audio ${id} failed`, error);
      const uncertain = attempted || (await remote.list(id)).some((file) => file.phase === "unknown" || file.phase === "uploading");
      await machine.failed(id, uncertain ? "Unknown" : "Rejected", words);
    }
  };

  machine.register({
    kinds: audioKinds,
    words,
    view,
    keep: async (row, signal) => {
      const input = request(row);
      if ((input.kind !== "speakers" && input.kind !== "voiceDesign") || row.result_format === null || row.content_type === null) throw corrupt();
      const format = row.result_format;
      const saved = await saveAudioResult(audioStorage, row.id, row.result_url ?? "", format, inputs, signal);
      let retained: AudioSavedResult = saved;
      const undo = () => releaseAudioResult(deps, row.id, retained, inputs);
      try {
        // A short designed voice is also kept as an input, to clone from or listen to again.
        let preview: T.MediaInputReference | undefined;
        if (
          input.kind === "voiceDesign" &&
          ["wav", "mp3", "flac"].includes(format) &&
          saved.attachment &&
          saved.attachment.size <= 10_000_000 &&
          saved.metadata?.duration !== undefined &&
          saved.metadata.duration <= 30
        ) {
          const file = await kept.get(saved.attachment.id);
          if (!file) throw corrupt();
          preview = await inputs.storeResult(
            {
              path: file.path,
              hash: saved.attachment.id,
              size: saved.attachment.size,
              mime: saved.attachment.type,
              name: saved.attachment.name,
              metadata: saved.metadata,
            },
            row.id,
            true,
          );
          retained = { ...saved, resultInput: preview };
        }
        const patch: Patch = {
          attachment: saved.attachment ? jsonText(saved.attachment) : null,
          result_input: saved.resultInput ? jsonText(saved.resultInput) : null,
          metadata: saved.metadata ? jsonText(saved.metadata) : null,
          preview_input: preview?.id ?? null,
        };
        return { patch, undo };
      } catch (e) {
        await undo();
        throw e;
      }
    },
    task: {
      kind: (row) => (row.kind === "transcription" ? "transcription" : row.kind === "voiceDesign" ? "voiceGeneration" : "speech"),
      done: async (_row, task) => {
        const usage = task.usage === undefined ? null : jsonText(task.usage);
        if (task.kind === "transcription") {
          const result: T.MediaAudioResult = { kind: "transcription", text: task.text, segments: [...(task.segments ?? [])] };
          return { phase: "ready" as const, result: jsonText(result), usage };
        }
        return { phase: "downloading" as const, result_url: task.url, result_format: task.format, content_type: task.contentType, usage };
      },
    },
    ran: cleanSafely,
    canceled: cleanSafely,
    restarted: async () => {
      for (const row of jobs.many(await q.audioCleanup(db.sql))) await cleanSafely(row.id);
    },
  });

  // Not stopped by the caller: a job once admitted is written and started.
  const create = async (given: T.MediaAudioRequest, caller: MediaCaller): Promise<T.MediaAudioJob> => {
    if ((caller.kind === "orchestrator" && !caller.forUser) || ((given.kind === "clone" || given.kind === "transcription") && caller.kind !== "user"))
      throw refused(t("server.media.userRequired"));
    const source = S.MediaSource.safeParse(caller);
    if (!source.success) throw invalid();
    const parsed = S.MediaAudioRequest.safeParse(given);
    if (!parsed.success || hasExtra(given, parsed.data)) throw invalid();
    const input = parsed.data;
    return machine.lock.with(async () => {
      const existing = await machine.admit(input.id, audioKinds, async (row) => {
        const stored = request(row);
        const shown = await view(row);
        return same(stored, input) && same(shown.source, source.data);
      });
      if (existing !== undefined) return view(existing);
      const account =
        input.kind === "speakers"
          ? await provider.speakers()
          : input.kind === "voiceDesign"
            ? await provider.voiceDesign()
            : input.kind === "transcription"
              ? await provider.transcription()
              : await provider.account({ connection: input.connection, model: "" });
      if (account.connection !== input.connection || account.revision !== input.revision) throw refused(words.accountChanged);
      let reference: T.MediaInputReference | null = null;
      if (input.kind === "clone" || input.kind === "transcription") {
        const local = await inputs.get(input.input);
        if (local.kind !== "audio" || local.phase !== "ready" || local.hash === null) throw invalid();
        reference = { id: local.id, kind: local.kind, mime: local.mime, name: local.name, size: local.size, hash: local.hash };
        const content = await inputs.content(input.input);
        let metadata;
        try {
          metadata = await inspectAudio(await fileBlob(content.path, content.mime));
        } catch {
          // Audio that cannot be read is not an input this job can take.
          throw invalid();
        }
        if (
          metadata.duration > 3600 ||
          (input.kind === "clone" && (local.size > 10_000_000 || metadata.duration > 30 || !["wav", "mp3", "m4a", "flac"].includes(metadata.format)))
        )
          throw invalid();
      }
      try {
        if (input.kind === "speakers") await account.speakers.check({ speakers: input.speakers, segments: input.segments, format: input.format });
        if (input.kind === "voiceDesign") await account.voiceDesign.check({ text: input.text, instruction: input.instruction, format: input.format });
        if (input.kind === "transcription")
          await account.transcription.check({
            fileId: input.input,
            ...(input.diarize !== undefined ? { diarize: input.diarize } : {}),
            ...(input.keyterms !== undefined ? { keyterms: input.keyterms } : {}),
            streaming: input.streaming === true,
          });
      } catch {
        // The vendor would not take it as asked: said as invalid audio.
        throw invalid();
      }
      const insert = async () => {
        await q.insertMediaJob(
          db.sql,
          newJob({
            id: input.id,
            kind: input.kind,
            phase: "queued",
            request: jsonText(input),
            source: jsonText(source.data),
            input: reference === null ? null : jsonText(reference),
            connection: account.connection,
            revision: account.revision,
            model: account.model,
            fingerprint: account.fingerprint,
            now: clock.now(),
          }),
        );
      };
      if (reference) await inputs.pin([reference.id], input.id, insert);
      else await insert();
      await machine.publish();
      await machine.run(input.id, (signal) => submit(input.id, signal));
      return get(input.id);
    });
  };

  return {
    createSpeakers: (input: T.MediaSpeakersRequest, caller: MediaCaller) => create({ ...input, kind: "speakers" }, caller),
    createVoiceDesign: (input: T.MediaVoiceDesignRequest, caller: MediaCaller) => create({ ...input, kind: "voiceDesign" }, caller),
    createClone: (input: T.MediaCloneRequest, caller: MediaCaller) => create({ ...input, kind: "clone" }, caller),
    createTranscription: (input: T.MediaTranscriptionRequest, caller: MediaCaller) => create({ ...input, kind: "transcription" }, caller),
    get,
    previewCleanup: async (id: string): Promise<T.Preview> => {
      const row = await machine.found(id, audioKinds);
      if (row.phase !== "ready" && row.phase !== "failed") throw refused(t("server.media.busy"));
      const files = await remote.list(id);
      const count = files.filter((file) => file.remote_id !== null && file.phase !== "deleted").length;
      return { does: count === 0 ? [] : [t("server.media.cleanupPreview", { count, connection: row.connection })] };
    },
    cleanup: async (id: string) => {
      const row = await machine.found(id, audioKinds);
      if (row.phase !== "ready" && row.phase !== "failed") throw refused(t("server.media.busy"));
      await cleanSafely(id);
      return get(id);
    },
  };
}
