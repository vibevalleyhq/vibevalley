import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { mossVoiceDesignModels } from "./voice-design-models.ts";
import { createMossVoiceDesignTask } from "./voice-design.ts";

const input = { model: "moss-voice-generator-1.0", text: "Synthetic preview", instruction: "A calm narrator", format: "wav" };

it.effect.each(mossVoiceDesignModels)("%s explicitly creates a preview, not an untracked reusable voice", (model) => {
  let calls = 0;
  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      calls++;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("https://api.mosi.cn/v1/audio/voice/generations");
      expect(request.headers.authorization).toBe("Bearer design-account");
      if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected JSON");
      expect(JSON.parse(new TextDecoder().decode(request.body.body))).toEqual({
        model,
        input: input.text,
        instruction: input.instruction,
        response_format: "wav",
        delivery_method: "url",
        create_voice: false,
        async: true,
      });
      return HttpClientResponse.fromWeb(request, Response.json({ task_id: "design-one" }, { status: 202 }));
    }),
  );
  return Effect.gen(function* () {
    expect(yield* createMossVoiceDesignTask("design-account", { ...input, model })).toEqual({ taskId: "design-one" });
    expect(calls).toBe(1);
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
});

it.effect.each([
  { text: "" },
  { text: " " },
  { instruction: " " },
  { instruction: "x".repeat(10001) },
  { text: "x".repeat(10001) },
  { model: "moss-ttsd-1.0" },
  { format: "ogg" },
  { create_voice: true },
  { voice: "voice-one" },
  { stream: true },
  { webhook_url: "https://example.com/callback" },
])("unsupported voice design input %# cannot create a billable request", (patch) =>
  Effect.gen(function* () {
    expect(yield* createMossVoiceDesignTask("design-account", { ...input, ...patch }).pipe(Effect.flip)).toMatchObject({
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
