import { readFileSync } from "node:fs";

import type { Page } from "@playwright/test";

import { attachmentPath, type VibeValleyApi } from "@vibevalley/protocol";

import { expect, test } from "./fixtures";

test.use({ farm: "media" });

async function bindImage(api: VibeValleyApi) {
  const current = await api.provider.get();
  await api.provider.update({
    revision: current.revision,
    connections: [{ id: "image", name: "Image test account", adapter: "moss", enabled: true, key: "test-image-key" }],
    dictation: null,
    live: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
    image: { connection: "image", model: "moss-image-sft-1.0" },
    understanding: null,
    speech: null,
  });
}

async function generate(page: Page, api: VibeValleyApi) {
  const before = new Set((await api.media.job.list()).map((job) => job.id));
  const sent = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/image/create") && response.status() === 200);
  await page.getByTestId("media-generate").click();
  await sent;
  const created = (await api.media.job.list()).filter((job) => !before.has(job.id));
  expect(created).toHaveLength(1);
  const job = created[0];
  if (job === undefined) throw new Error("The submitted task is missing");
  return job;
}

const imageRequest = { prompt: "A quiet farm", format: "text", width: 256, height: 256, enhance: false, watermark: true } as const;

test("regression: submission retries preserve the request ID and editing requires an explicit new request", async ({ page, api }) => {
  const bodies: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/v1/media/image/create")) bodies.push(request.postData() ?? "");
  });
  await page.goto("/library?make=image");
  await expect(page.getByTestId("image-panel")).toBeVisible();
  await page.getByTestId("media-prompt").fill("A quiet farm");
  const refused = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/image/create") && response.status() === 409);
  await page.getByTestId("media-generate").click();
  await refused;
  await expect(page.getByTestId("media-error")).toBeVisible();
  await expect(page.getByTestId("media-prompt")).toBeDisabled();
  const again = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/image/create") && response.status() === 409);
  await page.getByTestId("media-generate").click();
  await again;
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(await api.media.job.list()).toEqual([]);
  await page.getByTestId("media-new").click();
  await page.getByTestId("media-new-sure").click();
  await expect(page.getByTestId("media-prompt")).toBeEnabled();
});

test("regression: an image is generated, saved, published once and referenced by an artifact through the real server", async ({ page, api }) => {
  await bindImage(api);
  const channel = await api.channel.create({ name: "generated-images" });
  await page.goto("/library?make=image");
  await page.getByTestId("media-prompt").fill("[media:success] A quiet farm");
  await page.getByTestId("media-width").fill("256");
  await page.getByTestId("media-height").fill("256");
  const job = await generate(page, api);
  const card = page.locator(`[data-testid="media-job"][data-id="${job.id}"]`);
  await expect(card).toHaveAttribute("data-phase", "ready");
  await expect(card.getByTestId("media-image")).toBeVisible();
  await expect.poll(() => card.getByTestId("media-image").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256);
  const ready = await api.media.job.get({ id: job.id });
  if (ready.kind !== "image") throw new Error("Expected image task");
  expect(ready.source).toEqual({ kind: "user" });
  expect(ready.usage).toEqual({ images: 1, width: 256, height: 256 });
  await expect(card.getByTestId("media-usage")).not.toBeEmpty();
  const downloaded = page.waitForEvent("download");
  await card.getByTestId("media-save").click();
  const file = await (await downloaded).path();
  expect(
    readFileSync(file ?? "")
      .subarray(0, 8)
      .toString("hex"),
  ).toBe("89504e470d0a1a0a");
  await card.getByTestId("media-channel").click();
  await page.locator(`[role="option"][data-key="${channel}"]`).click();
  const published = page.waitForResponse((response) => response.url().endsWith("/api/v1/channel/message/send"));
  await card.getByTestId("media-publish").click();
  const receipt = await published;
  expect(receipt.status(), await receipt.text()).toBe(204);
  await expect(card.getByTestId("media-publish")).toHaveAttribute("data-published", "true");
  await page.reload();
  await expect(card).toHaveAttribute("data-phase", "ready");
  await card.getByTestId("media-channel").click();
  await page.locator(`[role="option"][data-key="${channel}"]`).click();
  await card.getByTestId("media-publish").click();
  await expect(card.getByTestId("media-publish")).toHaveAttribute("data-published", "true");
  const messages = await api.channel.message.list({ id: channel });
  expect(messages.filter((message) => message.attachments?.some((attachment) => attachment.id === ready.attachment?.id))).toHaveLength(1);
  const content = `![Generated image](${attachmentPath(ready.attachment?.id ?? "")})`;
  const artifact = await api.artifact.create({ title: "Generated image reference", kind: "markdown", content });
  expect((await api.artifact.content.get({ id: artifact.id })).content).toContain(attachmentPath(ready.attachment?.id ?? ""));
});

