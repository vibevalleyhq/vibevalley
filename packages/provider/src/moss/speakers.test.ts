import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { mossSpeakersModels } from "./speakers-models.ts";
import { createMossSpeakersTask, prepareMossSpeakers } from "./speakers.ts";

const bodyOf = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

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

it.effect.each(mossSpeakersModels)("%s maps voices and ordered dialogue without inventing streaming", (model) => {
  let calls = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://api.mosi.cn/v1/audio/speech/speakers");
      expect(request.headers.authorization).toBe("Bearer account-one");
      const serviceOption2 = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
      expect(serviceOption2).toMatchObject({ _tag: "Some", value: { redirect: "manual" } });
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
      expect(Option.getOrUndefined(bodyOf(new TextDecoder().decode(request.body.body)))).toEqual({
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
      return HttpClientResponse.fromWeb(request, Response.json({ task_id: "dialogue-one", retry_after: 3 }, { status: 202 }));
    }),
  );
  return Effect.gen(function* () {
    const mossSpeakersTaskCreated = yield* createMossSpeakersTask("account-one", { ...input, model });
    expect(mossSpeakersTaskCreated).toEqual({ taskId: "dialogue-one", retryAfterSeconds: 3 });
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
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
])("invalid speaker mapping %# is rejected before billing", (patch) =>
  Effect.gen(function* () {
    const mossSpeakersTaskCreatedFailure = yield* createMossSpeakersTask("account-one", { ...input, ...patch }).pipe(Effect.flip);
    expect(mossSpeakersTaskCreatedFailure).toMatchObject({
      reason: "InvalidInput",
      outcome: "NotSubmitted",
    });
  }).pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Must not submit")),
    ),
  ),
);

it.effect("Unicode text bounds count code points across all segments", () =>
  Effect.gen(function* () {
    const request = yield* prepareMossSpeakers({ ...input, segments: [{ speaker: "host", text: "𝄞".repeat(10000) }] });
    expect(request.segments[0]?.text).toHaveLength(20000);
    const mossSpeakersPreparedFailure = yield* prepareMossSpeakers({ ...input, segments: [{ speaker: "host", text: "𝄞".repeat(10001) }] }).pipe(Effect.flip);
    expect(mossSpeakersPreparedFailure).toMatchObject({
      reason: "InvalidInput",
    });
  }),
);
