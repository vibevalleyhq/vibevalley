import { Effect, Formatter, Layer, Schema, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { PublicHttp } from "#/infra/publicHttp.ts";
import { mp3, wav } from "#/modules/media/testdata/audio.ts";
import { png } from "#/modules/media/testdata/png.ts";

import { offlineNetwork } from "./layers.ts";

const ImageInput = Schema.fromJsonString(Schema.Struct({ prompt: Schema.String, size: Schema.String }));
const Dimension = Schema.FiniteFromString.check(Schema.isBetween({ minimum: 256, maximum: 2048 }));
const Dimensions = Schema.Tuple([Dimension, Dimension]);
const AudioFormat = Schema.Literals(["wav", "mp3", "pcm", "flac", "aac", "opus"]);
const SpeechInput = Schema.fromJsonString(
  Schema.Struct({
    input: Schema.String,
    response_format: AudioFormat,
    voice_id: Schema.String,
    async: Schema.optionalKey(Schema.Boolean),
    stream: Schema.optionalKey(Schema.Boolean),
  }),
);
const SpeakersInput = Schema.fromJsonString(
  Schema.Struct({
    segments: Schema.Array(Schema.Struct({ speaker: Schema.String, text: Schema.String })),
    speakers: Schema.Array(Schema.Struct({ id: Schema.String, voice_id: Schema.String })),
    response_format: AudioFormat,
  }),
);
const DesignInput = Schema.fromJsonString(Schema.Struct({ input: Schema.String, instruction: Schema.String, response_format: AudioFormat }));
const TranscriptionInput = Schema.fromJsonString(Schema.Struct({ file_id: Schema.String, model: Schema.String, stream: Schema.optionalKey(Schema.Boolean) }));
interface AudioFixtureTask {
  account: string;
  object: "audio.speech" | "audio.voice_generation" | "audio.transcription";
  status: "SUCCESS" | "FAILED";
  url?: string;
  response_format?: "wav" | "mp3";
  content_type?: string;
  text?: string;
  segments?: { speaker: string; text: string; start: number; end: number }[];
}
const UnderstandingInput = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    input: Schema.Array(
      Schema.Struct({
        content: Schema.Array(
          Schema.Union([
            Schema.Struct({ type: Schema.Literal("input_text"), text: Schema.String }),
            Schema.Struct({ type: Schema.Literals(["input_image", "input_video"]), file_id: Schema.String }),
          ]),
        ),
      }),
    ),
  }),
);

