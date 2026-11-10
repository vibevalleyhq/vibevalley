import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { mediaInputContentPath, type VibeValleyApi } from "@vibevalley/protocol";

import { expect, settled, test } from "./fixtures";

test.use({ farm: "speech" });

async function bindSpeech(api: VibeValleyApi, model = "moss-tts-1.5-flash", connection = "speech-a") {
  const current = await api.provider.get();
  return api.provider.update({
    revision: current.revision,
    connections: [
      { id: "speech-a", name: "Speech account A", adapter: "moss", enabled: true, key: "test-speech-a" },
      { id: "speech-b", name: "Speech account B", adapter: "moss", enabled: true, key: "test-speech-b" },
    ],
    dictation: null,
    live: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
    image: null,
    understanding: null,
    speech: { connection, model },
  });
}

async function chooseVoice(page: Page, id: string) {
  await expect(page.getByTestId("speech-voice")).toBeEnabled();
  await page.getByTestId("speech-voice").click();
  await page.locator(`[role="option"][data-key="${id}"]`).click();
}

for (const scenario of [
  { model: "moss-tts-1.5-flash", format: "wav", theme: "light", connection: "speech-a" },
  { model: "moss-tts-1.0-pro", format: "mp3", theme: "dark", connection: "speech-b" },
] as const) {
  test(`${scenario.model} generates playable ${scenario.format}, saves and publishes once in ${scenario.theme}`, async ({ page, api }) => {
    const status = await bindSpeech(api, scenario.model, scenario.connection);
    const channel = await api.channel.create({ name: `speech-${scenario.format}` });
    await page.addInitScript((theme) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme })), scenario.theme);
    await page.goto("/settings/providers");
    await page.getByTestId("provider-speech-open").click();
    await expect(page.getByTestId("library-make-form").locator('[data-key="speech"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("speech-connection")).toHaveAttribute("data-model", scenario.model);
    await expect(page.getByTestId("speech-connection")).toHaveAttribute("data-revision", String(status.revision));
    const next = page.waitForResponse((response) => response.url().endsWith("/api/v1/provider/voice/list") && response.status() === 200);
    await expect(page.getByTestId("speech-voices-next")).toBeEnabled();
    await page.getByTestId("speech-voices-next").click();
    const listed = await next;
    expect(listed.request().postDataJSON()).toMatchObject({ connection: scenario.connection, revision: status.revision, limit: 20, after: expect.any(String) });
    await chooseVoice(page, "voice-two");
    await page.getByTestId("speech-format").click();
    await page.locator(`[role="option"][data-key="${scenario.format}"]`).click();
    await page.getByTestId("speech-text").fill(`[speech:success] A quiet farm in ${scenario.format}`);
    const generated = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/speech/create") && response.status() === 200);
    await page.getByTestId("speech-generate").click();
    await generated;
    const id = await page.getByTestId("speech-request").getAttribute("data-id");
    if (!id) throw new Error("Missing speech request ID");
    const card = page.locator(`[data-testid="speech-job"][data-id="${id}"]`);
    await expect(card).toHaveAttribute("data-phase", "ready");
    const audio = card.getByTestId("speech-audio");
    await expect(audio).toBeVisible();
    await expect
      .poll(() => audio.evaluate((element: HTMLAudioElement) => Number.isFinite(element.duration) && element.duration > 0 && element.readyState >= 2))
      .toBe(true);
    expect(await audio.evaluate((element: HTMLAudioElement) => ({ paused: element.paused, autoplay: element.autoplay, time: element.currentTime }))).toEqual({
      paused: true,
      autoplay: false,
      time: 0,
    });
    await audio.evaluate((element: HTMLAudioElement) => element.play());
    await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
    await audio.evaluate((element: HTMLAudioElement) => element.pause());
    const ready = await api.media.job.get({ id });
    if (ready.kind !== "speech") throw new Error("Expected speech task");
    expect(ready).toMatchObject({
      kind: "speech",
      source: { kind: "user" },
      model: scenario.model,
      connection: scenario.connection,
      revision: status.revision,
      voice: "voice-two",
      format: scenario.format,
    });
    const downloaded = page.waitForEvent("download");
    await card.getByTestId("speech-save").click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${scenario.format}$`, "u"));
    const file = await download.path();
    const bytes = readFileSync(file ?? "");
    expect(bytes.byteLength).toBeGreaterThan(44);
    if (scenario.format === "wav") {
      expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString()).toBe("WAVE");
    } else {
      expect(bytes.subarray(0, 3).toString() === "ID3" || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0)).toBe(true);
    }
    await card.getByTestId("speech-channel").click();
    await page.locator(`[role="option"][data-key="${channel}"]`).click();
    await card.getByTestId("speech-publish").click();
    await expect(card.getByTestId("speech-publish")).toHaveAttribute("data-published", "true");
    await page.reload();
    await expect(card).toHaveAttribute("data-phase", "ready");
    await card.getByTestId("speech-channel").click();
    await page.locator(`[role="option"][data-key="${channel}"]`).click();
    await card.getByTestId("speech-publish").click();
    await expect(card.getByTestId("speech-publish")).toHaveAttribute("data-published", "true");
    const messages = await api.channel.message.list({ id: channel });
    expect(messages.filter((message) => message.attachments?.some((attachment) => attachment.id === ready.attachment?.id))).toHaveLength(1);
    const screens = join(import.meta.dirname, "../.screens");
    mkdirSync(screens, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator("html")).toHaveAttribute("data-theme", scenario.theme);
      await expect(page.locator("#opening")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await card.scrollIntoViewIfNeeded();
      await settled(page);
      await page.screenshot({ path: join(screens, `speech-ready-${scenario.theme}-${width}.png`), fullPage: true });
    }
    const player = await audio.evaluateHandle((element: HTMLAudioElement) => element);
    await audio.evaluate((element: HTMLAudioElement) => element.play());
    await page.getByTestId("library-make-form").locator('[data-key="image"]').click();
    await expect(page.getByTestId("speech-audio")).toHaveCount(0);
    expect(await player.evaluate((element) => ({ paused: element.paused, source: element.getAttribute("src") }))).toEqual({ paused: true, source: null });
    await player.dispose();
  });
}

test("regression: large speech survives reload until the user explicitly releases it", async ({ page, api }) => {
  await bindSpeech(api);
  const publications: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/channel/message/send")) publications.push(request.postData() ?? "");
  });
  await page.goto("/library?make=speech");
  await chooseVoice(page, "voice-one");
  await page.getByTestId("speech-text").fill("[speech:large]");
  await page.getByTestId("speech-generate").click();
  const id = await page.getByTestId("speech-request").getAttribute("data-id");
  if (!id) throw new Error("Missing large speech request ID");
  const card = page.locator(`[data-testid="speech-job"][data-id="${id}"]`);
  await expect(card).toHaveAttribute("data-phase", "ready");
  const job = await api.media.job.get({ id });
  if (job.kind !== "speech" || !job.resultInput || !job.metadata) throw new Error("Missing large speech result");
  expect(job.attachment).toBeUndefined();
  expect(job.resultInput.size).toBeGreaterThan(25 * 1024 * 1024);
  expect(job.resultInput.size).toBeLessThanOrEqual(512_000_000);
  expect(job).toMatchObject({ format: "wav", contentType: "audio/wav", metadata: { source: "file" } });
  await expect(card.getByTestId("speech-format-result")).toHaveAttribute("data-format", "wav");
  const path = mediaInputContentPath(job.resultInput.id);
  await expect(card.getByTestId("speech-save")).toHaveAttribute("href", path);
  await expect(card.getByTestId("speech-channel")).toHaveCount(0);
  await expect(card.getByTestId("speech-publish")).toHaveCount(0);
  await page.reload();
  await expect(card).toHaveAttribute("data-phase", "ready");
  expect(await api.media.job.get({ id })).toMatchObject({ resultInput: job.resultInput, metadata: job.metadata });
  await expect(card.getByTestId("speech-publish")).toHaveCount(0);
  await expect(card.getByTestId("speech-metadata")).toHaveAttribute("data-source", "file");
  const audio = card.getByTestId("speech-audio");
  await expect(audio).toHaveAttribute("src", path);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState >= 2 && element.duration > 0)).toBe(true);
  await audio.evaluate((element: HTMLAudioElement) => element.play());
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
  await audio.evaluate((element: HTMLAudioElement) => element.pause());
  const downloading = page.waitForEvent("download");
  await card.getByTestId("speech-save").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.wav$/u);
  const bytes = readFileSync((await download.path()) ?? "");
  expect(bytes.byteLength).toBe(job.resultInput.size);
  expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(bytes.subarray(8, 12).toString()).toBe("WAVE");
  expect(bytes.readUInt32LE(24)).toBe(job.metadata.sampleRate);
  expect(bytes.readUInt16LE(22)).toBe(job.metadata.channels);
  expect(bytes.readUInt16LE(34)).toBe(job.metadata.bitDepth);
  expect(publications).toEqual([]);
  await card.getByTestId("media-preview-release").click();
  await expect(card.getByTestId("media-release-preview")).toBeVisible();
  expect(await api.media.input.get({ id: job.resultInput.id })).toMatchObject({ canDelete: false });
  await card.getByTestId("media-release").click();
  await card.getByTestId("media-release-sure").click();
  await expect(card.getByTestId("speech-audio")).toHaveCount(0);
  await expect(card.getByTestId("speech-save")).toHaveCount(0);
  await page.reload();
  expect(await api.media.job.get({ id })).toMatchObject({ phase: "ready", resultInput: null, canRelease: false });
  await expect(api.media.input.get({ id: job.resultInput.id })).rejects.toBeDefined();
});

test("regression: a lost speech response preserves the immutable request across provider changes until an explicit new request", async ({ page, api }) => {
  const initial = await bindSpeech(api);
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/media/speech/create")) bodies.push(request.postData() ?? "");
  });
  await page.goto("/library?make=speech");
  await chooseVoice(page, "voice-one");
  await page.getByTestId("speech-text").fill("[speech:success] Retain the original request");
  await page.route(
    "**/api/v1/media/speech/create",
    async (route) => {
      await route.fetch();
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page.getByTestId("speech-generate").click();
  await expect(page.getByTestId("speech-error")).toBeVisible();
  await expect(page.getByTestId("speech-text")).toBeDisabled();
  const id = await page.getByTestId("speech-request").getAttribute("data-id");
  const changed = await bindSpeech(api, "moss-tts-1.0-pro", "speech-b");
  await page.getByTestId("speech-refresh").click();
  await expect(page.getByTestId("speech-connection")).toHaveAttribute("data-revision", String(changed.revision));
  await expect(page.getByTestId("speech-request")).toHaveAttribute("data-revision", String(initial.revision));
  const repeated = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/speech/create") && response.status() === 200);
  await page.getByTestId("speech-generate").click();
  await repeated;
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect((await api.media.job.list()).filter((job) => job.id === id)).toHaveLength(1);
  await page.getByTestId("speech-new").click();
  await page.getByTestId("speech-new-sure").click();
  await expect(page.getByTestId("speech-text")).toBeEnabled();
  await expect(page.getByTestId("speech-request")).toHaveCount(0);
  await expect(page.getByTestId("speech-generate")).toBeDisabled();
  await chooseVoice(page, "voice-one");
  await page.getByTestId("speech-text").fill("[speech:success] A new account request");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/speech/create") && response.status() === 200);
  await page.getByTestId("speech-generate").click();
  await created;
  await expect(page.getByTestId("speech-request")).not.toHaveAttribute("data-id", id ?? "");
  await expect(page.getByTestId("speech-request")).toHaveAttribute("data-connection", "speech-b");
});

test("speech download retry, unknown result and cancellation retain server job state without another generation", async ({ page, api }) => {
  const configuration = await bindSpeech(api);
  const request = { connection: "speech-a", revision: configuration.revision, voice: "voice-one", format: "wav" } as const;
  const retry = await api.media.speech.create({ ...request, id: "speech-retry-download", text: "[speech:download-failure]" });
  const unknown = await api.media.speech.create({ ...request, id: "speech-unknown-result", text: "[speech:unknown]" });
  const cancel = await api.media.speech.create({ ...request, id: "speech-cancel-wait", text: "[speech:hold]" });
  const generated: string[] = [];
  page.on("request", (sent) => {
    if (sent.url().endsWith("/api/v1/media/speech/create")) generated.push(sent.postData() ?? "");
  });
  await page.goto("/library?make=speech");
  const retryCard = page.locator(`[data-testid="speech-job"][data-id="${retry.id}"]`);
  const unknownCard = page.locator(`[data-testid="speech-job"][data-id="${unknown.id}"]`);
  const cancelCard = page.locator(`[data-testid="speech-job"][data-id="${cancel.id}"]`);
  await expect(retryCard).toHaveAttribute("data-phase", "download_failed");
  await expect(unknownCard).toHaveAttribute("data-phase", "unknown");
  await expect(unknownCard.getByTestId("speech-retry-download")).toHaveCount(0);
  await expect(cancelCard).toHaveAttribute("data-phase", "generating");
  await cancelCard.getByTestId("speech-cancel").click();
  await cancelCard.getByTestId("speech-cancel-sure").click();
  await expect(cancelCard).toHaveAttribute("data-phase", "canceled");
  await retryCard.getByTestId("speech-retry-download").click();
  await expect(retryCard).toHaveAttribute("data-phase", "ready");
  await expect
    .poll(() => retryCard.getByTestId("speech-audio").evaluate((element: HTMLAudioElement) => Number.isFinite(element.duration) && element.duration > 0))
    .toBe(true);
  await page.reload();
  await expect(retryCard).toHaveAttribute("data-phase", "ready");
  await expect(unknownCard).toHaveAttribute("data-phase", "unknown");
  await expect(cancelCard).toHaveAttribute("data-phase", "canceled");
  expect(generated).toEqual([]);
});
