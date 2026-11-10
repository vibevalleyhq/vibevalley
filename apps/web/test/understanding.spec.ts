import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test } from "./fixtures";
import { bindUnderstanding, localUnderstandingInput, understandingFile } from "./understanding-fixture";

test.use({ farm: "understanding" });

for (const kind of ["image", "video"] as const) {
  test(`${kind} uploads with explicit consent, produces saved text and survives refresh without resubmission`, async ({ page, api }) => {
    await bindUnderstanding(api);
    const before = new Set((await api.media.job.list()).map((job) => job.id));
    await page.goto("/media");
    await page.getByTestId("media-mode-understanding").click();
    await page.getByTestId("understanding-files").setInputFiles(understandingFile(kind).path);
    await page.getByTestId("understanding-prompt").fill(`Describe the synthetic ${kind}.`);
    await expect(page.getByTestId("understanding-submit")).toBeDisabled();
    await page.getByTestId("understanding-consent").click();
    const submitted = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/understanding/create") && response.status() === 200);
    await page.getByTestId("understanding-submit").click();
    await submitted;
    const created = (await api.media.job.list()).filter((job) => !before.has(job.id));
    expect(created).toHaveLength(1);
    const job = created[0];
    if (job?.kind !== "understanding") throw new Error("Expected understanding task");
    const card = page.locator(`[data-testid="understanding-job"][data-id="${job.id}"]`);
    await expect(card).toHaveAttribute("data-phase", "ready");
    await expect(card).toHaveAttribute("data-cleanup", "done");
    const ready = await api.media.job.get({ id: job.id });
    if (ready.kind !== "understanding" || ready.result === null) throw new Error("Expected persisted text");
    expect(ready.inputs[0]?.hash).toBe(
      createHash("sha256")
        .update(readFileSync(understandingFile(kind).path))
        .digest("hex"),
    );
    expect(ready.inputs[0]?.kind).toBe(kind);
    expect(ready.result.usage).toEqual({ inputTokens: 30, outputTokens: 8, totalTokens: 38 });
    await expect(card.getByTestId("understanding-result")).toHaveText(ready.result.text);
    await card.getByTestId("understanding-save").click();
    const saved = card.getByTestId("understanding-saved");
    await expect(saved).toBeVisible();
    const href = await saved.getAttribute("href");
    const artifacts = await api.artifact.list({});
    const artifact = artifacts.find((item) => href === `/artifacts/${item.id}`);
    if (!artifact) throw new Error("Expected saved document");
    expect((await api.artifact.content.get({ id: artifact.id })).content).toContain(ready.result.text);
    const retry = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/understanding/create") && response.status() === 200);
    await page.getByTestId("understanding-submit").click();
    await retry;
    expect((await api.media.job.list()).filter((item) => !before.has(item.id))).toHaveLength(1);
    await page.reload();
    await page.getByTestId("media-mode-understanding").click();
    await expect(card.getByTestId("understanding-result")).toHaveText(ready.result.text);
  });
}

test("regression: stale upload approval is refused before an understanding task is created", async ({ page, api }) => {
  const initial = await bindUnderstanding(api);
  const before = (await api.media.job.list()).map((job) => job.id);
  await page.goto("/media");
  await page.getByTestId("media-mode-understanding").click();
  await page.getByTestId("understanding-files").setInputFiles(understandingFile("image").path);
  await page.getByTestId("understanding-prompt").fill("Describe the synthetic image.");
  await page.getByTestId("understanding-consent").click();
  await api.provider.update({
    revision: initial.revision,
    connections: [{ id: "understanding", name: "Changed account", adapter: "moss", enabled: true, key: "changed-test-key" }],
    dictation: null,
    live: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    vision: null,
    image: null,
    understanding: initial.understanding,
    speech: null,
  });
  const refused = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/understanding/create") && response.status() === 409);
  await page.getByTestId("understanding-submit").click();
  await refused;
  await expect(page.getByTestId("understanding-error")).toBeVisible();
  expect((await api.media.job.list()).map((job) => job.id)).toEqual(before);
});

