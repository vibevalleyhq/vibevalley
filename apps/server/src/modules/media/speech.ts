import { z } from "zod";

import { abortable, TaskGroup } from "@vibevalley/async";
import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { MediaAudioFormatValues, MediaPhaseValues } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import * as S from "@vibevalley/protocol/schema";

import { BizCode, refuseIn } from "#/base/errors.ts";
import { jsonText } from "#/base/json.ts";
import type { Db } from "#/infra/db.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { PublicFetch } from "#/infra/publicHttp.ts";
import type { Time } from "#/infra/time.ts";
import type { Attachment } from "#/platform/attachment/attachment.ts";
import type { Account, Provider } from "#/platform/provider/provider.ts";
import { AudioFailure, type SpeechRequest } from "#/platform/provider/vendors.ts";
import * as q from "#db/media_job.sql.ts";

import { saveAudioResult, releaseAudioResult, type MediaInputs } from "./audioResult.ts";
import { jobsOf, newJob, type Row, storedAs } from "./job.ts";
import type { Machine, Patch } from "./machine.ts";
import type { MediaCaller } from "./media.ts";
import { receiveSpeechStream, type SpeechStreamSaved } from "./speechStream.ts";

const refused = refuseIn(BizCode.MediaRefused);

interface Ports {
  readonly inputs: MediaInputs;
  readonly machine: Machine;
}

export interface SpeechDeps {
  readonly db: Db;
  readonly clock: Time;
  readonly log: Logger;
  readonly attachment: Attachment;
  readonly provider: Provider;
  readonly publicFetch: PublicFetch;
}

/** A streamed job's events on their way to the page: at most `capacity` waiting, an offer past that waits for the page.
 * end() lets the page read what is left; shutdown() drops it all and lets every waiting offer go. */
class SpeechChannel {
  readonly #items: T.MediaSpeechEvent[] = [];
  readonly #takers: ((r: IteratorResult<T.MediaSpeechEvent>) => void)[] = [];
  readonly #offers: (() => void)[] = [];
  #ended = false;
  #shut = false;
  readonly capacity: number;
  claimed = false;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Kept, or dropped once the channel ended or was shut; waits while it is full. */
  async offer(event: T.MediaSpeechEvent, signal?: AbortSignal): Promise<void> {
    while (!this.#ended && !this.#shut && this.#takers.length === 0 && this.#items.length >= this.capacity) {
      const { promise, resolve } = Promise.withResolvers<void>();
      this.#offers.push(resolve);
      await abortable(promise, signal);
    }
    this.tryOffer(event);
  }

