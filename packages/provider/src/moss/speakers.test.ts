import { expect, it } from "vite-plus/test";

import { answering, failure, unreachable } from "../base/testing.ts";
import { mossSpeakersModels } from "./speakers-models.ts";
import { createMossSpeakersTask, prepareMossSpeakers } from "./speakers.ts";

const input = {
  model: "moss-ttsd-1.0",
  speakers: [
    { id: "host", voice: "voice-one" },
    { id: "guest", voice: "voice-two" },
  ],
  segments: [
    { speaker: "guest", text: "First line" },
    { speaker: "host", text: "Second line" },
  ],
  format: "mp3",
};

it.for(mossSpeakersModels)("%s maps voices and ordered dialogue without inventing streaming", async (model) => {
  let calls = 0;
  const fetch = answering(async (request) => {
    calls++;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/speech/speakers");
    expect(request.headers.get("authorization")).toBe("Bearer account-one");
    expect(request.redirect).toBe("manual");
    expect(await request.json()).toEqual({
      model,
      speakers: [
        { id: "host", voice_id: "voice-one" },
        { id: "guest", voice_id: "voice-two" },
      ],
      segments: input.segments,
      response_format: "mp3",
      delivery_method: "url",
      async: true,
    });
    return Response.json({ task_id: "dialogue-one", retry_after: 3 }, { status: 202 });
  });
  const mossSpeakersTaskCreated = await createMossSpeakersTask("account-one", { ...input, model }, { fetch });
  expect(mossSpeakersTaskCreated).toEqual({ taskId: "dialogue-one", retryAfterSeconds: 3 });
  expect(calls).toBe(1);
});

it.for([
  { speakers: [] },
  {
    speakers: [
      { id: "host", voice: "one" },
      { id: "host", voice: "two" },
    ],
  },
  { speakers: [{ id: "host", voice: "one" }] },
  { speakers: [{ id: "", voice: "one" }] },
  {
    speakers: [
      { id: "host", voice: "../one" },
      { id: "guest", voice: "two" },
    ],
  },
  { segments: [] },
  { segments: [{ speaker: "unknown", text: "Text" }] },
  { segments: [{ speaker: "host", text: " " }] },
  {
    segments: [
      { speaker: "host", text: "x".repeat(6000) },
      { speaker: "guest", text: "x".repeat(4001) },
    ],
  },
  { segments: Array.from({ length: 1001 }, () => ({ speaker: "host", text: "x" })) },
  { model: "moss-tts-1.5-flash" },
  { format: "ogg" },
  { stream: true },
  { webhook_url: "https://example.com/callback" },
])("invalid speaker mapping %# is rejected before billing", async (patch) => {
  const mossSpeakersTaskCreatedFailure = await failure(createMossSpeakersTask("account-one", { ...input, ...patch }, { fetch: unreachable }));
  expect(mossSpeakersTaskCreatedFailure).toMatchObject({
    reason: "InvalidInput",
    outcome: "NotSubmitted",
  });
});

it("Unicode text bounds count code points across all segments", async () => {
  const request = await prepareMossSpeakers({ ...input, segments: [{ speaker: "host", text: "𝄞".repeat(10000) }] });
  expect(request.segments[0]?.text).toHaveLength(20000);
  const mossSpeakersPreparedFailure = await failure(prepareMossSpeakers({ ...input, segments: [{ speaker: "host", text: "𝄞".repeat(10001) }] }));
  expect(mossSpeakersPreparedFailure).toMatchObject({
    reason: "InvalidInput",
  });
});