export const network = Layer.unwrap(
  Effect.gen(function* () {
    const local = yield* HttpClient.HttpClient;
    const assets = new Map<string, { bytes: Buffer; type: string; failOnce: boolean }>();
    const files = new Map<string, { purpose: string; failOnce: boolean }>();
    const tasks = new Map<string, AudioFixtureTask>();
    const cloned = new Map<string, { id: string; object: "audio.voice"; name: string; created_at: number }[]>();
    let next = 0;
    const model = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.url === "https://api.mosi.cn/v1/audio/voices" && request.method === "GET") {
          const last = request.urlParams.params.some(([key]) => key === "after");
          const account = request.headers.authorization === "Bearer test-voice-second" ? "second" : "first";
          const speech =
            request.headers.authorization === "Bearer test-speech-a" ||
            request.headers.authorization === "Bearer test-speech-b" ||
            request.headers.authorization?.startsWith("Bearer test-audio") === true;
          const id = speech ? (last ? "voice-two" : "voice-one") : `voice-${account}${last ? "-last" : ""}`;
          const data = [
            { id, object: "audio.voice", name: "Offline voice", created_at: 1 },
            ...(!last ? (cloned.get(request.headers.authorization ?? "") ?? []) : []),
          ];
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              object: "list",
              data,
              first_id: id,
              last_id: data.at(-1)?.id,
              has_more: !last,
              next_cursor: last ? null : "next-voice",
            }),
          );
        }
        if (request.url === "https://api.mosi.cn/v1/audio/voices" && request.method === "POST" && request.body._tag === "FormData") {
          const sample = request.body.formData.get("audio_sample");
          if (!(sample instanceof File) || sample.size === 0 || sample.size > 10_000_000)
            return HttpClientResponse.fromWeb(request, new Response("", { status: 400 }));
          const name = request.body.formData.get("name");
          const voice = { id: `voice-cloned-${++next}`, object: "audio.voice" as const, name: typeof name === "string" ? name : "", created_at: 1 };
          const account = request.headers.authorization ?? "";
          cloned.set(account, [...(cloned.get(account) ?? []), voice]);
          return HttpClientResponse.fromWeb(request, Response.json(voice));
        }
        if (request.url.startsWith("https://api.mosi.cn/v1/audio/tasks/") && request.method === "GET") {
          const id = request.url.slice("https://api.mosi.cn/v1/audio/tasks/".length);
          const task = tasks.get(id);
          if (!task || task.account !== request.headers.authorization)
            return HttpClientResponse.fromWeb(request, Response.json({ error: { code: "task_not_found" } }, { status: 404 }));
          const { account: _account, ...result } = task;
          return HttpClientResponse.fromWeb(request, Response.json({ id, created_at: 1, updated_at: 2, ...result }));
        }
        if (request.url === "https://api.mosi.cn/v1/audio/transcriptions" && request.method === "POST" && request.body._tag === "Uint8Array") {
          const input = yield* Schema.decodeEffect(TranscriptionInput)(Buffer.from(request.body.body).toString("utf8"));
          if (files.get(input.file_id)?.purpose !== "audio") return HttpClientResponse.fromWeb(request, new Response("", { status: 400 }));
          const id = `transcription-${++next}`;
          if (input.stream === true) {
            const frame = (value: object) => new TextEncoder().encode(`data: ${Formatter.formatJson(value)}\n\n`);
            const initial = Stream.make(
              frame({ type: "task.created", task_id: id, object: "audio.transcription", status: "PROCESSING", model: input.model }),
              frame({ type: "transcript.text.delta", delta: "First synthetic speaker." }),
              frame({ type: "transcript.segment.done", content_index: 0, speaker: "speaker_0", start: 0, end: 1.4, text: "First synthetic speaker." }),
            );
            const terminal =
              request.headers.authorization === "Bearer test-audio-stream-hold"
                ? Stream.fromEffect(Effect.never)
                : request.headers.authorization === "Bearer test-audio-stream-truncated"
                  ? Stream.empty
                  : Stream.make(
                      frame({ type: "transcript.text.delta", delta: " Second synthetic speaker." }),
                      frame({ type: "transcript.segment.done", content_index: 1, speaker: "speaker_1", start: 1.5, end: 3, text: "Second synthetic speaker." }),
                      frame({
                        type: "transcript.text.done",
                        text: "First synthetic speaker. Second synthetic speaker.",
                        usage: { type: "duration", prompt_tokens: 12, completion_tokens: 9, total_tokens: 21, input_audio_seconds: 4 },
                      }),
                    );
            const body = yield* Stream.toReadableStreamEffect(
              Stream.concat(initial, Stream.concat(Stream.fromEffect(Effect.sleep("1500 millis")).pipe(Stream.drain), terminal)),
            );
            return HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "text/event-stream" } }));
          }
          tasks.set(id, {
            account: request.headers.authorization ?? "",
            object: "audio.transcription",
            status: request.headers.authorization === "Bearer test-audio-failure" ? "FAILED" : "SUCCESS",
            text: "First synthetic speaker. Second synthetic speaker.",
            segments: [
              { speaker: "speaker_0", text: "First synthetic speaker.", start: 0, end: 1.4 },
              { speaker: "speaker_1", text: "Second synthetic speaker.", start: 1.5, end: 3 },
            ],
          });
          return HttpClientResponse.fromWeb(request, Response.json({ task_id: id }));
        }
        if (
          (request.url === "https://api.mosi.cn/v1/audio/speech/speakers" || request.url === "https://api.mosi.cn/v1/audio/voice/generations") &&
          request.method === "POST" &&
          request.body._tag === "Uint8Array"
        ) {
          const raw = Buffer.from(request.body.body).toString("utf8");
          const dialogue = request.url.endsWith("/speakers");
          const input = dialogue ? yield* Schema.decodeEffect(SpeakersInput)(raw) : yield* Schema.decodeEffect(DesignInput)(raw);
          const text = "segments" in input ? input.segments.map((segment) => segment.text).join(" ") : input.input;
          if (text.includes("[audio:hold]")) return yield* Effect.never;
          if (text.includes("[audio:unknown]")) return HttpClientResponse.fromWeb(request, new Response("", { status: 503 }));
          const large = text.includes("[audio:large]");
          const format = !large && input.response_format === "mp3" ? "mp3" : "wav";
          const type = format === "mp3" ? "audio/mpeg" : "audio/wav";
          const id = `audio-${++next}`;
          const url = `https://media.example.com/${id}.${format}`;
          assets.set(url, {
            bytes: large ? wav((26 * 1024 * 1024 - 44) / 2) : format === "mp3" ? mp3 : wav(),
            type,
            failOnce: text.includes("[audio:download-failure]"),
          });
          tasks.set(id, {
            account: request.headers.authorization ?? "",
            object: dialogue ? "audio.speech" : "audio.voice_generation",
            status: "SUCCESS",
            url,
            response_format: format,
            content_type: type,
          });
          return HttpClientResponse.fromWeb(request, Response.json({ task_id: id }));
        }
        if (request.url === "https://api.mosi.cn/v1/audio/speech" && request.method === "POST" && request.body._tag === "Uint8Array") {
          const input = yield* Schema.decodeEffect(SpeechInput)(Buffer.from(request.body.body).toString("utf8"));
          if (input.input.includes("[speech:hold]")) return yield* Effect.never;
          if (input.input.includes("[speech:unknown]")) return HttpClientResponse.fromWeb(request, new Response("", { status: 503 }));
          if (input.stream === true) {
            const id = `stream-${++next}`;
            const frame = (value: object) => new TextEncoder().encode(`data: ${Formatter.formatJson(value)}\n\n`);
            const mono = wav().subarray(44);
            const stereo = Buffer.alloc(mono.length * 2);
            for (let sample = 0; sample < mono.length / 2; sample++) {
              stereo.writeInt16LE(mono.readInt16LE(sample * 2), sample * 4);
              stereo.writeInt16LE(-mono.readInt16LE(sample * 2), sample * 4 + 2);
            }
            const chunk = stereo.toString("base64");
            const initial = Stream.make(
              frame({ type: "task.created", task_id: id, object: "audio.speech", status: "PROCESSING", model: "moss-tts-1.5-flash" }),
              frame({ type: "speech.created", format: "pcm", sample_rate: 24000, channels: 2, bit_depth: 16 }),
            );
            const frames = input.input.includes("[speech:stream-hold]") ? 1 : input.input.includes("[speech:stream-truncated]") ? 10 : 60;
            const audio = Stream.range(0, frames - 1).pipe(
              Stream.mapEffect(() => Effect.sleep("30 millis").pipe(Effect.as(frame({ type: "speech.audio.delta", audio: chunk })))),
            );
            const terminal = input.input.includes("[speech:stream-hold]")
              ? Stream.fromEffect(Effect.never)
              : input.input.includes("[speech:stream-truncated]")
                ? Stream.empty
                : Stream.make(
                    frame({
                      type: "speech.audio.done",
                      usage: { input_characters: input.input.length, prompt_tokens: 5, completion_tokens: frames, total_tokens: 5 + frames },
                      meta_info: { performance: { audio_duration_s: frames * 0.12 } },
                    }),
                  );
            const body = yield* Stream.toReadableStreamEffect(Stream.concat(Stream.concat(initial, audio), terminal));
            return HttpClientResponse.fromWeb(request, new Response(body, { headers: { "content-type": "text/event-stream" } }));
          }
          if (input.async === true) {
            const large = input.input.includes("[speech:large]");
            const format = !large && input.response_format === "mp3" ? "mp3" : "wav";
            const id = `speech-${++next}`;
            const url = `https://media.example.com/${id}.${format}`;
            const type = format === "mp3" ? "audio/mpeg" : "audio/wav";
            assets.set(url, {
              bytes: large ? wav((26 * 1024 * 1024 - 44) / 2) : format === "mp3" ? mp3 : wav(),
              type,
              failOnce: input.input.includes("[speech:download-failure]"),
            });
            tasks.set(id, {
              account: request.headers.authorization ?? "",
              object: "audio.speech",
              status: "SUCCESS",
              url,
              response_format: format,
              content_type: type,
            });
            return HttpClientResponse.fromWeb(request, Response.json({ task_id: id }));
          }
          if (input.response_format !== "wav" && input.response_format !== "mp3") return HttpClientResponse.fromWeb(request, new Response("", { status: 400 }));
          const large = input.input.includes("[speech:large]");
          const format = large ? "wav" : input.response_format;
          const url = `https://media.example.com/${++next}.${format}`;
          const type = format === "wav" ? "audio/wav" : "audio/mpeg";
          assets.set(url, {
            bytes: large ? wav((26 * 1024 * 1024 - 44) / 2) : format === "wav" ? wav() : mp3,
            type,
            failOnce: input.input.includes("[speech:download-failure]"),
          });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              id: `speech-${next}`,
              object: "audio.speech",
              status: "SUCCESS",
              created_at: 1,
              url,
              response_format: format,
              content_type: type,
            }),
          );
        }
        if (request.url === "https://api.mosi.cn/v1/files" && request.method === "POST" && request.body._tag === "FormData") {
          const file = request.body.formData.get("file");
          const purpose = request.body.formData.get("purpose");
          if (!(file instanceof File) || typeof purpose !== "string") return HttpClientResponse.fromWeb(request, new Response("", { status: 400 }));
          const id = `file-${++next}`;
          files.set(id, { purpose, failOnce: false });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ id, object: "file", bytes: file.size, created_at: 1, filename: file.name, purpose, status: "processed" }),
          );
        }
        if (request.url.startsWith("https://api.mosi.cn/v1/files/") && request.method === "DELETE") {
          const id = request.url.slice("https://api.mosi.cn/v1/files/".length);
          const file = files.get(id);
          if (!file) return HttpClientResponse.fromWeb(request, new Response("", { status: 404 }));
          if (file.failOnce) {
            file.failOnce = false;
            return HttpClientResponse.fromWeb(request, new Response("", { status: 503 }));
          }
          files.delete(id);
          return HttpClientResponse.fromWeb(request, Response.json({ id, object: "file", deleted: true }));
        }
        if (request.url === "https://api.mosi.cn/v1/responses" && request.method === "POST" && request.body._tag === "Uint8Array") {
          const input = yield* Schema.decodeEffect(UnderstandingInput)(Buffer.from(request.body.body).toString("utf8"));
          const content = input.input.flatMap((item) => item.content);
          const text = content
            .filter((part) => part.type === "input_text")
            .map((part) => part.text)
            .join("\n");
          const media = content.filter((part) => part.type !== "input_text");
          if (media.some((part) => files.get(part.file_id)?.purpose !== (part.type === "input_image" ? "image" : "video")))
            return HttpClientResponse.fromWeb(request, new Response("", { status: 400 }));
          if (text.includes("[understanding:hold]")) return yield* Effect.never;
          if (text.includes("[understanding:unknown]")) return HttpClientResponse.fromWeb(request, new Response("", { status: 503 }));
          if (text.includes("[understanding:cleanup-failure]"))
            for (const part of media) {
              const file = files.get(part.file_id);
              if (file) file.failOnce = true;
            }
          const incomplete = text.includes("[understanding:incomplete]");
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              id: `response-${++next}`,
              model: input.model,
              status: incomplete ? "incomplete" : "completed",
              incomplete_details: incomplete ? { reason: "max_output_tokens" } : null,
              output: [
                {
                  content: [
                    { type: "output_text", text: `Offline understanding of ${media.some((part) => part.type === "input_video") ? "video" : "image"} input.` },
                  ],
                },
              ],
              usage: { input_tokens: 30, output_tokens: 8, total_tokens: 38 },
            }),
          );
        }
        if (request.url !== "https://api.mosi.cn/v1/images/generations" || request.method !== "POST" || request.body._tag !== "Uint8Array")
          return yield* local.execute(request);
        const input = yield* Schema.decodeEffect(ImageInput)(Buffer.from(request.body.body).toString("utf8"));
        const [width, height] = yield* Schema.decodeUnknownEffect(Dimensions)(input.size.split("x"));
        if (input.prompt.includes("[media:hold]")) return yield* Effect.never;
        if (input.prompt.includes("[media:unknown]")) return HttpClientResponse.fromWeb(request, new Response("", { status: 503 }));
        const url = `https://media.example.com/${++next}.png`;
        assets.set(url, { bytes: png(width, height), type: "image/png", failOnce: input.prompt.includes("[media:download-failure]") });
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ created: 1, data: [{ url }], usage: { generated_images: 1, output_width: width, output_height: height } }),
        );
      }).pipe(Effect.mapError((cause) => new HttpClientError.HttpClientError({ reason: new HttpClientError.EncodeError({ request, cause }) }))),
    );
    const download = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.headers.authorization !== undefined) throw new Error("Asset download received credentials");
        const asset = assets.get(request.url);
        if (!asset) throw new Error("Unexpected asset request in the offline browser server");
        if (asset.failOnce) {
          asset.failOnce = false;
          return HttpClientResponse.fromWeb(request, new Response("", { status: 503 }));
        }
        let offset = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (offset === asset.bytes.length) {
              controller.close();
              return;
            }
            const chunk = asset.bytes.subarray(offset, offset + 65536);
            offset += chunk.length;
            controller.enqueue(chunk);
          },
        });
        return HttpClientResponse.fromWeb(
          request,
          new Response(body, { headers: { "content-type": asset.type, "content-length": String(asset.bytes.length) } }),
        );
      }),
    );
    return Layer.merge(Layer.succeed(HttpClient.HttpClient, model), Layer.succeed(PublicHttp, download));
  }),
).pipe(Layer.provide(offlineNetwork));
