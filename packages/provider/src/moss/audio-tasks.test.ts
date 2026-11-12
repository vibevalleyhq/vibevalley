import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { answering, failure, hanging, shown, unreachable } from "../base/testing.ts";
import { getMossAudioTask } from "./audio-tasks.ts";
import { createMossSpeechTask } from "./speech.ts";
import { createMossTranscriptionTask } from "./transcription.ts";

const base = { id: "task-one", object: "audio.speech", created_at: 1, updated_at: 2 };
const success = { ...base, status: "SUCCESS", url: "https://audio.example.com/out.wav", response_format: "wav", content_type: "audio/wav" };
const answer = (body: unknown, status = 200) => ({ fetch: answering(() => Response.json(body, { status })) });

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

it.for(["PENDING", "PROCESSING", "FAILED"])("task %s stays distinct from lookup failures and never exposes upstream diagnostics", async (status) => {
  const mossAudioTask = await getMossAudioTask("test-key", base.id, answer({ ...base, status, error: { message: "test-key private vendor error" } }));
  expect(mossAudioTask).toEqual({ id: base.id, object: base.object, status, createdAtSeconds: 1, updatedAtSeconds: 2 });
});

it.for(["audio.speech", "audio.voice_generation"])("%s preserves the actual asynchronous audio format", async (object) => {
  const mossAudioTask = await getMossAudioTask("test-key", base.id, answer({ ...success, object }));
  expect(mossAudioTask).toMatchObject({
    status: "SUCCESS",
    object,
    url: success.url,
    format: "wav",
    contentType: "audio/wav",
  });
});

it.for([{ segments: undefined }, { segments: [] }, { segments: [{ speaker: "speaker-1", text: "Hello", start: 0, end: 1.5 }] }])(
  "transcription preserves absent, empty or populated segments %#",
  async ({ segments }) => {
    const task = await getMossAudioTask(
      "test-key",
      base.id,
      answer({ ...base, object: "audio.transcription", status: "SUCCESS", text: "Hello", ...(segments === undefined ? {} : { segments }) }),
    );
    expect(task).toMatchObject({ status: "SUCCESS", object: "audio.transcription", text: "Hello" });
    if (segments === undefined) expect(task).not.toHaveProperty("segments");
    else expect(task).toHaveProperty("segments", segments);
  },
);

