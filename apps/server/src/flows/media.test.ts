import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { messageText } from "@vibevalley/agent/messages";
import { scriptedLLM } from "@vibevalley/agent/testing";
import { answer, toolCall } from "@vibevalley/ai/testing";
import { defaultOrchestrator } from "@vibevalley/protocol";

import { orchestrator, session } from "#/base/actor.ts";
import { Channel } from "#/channel/channel.ts";
import { Ingress } from "#/ingress/ingress.ts";
import { Media } from "#/media/media.ts";
import { Orchestrator } from "#/orchestrator/orchestrator.ts";
import { Provider } from "#/provider/provider.ts";
import { testConfig, until, waitFor } from "#/testing/layers.ts";
import { network } from "#/testing/network.ts";
import { world } from "#/testing/world.ts";
import { Tool } from "#/tool/tool.ts";

const configured = Effect.gen(function* () {
  yield* (yield* Provider).update({
    revision: 0,
    connections: [{ id: "images", name: "Images", adapter: "moss", enabled: true, key: "test-only-key" }],
    dictation: null,
    live: null,
    image: { connection: "images", model: "moss-image-base-1.0" },
    understanding: null,
    speech: null,
  });
});

const farm = (llm: ReturnType<typeof scriptedLLM>["llm"]) => {
  const media = Layer.fresh(Media.layer).pipe(
    Layer.provideMerge(network),
    Layer.provideMerge(world({ config: testConfig({ patrol: { heartbeatMinutes: 0 } }) })),
  );
  const tools = Layer.fresh(Tool.layer).pipe(Layer.provideMerge(media));
  return Orchestrator.layer({ llm: () => llm }).pipe(Layer.provideMerge(tools));
};

it.effect("the orchestrator creates an attributed image and reads its local attachment through the same media service", () => {
  const id = "orchestrator-image";
  const { llm, requests } = scriptedLLM([
    answer([toolCall("media_image_create", { id, prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true })]),
    answer("Submitted"),
    answer([toolCall("media_job_get", { id }), toolCall("media_job_list", {})]),
    answer("Saved locally"),
  ]);
  return Effect.gen(function* () {
    yield* configured;
    const ingress = yield* Ingress;
    yield* ingress.say("Generate one image", {}, undefined, "");
    const jobs = yield* waitFor((yield* Media).list(), (jobs) => jobs.some((job) => job.id === id && job.phase === "ready"), "the orchestrator's local image");
    const job = jobs.find((job) => job.id === id);
    if (job?.kind !== "image") return yield* Effect.die("Expected image task");
    expect(job?.source).toEqual({ kind: "orchestrator", agent: defaultOrchestrator, channel: (yield* Channel).defaultChannel() });
    expect(job?.usage).toEqual({ images: 1, width: 256, height: 256 });
    expect(job?.attachment?.id).toMatch(/^[a-f0-9]{64}$/u);
    yield* until(() => requests.length >= 2, "submission acknowledged");
    yield* ingress.say("Read the saved image", {}, undefined, "");
    yield* until(() => requests.length >= 4, "image tools answered");
    const results = requests.flatMap((request) => request.messages.filter((message) => message.role === "toolResult").map(messageText)).join("\n");
    expect(results).toContain(job?.attachment?.id);
    expect(results).not.toContain("test-only-key");
    expect(results).not.toContain("https://media.example.com");
  }).pipe(Effect.scoped, Effect.provide(farm(llm)));
});

it.effect("unknown outcomes reach the model without usage guesses, while autonomous and worker callers cannot generate", () => {
  const input = { id: "unknown", prompt: "[media:unknown]", format: "text", width: 256, height: 256, enhance: false, watermark: true };
  const { llm, requests } = scriptedLLM([
    answer([toolCall("media_image_create", input)]),
    answer("Submitted"),
    answer([toolCall("media_job_get", { id: "unknown" })]),
    answer("Outcome unknown"),
  ]);
  return Effect.gen(function* () {
    yield* configured;
    const ingress = yield* Ingress;
    const media = yield* Media;
    yield* ingress.say("Generate one image", {}, undefined, "");
    yield* waitFor(media.list(), (jobs) => jobs.some((job) => job.id === "unknown" && job.phase === "unknown"), "ambiguous submission");
    yield* until(() => requests.length >= 2, "submission acknowledged");
    yield* ingress.say("Check without submitting again", {}, undefined, "");
    yield* until(() => requests.length >= 4, "unknown outcome reported");
    const results = requests
      .at(-1)
      ?.messages.filter((message) => message.role === "toolResult")
      .map(messageText)
      .join("\n");
    expect(results).toContain('"phase":"unknown"');
    const unknown = yield* media.get("unknown");
    if (unknown.kind !== "image") return yield* Effect.die("Expected image task");
    expect(unknown.usage).toBeUndefined();
    const tools = yield* Tool;
    const channel = (yield* Channel).defaultChannel();
    const caller = () => ({ agent: defaultOrchestrator, session: "", repo: "", here: channel, picked: "", envelope: "", actor: orchestrator(false) });
    const create = tools.orchestrator(caller).find((tool) => tool.name === "media_image_create");
    if (create === undefined) throw new Error("media_image_create is missing");
    expect((yield* Effect.flip(create.execute({ ...input, id: "autonomous" }, { id: "blocked" }))).message).toBeTruthy();
    expect(tools.session(() => ({ ...caller(), session: "worker", actor: session("worker") })).filter((tool) => tool.name.startsWith("media_"))).toEqual([]);
    expect(yield* media.list()).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(farm(llm)));
});

it.effect("the orchestrator retries only a download and cancels a separate pending generation", () => {
  const parameters = { format: "text", width: 256, height: 256, enhance: false, watermark: true };
  const { llm, requests } = scriptedLLM([
    answer([toolCall("media_image_create", { ...parameters, id: "retry", prompt: "[media:download-failure]" })]),
    answer("Submitted"),
    answer([toolCall("media_job_download", { id: "retry" })]),
    answer("Download resumed"),
    answer([toolCall("media_image_create", { ...parameters, id: "cancel", prompt: "[media:hold]" })]),
    answer("Submitted"),
    answer([toolCall("media_job_cancel", { id: "cancel" })]),
    answer("Stopped waiting"),
  ]);
  return Effect.gen(function* () {
    yield* configured;
    const ingress = yield* Ingress;
    const media = yield* Media;
    yield* ingress.say("Generate one image", {}, undefined, "");
    yield* waitFor(media.list(), (jobs) => jobs.some((job) => job.id === "retry" && job.phase === "download_failed"), "download failed");
    yield* until(() => requests.length >= 2, "submission acknowledged");
    yield* ingress.say("Retry only its download", {}, undefined, "");
    yield* waitFor(media.get("retry"), (job) => job.phase === "ready", "tool retried download");
    yield* until(() => requests.length >= 4, "retry acknowledged");
    yield* ingress.say("Generate another image", {}, undefined, "");
    yield* waitFor(media.list(), (jobs) => jobs.some((job) => job.id === "cancel" && job.phase === "generating"), "generation started");
    yield* until(() => requests.length >= 6, "second submission acknowledged");
    yield* ingress.say("Cancel waiting for that image", {}, undefined, "");
    yield* waitFor(media.get("cancel"), (job) => job.phase === "canceled", "tool canceled waiting");
    expect(yield* media.list()).toHaveLength(2);
  }).pipe(Effect.scoped, Effect.provide(farm(llm)));
});
