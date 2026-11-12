import type { TranscriptionModelV4 } from "@ai-sdk/provider";
import { z } from "zod";

import { type Clock, isAbort, systemClock, withTimeout } from "@vibevalley/async";

import { mossTranscriptionModels } from "../moss/transcription-models.ts";
import { fromJson } from "./json.ts";

export const mossTranscription = { url: "https://api.mosi.cn/v1", models: mossTranscriptionModels } as const;
const transcriptionFormats = {
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  webm: "audio/webm",
  ogg: "audio/ogg",
  flac: "audio/flac",
} as const;
export const TranscriptionFormat = z.enum(["wav", "m4a", "mp3", "webm", "ogg", "flac"]);
export type TranscriptionFormat = z.output<typeof TranscriptionFormat>;

export class TranscriptionRequestError extends Error {
  override readonly name = "TranscriptionRequestError";
  readonly reason: "Unreachable" | "Cut" | "HttpStatus" | "InvalidResponse";
  declare readonly status?: number;

  constructor(fields: {
    readonly reason: "Unreachable" | "Cut" | "HttpStatus" | "InvalidResponse";
    readonly message: string;
    readonly status?: number;
    readonly cause?: unknown;
  }) {
    super(fields.message, fields.cause === undefined ? undefined : { cause: fields.cause });
    this.reason = fields.reason;
    if (fields.status !== undefined) this.status = fields.status;
  }
}

const ResponseSchema = z.object({
  text: z.exactOptional(z.string()),
  usage: z.exactOptional(z.unknown()),
  error: z.exactOptional(z.object({ message: z.exactOptional(z.string()) })),
});
const Usage = z.record(z.string(), z.json());

/** What failed, without the request: a transport error's own cause says it best. */
const causeText = (e: unknown): string => {
  const cause = e instanceof Error && e.cause !== undefined ? e.cause : e;
  return cause instanceof Error ? cause.message : String(cause);
};

// MOSS and configured compatible endpoints require json, not OpenAI's verbose_json response format.
export const transcriptionModel = (
  connection: {
    readonly url: string;
    readonly model: string;
    readonly key: string;
  },
  format: TranscriptionFormat,
  http: { readonly fetch: typeof fetch; readonly clock?: Clock },
): TranscriptionModelV4 => ({
  specificationVersion: "v4",
  provider: "compatible-transcription",
  modelId: connection.model,
  doGenerate: async (options) => {
    const clock = http.clock ?? systemClock;
    const signal = options.abortSignal;
    const audio = typeof options.audio === "string" ? Buffer.from(options.audio, "base64") : Buffer.from(options.audio);
    const form = new FormData();
    form.append("file", new Blob([audio], { type: transcriptionFormats[format] }), `dictation.${format}`);
    form.append("model", connection.model);
    form.append("response_format", "json");
    let res: Response;
    try {
      // The deadline covers the answer's head; the body is read after it.
      res = await withTimeout(
        (bounded) =>
          http.fetch(connection.url + "/audio/transcriptions", {
            method: "POST",
            headers: connection.key ? { authorization: "Bearer " + connection.key } : {},
            body: form,
            signal: bounded,
          }),
        120_000,
        { clock, ...(signal !== undefined ? { signal } : {}), what: "the transcription request" },
      );
    } catch (cause) {
      if (signal?.aborted === true && isAbort(cause, signal)) throw cause;
      throw new TranscriptionRequestError({ reason: "Unreachable", message: causeText(cause), cause });
    }
    let raw: string;
    try {
      raw = (await res.text()).slice(0, 1 << 20);
    } catch (cause) {
      if (signal?.aborted === true && isAbort(cause, signal)) throw cause;
      throw new TranscriptionRequestError({ reason: "Cut", message: causeText(cause), cause });
    }
    const got = fromJson(ResponseSchema, raw);
    const detail = got?.error?.message;
    if (res.status < 200 || res.status >= 300)
      throw new TranscriptionRequestError({
        reason: "HttpStatus",
        status: res.status,
        message: [...(detail || raw.trim())].slice(0, 200).join(""),
      });
    if (got === undefined) throw new TranscriptionRequestError({ reason: "InvalidResponse", message: "Invalid transcription response" });
    const usage = Usage.safeParse(got.usage);
    return {
      text: (got.text ?? "").trim(),
      segments: [],
      language: undefined,
      durationInSeconds: undefined,
      ...(usage.success ? { usage: usage.data } : {}),
      warnings: [],
      response: { timestamp: new Date(clock.now()), modelId: connection.model, headers: Object.fromEntries(res.headers.entries()), body: raw },
    };
  },
});
