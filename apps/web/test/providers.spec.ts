import { expect, test } from "./fixtures";

test.use({ farm: "providers" });

test("regression: the settings navigation leaves the provider form usable at 390px", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // The MOSS accounts are on the accounts page.
  await page.goto("/settings/accounts");
  await expect(page.getByTestId("provider-form")).toBeVisible();
  const navigation = await page.getByTestId("settings-nav").boundingBox();
  expect(navigation?.height).toBeLessThanOrEqual(224);
  await page.getByTestId("provider-add").click();
  const input = page.getByTestId("provider-name");
  await input.fill("mobile draft");
  await expect(input).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("regression: unbound provider choices keep a visible placeholder", async ({ page }) => {
  await page.goto("/settings/providers");
  for (const use of ["dictation", "live", "image", "understanding", "speech", "speakers", "voiceDesign", "transcription", "vision"]) {
    const choice = page.getByTestId(`provider-${use}`);
    await expect(choice).toHaveAttribute("data-value", "");
    await expect(choice.locator("span").first()).not.toBeEmpty();
  }
  await page.getByTestId("provider-image").click();
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("Escape");
});

test("MOSS connections bind uses, mask credentials, reject stale saves and require unbinding before clearing", async ({ page, api }) => {
  // The accounts are made on the accounts page, the uses bound on the uses page: each form saves the whole settings.
  const form = page.getByTestId("provider-form");
  const save = form.getByTestId("save");
  const connection = page.getByTestId("provider-connection");
  await page.goto("/settings/accounts");
  await expect(form).toHaveAttribute("data-revision", "0");
  await page.getByTestId("provider-add").click();
  await connection.getByTestId("provider-name").fill("MOSS test account");
  await connection.getByTestId("secret").fill("test-provider-key-1234");
  await save.click();
  await expect(form).toHaveAttribute("data-revision", "1");
  await expect(connection.getByTestId("secret")).toHaveValue("");
  await expect(connection.getByTestId("key-mark")).toHaveAttribute("data-hint", /1234/u);
  const saved = await api.provider.get();
  const id = saved.connections[0]?.id;
  expect(id).toBeTruthy();
  expect(JSON.stringify(saved)).not.toContain("test-provider-key");
  await page.goto("/settings/providers");
  await expect(form).toHaveAttribute("data-revision", "1");
  await page.getByTestId("provider-dictation").click();
  await page.locator(`[role="option"][data-key="${id}"]`).click();
  await page.getByTestId("provider-dictation-model").click();
  await page.locator('[role="option"][data-key="moss-transcribe-diarize-pro"]').click();
  await page.getByTestId("provider-live").click();
  await page.locator(`[role="option"][data-key="${id}"]`).click();
  await page.getByTestId("provider-image").click();
  await page.locator(`[role="option"][data-key="${id}"]`).click();
  await page.getByTestId("provider-image-model").click();
  await page.locator('[role="option"][data-key="moss-image-sft-1.0-2026-10-09"]').click();
  await page.getByTestId("provider-understanding").click();
  await page.locator(`[role="option"][data-key="${id}"]`).click();
  await page.getByTestId("provider-understanding-model").click();
  await page.locator('[role="option"][data-key="moss-vl-1.0-2026-07-08"]').click();
  await page.getByTestId("provider-speech").click();
  await page.locator(`[role="option"][data-key="${id}"]`).click();
  await page.getByTestId("provider-speech-model").click();
  await expect(page.getByRole("option")).toHaveCount(4);
  await page.locator('[role="option"][data-key="moss-tts-1.0-pro-2026-02-07"]').click();
  const audioAndRealtime = [
    ["live", "moss-live-1.0-2026-11-02"],
    ["speakers", "moss-ttsd-1.0-2026-03-20"],
    ["voiceDesign", "moss-voice-generator-1.0-2026-07-22"],
    ["transcription", "moss-transcribe-diarize-pro-2026-07-03"],
    ["vision", "moss-vl-realtime-1.0-2026-09-09"],
  ] as const;
  for (const [use, model] of audioAndRealtime) {
    if (use !== "live") {
      await page.getByTestId(`provider-${use}`).click();
      await page.locator(`[role="option"][data-key="${id}"]`).click();
    }
    await page.getByTestId(`provider-${use}-model`).click();
    await page.locator(`[role="option"][data-key="${model}"]`).click();
  }
  await save.click();
  await expect(form).toHaveAttribute("data-revision", "2");
  expect((await api.provider.get()).dictation).toEqual({ connection: id, model: "moss-transcribe-diarize-pro" });
  expect((await api.provider.get()).image).toEqual({ connection: id, model: "moss-image-sft-1.0-2026-10-09" });
  expect((await api.provider.get()).understanding).toEqual({ connection: id, model: "moss-vl-1.0-2026-07-08" });
  expect((await api.provider.get()).speech).toEqual({ connection: id, model: "moss-tts-1.0-pro-2026-02-07" });
  expect(await api.setting.get()).toMatchObject({ readiness: { live: { ready: true }, dictation: { ready: true } } });
  await page.reload();
  await expect(page.getByTestId("provider-dictation-model")).toHaveAttribute("data-value", "moss-transcribe-diarize-pro");
  await expect(page.getByTestId("provider-image-model")).toHaveAttribute("data-value", "moss-image-sft-1.0-2026-10-09");
  await expect(page.getByTestId("provider-understanding-model")).toHaveAttribute("data-value", "moss-vl-1.0-2026-07-08");
  await expect(page.getByTestId("provider-speech-model")).toHaveAttribute("data-value", "moss-tts-1.0-pro-2026-02-07");
  const restored = await api.provider.get();
  for (const [use, model] of audioAndRealtime) {
    expect(restored[use]).toEqual({ connection: id, model });
    await expect(page.getByTestId(`provider-${use}-model`)).toHaveAttribute("data-value", model);
  }
  await page.goto("/settings/accounts");
  await connection.getByTestId("provider-name").fill("unsaved edit");
  const current = await api.provider.get();
  await api.provider.update({ ...current, connections: current.connections.map(({ key: _key, ...item }) => ({ ...item, name: "other window" })) });
  await save.click();
  await expect(page.getByTestId("provider-error")).toBeVisible();
  expect((await api.provider.get()).connections[0]?.name).toBe("other window");
  await expect(connection.getByTestId("provider-name")).toHaveValue("unsaved edit");
  await page.getByTestId("provider-reload").click();
  await page.getByTestId("provider-reload-sure").click();
  await expect(form).toHaveAttribute("data-revision", "3");
  await expect(connection.getByTestId("provider-name")).toHaveValue("other window");

  await connection.getByTestId("provider-key").locator('button:not([data-testid="reveal"])').click();
  await save.click();
  await expect(page.getByTestId("provider-error")).toBeVisible();
  expect((await api.provider.get()).connections[0]?.key.source).toBe("settings");
  // Bound uses keep the key: unbinding every use on the uses page lets the account go.
  await page.goto("/settings/providers");
  for (const use of ["dictation", "live", "image", "understanding", "speech", "speakers", "voiceDesign", "transcription", "vision"]) {
    await page.getByTestId(`provider-${use}`).click();
    await page.locator('[role="option"][data-key=""]').click();
  }
  await save.click();
  await expect(form).toHaveAttribute("data-revision", "4");
  expect(await api.setting.get()).toMatchObject({ readiness: { live: { ready: false, missing: "binding" }, dictation: { ready: false, missing: "binding" } } });
  await page.goto("/settings/accounts");
  await connection.getByTestId("provider-models").click();
  await expect(page.getByTestId("provider-error")).toBeVisible();
  await page.getByTestId("provider-delete").click();
  await page.getByTestId("provider-delete-sure").click();
  await save.click();
  await expect(form).toHaveAttribute("data-revision", "5");
  expect((await api.provider.get()).connections).toEqual([]);
});