  /** Kept unless full, ended or shut. */
  tryOffer(event: T.MediaSpeechEvent): boolean {
    if (this.#ended || this.#shut) return false;
    const taker = this.#takers.shift();
    if (taker) {
      taker({ value: event, done: false });
      return true;
    }
    if (this.#items.length >= this.capacity) return false;
    this.#items.push(event);
    return true;
  }

  async next(signal?: AbortSignal): Promise<IteratorResult<T.MediaSpeechEvent>> {
    const item = this.#items.shift();
    if (item !== undefined) {
      this.#offers.shift()?.();
      return { value: item, done: false };
    }
    if (this.#ended || this.#shut) return { value: undefined, done: true };
    const { promise, resolve } = Promise.withResolvers<IteratorResult<T.MediaSpeechEvent>>();
    this.#takers.push(resolve);
    try {
      return await abortable(promise, signal);
    } finally {
      const at = this.#takers.indexOf(resolve);
      if (at >= 0) this.#takers.splice(at, 1);
    }
  }

  end(): void {
    this.#ended = true;
    if (this.#items.length === 0) this.#wake();
  }

  shutdown(): void {
    this.#shut = true;
    this.#items.length = 0;
    this.#wake();
  }

  #wake() {
    for (const taker of this.#takers.splice(0)) taker({ value: undefined, done: true });
    for (const offer of this.#offers.splice(0)) offer();
  }
}

const jobs = jobsOf({ kinds: ["speech"], phases: MediaPhaseValues });
const AudioFormat = z.enum(MediaAudioFormatValues);

/** Single-voice speech: asked at once, as a vendor task followed until done, or streamed to the page as it is spoken. */
export function makeSpeech(deps: SpeechDeps, { inputs, machine }: Ports) {
  const { db, clock, attachment: kept, provider, publicFetch } = deps;
  const log = deps.log.child("media/speech");
  const audioStorage = { publicFetch, files: kept, log, clock };
  const streams = new Map<string, SpeechChannel>();
  // A finished stream's events stay a minute for a page that comes late, one timer per job.
  const streamCleanup = new TaskGroup({ name: "media.speech", onError: (task, e) => log.warn(`${task} failed`, e) });
  const corrupt = () => refused(t("server.media.corrupt"));
  const invalid = () => refused(t("server.media.speechInvalid"));
  const words = {
    unknown: t("server.media.speechUnknown"),
    rejected: t("server.media.speechRejected"),
    paused: t("server.media.speechPollPaused"),
    downloadFailed: t("server.media.speechDownloadFailed"),
    accountChanged: t("server.media.remoteAccountChanged"),
    noResume: t("server.media.speechNoResume"),
  };
  const decodeRequest = storedAs(S.MediaSpeechRequest, corrupt);
  const view = async (given: Row): Promise<T.MediaSpeechJob> => {
    const row = jobs.one(given);
    if (row === undefined) throw corrupt();
    const input = decodeRequest(row.request);
    const attachment = row.attachment === null ? undefined : storedAs(S.Attachment, corrupt)(row.attachment);
    let format = input.format;
    if (row.result_format !== null) {
      const got = AudioFormat.safeParse(row.result_format);
      if (!got.success) throw corrupt();
      format = got.data;
    }
    const metadata = row.metadata === null ? undefined : storedAs(S.MediaAudioMetadata, corrupt)(row.metadata);
    const usage = row.usage === null ? undefined : storedAs(S.MediaAudioUsage, corrupt)(row.usage);
    const resultInput = row.result_input === null ? null : storedAs(S.MediaInputReference, corrupt)(row.result_input);
    return {
      kind: "speech",
      id: row.id,
      prompt: input.text,
      voice: input.voice,
      format,
      ...(row.content_type !== null ? { contentType: row.content_type } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
      ...(usage === undefined ? {} : { usage }),
      canResume:
        row.assets_released === 0 &&
        input.streaming !== true &&
        row.remote_task !== null &&
        (row.phase === "unknown" || row.phase === "canceled") &&
        row.result_url === null,
      model: row.model,
      connection: row.connection,
      revision: row.revision,
      source: storedAs(S.MediaSource, corrupt)(row.source),
      phase: row.phase,
      phaseText: t(`server.media.phase.${row.phase}`),
      problem: row.problem,
      ...(attachment ? { attachment } : {}),
      resultInput,
      canCancel: machine.active(row.phase),
      canRelease: !machine.active(row.phase) && row.assets_released === 0,
      canRetryDownload: row.assets_released === 0 && row.result_url !== null && (row.phase === "download_failed" || row.phase === "canceled"),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  };
  const get = async (id: string) => view(await machine.found(id, ["speech"]));
  const audioFields = (made: { url: string; format: T.MediaAudioFormat; contentType: string; usage?: T.MediaAudioUsage }) =>
    ({
      result_url: made.url,
      result_format: made.format,
      content_type: made.contentType,
      usage: made.usage === undefined ? null : jsonText(made.usage),
    }) satisfies Patch;
  /** What a saved result writes, kept or kept as an input for later use. */
  const savedFields = (saved: { attachment?: T.Attachment; resultInput: T.MediaInputReference | null }) =>
    ({
      attachment: saved.attachment === undefined ? null : jsonText(saved.attachment),
      result_input: saved.resultInput === null ? null : jsonText(saved.resultInput),
    }) satisfies Patch;

  /** Streamed speech goes to the page as it is spoken and is kept whole once done. */
  const receive = async (id: string, account: Account, synthesis: SpeechRequest, signal: AbortSignal) => {
    const session = streams.get(id);
    if (!session) throw invalid();
    try {
      await receiveSpeechStream(
        audioStorage,
        id,
        (within) => account.speech.stream(synthesis, within),
        {
          inputs,
          task: async (taskId) => {
            await machine.change(id, ["generating", "canceled"], { remote_task: taskId });
          },
          emit: (event, within) => session.offer(event, within),
          save: async (saved: SpeechStreamSaved) => {
            const patch = {
              ...savedFields(saved),
              result_format: "wav",
              content_type: "audio/wav",
              metadata: jsonText(saved.metadata),
              usage: saved.usage === undefined ? null : jsonText(saved.usage),
            } satisfies Patch;
            if (
              !(await machine.change(id, ["generating"], {
                ...patch,
                phase: saved.complete ? "ready" : "unknown",
                problem: saved.complete ? "" : t("server.media.speechPartial"),
              })) &&
              !(await machine.change(id, ["canceled"], patch))
            )
              await releaseAudioResult(deps, id, saved, inputs);
          },
        },
        signal,
      );
    } catch (e) {
      if (signal.aborted) throw e;
      log.warn(`media: speech stream ${id} failed`, e);
      await machine.change(id, ["generating"], { phase: "unknown", problem: words.unknown });
      session.tryOffer({ type: "failed" });
    } finally {
      session.end();
      streamCleanup.keyed(id, async (stop) => {
        await clock.sleep(60_000, stop);
        session.shutdown();
        if (streams.get(id) === session) streams.delete(id);
      });
    }
  };

  machine.register({
    kinds: ["speech"],
    words,
    view,
    keep: async (given, signal) => {
      const job = await view(given);
      const saved = await saveAudioResult(audioStorage, given.id, given.result_url ?? "", job.format, inputs, signal);
      const undo = () => bestEffort(log, `media: letting go of speech ${given.id}`, () => releaseAudioResult(deps, given.id, saved, inputs));
      const patch = {
        ...savedFields(saved),
        metadata: saved.metadata === undefined ? null : jsonText(saved.metadata),
      } satisfies Patch;
      return { patch, undo };
    },
    task: {
      kind: () => "speech",
      done: async (_row, task) => {
        if (task.kind === "transcription") throw corrupt();
        return { ...audioFields(task), phase: "downloading" as const };
      },
    },
    canceled: async (id) => {
      const session = streams.get(id);
      if (!session) return;
      session.shutdown();
      streams.delete(id);
    },
  });

  const generate = async (input: T.MediaSpeechRequest, account: Account, synthesis: SpeechRequest, signal: AbortSignal) => {
    if (!(await machine.change(input.id, ["queued"], { phase: "generating" }))) return;
    if (input.streaming === true) {
      await receive(input.id, account, synthesis, signal);
      return;
    }
    try {
      if (input.asynchronous === true) {
        await machine.follow(input.id, (within) => account.speech.createTask(synthesis, within), signal);
        return;
      }
      const made = await account.speech.generate(synthesis, signal);
      if (await machine.change(input.id, ["generating"], { ...audioFields(made), phase: "downloading" })) await machine.download(input.id, signal);
    } catch (error) {
      if (!(error instanceof AudioFailure) || signal.aborted) throw error;
      await machine.failed(input.id, error.outcome, words);
    }
  };

  return {
    get,
    /** The page's one reading of a streamed job; it claims the stream on the first next() (refused when another page has
     * it), and a page that goes away cancels the job. */
    events: async function* (id: string, signal?: AbortSignal): AsyncGenerator<T.MediaSpeechEvent> {
      const session = await machine.lock.with(async () => {
        const session = streams.get(id);
        if (!session || session.claimed) throw refused(t("server.media.speechStreamUnavailable"));
        session.claimed = true;
        return session;
      });
      try {
        for (;;) {
          const next = await session.next(signal);
          if (next.done === true) return;
          yield next.value;
          if (next.value.type === "done" || next.value.type === "failed") return;
        }
      } finally {
        session.shutdown();
        if (streams.get(id) === session) streams.delete(id);
        await bestEffort(log, "Speech stream disconnect could not be recorded", () =>
          machine.change(id, ["queued", "generating"], { phase: "canceled", problem: t("server.media.canceled") }),
        );
        await machine.stop(id);
      }
    },
    // Not stopped by the caller: a job once admitted is written and started.
    create: async (given: T.MediaSpeechRequest, caller: MediaCaller): Promise<T.MediaSpeechJob> => {
      if (caller.kind === "orchestrator" && !caller.forUser) throw refused(t("server.media.userRequired"));
      const source = S.MediaSource.safeParse(caller);
      if (!source.success) throw invalid();
      const parsed = S.MediaSpeechRequest.safeParse(given);
      if (!parsed.success) throw invalid();
      const input = parsed.data;
      if (input.streaming === true && (caller.kind !== "user" || input.asynchronous === true || input.format !== "pcm")) throw invalid();
      return machine.lock.with(async () => {
        const existing = await machine.admit(input.id, ["speech"], async (row) => {
          const stored = decodeRequest(row.request);
          const shown = await view(row);
          return same(stored, input) && same(shown.source, source.data);
        });
        if (existing !== undefined) return view(existing);
        const account = await provider.speech();
        if (input.connection !== account.connection || input.revision !== account.revision) throw refused(t("server.media.speechChanged"));
        const synthesis: SpeechRequest = { text: input.text, voice: input.voice, format: input.format };
        try {
          await account.speech.check({ ...synthesis, streaming: input.streaming === true });
        } catch {
          // The vendor would not take it as asked: said as invalid speech.
          throw invalid();
        }
        if (input.streaming === true && streams.size >= 8) throw invalid();
        await q.insertMediaJob(
          db.sql,
          newJob({
            id: input.id,
            kind: "speech",
            phase: "queued",
            request: jsonText(input),
            source: jsonText(source.data),
            connection: account.connection,
            revision: account.revision,
            model: account.model,
            fingerprint: account.fingerprint,
            now: clock.now(),
          }),
        );
        if (input.streaming === true) streams.set(input.id, new SpeechChannel(16));
        await machine.publish();
        await machine.run(input.id, (signal) => generate(input, account, synthesis, signal));
        return get(input.id);
      });
    },
    close: () => streamCleanup.close(),
  };
}
