import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { orchestrator, worker } from "#/base/actor.ts";
import { messageText } from "#/modules/agent/durable.ts";
import { png } from "#/modules/media/testdata/png.ts";
import type { Provider } from "#/platform/provider/provider.ts";
import { until, waitFor } from "#/testing/layers.ts";
import { answer, scriptedLLM, toolCall } from "#/testing/model.ts";

import { failure, mediaFarm } from "./farm.ts";

const configure = (fw: { readonly provider: Provider }) =>
  fw.provider.update({
    revision: 0,
    connections: [{ id: "images", name: "Images", adapter: "moss", enabled: true, key: "test-only-key" }],
    dictation: null,
    live: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
    image: { connection: "images", model: "moss-image-base-1.0" },
    understanding: null,
    speech: null,
  });

test("the orchestrator creates an attributed image and reads its local attachment through the same media service", async () => {
  const id = "orchestrator-image";
  const { llm, requests } = scriptedLLM([
    answer([toolCall("media_image_create", { id, prompt: "A farm", format: "text", width: 256, height: 256, enhance: false, watermark: true })]),
    answer("Submitted"),
    answer([toolCall("media_job_get", { id }), toolCall("media_job_list", {})]),
    answer("Saved locally"),
  ]);
  await using fw = await mediaFarm(llm);
  await configure(fw);
  const chat = fw.channel;
  await chat.say({ text: "Generate one image", sendKey: "" });
  const jobs = await waitFor(
    () => fw.media.list(),
    (jobs) => jobs.some((job) => job.id === id && job.phase === "ready"),
    "the orchestrator's local image",
  );
  const job = jobs.find((job) => job.id === id);
  if (job?.kind !== "image") throw new Error("Expected image task");
  expect(job?.source).toEqual({ kind: "orchestrator", agent: defaultOrchestrator, channel: chat.defaultChannel() });
  expect(job?.usage).toEqual({ images: 1, width: 256, height: 256 });
  expect(job?.attachment?.id).toMatch(/^[a-f0-9]{64}$/u);
  await until(() => requests.length >= 2, "submission acknowledged");
  await chat.say({ text: "Read the saved image", sendKey: "" });
  await until(() => requests.length >= 4, "image tools answered");
  const results = requests.flatMap((request) => request.messages.filter((message) => message.role === "toolResult").map(messageText)).join("\n");
  expect(results).toContain(job?.attachment?.id);
  expect(results).not.toContain("test-only-key");
  expect(results).not.toContain("https://media.example.com");
});

test("unknown outcomes reach the model without usage guesses, while autonomous and worker callers cannot generate", async () => {
  const input = { id: "unknown", prompt: "[media:unknown]", format: "text", width: 256, height: 256, enhance: false, watermark: true };
  const { llm, requests } = scriptedLLM([
    answer([toolCall("media_image_create", input)]),
    answer("Submitted"),
    answer([toolCall("media_job_get", { id: "unknown" })]),
    answer("Outcome unknown"),
  ]);
  await using fw = await mediaFarm(llm);
  await configure(fw);
  const chat = fw.channel;
  const media = fw.media;
  await chat.say({ text: "Generate one image", sendKey: "" });
  await waitFor(
    () => media.list(),
    (jobs) => jobs.some((job) => job.id === "unknown" && job.phase === "unknown"),
    "ambiguous submission",
  );
  await until(() => requests.length >= 2, "submission acknowledged");
  await chat.say({ text: "Check without submitting again", sendKey: "" });
  await until(() => requests.length >= 4, "unknown outcome reported");
  const results = requests
    .at(-1)
    ?.messages.filter((message) => message.role === "toolResult")
    .map(messageText)
    .join("\n");
  expect(results).toContain('"phase":"unknown"');
  const unknown = await media.get("unknown");
  if (unknown.kind !== "image") throw new Error("Expected image task");
  expect(unknown.usage).toBeUndefined();
  const tools = fw.tool;
  const channel = fw.channel.defaultChannel();
  const caller = () => ({ agent: defaultOrchestrator, session: "", repo: "", here: channel, picked: "", envelope: "", actor: orchestrator(false) });
  const create = tools.orchestrator(caller).find((tool) => tool.name === "media_image_create");
  if (create === undefined) throw new Error("media_image_create is missing");
  expect((await failure(create.execute({ ...input, id: "autonomous" }, { id: "blocked" }))).message).toBeTruthy();
  expect(tools.session(() => ({ ...caller(), session: "worker", actor: worker("worker") })).filter((tool) => tool.name.startsWith("media_"))).toEqual([]);
  const medias = await media.list();
  expect(medias).toHaveLength(1);
});

test("the orchestrator retries only a download and cancels a separate pending generation", async () => {
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
  await using fw = await mediaFarm(llm);
  await configure(fw);
  const chat = fw.channel;
  const media = fw.media;
  await chat.say({ text: "Generate one image", sendKey: "" });
  await waitFor(
    () => media.list(),
    (jobs) => jobs.some((job) => job.id === "retry" && job.phase === "download_failed"),
    "download failed",
  );
  await until(() => requests.length >= 2, "submission acknowledged");
  await chat.say({ text: "Retry only its download", sendKey: "" });
  await waitFor(
    () => media.get("retry"),
    (job) => job.phase === "ready",
    "tool retried download",
  );
  await until(() => requests.length >= 4, "retry acknowledged");
  await chat.say({ text: "Generate another image", sendKey: "" });
  await waitFor(
    () => media.list(),
    (jobs) => jobs.some((job) => job.id === "cancel" && job.phase === "generating"),
    "generation started",
  );
  await until(() => requests.length >= 6, "second submission acknowledged");
  await chat.say({ text: "Cancel waiting for that image", sendKey: "" });
  await waitFor(
    () => media.get("cancel"),
    (job) => job.phase === "canceled",
    "tool canceled waiting",
  );
  const medias = await media.list();
  expect(medias).toHaveLength(2);
});

