import { z } from "zod";

import type { ProviderHttp } from "../base/http.ts";
import { codePoints, fromJson, int } from "../base/json.ts";
import { AudioId, audioRequest, boundedAudio, invalidAudioInput, invalidAudioResponse } from "./audio-response.ts";

const Cursor = codePoints(1, 8192);
const Input = z
  .strictObject({
    limit: z.exactOptional(int(1, 150)),
    offset: z.exactOptional(int(0, 100000)),
    after: z.exactOptional(Cursor),
    status: z.exactOptional(codePoints(1, 128)),
  })
  .refine((input) => input.offset === undefined || input.after === undefined);
const Voice = z.object({
  id: AudioId,
  object: z.literal("audio.voice"),
  name: z.string().max(1000),
  created_at: int(),
});

export interface MossVoice {
  readonly id: string;
  readonly name: string;
  readonly createdAtSeconds: number;
}

const Clone = z.strictObject({
  audio: z
    .instanceof(Blob)
    .refine(
      (audio) =>
        audio.size > 0 &&
        audio.size <= 10_000_000 &&
        ["audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3", "audio/mp4", "audio/x-m4a", "audio/flac", "audio/x-flac"].includes(audio.type),
    ),
  filename: codePoints(1, 256).regex(/^[^\p{Cc}/\\]+\.(?:wav|mp3|m4a|flac)$/iu),
  name: z.exactOptional(z.string().max(1000)),
  // Duration must come from the caller's media inspection, not a browser or model assertion.
  durationSeconds: z.number().gt(0).max(30),
});

export const createMossVoice = (key: string, input: unknown, http: ProviderHttp): Promise<MossVoice> =>
  boundedAudio(300_000, http, async (signal) => {
    const parsed = Clone.safeParse(input);
    if (!parsed.success) throw invalidAudioInput();
    const request = parsed.data;
    const form = new FormData();
    form.append("audio_sample", request.audio, request.filename);
    if (request.name !== undefined) form.append("name", request.name);
    const raw = await audioRequest(key, { method: "POST", url: "https://api.mosi.cn/v1/audio/voices", body: form }, http, signal);
    const voice = fromJson(Voice, raw);
    if (voice === undefined) throw invalidAudioResponse();
    return { id: voice.id, name: voice.name, createdAtSeconds: voice.created_at } satisfies MossVoice;
  });

const Listing = z
  .object({
    object: z.literal("list"),
    data: z.array(Voice).max(150),
    has_more: z.boolean(),
    first_id: z.exactOptional(AudioId.nullable()),
    last_id: z.exactOptional(AudioId.nullable()),
    next_cursor: z.exactOptional(Cursor.nullable()),
  })
  .refine((list) => {
    if (list.has_more && !list.next_cursor) return false;
    if (new Set(list.data.map((voice) => voice.id)).size !== list.data.length) return false;
    return (list.first_id ?? undefined) === list.data[0]?.id && (list.last_id ?? undefined) === list.data.at(-1)?.id;
  });

export const listMossVoices = (
  key: string,
  input: unknown,
  http: ProviderHttp,
): Promise<{ readonly voices: readonly MossVoice[]; readonly hasMore: boolean; readonly nextCursor: string | null }> =>
  boundedAudio(30_000, http, async (signal) => {
    const parsed = Input.safeParse(input);
    if (!parsed.success) throw invalidAudioInput();
    const request = parsed.data;
    const limit = request.limit ?? 20;
    const url = new URL("https://api.mosi.cn/v1/audio/voices");
    url.searchParams.set("limit", String(limit));
    if (request.offset !== undefined) url.searchParams.set("offset", String(request.offset));
    if (request.after !== undefined) url.searchParams.set("after", request.after);
    if (request.status !== undefined) url.searchParams.set("status", request.status);
    const raw = await audioRequest(key, { method: "GET", url }, http, signal);
    const result = fromJson(Listing, raw);
    if (result === undefined || result.data.length > limit) throw invalidAudioResponse();
    return {
      voices: result.data.map((voice) => ({ id: voice.id, name: voice.name, createdAtSeconds: voice.created_at })),
      hasMore: result.has_more,
      nextCursor: result.next_cursor ?? null,
    };
  });