test("truncated text is retained and cleanup retry does not repeat inference", async ({ page, api }) => {
  const status = await bindUnderstanding(api);
  const input = await localUnderstandingInput(api, "image");
  const job = await api.media.understanding.create({
    id: crypto.randomUUID(),
    prompt: "[understanding:incomplete] [understanding:cleanup-failure] Explain this image.",
    inputs: [input.id],
    connection: "understanding",
    revision: status.revision,
    allowUpload: true,
    maxOutputTokens: 8,
  });
  await page.goto("/media");
  await page.getByTestId("media-mode-understanding").click();
  const card = page.locator(`[data-testid="understanding-job"][data-id="${job.id}"]`);
  await expect(card).toHaveAttribute("data-phase", "incomplete");
  await expect(card).toHaveAttribute("data-cleanup", "blocked");
  await expect(card.getByTestId("understanding-truncated")).toBeVisible();
  const before = await api.media.job.get({ id: job.id });
  await card.getByTestId("understanding-cleanup").click();
  await card.getByTestId("understanding-cleanup-sure").click();
  await expect(card).toHaveAttribute("data-cleanup", "done");
  const after = await api.media.job.get({ id: job.id });
  if (before.kind !== "understanding" || after.kind !== "understanding") throw new Error("Expected understanding task");
  expect(after.result).toEqual(before.result);
  expect(after.result?.incompleteReason).toBe("max_output_tokens");
});

test("unknown and canceled understanding retain honest states and explicit cleanup", async ({ page, api }) => {
  const status = await bindUnderstanding(api);
  const input = await localUnderstandingInput(api, "image");
  const request = {
    prompt: "[understanding:unknown]",
    inputs: [input.id],
    connection: "understanding",
    revision: status.revision,
    allowUpload: true,
    maxOutputTokens: 64,
  } as const;
  const unknown = await api.media.understanding.create({ ...request, inputs: [...request.inputs], id: crypto.randomUUID() });
  const canceled = await api.media.understanding.create({ ...request, inputs: [...request.inputs], id: crypto.randomUUID(), prompt: "[understanding:hold]" });
  await page.goto("/media");
  await page.getByTestId("media-mode-understanding").click();
  const unknownCard = page.locator(`[data-testid="understanding-job"][data-id="${unknown.id}"]`);
  const canceledCard = page.locator(`[data-testid="understanding-job"][data-id="${canceled.id}"]`);
  await expect(unknownCard).toHaveAttribute("data-phase", "unknown");
  await expect(canceledCard).toHaveAttribute("data-phase", "generating");
  await canceledCard.getByTestId("understanding-cancel").click();
  await canceledCard.getByTestId("understanding-cancel-sure").click();
  await expect(canceledCard).toHaveAttribute("data-phase", "canceled");
  await expect(canceledCard.getByTestId("understanding-result")).toHaveCount(0);
  await expect(unknownCard.getByTestId("understanding-result")).toHaveCount(0);
  await api.media.understanding.cleanup({ id: unknown.id });
  await api.media.understanding.cleanup({ id: canceled.id });
  await expect(unknownCard).toHaveAttribute("data-cleanup", "done");
  await expect(canceledCard).toHaveAttribute("data-cleanup", "done");
});

test("user can authorize immutable input for a channel and revoke it before any vendor upload", async ({ page, api }) => {
  await bindUnderstanding(api);
  const channel = await api.channel.create({ name: "understanding-approval" });
  await page.goto("/media");
  await page.getByTestId("media-mode-understanding").click();
  await page.getByTestId("understanding-files").setInputFiles(understandingFile("video").path);
  await page.getByTestId("understanding-prompt").fill("Explain this synthetic video after my approval.");
  await page.getByTestId("understanding-channel").click();
  await page.locator(`[role="option"][data-key="${channel}"]`).click();
  await page.getByTestId("understanding-consent").click();
  const approved = page.waitForResponse((response) => response.url().endsWith("/api/v1/media/understanding/authorize") && response.status() === 200);
  await page.getByTestId("understanding-submit").click();
  const response = await approved;
  const job = await response.json();
  const card = page.locator(`[data-testid="understanding-job"][data-id="${job.id}"]`);
  await expect(card).toHaveAttribute("data-phase", "authorized");
  await expect(card.getByTestId("understanding-delegate")).toBeEnabled();
  await expect(card.getByTestId("understanding-result")).toHaveCount(0);
  const granted = await api.media.job.get({ id: job.id });
  if (granted.kind !== "understanding") throw new Error("Expected understanding task");
  expect(granted.authorization?.channel).toBe(channel);
  expect(granted.inputs[0]?.kind).toBe("video");
  await page.reload();
  await page.getByTestId("media-mode-understanding").click();
  await expect(card).toHaveAttribute("data-phase", "authorized");
  await card.getByTestId("understanding-cancel").click();
  await card.getByTestId("understanding-cancel-sure").click();
  await expect(card).toHaveAttribute("data-phase", "canceled");
  await expect(card.getByTestId("understanding-delegate")).toHaveCount(0);
  const input = granted.inputs[0];
  if (!input) throw new Error("Expected authorized input");
  expect((await api.media.input.get({ id: input.id })).canDelete).toBe(true);
});
