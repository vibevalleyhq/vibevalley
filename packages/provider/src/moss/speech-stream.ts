import { z } from "zod";

import { boundedBody, Deadline, decodeText, mediaType, type ProviderHttp, ProviderTransportError, send } from "../base/http.ts";
import { fromJson, int } from "../base/json.ts";
import { SseRetry, SseTooLarge, type SseEvent, sseEvents } from "../base/sse.ts";
import { AudioId, audioJson, AudioUsage, audioUsage, invalidAudioResponse, MossAudioError, type MossAudioUsage } from "./audio-response.ts";
import { badKey, MossResponseTooLarge, readMossResponse, rejectedStatuses } from "./response.ts";
import { prepareMossSpeech } from "./speech.ts";

const maxEventSize = 1 << 20;
const maxAudioFrameBytes = 512 << 10;
const maxAudioBytes = 128 << 20;
const maxWireBytes = 192 << 20;
const FlashModel = z.enum(["moss-tts-1.5-flash", "moss-tts-1.5-flash-2026-06-26"]);
const Event = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task.created"),
    task_id: AudioId,
    object: z.literal("audio.speech"),
    status: z.literal("PROCESSING"),
    model: FlashModel,
  }),
  z.object({
    type: z.literal("speech.created"),
    format: z.literal("pcm"),
    sample_rate: int(8000, 192000),
    channels: int(1, 8),
    bit_depth: z.literal([8, 16, 24, 32]),
    usage: z.exactOptional(AudioUsage),
  }),
  z.object({
    type: z.literal("speech.audio.delta"),
    audio: z.string().min(1).max(maxEventSize),
    usage: z.exactOptional(AudioUsage),
  }),
  z.object({
    type: z.literal("speech.audio.done"),
    usage: z.exactOptional(AudioUsage),
    meta_info: z.exactOptional(
      z.object({
        performance: z.exactOptional(z.object({ audio_duration_s: z.exactOptional(z.number().min(0)) })),
      }),
    ),
  }),
  z.object({ type: z.literal("error") }),
]);
const VoiceNotFound = z.object({ error: z.object({ code: z.literal("voice_not_found") }) });

export type MossSpeechEvent =
  | { readonly type: "task.created"; readonly taskId: string; readonly model: string }
  | {
      readonly type: "speech.created";
      readonly format: "pcm";
      readonly sampleRate: number;
      readonly channels: number;
      readonly bitDepth: number;
      readonly usage?: MossAudioUsage;
    }
  | { readonly type: "speech.audio.delta"; readonly audio: Uint8Array; readonly usage?: MossAudioUsage }
  | { readonly type: "speech.audio.done"; readonly usage?: MossAudioUsage; readonly durationSeconds?: number };

const tooLarge = () => new MossAudioError({ reason: "TooLarge", outcome: "Unknown" });

/** Strict Base64 (padding only at the end, length a multiple of 4; line breaks ignored), or undefined. */
function base64(text: string): Uint8Array | undefined {
  const stripped = text.replace(/[\n\r]/gu, "");
  if (stripped.length % 4 !== 0 || !/^[A-Za-z0-9+/]*(?:={0,2})$/u.test(stripped)) return undefined;
  return new Uint8Array(Buffer.from(stripped, "base64"));
}

async function* events(key: string, input: unknown, http: ProviderHttp, signal: AbortSignal): AsyncGenerator<MossSpeechEvent> {
  const request = await prepareMossSpeech(input);
  if (!FlashModel.safeParse(request.model).success || request.response_format !== "pcm")
    throw new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" });
  if (badKey(key)) throw new MossAudioError({ reason: "Credentials", outcome: "NotSubmitted" });
  const { delivery_method: _delivery, ...prepared } = request;
  const body = audioJson({ ...prepared, stream: true, stream_format: "sse", async: false });
  const response = await send(
    http,
    "https://api.mosi.cn/v1/audio/speech",
    {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, accept: "text/event-stream", "content-type": "application/json" },
      body,
      redirect: "manual",
    },
    signal,
  );
  if (response.status < 200 || response.status >= 300) {
    const raw = await readMossResponse(response, signal);
    const missingVoice = fromJson(VoiceNotFound, raw) !== undefined;
    throw new MossAudioError({
      reason: "HttpStatus",
      status: response.status,
      outcome: rejectedStatuses.includes(response.status) || (response.status === 404 && missingVoice) ? "Rejected" : "Unknown",
      ...(missingVoice ? { code: "voice_not_found" } : {}),
    });
  }
  if (mediaType(response.headers) !== "text/event-stream") {
    await response.body?.cancel().catch(
      // The answer is already refused; the body is only dropped.
      () => undefined,
    );
    throw invalidAudioResponse();
  }

  let audioBytes = 0;
  let frameBytes = 0;
  let eventCount = 0;
  let taskCreated = false;
  const decode = (event: SseEvent): MossSpeechEvent => {
    if (++eventCount > 100000) throw tooLarge();
    const value = fromJson(Event, event.data);
    if (value === undefined) throw invalidAudioResponse();
    if (event.event !== "message" && event.event !== value.type) throw invalidAudioResponse();
    switch (value.type) {
      case "task.created":
        if (taskCreated || frameBytes !== 0) throw invalidAudioResponse();
        taskCreated = true;
        return { type: value.type, taskId: value.task_id, model: value.model };
      case "speech.created":
        if (frameBytes !== 0) throw invalidAudioResponse();
        frameBytes = (value.channels * value.bit_depth) / 8;
        return {
          type: value.type,
          format: value.format,
          sampleRate: value.sample_rate,
          channels: value.channels,
          bitDepth: value.bit_depth,
          ...(value.usage !== undefined ? { usage: audioUsage(value.usage) } : {}),
        };
      case "speech.audio.delta": {
        if (frameBytes === 0) throw invalidAudioResponse();
        if (value.audio.length > Math.ceil(maxAudioFrameBytes / 3) * 4) throw tooLarge();
        const audio = base64(value.audio);
        if (audio === undefined) throw invalidAudioResponse();
        audioBytes += audio.byteLength;
        if (audio.byteLength > maxAudioFrameBytes || audioBytes > maxAudioBytes) throw tooLarge();
        if (audio.byteLength === 0) throw invalidAudioResponse();
        return { type: value.type, audio, ...(value.usage !== undefined ? { usage: audioUsage(value.usage) } : {}) };
      }
      case "speech.audio.done": {
        if (frameBytes === 0 || audioBytes === 0 || audioBytes % frameBytes !== 0) throw invalidAudioResponse();
        const durationSeconds = value.meta_info?.performance?.audio_duration_s;
        return {
          type: value.type,
          ...(value.usage !== undefined ? { usage: audioUsage(value.usage) } : {}),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
        };
      }
      case "error":
        throw invalidAudioResponse();
    }
  };
  for await (const event of sseEvents(decodeText(boundedBody(response, signal, maxWireBytes, tooLarge)), { maxEventSize })) {
    const decoded = decode(event);
    yield decoded;
    if (decoded.type === "speech.audio.done") return;
  }
  // EOF is not a completion receipt, including EOF after a partial SSE event.
  throw invalidAudioResponse();
}

/** One Flash speech request streamed as SSE: the task, the PCM's actual format, its audio in order, and the done event
 * (with usage). The whole stream has 300 s; it ends with done, and anything short of it fails. */
export async function* streamMossSpeech(key: string, input: unknown, http: ProviderHttp): AsyncGenerator<MossSpeechEvent> {
  const deadline = new Deadline(300_000, http);
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
