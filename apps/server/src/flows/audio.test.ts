import { expect, test } from "vite-plus/test";

import { defaultOrchestrator } from "@vibevalley/protocol";

import { orchestrator, worker } from "#/base/actor.ts";
import type { Provider } from "#/modules/provider/provider.ts";
import { messageText } from "#/modules/runtime/durable.ts";
import { until, waitFor } from "#/testing/layers.ts";
import { answer, scriptedLLM, toolCall } from "#/testing/model.ts";

import { failure, mediaFarm } from "./farm.ts";

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
const configure = (fw: { readonly provider: Provider }) =>
  fw.provider.update({
    ...fw.provider.status(),
    connections: [{ id: "audio", name: "Audio", adapter: "moss", enabled: true, key: "test-audio-key" }],
    speakers: { connection: "audio", model: "moss-ttsd-1.0" },
    voiceDesign: { connection: "audio", model: "moss-voice-generator-1.0" },
  });

test("user-directed audio tools create attributed dialogue and a preview without silently cloning a voice", async () => {
  const { llm, requests } = scriptedLLM([
    answer([toolCall("media_dialogue_create", dialogue), toolCall("media_voice_design_create", design)]),
    answer("Submitted"),
    answer([toolCall("media_job_get", { id: dialogue.id }), toolCall("media_job_get", { id: design.id })]),
    answer("Saved locally"),
  ]);
  await using fw = await mediaFarm(llm);
  await configure(fw);
  const media = fw.media;
  const chat = fw.channel;
  await chat.say({ text: "Create dialogue and a voice preview", sendKey: "" });
  await waitFor(
    () => media.list(),
    (jobs) => [dialogue.id, design.id].every((id) => jobs.some((job) => job.id === id && job.phase === "ready")),
    "audio results saved",
  );
  const speech = await media.get(dialogue.id);
  const preview = await media.get(design.id);
  expect(speech.kind).toBe("speakers");
  expect(preview.kind).toBe("voiceDesign");
  if (speech.kind !== "speakers" || preview.kind !== "voiceDesign") throw new Error("Expected dialogue and voice design preview");
  const source = { kind: "orchestrator", agent: defaultOrchestrator, channel: chat.defaultChannel() };
  expect(speech.source).toEqual(source);
  expect(preview.source).toEqual(source);
  expect(preview.previewInput).not.toBeNull();
  expect(preview.result).toBeNull();
  expect(speech.attachment?.id).toMatch(/^[a-f0-9]{64}$/u);
  await until(() => requests.length >= 2, "audio creation acknowledged");
  await chat.say({ text: "Read both audio results", sendKey: "" });
  await until(() => requests.length >= 4, "audio results delivered");
  const results = requests.flatMap((request) => request.messages.filter((message) => message.role === "toolResult").map(messageText)).join("\n");
  expect(results).toContain(speech.attachment?.id);
  expect(results).not.toContain("test-audio-key");
  expect(results).not.toContain("https://media.example.com");
  expect((await media.list()).filter((job) => job.kind === "clone")).toEqual([]);
});

test("regression: audio tools reject autonomous and worker callers; cloning and source upload remain user-only", async () => {
  const { llm } = scriptedLLM([answer("No operation")]);
  await using fw = await mediaFarm(llm);
  await configure(fw);
  const tools = fw.tool;
  const here = fw.channel.defaultChannel();
  const caller = () => ({ agent: defaultOrchestrator, session: "", repo: "", here, picked: "", envelope: "", actor: orchestrator(false) });
  const available = tools.orchestrator(caller);
  for (const [name, input] of [
    ["media_dialogue_create", dialogue],
    ["media_voice_design_create", design],
  ] as const) {
    const tool = available.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Missing ${name}`);
    expect((await failure(tool.execute(input, { id: name }))).message).toBeTruthy();
  }
  expect(
    available.some((tool) => tool.name === "media_clone_create" || tool.name === "media_transcription_create" || tool.name === "media_audio_cleanup"),
  ).toBe(false);
  expect(tools.session(() => ({ ...caller(), session: "worker", actor: worker("worker") })).filter((tool) => tool.name.startsWith("media_"))).toEqual([]);
  const found = await fw.media.list();
  expect(found).toEqual([]);
});
