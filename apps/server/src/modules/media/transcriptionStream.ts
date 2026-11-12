import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { BizCode, refuseIn } from "#/base/errors.ts";
import { bestEffort, type Logger } from "#/infra/log.ts";
import type { Time } from "#/infra/time.ts";
import type { TranscriptionEvent } from "#/modules/provider/vendors.ts";

import { untilAborted } from "./job.ts";

const refused = refuseIn(BizCode.MediaRefused);

export interface TranscriptionCheckpoint {
  result: Extract<T.MediaAudioResult, { kind: "transcription" }>;
  usage?: T.MediaAudioUsage;
  complete: boolean;
}
interface Ports {
  task: (id: string) => Promise<void>;
  save: (value: TranscriptionCheckpoint) => Promise<void>;
}

/** The vendor's transcript as it comes, saved at most every 200 ms (and at once for each segment and the end); stopped
 * or failed, what came so far is saved before the failure goes on. */
export async function receiveTranscriptionStream(
  deps: { readonly clock: Time; readonly log: Logger },
  events: AsyncIterable<TranscriptionEvent>,
  ports: Ports,
  signal: AbortSignal,
): Promise<void> {
  let text = "";
  const segments: T.MediaAudioSegment[] = [];
  const indexes = new Set<number>();
  let usage: T.MediaAudioUsage | undefined;
  let dirty = false;
  let complete = false;
  let last = -Infinity;
  const flush = async (force: boolean) => {
    const now = deps.clock.now();
    if (!dirty || (!force && now - last < 200)) return;
    await ports.save({ result: { kind: "transcription", text, segments }, ...(usage === undefined ? {} : { usage }), complete });
    last = now;
    dirty = false;
  };
  try {
    for await (const event of untilAborted(events, signal)) {
      switch (event.type) {
        case "task.created":
          await ports.task(event.taskId);
          break;
        case "transcript.text.delta":
          if (text.length + event.text.length > 1_000_000) throw refused(t("server.media.audioInvalid"));
          text += event.text;
          dirty = true;
          await flush(false);
          break;
        case "transcript.segment.done":
          if (segments.length >= 10_000 || indexes.has(event.index)) throw refused(t("server.media.audioInvalid"));
          indexes.add(event.index);
          segments.push(event.segment);
          if (event.usage !== undefined) usage = event.usage;
          dirty = true;
          await flush(true);
          break;
        case "transcript.text.done":
          if (event.text.length > 1_000_000) throw refused(t("server.media.audioInvalid"));
          text = event.text;
          if (event.usage !== undefined) usage = event.usage;
          complete = true;
          dirty = true;
          await flush(true);
          break;
      }
    }
  } catch (e) {
    await bestEffort(deps.log, "Partial transcription checkpoint could not be saved", () => flush(true));
    throw e;
  }
}
