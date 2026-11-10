import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { mediaInputContentPath, type VibeValleyApi } from "@vibevalley/protocol";

import { expect, settled, test } from "./fixtures";

test.use({ farm: "audio" });

async function bindAudio(
  api: VibeValleyApi,
  connection = "audio-a",
  transcriptionFailure = false,
  streaming?: "success" | "truncated" | "hold",
  model = "moss-transcribe-diarize-pro",
) {
  const current = await api.provider.get();
  return api.provider.update({
    revision: current.revision,
    connections: [
      { id: "audio-a", name: "Audio account A", adapter: "moss", enabled: true, key: streaming ? `test-audio-stream-${streaming}` : "test-audio-a" },
      { id: "audio-b", name: "Audio account B", adapter: "moss", enabled: true, key: transcriptionFailure ? "test-audio-failure" : "test-audio-b" },
    ],
    dictation: null,
    live: null,
    image: null,
    understanding: null,
    speech: null,
    vision: null,
    speakers: { connection, model: "moss-ttsd-1.0" },
    voiceDesign: { connection, model: "moss-voice-generator-1.0" },
    transcription: { connection, model },
  });
}

function audioFile(name = "audio-success.wav") {
  const sampleRate = 16000;
  const samples = sampleRate * 4;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) buffer.writeInt16LE(Math.round(Math.sin((index * Math.PI * 440) / sampleRate) * 4000), 44 + index * 2);
  return { name, mimeType: "audio/wav", buffer };
}

async function choose(page: Page, select: Locator, id: string) {
  await expect(select).toBeEnabled();
  await select.click();
  await page.locator(`[role="option"][data-key="${id}"]`).click();
}

async function submittedJob(page: Page) {
  const id = await page.getByTestId("audio-request").getAttribute("data-id");
  if (!id) throw new Error("Missing audio request ID");
  return { id, card: page.locator(`[data-testid="audio-job"][data-id="${id}"]`) };
}

for (const mode of ["success", "truncated", "hold"] as const) {
  test(`streamed transcription exposes persisted partial text and segments before ${mode}`, async ({ page, api }) => {
    await bindAudio(api, "audio-a", false, mode);
    await page.goto("/library?make=audio");
    await page.getByTestId("audio-mode-transcription").click();
    await choose(page, page.getByTestId("audio-execution"), "streaming");
    await page.getByTestId("audio-file").setInputFiles(audioFile());
    await expect(page.getByTestId("audio-submit")).toBeDisabled();
    await page.getByTestId("audio-consent").click();
    await page.getByTestId("audio-submit").click();
    const { id, card } = await submittedJob(page);
    await expect(card.getByTestId("audio-transcript")).toHaveText(/\S/u);
    await expect(card.getByTestId("audio-timeline").locator("li")).not.toHaveCount(0);
    await expect(card).toHaveAttribute("data-phase", "generating");
    await expect(card.getByTestId("audio-partial")).toBeVisible();
    await expect(card.getByTestId("audio-input-player")).toBeVisible();
    const partial = await card.getByTestId("audio-transcript").innerText();
    expect(await api.media.job.get({ id })).toMatchObject({
      request: { streaming: true },
      result: { kind: "transcription", text: expect.stringContaining(partial) },
    });
    if (mode === "hold") {
      await page.reload();
      await expect(card.getByTestId("audio-transcript")).toHaveText(partial);
      await expect(card).toHaveAttribute("data-phase", "generating");
      await card.getByTestId("audio-cancel").click();
      await card.getByTestId("audio-cancel-sure").click();
      await expect(card).toHaveAttribute("data-phase", "canceled");
    } else {
      await expect(card).toHaveAttribute("data-phase", mode === "success" ? "ready" : "unknown");
    }
    if (mode === "success") {
      await expect(card.getByTestId("audio-partial")).toHaveCount(0);
    } else {
      await expect(card.getByTestId("audio-partial")).toBeVisible();
      await expect(card.getByTestId("audio-transcript")).toContainText(partial);
      await card.getByTestId("audio-save-transcript").click();
      await expect(card.getByTestId("audio-artifact")).toBeVisible();
      const href = await card.getByTestId("audio-artifact").getAttribute("href");
      const artifact = (await api.artifact.list({})).find((item) => href === `/artifacts/${item.id}`);
      if (!artifact) throw new Error("Missing partial transcript artifact");
      expect((await api.artifact.content.get({ id: artifact.id })).content).toContain(partial);
      await expect(card.getByTestId("audio-download-transcript")).toHaveAttribute("download", `${id}-partial.txt`);
      await page.reload();
      await expect(card.getByTestId("audio-transcript")).toContainText(partial);
      await expect(card.getByTestId("audio-partial")).toBeVisible();
    }
  });
}