it.for([
  { ...success, id: "other-task" },
  { ...success, updated_at: 0 },
  { ...success, status: "FUTURE_STATUS" },
  { ...success, object: "other.object" },
  { ...success, url: "http://private.example.com/audio" },
  { ...success, content_type: "audio/mpeg" },
  { ...base, status: "SUCCESS" },
  { ...base, status: "SUCCESS", result: { url: success.url, response_format: "wav", content_type: "audio/wav" } },
  { ...base, object: "audio.transcription", status: "SUCCESS", text: "x", segments: [{ speaker: "one", text: "x", start: 2, end: 1 }] },
])("invalid task receipt %# is not a completed result", async (body) => {
  const mossAudioTaskFailure = await failure(getMossAudioTask("test-key", base.id, answer(body)));
  expect(mossAudioTaskFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it.for(["", "../other", "task/other", "task?key=private", "%2e%2e", "a".repeat(257)])("task path input %# cannot escape the fixed endpoint", async (id) => {
  const mossAudioTaskFailure = await failure(getMossAudioTask("test-key", id, { fetch: unreachable }));
  expect(mossAudioTaskFailure).toMatchObject({ reason: "InvalidInput", outcome: "NotSubmitted" });
});

it("missing task and failed task have different results", async () => {
  const mossAudioTaskFailure = await failure(getMossAudioTask("test-key", base.id, answer({ error: { code: "task_not_found", message: "private" } }, 404)));
  expect(mossAudioTaskFailure).toMatchObject({ reason: "HttpStatus", status: 404, code: "task_not_found" });
});

it("an asynchronous submission is followed by explicit reads only, with the same account", async () => {
  const calls: string[] = [];
  let reads = 0;
  const http = {
    fetch: answering((request) => {
      calls.push(`${request.method} ${request.url}`);
      expect(request.headers.get("authorization")).toBe("Bearer test-key");
      if (request.method === "POST") return Response.json({ task_id: base.id }, { status: 202 });
      reads++;
      return Response.json(reads === 3 ? success : { ...base, status: reads === 1 ? "PENDING" : "PROCESSING" });
    }),
  };
  const submitted = await createMossSpeechTask("test-key", { model: "moss-tts-1.0-pro", text: "Synthetic sample", voice: "voice-one", format: "mp3" }, http);
  expect(calls).toHaveLength(1);
  const tasks = [];
  for (const _ of [1, 2, 3]) tasks.push(await getMossAudioTask("test-key", submitted.taskId, http));
  expect(tasks.map((task) => task.status)).toEqual(["PENDING", "PROCESSING", "SUCCESS"]);
  expect(tasks[2]).toMatchObject({ format: "wav" });
  expect(calls).toEqual(["POST https://api.mosi.cn/v1/audio/speech", ...Array.from({ length: 3 }, () => "GET https://api.mosi.cn/v1/audio/tasks/task-one")]);
});

it("task lookup has a bounded deadline and never resubmits generation", async () => {
  const transport = hanging();
  const result = failure(getMossAudioTask("test-key", base.id, { fetch: transport.fetch }));
  await transport.started;
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await result).toMatchObject({ reason: "Timeout" });
  expect(transport.seen.calls).toBe(1);
});

it("long transcription submits once and preserves overlapping speakers and precise timeline offsets", async () => {
  const segments = [
    { speaker: "S02", text: "Later start", start: 35.125, end: 36.875 },
    { speaker: "S01", text: "Overlapping response", start: 35.5, end: 37 },
    { speaker: "S02", text: "Final line", start: 3598, end: 3600 },
  ];
  const calls: string[] = [];
  const http = {
    fetch: answering((request) => {
      calls.push(`${request.method} ${request.url}`);
      expect(request.headers.get("authorization")).toBe("Bearer frozen-account");
      return Response.json(
        request.method === "POST"
          ? { task_id: base.id, retry_after: 4 }
          : { ...base, object: "audio.transcription", status: "SUCCESS", text: "Full transcript", segments },
      );
    }),
  };
  const submitted = await createMossTranscriptionTask("frozen-account", { model: "moss-transcribe-diarize-pro", fileId: "file-one", diarize: true }, http);
  expect(calls).toHaveLength(1);
  const task = await getMossAudioTask("frozen-account", submitted.taskId, http);
  expect(task).toEqual({
    id: base.id,
    object: "audio.transcription",
    status: "SUCCESS",
    text: "Full transcript",
    segments,
    createdAtSeconds: 1,
    updatedAtSeconds: 2,
  });
  expect(task).not.toHaveProperty("duration");
  expect(task).not.toHaveProperty("usage");
  expect(calls).toEqual(["POST https://api.mosi.cn/v1/audio/transcriptions", `GET https://api.mosi.cn/v1/audio/tasks/${base.id}`]);
});

it.for([
  { segments: [{ speaker: "", text: "x", start: 0, end: 1 }] },
  { segments: [{ speaker: "S01", text: "x", start: -1, end: 1 }] },
  { segments: [{ speaker: "S01", text: "x", start: 2, end: 1 }] },
  { segments: Array.from({ length: 10001 }, () => ({ speaker: "S01", text: "x", start: 0, end: 1 })) },
])("invalid or excessive transcription segments %# cannot become a usable timeline", async ({ segments }) => {
  const mossAudioTaskFailure = await failure(
    getMossAudioTask("test-key", base.id, answer({ ...base, object: "audio.transcription", status: "SUCCESS", text: "x", segments })),
  );
  expect(mossAudioTaskFailure).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
});

it.for(["audio.speech", "audio.voice_generation", "audio.transcription"])(
  "%s preserves observed optional usage without deriving missing counts",
  async (object) => {
    const task = await getMossAudioTask(
      "test-key",
      base.id,
      answer({
        ...success,
        object,
        text: "Transcript",
        usage: { input_characters: 9, prompt_tokens: 149, completion_tokens: 63, total_tokens: 212 },
      }),
    );
    expect(task).toHaveProperty("usage", { inputCharacters: 9, promptTokens: 149, completionTokens: 63, totalTokens: 212 });
  },
);

it("partial zero-valued audio task usage remains partial and zero", async () => {
  const mossAudioTask = await getMossAudioTask("test-key", base.id, answer({ ...success, usage: { completion_tokens: 0 } }));
  expect(mossAudioTask).toHaveProperty("usage", { completionTokens: 0 });
});

it.for([{ total_tokens: -1 }, { input_characters: 0.5 }, { prompt_tokens: "private" }])(
  "malformed task usage %# fails without exposing its content",
  async (usage) => {
    const error = await failure(getMossAudioTask("test-key", base.id, answer({ ...success, usage })));
    expect(error).toMatchObject({ reason: "InvalidResponse", outcome: "Unknown" });
    expect(shown(error)).not.toContain("private");
  },
);
