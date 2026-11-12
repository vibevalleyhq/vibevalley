import { z } from "zod";

import { jsonString } from "@vibevalley/protocol/schema";

import type { PublicFetch } from "#/infra/publicHttp.ts";
import { wallTime } from "#/infra/time.ts";
import { mp3, wav } from "#/modules/media/testdata/audio.ts";
import { png } from "#/modules/media/testdata/png.ts";

import { offlineNetwork } from "./layers.ts";

const ImageInput = jsonString(z.object({ prompt: z.string(), size: z.string() }));
const Dimension = z.coerce.number().min(256).max(2048);
const Dimensions = z.tuple([Dimension, Dimension]);
const AudioFormat = z.enum(["wav", "mp3", "pcm", "flac", "aac", "opus"]);
const SpeechInput = jsonString(
  z.object({
    input: z.string(),
    response_format: AudioFormat,
    voice_id: z.string(),
    async: z.exactOptional(z.boolean()),
    stream: z.exactOptional(z.boolean()),
  }),
);
const SpeakersInput = jsonString(
  z.object({
    segments: z.array(z.object({ speaker: z.string(), text: z.string() })),
    speakers: z.array(z.object({ id: z.string(), voice_id: z.string() })),
    response_format: AudioFormat,
  }),
);
const DesignInput = jsonString(z.object({ input: z.string(), instruction: z.string(), response_format: AudioFormat }));
const TranscriptionInput = jsonString(z.object({ file_id: z.string(), model: z.string(), stream: z.exactOptional(z.boolean()) }));
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
const UnderstandingInput = jsonString(
  z.object({
    model: z.string(),
    input: z.array(
      z.object({
        content: z.array(
          z.union([
            z.object({ type: z.literal("input_text"), text: z.string() }),
            z.object({ type: z.enum(["input_image", "input_video"]), file_id: z.string() }),
          ]),
        ),
      }),
    ),
  }),
);

/** An answer that never comes: the request hangs until its caller gives up on it. */
const never = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