test("ordinary transcription stays asynchronous and cannot enable streaming", async ({ page, api }) => {
  await bindAudio(api, "audio-a", false, undefined, "moss-transcribe-1.0");
  await page.goto("/library?make=audio");
  await page.getByTestId("audio-mode-transcription").click();
  await expect(page.getByTestId("audio-execution")).toBeDisabled();
  await expect(page.getByTestId("audio-diarize")).toBeDisabled();
  await page.getByTestId("audio-file").setInputFiles(audioFile());
  await page.getByTestId("audio-consent").click();
  await page.getByTestId("audio-submit").click();
  const { id, card } = await submittedJob(page);
  await expect(card).toHaveAttribute("data-phase", "ready");
  const job = await api.media.job.get({ id });
  if (job.kind !== "transcription") throw new Error("Expected transcription");
  expect(job.request.streaming).toBeUndefined();
  expect(job.request.diarize).toBeUndefined();
});

for (const theme of ["light", "dark"] as const) {
  test(`structured speakers produce playable saved audio in ${theme}`, async ({ page, api }) => {
    const configuration = await bindAudio(api);
    await page.addInitScript((value) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: value })), theme);
    await page.goto("/library?make=audio");
    await page.getByTestId("audio-speaker-name").fill("host");
    await choose(page, page.getByTestId("audio-speaker-voice"), "voice-one");
    await page.getByTestId("audio-turn-text").fill("[audio:success] Hello from the host.");
    await page.getByTestId("audio-add-speaker").click();
    const guest = page.getByTestId("audio-speaker").nth(1);
    await guest.getByTestId("audio-speaker-name").fill("host");
    await guest.getByTestId("audio-speaker-voice-next").click();
    await choose(page, guest.getByTestId("audio-speaker-voice"), "voice-two");
    await expect(page.getByTestId("audio-submit")).toBeDisabled();
    await guest.getByTestId("audio-speaker-name").fill("guest");
    await page.getByTestId("audio-add-turn").click();
    const turn = page.getByTestId("audio-turn").nth(1);
    await turn.getByTestId("audio-turn-speaker").click();
    await page.getByRole("option").nth(1).click();
    await turn.getByTestId("audio-turn-text").fill("Hello from the guest.");
    const created = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/dialogue/create") && response.status() === 200);
    await page.getByTestId("audio-submit").click();
    await created;
    const { id, card } = await submittedJob(page);
    await expect(card).toHaveAttribute("data-phase", "ready");
    const job = await api.media.job.get({ id });
    if (job.kind !== "speakers") throw new Error("Expected speaker synthesis");
    expect(job.request).toMatchObject({
      connection: "audio-a",
      revision: configuration.revision,
      speakers: [
        { id: "host", voice: "voice-one" },
        { id: "guest", voice: "voice-two" },
      ],
      segments: [
        { speaker: "host", text: "[audio:success] Hello from the host." },
        { speaker: "guest", text: "Hello from the guest." },
      ],
    });
    const player = card.getByTestId("audio-result-player");
    await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.duration > 0 && element.readyState >= 2)).toBe(true);
    await player.evaluate((element: HTMLAudioElement) => element.play());
    await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
    await player.evaluate((element: HTMLAudioElement) => element.pause());
    const downloading = page.waitForEvent("download");
    await card.getByTestId("audio-download").click();
    const download = await downloading;
    const path = await download.path();
    expect(
      readFileSync(path ?? "")
        .subarray(0, 4)
        .toString(),
    ).toBe("RIFF");
    const screens = join(import.meta.dirname, "../.screens");
    mkdirSync(screens, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("#opening")).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await card.scrollIntoViewIfNeeded();
      await settled(page);
      await page.screenshot({ path: join(screens, `audio-speakers-${theme}-${width}.png`), fullPage: true });
    }
    await test.step("audit: audio studio", async () => {
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
    });
    const handle = await player.evaluateHandle((element: HTMLAudioElement) => element);
    await player.evaluate((element: HTMLAudioElement) => element.play());
    await page.getByTestId("library-make-form").locator('[data-key="image"]').click();
    expect(await handle.evaluate((element) => ({ paused: element.paused, src: element.getAttribute("src") }))).toEqual({ paused: true, src: null });
    await handle.dispose();
  });
}

