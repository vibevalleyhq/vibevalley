// The media library on the fixture (fixtures/library.ts): the tiles and the
// rail, one file's inspector, and the generation panels in their dialog
// (image, speech, audio) and the understanding one, with fakeHost playing
// the Rust side.
import "../polyfill";
import { expect, open, test } from "nsh/test";

import { boundProvider } from "../fixtures/library";
import { responses, state } from "../fixtures/workbench";
import { fakeHost } from "./fakeHost";

async function start(route: string) {
  const fake = fakeHost({ state, responses: { ...responses, "provider.get": boundProvider } }, { route });
  const app = await open("./main.tsx", { width: 1400, height: 900, colorScheme: "light", platform: "macos", host: fake.options });
  for (let i = 0; i < 4; i++) await fake.pump(app);
  return { app, fake };
}

const payloadOf = (fake: { calls: { op: string; payload: unknown }[] }, op: string) => fake.calls.find((c) => c.op === op)?.payload as Record<string, unknown>;

test("the library: every kept file as a tile, the job still generating, one file's inspector", async () => {
  const { app, fake } = await start("/library");
  expect(app.count("id:library-page")).toBe(1);
  expect(app.count("id:library-rail")).toBe(1);
  expect(app.count("id:library-item")).toBe(3);
  expect(app.count("id:library-making")).toBe(1);
  await app.press("id:library-item >> nth=1");
  await fake.pump(app);
  expect(app.count("id:library-inspector")).toBe(1);
  expect(app.count("id:library-inspector-name")).toBe(1);
  await app.type("id:library-search", "海报");
  await app.waitUntil(() => fake.calls.some((c) => c.op === "library.item.list" && (c.payload as { text?: string }).text === "海报"));
});

test("making an image: the form sends the prompt with its advanced options; the jobs say who asked and what was counted", async () => {
  const { app, fake } = await start("/library?make=image");
  expect(app.count("id:image-panel")).toBe(1);
  expect(app.count("id:media-job")).toBe(2);
  expect(app.count("id:media-source")).toBe(2);
  expect(app.count("id:media-cancel")).toBe(1);
  expect(app.enabled("id:media-generate")).toBe(false);
  await app.type("id:media-prompt", "一块麦田");
  await app.press("id:media-advanced");
  await app.type("id:media-seed", "7x");
  await app.press("id:media-generate");
  await fake.pump(app);
  const sent = payloadOf(fake, "media.image.create");
  expect(sent.prompt).toBe("一块麦田");
  expect(sent.seed).toBe(7);
  expect(app.count("id:media-new")).toBe(1);
});

test("speech: a voice of the account, the text, the request kept for a retry; a finished job plays through the host", async () => {
  const { app, fake } = await start("/library?make=speech");
  expect(app.count("id:speech-panel")).toBe(1);
  expect(app.count("id:speech-connection")).toBe(1);
  expect(payloadOf(fake, "provider.voice.list").connection).toBe("moss-main");
  expect(app.count("id:speech-job")).toBe(1);
  expect(app.count("id:speech-metadata")).toBe(1);
  await app.press("选择账号音色");
  await app.press("暖声 · voice-warm");
  await app.type("id:speech-text", "收工了");
  await app.press("id:speech-generate");
  await fake.pump(app);
  const sent = payloadOf(fake, "media.speech.create");
  expect(sent.voice).toBe("voice-warm");
  expect(sent.text).toBe("收工了");
  expect(sent.streaming).toBe(false);
  expect(app.count("id:speech-request")).toBe(1);
  await app.press("id:speech-play");
  await fake.pump(app);
  expect(fake.calls.map((c) => c.op)).toContain("host.playAudio");
});

test("flash live playback is offered and says it cannot play here", async () => {
  const { app } = await start("/library?make=speech");
  await app.press("等待生成结果");
  await app.press("Flash 实时播放");
  expect(app.count("id:speech-flash-unsupported")).toBe(1);
  expect(app.enabled("id:speech-generate")).toBe(false);
});

test("audio: the four forms, a dialogue's failed download retried, a transcript with its timeline", async () => {
  const { app, fake } = await start("/library?make=audio");
  expect(app.count("id:audio-panel")).toBe(1);
  expect(app.count("id:audio-speaker")).toBe(1);
  expect(app.count("id:audio-job")).toBe(2);
  expect(app.count("id:audio-transcript")).toBe(1);
  expect(app.count("id:audio-timeline")).toBe(1);
  await app.press("id:audio-retry-download");
  await fake.pump(app);
  expect(payloadOf(fake, "media.job.download")).toEqual({ id: "job-dialogue" });
  await app.press("id:audio-add-speaker");
  expect(app.count("id:audio-speaker")).toBe(2);
  await app.press("id:audio-mode-voiceDesign");
  expect(app.count("id:audio-instructions")).toBe(1);
  await app.press("id:audio-mode-clone");
  expect(app.count("id:audio-account")).toBe(1);
  expect(app.enabled("id:audio-consent")).toBe(false);
  await app.press("id:audio-mode-transcription");
  expect(app.count("id:audio-binding")).toBe(1);
  expect(app.enabled("id:audio-submit")).toBe(false);
});

test("transcription: the picked recording is kept as an attachment, taken as the input, and sent once consent is given", async () => {
  const { app, fake } = await start("/library?make=audio");
  app.onPick(() => [{ name: "standup.m4a", type: "audio/mp4", data: new Uint8Array([1, 2, 3]) }]);
  await app.press("id:audio-mode-transcription");
  await app.press("id:audio-file");
  expect(app.count("id:audio-file-name")).toBe(1);
  await app.press("id:audio-consent");
  await app.press("id:audio-submit");
  for (let i = 0; i < 4; i++) await fake.pump(app);
  expect(payloadOf(fake, "attachment.create").name).toBe("standup.m4a");
  expect(payloadOf(fake, "media.input.adopt")).toEqual({ attachment: "a9" });
  const sent = payloadOf(fake, "media.transcription.create");
  expect(sent.input).toBe("in-poster");
  expect(sent.allowUpload).toBe(true);
  expect(sent.diarize).toBe(true);
  expect(app.count("id:audio-request")).toBe(1);
});

test("understanding a kept picture: consent first, then its bytes taken as the input and the request sent", async () => {
  const { app, fake } = await start("/library?understand=lib-poster");
  expect(app.count("id:understanding-panel")).toBe(1);
  expect(app.count("id:understanding-file")).toBe(1);
  expect(app.count("id:understanding-job")).toBe(1);
  expect(app.count("id:understanding-result")).toBe(1);
  await app.type("id:understanding-prompt", "画的是什么");
  expect(app.enabled("id:understanding-submit")).toBe(false);
  await app.press("id:understanding-consent");
  await app.press("id:understanding-submit");
  for (let i = 0; i < 3; i++) await fake.pump(app);
  expect(payloadOf(fake, "media.input.adopt")).toEqual({ attachment: "lib-poster" });
  const sent = payloadOf(fake, "media.understanding.create");
  expect(sent.prompt).toBe("画的是什么");
  expect(sent.inputs).toEqual(["in-poster"]);
  expect(sent.allowUpload).toBe(true);
});