/** A body of these frames, one after another; a hold keeps it open until the reader cancels it. */
function eventStream(request: Request, frames: (signal: AbortSignal) => AsyncGenerator<Uint8Array>): Response {
  // Cancelled by its reader, or its request aborted: a hold or a wait in it ends there.
  const cancelled = new AbortController();
  const source = frames(AbortSignal.any([request.signal, cancelled.signal]));
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await source.next();
      if (next.done === true) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() {
      cancelled.abort();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const frameOf = (value: object) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);

/** Every vendor the media tests reach (MOSS's audio, images, files, understanding), answered offline; the public fetch
 * serves what they made. Anything else goes to the test network (loopback only). */
export function network(): { readonly fetch: typeof fetch; readonly publicFetch: PublicFetch } {
  const local = offlineNetwork.fetch;
  const assets = new Map<string, { bytes: Buffer; type: string; failOnce: boolean }>();
  const files = new Map<string, { purpose: string; failOnce: boolean }>();
  const tasks = new Map<string, AudioFixtureTask>();
  const cloned = new Map<string, { id: string; object: "audio.voice"; name: string; created_at: number }[]>();
  let next = 0;
  const model: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const at = target.origin + target.pathname;
    const authorization = request.headers.get("authorization") ?? undefined;
    const form = (request.headers.get("content-type") ?? "").startsWith("multipart/form-data");
    const hasBody = request.body !== null;
    // oxlint-disable-next-line no-deprecated -- the body is the farm's own request in a test, small and trusted
    const formData = form ? await request.clone().formData() : new FormData();
    const respond = (response: Response) => response;
    if (at === "https://api.mosi.cn/v1/audio/voices" && request.method === "GET") {
      const last = target.searchParams.has("after");
      const account = authorization === "Bearer test-voice-second" ? "second" : "first";
      const speech =
        authorization === "Bearer test-speech-a" || authorization === "Bearer test-speech-b" || authorization?.startsWith("Bearer test-audio") === true;
      const id = speech ? (last ? "voice-two" : "voice-one") : `voice-${account}${last ? "-last" : ""}`;
      const data = [{ id, object: "audio.voice", name: "Offline voice", created_at: 1 }, ...(!last ? (cloned.get(authorization ?? "") ?? []) : [])];
      return respond(
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
    if (at === "https://api.mosi.cn/v1/audio/voices" && request.method === "POST" && form) {
      const sample = formData.get("audio_sample");
      if (!(sample instanceof File) || sample.size === 0 || sample.size > 10_000_000) return respond(new Response("", { status: 400 }));
      const name = formData.get("name");
      const voice = { id: `voice-cloned-${++next}`, object: "audio.voice" as const, name: typeof name === "string" ? name : "", created_at: 1 };
      const account = authorization ?? "";
      cloned.set(account, [...(cloned.get(account) ?? []), voice]);
      return respond(Response.json(voice));
    }
    if (at.startsWith("https://api.mosi.cn/v1/audio/tasks/") && request.method === "GET") {
      const id = at.slice("https://api.mosi.cn/v1/audio/tasks/".length);
      const task = tasks.get(id);
      if (!task || task.account !== authorization) return respond(Response.json({ error: { code: "task_not_found" } }, { status: 404 }));
      const { account: _account, ...result } = task;
      return respond(Response.json({ id, created_at: 1, updated_at: 2, ...result }));
    }
    if (at === "https://api.mosi.cn/v1/audio/transcriptions" && request.method === "POST" && hasBody && !form) {
      const input = TranscriptionInput.parse(await request.text());
      if (files.get(input.file_id)?.purpose !== "audio") return respond(new Response("", { status: 400 }));
      const id = `transcription-${++next}`;
      if (input.stream === true) {
        const frame = frameOf;
        const hold = authorization === "Bearer test-audio-stream-hold";
        const truncated = authorization === "Bearer test-audio-stream-truncated";
        return eventStream(request, async function* (signal) {
          yield frame({ type: "task.created", task_id: id, object: "audio.transcription", status: "PROCESSING", model: input.model });
          yield frame({ type: "transcript.text.delta", delta: "First synthetic speaker." });
          yield frame({ type: "transcript.segment.done", content_index: 0, speaker: "speaker_0", start: 0, end: 1.4, text: "First synthetic speaker." });
          await wallTime.sleep(1500, signal);
          if (hold) await never(signal);
          if (truncated) return;
          yield frame({ type: "transcript.text.delta", delta: " Second synthetic speaker." });
          yield frame({ type: "transcript.segment.done", content_index: 1, speaker: "speaker_1", start: 1.5, end: 3, text: "Second synthetic speaker." });
          yield frame({
            type: "transcript.text.done",
            text: "First synthetic speaker. Second synthetic speaker.",
            usage: { type: "duration", prompt_tokens: 12, completion_tokens: 9, total_tokens: 21, input_audio_seconds: 4 },
          });
        });
      }
      tasks.set(id, {
        account: authorization ?? "",
        object: "audio.transcription",
        status: authorization === "Bearer test-audio-failure" ? "FAILED" : "SUCCESS",
        text: "First synthetic speaker. Second synthetic speaker.",
        segments: [
          { speaker: "speaker_0", text: "First synthetic speaker.", start: 0, end: 1.4 },
          { speaker: "speaker_1", text: "Second synthetic speaker.", start: 1.5, end: 3 },
        ],
      });
      return respond(Response.json({ task_id: id }));
    }
    if (
      (at === "https://api.mosi.cn/v1/audio/speech/speakers" || at === "https://api.mosi.cn/v1/audio/voice/generations") &&
      request.method === "POST" &&
      hasBody &&
      !form
    ) {
      const raw = await request.text();
      const dialogue = at.endsWith("/speakers");
      const input = dialogue ? SpeakersInput.parse(raw) : DesignInput.parse(raw);
      const text = "segments" in input ? input.segments.map((segment) => segment.text).join(" ") : input.input;
      if (text.includes("[audio:hold]")) return never(request.signal);
      if (text.includes("[audio:unknown]")) return respond(new Response("", { status: 503 }));
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
        account: authorization ?? "",
        object: dialogue ? "audio.speech" : "audio.voice_generation",
        status: "SUCCESS",
        url,
        response_format: format,
        content_type: type,
      });
      return respond(Response.json({ task_id: id }));
    }
    if (at === "https://api.mosi.cn/v1/audio/speech" && request.method === "POST" && hasBody && !form) {
      const input = SpeechInput.parse(await request.text());
      if (input.input.includes("[speech:hold]")) return never(request.signal);
      if (input.input.includes("[speech:unknown]")) return respond(new Response("", { status: 503 }));
      if (input.stream === true) {
        const id = `stream-${++next}`;
        const frame = frameOf;
        const mono = wav().subarray(44);
        const stereo = Buffer.alloc(mono.length * 2);
        for (let sample = 0; sample < mono.length / 2; sample++) {
          stereo.writeInt16LE(mono.readInt16LE(sample * 2), sample * 4);
          stereo.writeInt16LE(-mono.readInt16LE(sample * 2), sample * 4 + 2);
        }
        const chunk = stereo.toString("base64");
        const frames = input.input.includes("[speech:stream-hold]") ? 1 : input.input.includes("[speech:stream-truncated]") ? 10 : 60;
        const hold = input.input.includes("[speech:stream-hold]");
        const truncated = input.input.includes("[speech:stream-truncated]");
        return eventStream(request, async function* (signal) {
          yield frame({ type: "task.created", task_id: id, object: "audio.speech", status: "PROCESSING", model: "moss-tts-1.5-flash" });
          yield frame({ type: "speech.created", format: "pcm", sample_rate: 24000, channels: 2, bit_depth: 16 });
          for (let i = 0; i < frames; i++) {
            await wallTime.sleep(30, signal);
            yield frame({ type: "speech.audio.delta", audio: chunk });
          }
          if (hold) await never(signal);
          if (truncated) return;
          yield frame({
            type: "speech.audio.done",
            usage: { input_characters: input.input.length, prompt_tokens: 5, completion_tokens: frames, total_tokens: 5 + frames },
            meta_info: { performance: { audio_duration_s: frames * 0.12 } },
          });
        });
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
          account: authorization ?? "",
          object: "audio.speech",
          status: "SUCCESS",
          url,
          response_format: format,
          content_type: type,
        });
        return respond(Response.json({ task_id: id }));
      }
      if (input.response_format !== "wav" && input.response_format !== "mp3") return respond(new Response("", { status: 400 }));
      const large = input.input.includes("[speech:large]");
      const format = large ? "wav" : input.response_format;
      const url = `https://media.example.com/${++next}.${format}`;
      const type = format === "wav" ? "audio/wav" : "audio/mpeg";
      assets.set(url, {
        bytes: large ? wav((26 * 1024 * 1024 - 44) / 2) : format === "wav" ? wav() : mp3,
        type,
        failOnce: input.input.includes("[speech:download-failure]"),
      });
      return respond(
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
    if (at === "https://api.mosi.cn/v1/files" && request.method === "POST" && form) {
      const file = formData.get("file");
      const purpose = formData.get("purpose");
      if (!(file instanceof File) || typeof purpose !== "string") return respond(new Response("", { status: 400 }));
      const id = `file-${++next}`;
      files.set(id, { purpose, failOnce: false });
      return respond(Response.json({ id, object: "file", bytes: file.size, created_at: 1, filename: file.name, purpose, status: "processed" }));
    }
    if (at.startsWith("https://api.mosi.cn/v1/files/") && request.method === "DELETE") {
      const id = at.slice("https://api.mosi.cn/v1/files/".length);
      const file = files.get(id);
      if (!file) return respond(new Response("", { status: 404 }));
      if (file.failOnce) {
        file.failOnce = false;
        return respond(new Response("", { status: 503 }));
      }
      files.delete(id);
      return respond(Response.json({ id, object: "file", deleted: true }));
    }
    if (at === "https://api.mosi.cn/v1/responses" && request.method === "POST" && hasBody && !form) {
      const input = UnderstandingInput.parse(await request.text());
      const content = input.input.flatMap((item) => item.content);
      const text = content
        .filter((part) => part.type === "input_text")
        .map((part) => part.text)
        .join("\n");
      const media = content.filter((part) => part.type !== "input_text");
      if (media.some((part) => files.get(part.file_id)?.purpose !== (part.type === "input_image" ? "image" : "video")))
        return respond(new Response("", { status: 400 }));
      if (text.includes("[understanding:hold]")) return never(request.signal);
      if (text.includes("[understanding:unknown]")) return respond(new Response("", { status: 503 }));
      if (text.includes("[understanding:cleanup-failure]"))
        for (const part of media) {
          const file = files.get(part.file_id);
          if (file) file.failOnce = true;
        }
      const incomplete = text.includes("[understanding:incomplete]");
      return respond(
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
    if (at !== "https://api.mosi.cn/v1/images/generations" || request.method !== "POST" || !hasBody || form) return local(request);
    const image = ImageInput.parse(await request.text());
    const [width, height] = Dimensions.parse(image.size.split("x"));
    if (image.prompt.includes("[media:hold]")) return never(request.signal);
    if (image.prompt.includes("[media:unknown]")) return respond(new Response("", { status: 503 }));
    const url = `https://media.example.com/${++next}.png`;
    assets.set(url, { bytes: png(width, height), type: "image/png", failOnce: image.prompt.includes("[media:download-failure]") });
    return respond(Response.json({ created: 1, data: [{ url }], usage: { generated_images: 1, output_width: width, output_height: height } }));
  };
  const download: PublicFetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get("authorization") !== null) throw new Error("Asset download received credentials");
    const asset = assets.get(request.url);
    if (!asset) throw new Error("Unexpected asset request in the offline browser server");
    if (asset.failOnce) {
      asset.failOnce = false;
      return new Response("", { status: 503 });
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
    return new Response(body, { headers: { "content-type": asset.type, "content-length": String(asset.bytes.length) } });
  };
  return { fetch: model, publicFetch: download };
}