test("regression: large speaker audio survives reload until the user explicitly releases it", async ({ page, api }) => {
  await bindAudio(api);
  const publications: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/channel/message/send")) publications.push(request.postData() ?? "");
  });
  await page.goto("/library?make=audio");
  await page.getByTestId("audio-speaker-name").fill("host");
  await choose(page, page.getByTestId("audio-speaker-voice"), "voice-one");
  await choose(page, page.getByTestId("audio-format"), "mp3");
  await page.getByTestId("audio-turn-text").fill("[audio:large]");
  await page.getByTestId("audio-submit").click();
  const { id, card } = await submittedJob(page);
  await expect(card).toHaveAttribute("data-phase", "ready");
  const job = await api.media.job.get({ id });
  if (job.kind !== "speakers" || !job.resultInput || !job.metadata) throw new Error("Missing large speaker result");
  expect(job.attachment).toBeUndefined();
  expect(job.resultInput.size).toBeGreaterThan(25 * 1024 * 1024);
  expect(job.resultInput.size).toBeLessThanOrEqual(512_000_000);
  expect(job).toMatchObject({ format: "wav", contentType: "audio/wav", metadata: { source: "file" } });
  const path = mediaInputContentPath(job.resultInput.id);
  await expect(card.getByTestId("audio-download")).toHaveAttribute("href", path);
  await page.reload();
  await expect(card).toHaveAttribute("data-phase", "ready");
  expect(await api.media.job.get({ id })).toMatchObject({ resultInput: job.resultInput, metadata: job.metadata });
  await expect(card.getByTestId("audio-metadata")).toHaveAttribute("data-source", "file");
  await expect(card.getByTestId("audio-format-result")).toHaveAttribute("data-format", "wav");
  const player = card.getByTestId("audio-result-player");
  await expect(player).toHaveAttribute("src", path);
  await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.readyState >= 2 && element.duration > 0)).toBe(true);
  await player.evaluate((element: HTMLAudioElement) => element.play());
  await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0);
  await player.evaluate((element: HTMLAudioElement) => element.pause());
  const downloading = page.waitForEvent("download");
  await card.getByTestId("audio-download").click();
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
  await expect(card.getByTestId("audio-result-player")).toHaveCount(0);
  await expect(card.getByTestId("audio-download")).toHaveCount(0);
  await page.reload();
  expect(await api.media.job.get({ id })).toMatchObject({ phase: "ready", resultInput: null, canRelease: false });
  await expect(api.media.input.get({ id: job.resultInput.id })).rejects.toBeDefined();
  expect(await api.media.dialogue.create(job.request)).toMatchObject({ id, phase: "ready", resultInput: null });
});

async function captureAudio(page: Page, card: Locator, scenario: string, theme: "light" | "dark") {
  const screens = join(import.meta.dirname, "../.screens");
  mkdirSync(screens, { recursive: true });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.locator("#opening")).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await card.scrollIntoViewIfNeeded();
    await settled(page);
    await page.screenshot({ path: join(screens, `audio-${scenario}-${theme}-${width}.png`), fullPage: true });
  }
}

