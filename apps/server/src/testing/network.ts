import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { PublicHttp } from "#/infra/publicHttp.ts";
import { png } from "#/media/testdata/png.ts";

import { offlineNetwork } from "./layers.ts";

const ImageInput = Schema.fromJsonString(Schema.Struct({ prompt: Schema.String, size: Schema.String }));
const Dimension = Schema.FiniteFromString.check(Schema.isBetween({ minimum: 256, maximum: 2048 }));
const Dimensions = Schema.Tuple([Dimension, Dimension]);
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
    const assets = new Map<string, { bytes: Buffer; failOnce: boolean }>();
    const files = new Map<string, { purpose: string; failOnce: boolean }>();
    let next = 0;
    const model = HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.url === "https://api.mosi.cn/v1/audio/voices" && request.method === "GET") {
          const last = request.urlParams.params.some(([key]) => key === "after");
          const account = request.headers.authorization === "Bearer test-voice-second" ? "second" : "first";
          const id = `voice-${account}${last ? "-last" : ""}`;
          return HttpClientResponse.fromWeb(
            request,
            Response.json({
              object: "list",
              data: [{ id, object: "audio.voice", name: "Offline voice", created_at: 1 }],
              first_id: id,
              last_id: id,
              has_more: !last,
              next_cursor: last ? null : "next-voice",
            }),
          );
        }
        if (request.url === "https://api.mosi.cn/v1/files" && request.method === "POST" && request.body._tag === "FormData") {
          const file = request.body.formData.get("file");
          const purpose = request.body.formData.get("purpose");
          if (!(file instanceof File) || typeof purpose !== "string") return HttpClientResponse.fromWeb(request, new Response("", { status: 400 }));
          const bytes = yield* Effect.promise(() => file.arrayBuffer());
          const id = `file-${++next}`;
          files.set(id, { purpose, failOnce: false });
          return HttpClientResponse.fromWeb(
            request,
            Response.json({ id, object: "file", bytes: bytes.byteLength, created_at: 1, filename: file.name, purpose, status: "processed" }),
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
        assets.set(url, { bytes: png(width, height), failOnce: input.prompt.includes("[media:download-failure]") });
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
        return HttpClientResponse.fromWeb(request, new Response(asset.bytes, { headers: { "content-type": "image/png" } }));
      }),
    );
    return Layer.merge(Layer.succeed(HttpClient.HttpClient, model), Layer.succeed(PublicHttp, download));
  }),
).pipe(Layer.provide(offlineNetwork));
