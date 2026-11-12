import { z } from "zod";

import { bounded, type ProviderHttp, send } from "../base/http.ts";
import { codePoints, fromJson, httpsUrl, int } from "../base/json.ts";
import { badKey, type MossErrorFields, MossResponseTooLarge, readMossResponse, rejectedStatuses } from "./response.ts";
import { mossSpeechFormats } from "./speech-models.ts";

export const AudioId = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/u);
const ErrorCode = z.enum([
  "voice_not_found",
  "task_not_found",
  "unsupported_stream",
  "unsupported_for_stream",
  "unsupported_with_async",
  "unsupported_with_webhook",
  "invalid_field_value",
  "rate_limit_exceeded",
  "concurrency_limit_exceeded",
]);
type ErrorCode = z.output<typeof ErrorCode>;
const ErrorBody = z.object({ error: z.object({ code: ErrorCode }) });

export class MossAudioError extends Error {
  override readonly name = "MossAudioError";
  readonly reason: MossErrorFields["reason"];
  readonly outcome: MossErrorFields["outcome"];
  declare readonly status?: number;
  declare readonly code?: ErrorCode;

  constructor(fields: MossErrorFields & { readonly code?: ErrorCode }) {
    super(`MOSS audio: ${fields.reason}`);
    this.reason = fields.reason;
    this.outcome = fields.outcome;
    if (fields.status !== undefined) this.status = fields.status;
    if (fields.code !== undefined) this.code = fields.code;
  }
}

const UsageCount = int();
export const AudioUsage = z.object({
  input_characters: z.exactOptional(UsageCount),
  prompt_tokens: z.exactOptional(UsageCount),
  completion_tokens: z.exactOptional(UsageCount),
  total_tokens: z.exactOptional(UsageCount),
  input_audio_seconds: z.exactOptional(z.number().min(0)),
});

export interface MossAudioUsage {
  readonly inputCharacters?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly inputAudioSeconds?: number;
}

export function audioUsage(usage: z.output<typeof AudioUsage>): MossAudioUsage {
  return {
    ...(usage.input_characters !== undefined ? { inputCharacters: usage.input_characters } : {}),
    ...(usage.prompt_tokens !== undefined ? { promptTokens: usage.prompt_tokens } : {}),
    ...(usage.completion_tokens !== undefined ? { completionTokens: usage.completion_tokens } : {}),
    ...(usage.total_tokens !== undefined ? { totalTokens: usage.total_tokens } : {}),
    ...(usage.input_audio_seconds !== undefined ? { inputAudioSeconds: usage.input_audio_seconds } : {}),
  };
}

const mimeTypes: Record<(typeof mossSpeechFormats)[number], readonly string[]> = {
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  pcm: ["audio/pcm", "audio/l16", "application/octet-stream"],
  flac: ["audio/flac", "audio/x-flac"],
  aac: ["audio/aac", "audio/aacp"],
  opus: ["audio/opus", "audio/ogg", "application/ogg"],
};
/** The fields of an audio result; an object holding them must also pass `audioMimeMatches`. */
export const audioResultShape = {
  url: httpsUrl(8192),
  response_format: z.enum(mossSpeechFormats),
  content_type: codePoints(1, 256),
};
/** The content type is one of the format's MIME types. */
export const audioMimeMatches = (result: { readonly response_format: (typeof mossSpeechFormats)[number]; readonly content_type: string }): boolean =>
  mimeTypes[result.response_format].includes(result.content_type.split(";")[0]?.trim().toLowerCase() ?? "");

export const invalidAudioResponse = () => new MossAudioError({ reason: "InvalidResponse", outcome: "Unknown" });
export const invalidAudioInput = () => new MossAudioError({ reason: "InvalidInput", outcome: "NotSubmitted" });

/** body as JSON text, or InvalidInput when JSON cannot hold it. */
export function audioJson(body: unknown): string {
  try {
    const text = JSON.stringify(body);
    if (text === undefined) throw invalidAudioInput();
    return text;
  } catch (e) {
    if (e instanceof MossAudioError) throw e;
    throw invalidAudioInput();
  }
}

export interface AudioRequest {
  readonly method: "GET" | "POST";
  readonly url: string | URL;
  /** JSON text or a form. */
  readonly body?: string | FormData;
}

/** One request to the MOSS audio API with key, never following a redirect (it would carry the key); the raw body of a 2xx
 * answer, else a MossAudioError saying whether MOSS refused it. */
export async function audioRequest(key: string, request: AudioRequest, http: ProviderHttp, signal: AbortSignal): Promise<string> {
  if (badKey(key)) throw new MossAudioError({ reason: "Credentials", outcome: "NotSubmitted" });
  const response = await send(
    http,
    request.url,
    {
      method: request.method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(typeof request.body === "string" ? { "content-type": "application/json" } : {}),
      },
      ...(request.body !== undefined ? { body: request.body } : {}),
      redirect: "manual",
    },
    signal,
  );
  let raw: string;
  try {
    raw = await readMossResponse(response, signal);
  } catch (e) {
    if (e instanceof MossResponseTooLarge) throw new MossAudioError({ reason: "TooLarge", outcome: "Unknown" });
    throw e;
  }
  if (response.status < 200 || response.status >= 300) {
    const code = fromJson(ErrorBody, raw)?.error.code;
    throw new MossAudioError({
      reason: "HttpStatus",
      status: response.status,
      outcome:
        rejectedStatuses.includes(response.status) || (response.status === 404 && (code === "voice_not_found" || code === "task_not_found"))
          ? "Rejected"
          : "Unknown",
      ...(code !== undefined ? { code } : {}),
    });
  }
  return raw;
}

/** An audio call under a deadline of ms: running out is Timeout, a transport failure Network, both of unknown outcome. */
export const boundedAudio = <A>(ms: number, http: ProviderHttp, work: (signal: AbortSignal) => Promise<A>): Promise<A> =>
  bounded(ms, http, work, {
    timeout: () => new MossAudioError({ reason: "Timeout", outcome: "Unknown" }),
    network: () => new MossAudioError({ reason: "Network", outcome: "Unknown" }),
  });