for (const theme of ["light", "dark"] as const)
  test(`design preview creates no reusable voice until explicit save, which remains idempotent after reload in ${theme}`, async ({ page, api }) => {
    await bindAudio(api);
    await page.addInitScript((value) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: value })), theme);
    const before = new Set((await api.media.job.list()).map((job) => job.id));
    await page.goto("/library?make=audio");
    await page.getByTestId("audio-mode-voiceDesign").click();
    await page.getByTestId("audio-instructions").fill("[audio:success] A warm calm narrator.");
    await page.getByTestId("audio-preview-text").fill("[audio:success] This is a voice preview.");
    await page.getByTestId("audio-submit").click();
    const { card } = await submittedJob(page);
    await expect(card).toHaveAttribute("data-phase", "ready");
    expect((await api.media.job.list()).filter((job) => !before.has(job.id) && job.kind === "clone")).toHaveLength(0);
    await expect(card.getByTestId("audio-result-player")).toBeVisible();
    await card.getByTestId("audio-save-name").fill("Reusable narrator");
    await card.getByTestId("audio-save-voice").click();
    await expect(card.getByTestId("audio-save-voice")).toHaveAttribute("data-request", /.+/u);
    const savedId = await card.getByTestId("audio-save-voice").getAttribute("data-request");
    const saved = page.locator(`[data-testid="audio-job"][data-id="${savedId}"]`);
    await expect(saved).toHaveAttribute("data-phase", "ready");
    await expect(saved.getByTestId("audio-saved-voice")).toHaveAttribute("data-voice", /.+/u);
    await captureAudio(page, card, "design", theme);
    await captureAudio(page, saved, "saved-voice", theme);
    await page.reload();
    await expect(card.getByTestId("audio-save-name")).toBeDisabled();
    const checked = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/clone/create") && response.status() === 200);
    await card.getByTestId("audio-save-voice").click();
    await checked;
    expect((await api.media.job.list()).filter((job) => job.id === savedId)).toHaveLength(1);
  });

for (const theme of ["light", "dark"] as const)
  test(`regression: cloning requires file and account revision consent and lists only the selected account in ${theme}`, async ({ page, api }) => {
    await bindAudio(api);
    await page.addInitScript((value) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: value })), theme);
    await page.goto("/library?make=audio");
    await page.getByTestId("audio-mode-clone").click();
    await choose(page, page.getByTestId("audio-account"), "audio-a");
    await page.getByTestId("audio-file").setInputFiles(audioFile());
    await expect(page.getByTestId("audio-submit")).toBeDisabled();
    await page.getByTestId("audio-consent").click();
    await choose(page, page.getByTestId("audio-account"), "audio-b");
    await expect(page.getByTestId("audio-consent")).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("audio-submit")).toBeDisabled();
    await page.getByTestId("audio-consent").click();
    await page.getByTestId("audio-file").setInputFiles(audioFile());
    await expect(page.getByTestId("audio-consent")).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("audio-consent").click();
    const configuration = await bindAudio(api, "audio-b");
    await page.getByTestId("audio-refresh").click();
    await expect(page.getByTestId("audio-consent")).toHaveAttribute("aria-checked", "false");
    await page.getByTestId("audio-consent").click();
    await page.getByTestId("audio-voice-name").fill("Consented sample");
    await page.getByTestId("audio-submit").click();
    const { id, card } = await submittedJob(page);
    await expect(card).toHaveAttribute("data-phase", "ready");
    const job = await api.media.job.get({ id });
    expect(job).toMatchObject({ kind: "clone", connection: "audio-b", revision: configuration.revision, request: { consent: true, name: "Consented sample" } });
    const listed = page.waitForResponse((response) => response.url().endsWith("/api/v1/provider/voice/list") && response.status() === 200);
    await page.getByTestId("audio-account-voice-first").click();
    expect((await listed).request().postDataJSON()).toMatchObject({ connection: "audio-b", revision: configuration.revision });
    await page.getByTestId("audio-account-voice-search").fill("voice-one");
    await choose(page, page.getByTestId("audio-account-voice"), "voice-one");
    await captureAudio(page, card, "clone", theme);
  });