test("the orchestrator executes a frozen user approval through its trusted channel context", async () => {
  const id = "authorized-understanding";
  const { llm, requests } = scriptedLLM([
    answer([toolCall("media_understanding_start", { id })]),
    answer("Started the authorized request"),
    answer([toolCall("media_job_get", { id })]),
    answer("The synthetic image was understood"),
  ]);
  await using fw = await mediaFarm(llm);
  await configure(fw);
  const provider = fw.provider;
  const status = await provider.update({
    ...provider.status(),
    connections: [{ id: "images", name: "Images", adapter: "moss", enabled: true }],
    understanding: { connection: "images", model: "moss-vl-1.0" },
  });
  const media = fw.media;
  const bytes = png();
  const input = await media.inputs.create({ kind: "image", mime: "image/png", name: "synthetic.png", size: bytes.length });
  await media.inputs.upload(
    input.id,
    (async function* () {
      yield bytes;
    })(),
  );
  const channel = fw.channel.defaultChannel();
  await media.authorizeUnderstanding({
    id,
    prompt: "Explain this synthetic image",
    inputs: [input.id],
    connection: "images",
    revision: status.revision,
    allowUpload: true,
    maxOutputTokens: 64,
    channel,
  });
  expect((await media.get(id)).phase).toBe("authorized");
  const chat = fw.channel;
  await chat.say({ text: "Execute the authorized understanding task", channel: channel, sendKey: "" });
  const job = await waitFor(
    () => media.get(id),
    (job) => job.kind === "understanding" && job.cleanup === "done",
    "delegated task result",
  );
  expect(job).toMatchObject({
    phase: "ready",
    source: { kind: "orchestrator", agent: defaultOrchestrator, channel },
    result: { text: "Offline understanding of image input." },
  });
  await until(() => requests.length >= 2, "delegated submission acknowledged");
  await chat.say({ text: "Read the understanding result", channel: channel, sendKey: "" });
  await until(() => requests.length >= 4, "understanding result read by orchestrator");
  const returned = requests
    .at(-1)
    ?.messages.filter((message) => message.role === "toolResult")
    .map(messageText)
    .join("\n");
  expect(returned).toContain("Offline understanding of image input.");
  expect(returned).not.toContain("fingerprint");
  const tools = fw.tool;
  const caller = () => ({ agent: defaultOrchestrator, session: "", repo: "", here: channel, picked: "", envelope: "", actor: orchestrator(false) });
  const start = tools.orchestrator(caller).find((tool) => tool.name === "media_understanding_start");
  if (!start) throw new Error("Missing authorized understanding tool");
  const outcomeFailure = await failure(start.execute({ id }, { id: "autonomous" }));
  expect(outcomeFailure).toMatchObject({ _tag: "ToolFailed" });
});

test("the orchestrator synthesizes speech with trusted provenance and reads the persisted audio", async () => {
  const id = "orchestrator-speech";
  const { llm, requests } = scriptedLLM([
    answer([
      toolCall("media_speech_create", { id, text: "[speech:success] A quiet farm", voice: "voice-one", format: "wav", connection: "images", revision: 2 }),
    ]),
    answer("Submitted"),
    answer([toolCall("media_job_get", { id })]),
    answer("Audio saved"),
  ]);
  await using fw = await mediaFarm(llm);
  await configure(fw);
  const provider = fw.provider;
  await provider.update({
    ...provider.status(),
    connections: [{ id: "images", name: "Images", adapter: "moss", enabled: true }],
    speech: { connection: "images", model: "moss-tts-1.5-flash" },
  });
  const chat = fw.channel;
  await chat.say({ text: "Generate the requested speech", sendKey: "" });
  const jobs = await waitFor(
    () => fw.media.list(),
    (jobs) => jobs.some((job) => job.id === id && job.phase === "ready"),
    "speech tool saved audio",
  );
  const job = jobs.find((job) => job.id === id);
  expect(job).toMatchObject({
    kind: "speech",
    source: { kind: "orchestrator", agent: defaultOrchestrator, channel: chat.defaultChannel() },
    attachment: { type: "audio/wav" },
  });
  if (job?.kind !== "speech" || !job.attachment) throw new Error("Expected saved speech");
  await until(() => requests.length >= 2, "speech submission acknowledged");
  await chat.say({ text: "Read the saved speech", sendKey: "" });
  await until(() => requests.length >= 4, "speech result read by orchestrator");
  const returned = requests
    .at(-1)
    ?.messages.filter((message) => message.role === "toolResult")
    .map(messageText)
    .join("\n");
  expect(returned).toContain(job.attachment.id);
  expect(returned).not.toContain("test-only-key");
  expect(returned).not.toContain("https://media.example.com");
});
