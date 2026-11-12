import { z } from "zod";

import { boundedBody, Deadline, decodeText, mediaType, type ProviderHttp, ProviderTransportError, send } from "../base/http.ts";
import { codePoints, fromJson, int } from "../base/json.ts";
import { SseRetry, SseTooLarge, type SseEvent, sseEvents } from "../base/sse.ts";
import { AudioId, audioJson, AudioUsage, audioUsage, invalidAudioResponse, MossAudioError, type MossAudioUsage } from "./audio-response.ts";
import type { MossTranscriptionSegment } from "./audio-tasks.ts";
import { badKey, MossResponseTooLarge, readMossResponse, rejectedStatuses } from "./response.ts";
import { prepareMossTranscription } from "./transcription.ts";

const maxEventSize = 4 << 20;
const maxWireBytes = 32 << 20;
const maxTextLength = 1 << 20;
const DiarizeModel = z.enum(["moss-transcribe-diarize-pro", "moss-transcribe-diarize-pro-2026-07-03"]);
const Event = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.created"),
    task_id: AudioId,
    object: z.literal("audio.transcription"),
    status: z.literal("PROCESSING"),
    model: DiarizeModel,
  }),
  z.object({ type: z.literal("transcript.text.delta"), delta: z.string() }),
  z
    .object({
      type: z.literal("transcript.segment.done"),
      content_index: int(),
      speaker: codePoints(1, 256),
      start: z.number().min(0),
      end: z.number().min(0),
      text: z.string(),
      session_usage: z.exactOptional(AudioUsage),
    })
    .refine((segment) => segment.end >= segment.start),
  z.object({ type: z.literal("transcript.text.done"), text: z.string(), usage: z.exactOptional(AudioUsage) }),
  z.object({ type: z.literal("error") }),
]);

export type MossTranscriptionEvent =
  | { readonly type: "task.created"; readonly taskId: string; readonly model: string }
  | { readonly type: "transcript.text.delta"; readonly text: string }
  | { readonly type: "transcript.segment.done"; readonly index: number; readonly segment: MossTranscriptionSegment; readonly usage?: MossAudioUsage }
  | { readonly type: "transcript.text.done"; readonly text: string; readonly usage?: MossAudioUsage };

const tooLarge = () => new MossAudioError({ reason: "TooLarge", outcome: "Unknown" });

async function* events(key: string, input: unknown, http: ProviderHttp, signal: AbortSignal): AsyncGenerator<MossTranscriptionEvent> {
  const request = await prepareMossTranscription(input);
  if (!DiarizeModel.safeParse(request.model).success) throw new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" });
  if (badKey(key)) throw new MossAudioError({ reason: "Credentials", outcome: "NotSubmitted" });
  const body = audioJson({ ...request, response_format: "verbose_json", stream: true, async: false });
  const response = await send(
    http,
    "https://api.mosi.cn/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, accept: "text/event-stream", "content-type": "application/json" },
      body,
      redirect: "manual",
    },
    signal,
  );
  if (response.status < 200 || response.status >= 300) {
    await readMossResponse(response, signal);
    throw new MossAudioError({
      reason: "HttpStatus",
      status: response.status,
      outcome: rejectedStatuses.includes(response.status) ? "Rejected" : "Unknown",
    });
  }
  if (mediaType(response.headers) !== "text/event-stream") {
    await response.body?.cancel().catch(
      // The answer is already refused; the body is only dropped.
      () => undefined,
    );
    throw invalidAudioResponse();
  }

  let deltaLength = 0;
  let segmentLength = 0;
  let segmentCount = 0;
  let eventCount = 0;
  const decode = (event: SseEvent): MossTranscriptionEvent => {
    if (++eventCount > 100000) throw tooLarge();
    const decoded = fromJson(Event, event.data);
    if (decoded === undefined) throw invalidAudioResponse();
    if (event.event !== "message" && event.event !== decoded.type) throw invalidAudioResponse();
    switch (decoded.type) {
      case "task.created":
        if (eventCount !== 1) throw invalidAudioResponse();
        return { type: decoded.type, taskId: decoded.task_id, model: decoded.model };
      case "transcript.text.delta":
        deltaLength += decoded.delta.length;
        if (deltaLength > maxTextLength) throw tooLarge();
        return { type: decoded.type, text: decoded.delta };
      case "transcript.segment.done":
        segmentLength += decoded.text.length;
        if (++segmentCount > 10000 || segmentLength > maxTextLength) throw tooLarge();
        return {
          type: decoded.type,
          index: decoded.content_index,
          segment: { speaker: decoded.speaker, text: decoded.text, start: decoded.start, end: decoded.end },
          ...(decoded.session_usage !== undefined ? { usage: audioUsage(decoded.session_usage) } : {}),
        };
      case "transcript.text.done":
        if (decoded.text.length > maxTextLength) throw tooLarge();
        return { type: decoded.type, text: decoded.text, ...(decoded.usage !== undefined ? { usage: audioUsage(decoded.usage) } : {}) };
      case "error":
        throw invalidAudioResponse();
    }
  };
  for await (const event of sseEvents(decodeText(boundedBody(response, signal, maxWireBytes, tooLarge)), { maxEventSize })) {
    const decoded = decode(event);
    yield decoded;
    if (decoded.type === "transcript.text.done") return;
  }
  // Only a complete transcript.text.done frame acknowledges success; EOF never does.
  throw invalidAudioResponse();
}

/** One diarized transcription streamed as SSE: the task, text deltas, finished segments and the final text (with usage).
 * The whole stream has 900 s; it ends with the final text, and anything short of it fails. */
export async function* streamMossTranscription(key: string, input: unknown, http: ProviderHttp): AsyncGenerator<MossTranscriptionEvent> {
  const deadline = new Deadline(900_000, http);
  try {
    yield* events(key, input, http, deadline.signal);
  } catch (e) {
    if (deadline.expired) throw new MossAudioError({ reason: "Timeout", outcome: "Unknown" });
    if (e instanceof ProviderTransportError) throw new MossAudioError({ reason: "Network", outcome: "Unknown" });
    if (e instanceof MossResponseTooLarge || e instanceof SseTooLarge) throw tooLarge();
    if (e instanceof SseRetry) throw invalidAudioResponse();
    throw e;
  } finally {
    deadline.stop();
  }
}