for (const theme of ["light", "dark"] as const)
  test(`long transcription keeps timestamps, seeks local input and saves results without resubmitting on reload in ${theme}`, async ({ page, api }) => {
    await bindAudio(api);
    await page.addInitScript((value) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: value })), theme);
    await page.goto("/library?make=audio");
    await page.getByTestId("audio-mode-transcription").click();
    await page.getByTestId("audio-file").setInputFiles(audioFile());
    await expect(page.getByTestId("audio-submit")).toBeDisabled();
    await page.getByTestId("audio-consent").click();
    await page.getByTestId("audio-submit").click();
    const { id, card } = await submittedJob(page);
    await expect(card).toHaveAttribute("data-phase", "ready");
    const job = await api.media.job.get({ id });
    if (job.kind !== "transcription" || job.result?.kind !== "transcription" || !job.input) throw new Error("Expected persisted transcription");
    const result = job.result;
    expect(result.segments.length).toBeGreaterThan(1);
    await expect(card.getByTestId("audio-transcript")).toHaveText(result.text);
    const player = card.getByTestId("audio-input-player");
    await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.readyState >= 2)).toBe(true);
    const segment = result.segments.find((item) => item.start > 0 && item.start < 4);
    if (!segment) throw new Error("Fixture must include a nonzero timestamp within the four-second local file");
    await card.locator(`[data-testid="audio-seek"][data-start="${segment.start}"]`).first().click();
    await expect.poll(() => player.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeCloseTo(segment.start, 2);
    const downloading = page.waitForEvent("download");
    await card.getByTestId("audio-download-transcript").click();
    const path = await (await downloading).path();
    const downloaded = readFileSync(path ?? "", "utf8");
    expect(downloaded).toContain(result.text);
    expect(downloaded).toContain(segment.speaker);
    await card.getByTestId("audio-save-transcript").click();
    const link = card.getByTestId("audio-artifact");
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    const artifact = (await api.artifact.list({})).find((item) => href === `/artifacts/${item.id}`);
    if (!artifact) throw new Error("Missing saved transcript artifact");
    const view = await page.context().newPage();
    try {
      await view.goto(`/artifacts/${artifact.id}`);
      await expect(view.getByTestId("artifact-blocks")).toContainText(result.text);
      await expect(view.getByTestId("artifact-blocks")).toContainText(segment.speaker);
    } finally {
      await view.close();
    }
    await captureAudio(page, card, "transcription", theme);
    const submitted: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/v1/media/transcription/create")) submitted.push(request.postData() ?? "");
    });
    await page.reload();
    await expect(card).toHaveAttribute("data-phase", "ready");
    await expect.poll(() => card.getByTestId("audio-input-player").evaluate((element: HTMLAudioElement) => element.readyState >= 2)).toBe(true);
    expect(submitted).toEqual([]);
  });

test("regression: lost submission preserves the original account and ID; unknown and failed results expose no regenerate shortcut", async ({ page, api }) => {
  const configuration = await bindAudio(api);
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/media/voiceDesign/create")) bodies.push(request.postData() ?? "");
  });
  await page.goto("/library?make=audio");
  await page.getByTestId("audio-mode-voiceDesign").click();
  await page.getByTestId("audio-instructions").fill("A calm narrator");
  await page.getByTestId("audio-preview-text").fill("[audio:unknown]");
  await page.route(
    "**/api/v1/media/voiceDesign/create",
    async (route) => {
      await route.fetch();
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page.getByTestId("audio-submit").click();
  await expect(page.getByTestId("audio-error").first()).toBeVisible();
  const { id, card } = await submittedJob(page);
  await expect(card).toHaveAttribute("data-phase", "unknown");
  await bindAudio(api, "audio-b");
  await page.getByTestId("audio-refresh").click();
  await expect(page.getByTestId("audio-request")).toHaveAttribute("data-revision", String(configuration.revision));
  await expect(page.getByTestId("audio-preview-text")).toBeDisabled();
  const checked = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/voiceDesign/create") && response.status() === 200);
  await page.getByTestId("audio-submit").click();
  await checked;
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect((await api.media.job.list()).filter((job) => job.id === id)).toHaveLength(1);
  await expect(card.getByTestId("audio-retry-download")).toHaveCount(0);
  await expect(card.getByTestId("audio-save-voice")).toHaveCount(0);
  await bindAudio(api, "audio-b", true);
  await page.getByTestId("audio-refresh").click();
  await page.getByTestId("audio-mode-transcription").click();
  await page.getByTestId("audio-file").setInputFiles(audioFile("audio-failure.wav"));
  await page.getByTestId("audio-consent").click();
  await page.getByTestId("audio-submit").click();
  const failed = await submittedJob(page);
  await expect(failed.card).toHaveAttribute("data-phase", "failed");
  await expect(failed.card.getByTestId("audio-transcript")).toHaveCount(0);
  await expect(failed.card.getByTestId("audio-problem")).toBeVisible();
});