test("layout input generates through the same task and attachment pipeline", async ({ page, api }) => {
  await bindImage(api);
  await page.goto("/library?make=image");
  await page.getByTestId("media-format").click();
  await page.locator('[role="option"][data-key="layout"]').click();
  await page.getByTestId("media-prompt").fill(
    JSON.stringify({
      summary: { caption: "A quiet farm" },
      items: [{ label: "barn", caption: "A red barn", bbox: [-80, -80, 80, 80] }],
      bbox_format: "yxyx",
      bbox_coord_space: "abs_centralized",
    }),
  );
  await page.getByTestId("media-width").fill("256");
  await page.getByTestId("media-height").fill("256");
  const job = await generate(page, api);
  const card = page.locator(`[data-testid="media-job"][data-id="${job.id}"]`);
  await expect(card).toHaveAttribute("data-phase", "ready");
  await expect.poll(() => card.getByTestId("media-image").evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(256);
});

test("download retry, unknown outcomes and cancellation use the task state without generating again", async ({ page, api }) => {
  await bindImage(api);
  const retry = await api.media.image.create({ ...imageRequest, id: "retry-download", prompt: "[media:download-failure]" });
  const unknown = await api.media.image.create({ ...imageRequest, id: "unknown-result", prompt: "[media:unknown]" });
  const cancel = await api.media.image.create({ ...imageRequest, id: "cancel-wait", prompt: "[media:hold]" });
  await page.goto("/library?make=image");
  const retryCard = page.locator(`[data-testid="media-job"][data-id="${retry.id}"]`);
  await expect(retryCard).toHaveAttribute("data-phase", "download_failed");
  const unknownCard = page.locator(`[data-testid="media-job"][data-id="${unknown.id}"]`);
  await expect(unknownCard).toHaveAttribute("data-phase", "unknown");
  await expect(unknownCard.getByTestId("media-retry-download")).toHaveCount(0);
  const cancelCard = page.locator(`[data-testid="media-job"][data-id="${cancel.id}"]`);
  await expect(cancelCard).toHaveAttribute("data-phase", "generating");
  await cancelCard.getByTestId("media-cancel").click();
  await cancelCard.getByTestId("media-cancel-sure").click();
  await expect(cancelCard).toHaveAttribute("data-phase", "canceled");
  await retryCard.getByTestId("media-retry-download").click();
  await expect(retryCard).toHaveAttribute("data-phase", "ready");
  expect(await api.media.job.get({ id: retry.id })).toMatchObject({ kind: "image", usage: { images: 1, width: 256, height: 256 } });
});

test("invalid image dimensions are rejected before an external request and leave no task", async ({ page, api }) => {
  await bindImage(api);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/library?make=image");
  await page.getByTestId("media-prompt").fill("Invalid size, no generation");
  await page.getByTestId("media-width").fill("257");
  await page.getByTestId("media-generate").click();
  await expect(page.getByTestId("media-error")).toBeVisible();
  expect((await api.media.job.list()).some((job) => job.prompt === "Invalid size, no generation")).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});
