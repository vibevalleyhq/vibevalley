import { readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import type { VibeValleyApi } from "@vibevalley/protocol";

import { expect, test } from "./fixtures";

test.use({ farm: "flash" });

async function configure(api: VibeValleyApi) {
  const status = await api.provider.get();
  await api.provider.update({
    revision: status.revision,
    connections: [{ id: "flash", name: "Flash fixture", adapter: "moss", enabled: true, key: "test-speech-a" }],
    speech: { connection: "flash", model: "moss-tts-1.5-flash" },
    dictation: null,
    live: null,
    image: null,
    understanding: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
  });
}

async function prepare(page: Page, text: string) {
  await page.addInitScript(() => {
    window.flashContexts = [];
    window.flashBuffers = [];
    window.flashPeakBuffer = 0;
    const NativeAudioContext = window.AudioContext;
    window.AudioContext = class extends NativeAudioContext {
      constructor(options?: AudioContextOptions) {
        super(options);
        window.flashContexts.push(this);
      }
      override createBuffer(channels: number, frames: number, sampleRate: number) {
        window.flashBuffers.push({ sampleRate, channels, frames });
        return super.createBuffer(channels, frames, sampleRate);
      }
    };
  });
  await page.goto("/library?make=speech");
  await expect(page.getByTestId("speech-voice")).toBeEnabled();
  await page.getByTestId("speech-voice").click();
  await page.locator('[role="option"][data-key="voice-one"]').click();
  await page.getByTestId("speech-text").fill(text);
  await page.getByTestId("speech-execution").click();
  await page.locator('[role="option"][data-key="streaming"]').click();
  await expect(page.getByTestId("speech-format")).toBeDisabled();
  await page.evaluate(() => {
    new MutationObserver(() => {
      const seconds = Number(document.querySelector('[data-testid="flash-player"]')?.getAttribute("data-buffered") ?? 0);
      window.flashPeakBuffer = Math.max(window.flashPeakBuffer, seconds);
    }).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["data-buffered"] });
  });
}

test("Flash starts only on explicit consent, plays chunks before completion, saves WAV and closes its real audio context", async ({ page, api }) => {
  await configure(api);
  const submitted: string[] = [];
  const opened: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/media/speech/create")) submitted.push(request.postData() ?? "");
    if (/\/api\/v1\/media\/speech\/[^/]+\/stream$/u.test(request.url())) opened.push(request.url());
  });
  await prepare(page, "[speech:stream-success]");
  expect(await page.evaluate(() => window.flashContexts.length)).toBe(0);
  expect(submitted).toEqual([]);
  expect(opened).toEqual([]);
  await page.getByTestId("flash-start").click();
  await expect(page.getByTestId("flash-player")).toHaveAttribute("data-phase", "playing");
  await expect.poll(async () => Number(await page.getByTestId("flash-player").getAttribute("data-received"))).toBeGreaterThan(0);
  const id = await page.getByTestId("speech-request").getAttribute("data-id");
  if (!id) throw new Error("Missing immutable Flash request ID");
  const card = page.locator(`[data-testid="speech-job"][data-id="${id}"]`);
  await expect(card).not.toHaveAttribute("data-phase", "ready");
  await expect.poll(async () => Number(await page.getByTestId("flash-player").getAttribute("data-played"))).toBeGreaterThan(0);
  expect(Number(await page.getByTestId("flash-player").getAttribute("data-buffered"))).toBeLessThanOrEqual(5);
  await expect(page.getByTestId("flash-player")).toHaveAttribute("data-phase", "done", { timeout: 10_000 });
  const peak = await page.evaluate(() => window.flashPeakBuffer);
  expect(peak).toBeLessThanOrEqual(5);
  await expect(card).toHaveAttribute("data-phase", "ready");
  await expect(page.getByTestId("flash-start")).toBeDisabled();
  const job = await api.media.job.get({ id });
  if (job.kind !== "speech" || !job.metadata) throw new Error("Missing actual stream metadata");
  expect(job).toMatchObject({ format: "wav", contentType: "audio/wav", metadata: { source: "provider", bitDepth: 16 } });
  const buffers = await page.evaluate(() => window.flashBuffers);
  expect(buffers.length).toBeGreaterThan(1);
  expect(buffers.every((buffer) => buffer.sampleRate === job.metadata?.sampleRate && buffer.channels === job.metadata?.channels)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.flashContexts.map((context) => context.state))).toEqual(["closed"]);
  await expect(card.getByTestId("speech-metadata")).toHaveAttribute("data-source", "provider");
  await expect(card.getByTestId("speech-usage")).toBeVisible();
  const downloading = page.waitForEvent("download");
  await card.getByTestId("speech-save").click();
  const download = await downloading;
  const bytes = readFileSync((await download.path()) ?? "");
  expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
  expect(bytes.readUInt32LE(24)).toBe(job.metadata.sampleRate);
  expect(bytes.readUInt16LE(22)).toBe(job.metadata.channels);
  await page.reload();
  await expect(card).toHaveAttribute("data-phase", "ready");
  expect(submitted).toHaveLength(1);
  expect(opened).toHaveLength(1);
});

test("regression: truncated Flash audio remains partial, never reconnects and releases playback", async ({ page, api }) => {
  await configure(api);
  const streams: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/v1\/media\/speech\/[^/]+\/stream$/u.test(request.url())) streams.push(request.url());
  });
  await prepare(page, "[speech:stream-truncated]");
  await page.getByTestId("flash-start").click();
  await expect(page.getByTestId("flash-player")).toHaveAttribute("data-phase", "failed");
  await expect(page.getByTestId("flash-player")).toHaveAttribute("data-partial", "true");
  await expect(page.getByTestId("flash-error")).toBeVisible();
  await expect(page.getByTestId("flash-start")).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.flashContexts.map((context) => context.state))).toEqual(["closed"]);
  const id = await page.getByTestId("speech-request").getAttribute("data-id");
  if (!id) throw new Error("Missing failed Flash ID");
  const card = page.locator(`[data-testid="speech-job"][data-id="${id}"]`);
  await expect(card).toHaveAttribute("data-phase", "unknown");
  await expect(card.getByTestId("speech-problem")).toBeVisible();
  await page.reload();
  await expect(card).toHaveAttribute("data-phase", "unknown");
  expect(streams).toHaveLength(1);
});

for (const action of ["stop", "leave", "device"] as const) {
  test(`Flash ${action} aborts the stream, cancels its original task and closes playback resources`, async ({ page, api }) => {
    await configure(api);
    await prepare(page, "[speech:stream-hold]");
    await page.getByTestId("flash-start").click();
    await expect(page.getByTestId("flash-player")).toHaveAttribute("data-phase", "playing");
    const id = await page.getByTestId("speech-request").getAttribute("data-id");
    if (!id) throw new Error("Missing active Flash ID");
    switch (action) {
      case "stop":
        await page.getByTestId("flash-stop").click();
        break;
      case "leave":
        await page.getByTestId("library-make-form").locator('[data-key="image"]').click();
        break;
      case "device":
        await page.evaluate(() => navigator.mediaDevices.dispatchEvent(new Event("devicechange")));
        break;
    }
    await expect.poll(() => page.evaluate(() => window.flashContexts.map((context) => context.state))).toEqual(["closed"]);
    await expect.poll(async () => (await api.media.job.get({ id })).phase).toBe("canceled");
    if (action !== "leave") {
      await expect(page.getByTestId("flash-player")).toHaveAttribute("data-phase", "stopped");
      await expect(page.getByTestId("flash-start")).toBeDisabled();
    }
  });
}
