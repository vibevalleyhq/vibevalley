import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { messageText } from "@vibevalley/agent/messages";
import { scriptedLLM } from "@vibevalley/agent/testing";
import type { ModelClient } from "@vibevalley/ai/client";
import { answer, toolCall } from "@vibevalley/ai/testing";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { orchestrator, worker } from "#/base/actor.ts";
import { Channel } from "#/channel/channel.ts";
import { Ingress } from "#/ingress/ingress.ts";
import { Media } from "#/media/media.ts";
import { Orchestrator } from "#/orchestrator/orchestrator.ts";
import { Provider } from "#/provider/provider.ts";
import { testConfig, until, waitFor } from "#/testing/layers.ts";
import { network } from "#/testing/network.ts";
import { world } from "#/testing/world.ts";
import { Tool } from "#/tool/tool.ts";

const dialogue = {
  id: "tool-speakers",
  connection: "audio",
  revision: 1,
  format: "wav",
  speakers: [
    { id: "host", voice: "voice-one" },
    { id: "guest", voice: "voice-two" },
  ],
  segments: [
    { speaker: "host", text: "Hello." },
    { speaker: "guest", text: "Welcome." },
  ],
};
const design = { id: "tool-design", connection: "audio", revision: 1, format: "wav", text: "Hello.", instruction: "A warm clear voice." };
const configured = Effect.gen(function* () {
  const provider = yield* Provider;
  yield* provider.update({
    ...provider.status(),
    connections: [{ id: "audio", name: "Audio", adapter: "moss", enabled: true, key: "test-audio-key" }],
    speakers: { connection: "audio", model: "moss-ttsd-1.0" },
    voiceDesign: { connection: "audio", model: "moss-voice-generator-1.0" },
  });
});
const farm = (llm: ModelClient) => {
  const media = Layer.fresh(Media.layer).pipe(
    Layer.provideMerge(Layer.fresh(Provider.layer)),
    Layer.provideMerge(network),
    Layer.provideMerge(world({ config: testConfig({ patrol: { heartbeatMinutes: 0 } }) })),
  );
  const tools = Layer.fresh(Tool.layer).pipe(Layer.provideMerge(media));
  return Orchestrator.layer({ llm: () => llm }).pipe(Layer.provideMerge(tools));
};

it.effect("user-directed audio tools create attributed dialogue and a preview without silently cloning a voice", () => {
  const { llm, requests } = scriptedLLM([
    answer([toolCall("media_dialogue_create", dialogue), toolCall("media_voice_design_create", design)]),
    answer("Submitted"),
    answer([toolCall("media_job_get", { id: dialogue.id }), toolCall("media_job_get", { id: design.id })]),
    answer("Saved locally"),
  ]);
  return Effect.gen(function* () {
    yield* configured;
    const media = yield* Media;
    const ingress = yield* Ingress;
    yield* ingress.say("Create dialogue and a voice preview", {}, undefined, "");
    yield* waitFor(
      media.list(),
      (jobs) => [dialogue.id, design.id].every((id) => jobs.some((job) => job.id === id && job.phase === "ready")),
      "audio results saved",
    );
    const speech = yield* media.get(dialogue.id);
    const preview = yield* media.get(design.id);
    expect(speech.kind).toBe("speakers");
    expect(preview.kind).toBe("voiceDesign");
    if (speech.kind !== "speakers" || preview.kind !== "voiceDesign") return yield* Effect.die("Expected dialogue and voice design preview");
    const source = { kind: "orchestrator", agent: defaultOrchestrator, channel: (yield* Channel).defaultChannel() };
    expect(speech.source).toEqual(source);
    expect(preview.source).toEqual(source);
    expect(preview.previewInput).not.toBeNull();
    expect(preview.result).toBeNull();
    expect(speech.attachment?.id).toMatch(/^[a-f0-9]{64}$/u);
    yield* until(() => requests.length >= 2, "audio creation acknowledged");
    yield* ingress.say("Read both audio results", {}, undefined, "");
    yield* until(() => requests.length >= 4, "audio results delivered");
    const results = requests.flatMap((request) => request.messages.filter((message) => message.role === "toolResult").map(messageText)).join("\n");
    expect(results).toContain(speech.attachment?.id);
    expect(results).not.toContain("test-audio-key");
    expect(results).not.toContain("https://media.example.com");
    expect((yield* media.list()).filter((job) => job.kind === "clone")).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(farm(llm)));
});

it.effect("regression: audio tools reject autonomous and worker callers; cloning and source upload remain user-only", () => {
  const { llm } = scriptedLLM([answer("No operation")]);
  return Effect.gen(function* () {
    yield* configured;
    const tools = yield* Tool;
    const here = (yield* Channel).defaultChannel();
    const caller = () => ({ agent: defaultOrchestrator, session: "", repo: "", here, picked: "", envelope: "", actor: orchestrator(false) });
    const available = tools.orchestrator(caller);
    for (const [name, input] of [
      ["media_dialogue_create", dialogue],
      ["media_voice_design_create", design],
    ] as const) {
      const tool = available.find((candidate) => candidate.name === name);
      if (!tool) return yield* Effect.die(`Missing ${name}`);
      expect((yield* tool.execute(input, { id: name }).pipe(Effect.flip)).message).toBeTruthy();
    }
    expect(
      available.some((tool) => tool.name === "media_clone_create" || tool.name === "media_transcription_create" || tool.name === "media_audio_cleanup"),
    ).toBe(false);
    expect(tools.session(() => ({ ...caller(), session: "worker", actor: worker("worker") })).filter((tool) => tool.name.startsWith("media_"))).toEqual([]);
    const found = yield* (yield* Media).list();
    expect(found).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(farm(llm)));
});
