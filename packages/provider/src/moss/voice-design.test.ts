import { expect, it } from "vite-plus/test";

import { answering, failure, unreachable } from "../base/testing.ts";
import { mossVoiceDesignModels } from "./voice-design-models.ts";
import { createMossVoiceDesignTask } from "./voice-design.ts";

const input = { model: "moss-voice-generator-1.0", text: "Synthetic preview", instruction: "A calm narrator", format: "wav" };

it.for(mossVoiceDesignModels)("%s explicitly creates a preview, not an untracked reusable voice", async (model) => {
  let calls = 0;
  const fetch = answering(async (request) => {
    calls++;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://api.mosi.cn/v1/audio/voice/generations");
    expect(request.headers.get("authorization")).toBe("Bearer design-account");
    expect(await request.json()).toEqual({
      model,
      input: input.text,
      instruction: input.instruction,
      response_format: "wav",
      delivery_method: "url",
      create_voice: false,
      async: true,
    });
    return Response.json({ task_id: "design-one" }, { status: 202 });
  });
  const mossVoiceDesignTaskCreated = await createMossVoiceDesignTask("design-account", { ...input, model }, { fetch });
  expect(mossVoiceDesignTaskCreated).toEqual({ taskId: "design-one" });
  expect(calls).toBe(1);
});

it.for([
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
])("unsupported voice design input %# cannot create a billable request", async (patch) => {
  const mossVoiceDesignTaskCreatedFailure = await failure(createMossVoiceDesignTask("design-account", { ...input, ...patch }, { fetch: unreachable }));
  expect(mossVoiceDesignTaskCreatedFailure).toMatchObject({
    reason: "InvalidInput",
    outcome: "NotSubmitted",
  });
});
