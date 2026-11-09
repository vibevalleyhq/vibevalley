import { mkdirSync } from "node:fs";
import { join } from "node:path";

import AxeBuilder from "@axe-core/playwright";

import { expect, settled, test } from "./fixtures";
import { bindUnderstanding, localUnderstandingInput } from "./understanding-fixture";

test.use({ farm: "a11y" });

const sections = ["general", "appearance", "models", "providers", "about", "memory", "skills", "call", "moss", "dictation", "github", "chat", "devices"];

for (const theme of ["light", "dark"] as const)
  test(`no workbench page has an accessibility violation in the ${theme} theme`, async ({ page, api }) => {
    await page.addInitScript((t) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: t })), theme);
    const issue = await api.issue.create({ title: "an issue to look at" });
    const agent = (await api.agent.list()).find((a) => a.role === "worker")!;
    const paths = [
      "/chat",
      "/issues",
      `/issues/${issue.id}`,
      "/artifacts",
      "/media",
      "/agents",
      `/agents/${agent.id}`,
      "/agents/templates",
      "/orchestrator",
      "/runtimes",
      "/repos",
      "/catalog",
      ...sections.map((s) => `/settings/${s}`),
    ];
    const found: string[] = [];
    for (const path of paths)
      await test.step(`audit: ${path}`, async () => {
        await page.goto(path);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.getByTestId("link")).toHaveAttribute("data-state", "open");
        // The opening bar is gone once the page is up. measured before that, its fading words read as low contrast.
        await expect(page.locator("#opening")).toHaveCount(0, { timeout: 15_000 });
        // Measured once things have moved in (a dialog fading in reads as low contrast); a pulse that never ends is not waited for.
        await page.evaluate(() =>
          Promise.all(
            document
              .getAnimations()
              .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity))
              .map((a) => a.finished.catch(() => undefined)),
          ),
        );
        const { violations } = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
        for (const v of violations)
          found.push(`${path} ${v.id}: ${v.nodes.map((n) => `${n.target.join(" ")} ${n.any.map((c) => c.message).join(" ")}`).join(", ")}`);
      });
    expect(found).toEqual([]);
  });

for (const theme of ["light", "dark"] as const)
  test(`image generation form is accessible in ${theme} at desktop and mobile widths`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: value })), theme);
    await page.goto("/media");
    await expect(page.getByTestId("media-page")).toBeVisible();
    await expect(page.locator("#opening")).toHaveCount(0);
    await page.locator("summary").click();
    const screenshots = join(import.meta.dirname, "../.screens");
    mkdirSync(screenshots, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await settled(page);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await page.screenshot({ path: join(screenshots, `media-${theme}-${width}.png`), fullPage: true });
    }
  });

for (const theme of ["light", "dark"] as const)
  test(`image task results are accessible in ${theme} at desktop and mobile widths`, async ({ page, api }) => {
    const current = await api.provider.get();
    await api.provider.update({
      revision: current.revision,
      connections: [{ id: "media-audit", name: "Image audit", adapter: "moss", enabled: true, key: "test-only-key" }],
      dictation: null,
      live: null,
      image: { connection: "media-audit", model: "moss-image-sft-1.0" },
      understanding: null,
      speech: null,
      speakers: null,
      voiceDesign: null,
      transcription: null,
      vision: null,
    });
    const input = { format: "text", width: 256, height: 256, enhance: false, watermark: true } as const;
    const ready = await api.media.image.create({ ...input, id: `audit-ready-${theme}`, prompt: "A generated image fixture" });
    await api.media.image.create({ ...input, id: `audit-failed-${theme}`, prompt: "[media:download-failure]" });
    await api.media.image.create({ ...input, id: `audit-unknown-${theme}`, prompt: "[media:unknown]" });
    await api.media.image.create({ ...input, id: `audit-canceled-${theme}`, prompt: "[media:hold]" });
    await expect.poll(async () => (await api.media.job.get({ id: `audit-canceled-${theme}` })).phase).toBe("generating");
    await api.media.job.cancel({ id: `audit-canceled-${theme}` });
    await page.addInitScript((value) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: value })), theme);
    await page.goto("/media");
    await expect(page.locator("#opening")).toHaveCount(0);
    const card = page.locator(`[data-testid="media-job"][data-id="${ready.id}"]`);
    await expect(card).toHaveAttribute("data-phase", "ready");
    const screenshots = join(import.meta.dirname, "../.screens");
    mkdirSync(screenshots, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await card.scrollIntoViewIfNeeded();
      await settled(page);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      for (const state of ["ready", "failed", "unknown", "canceled"]) {
        await page.locator(`[data-testid="media-job"][data-id="audit-${state}-${theme}"]`).evaluate((element) => element.scrollIntoView({ block: "center" }));
        await settled(page);
        await page.screenshot({ path: join(screenshots, `media-${state}-${theme}-${width}.png`), fullPage: true });
      }
    }
  });

for (const theme of ["light", "dark"] as const)
  test(`configured capability bindings are accessible in ${theme} at desktop and mobile widths`, async ({ page, api }) => {
    const current = await api.provider.get();
    await api.provider.update({
      revision: current.revision,
      connections: [{ id: "image-audit", name: "MOSS image account", adapter: "moss", enabled: true, key: "test-audit-key-1234" }],
      dictation: null,
      live: { connection: "image-audit", model: "moss-live-1.0" },
      image: { connection: "image-audit", model: "moss-image-sft-1.0-2026-10-09" },
      understanding: { connection: "image-audit", model: "moss-vl-1.0-2026-07-08" },
      speech: { connection: "image-audit", model: "moss-tts-1.0-pro-2026-02-07" },
      speakers: { connection: "image-audit", model: "moss-ttsd-1.0" },
      voiceDesign: { connection: "image-audit", model: "moss-voice-generator-1.0" },
      transcription: { connection: "image-audit", model: "moss-transcribe-diarize-pro" },
      vision: { connection: "image-audit", model: "moss-vl-realtime-1.0" },
    });
    await page.addInitScript((value) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: value })), theme);
    await page.goto("/settings/providers");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(page.getByTestId("provider-image-model")).toHaveAttribute("data-value", "moss-image-sft-1.0-2026-10-09");
    await expect(page.locator("#opening")).toHaveCount(0);
    const screenshots = join(import.meta.dirname, "../.screens");
    mkdirSync(screenshots, { recursive: true });
    for (const width of [1280, 390]) {
      await test.step(`audit: configured image binding at ${width}px`, async () => {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
        await page.getByTestId("provider-image-notice").evaluate((element) => element.scrollIntoView({ block: "center" }));
        await expect(page.getByTestId("provider-image-notice")).toBeInViewport();
        await settled(page);
        expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.screenshot({ path: join(screenshots, `provider-image-${theme}-${width}.png`), fullPage: true });
        await page.getByTestId("provider-image-model").click();
        await expect(page.getByRole("option")).toHaveCount(4);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.keyboard.press("Escape");
        await page.getByTestId("provider-understanding-model").evaluate((element) => element.scrollIntoView({ block: "center" }));
        await expect(page.getByTestId("provider-understanding-model")).toHaveAttribute("data-value", "moss-vl-1.0-2026-07-08");
        await settled(page);
        await page.screenshot({ path: join(screenshots, `provider-understanding-${theme}-${width}.png`), fullPage: true });
        await page.getByTestId("provider-understanding-model").click();
        await expect(page.getByRole("option")).toHaveCount(2);
        await page.keyboard.press("Escape");
        await page.getByTestId("provider-speech-notice").evaluate((element) => element.scrollIntoView({ block: "center" }));
        await expect(page.getByTestId("provider-speech-notice")).toBeInViewport();
        await expect(page.getByTestId("provider-speech-model")).toHaveAttribute("data-value", "moss-tts-1.0-pro-2026-02-07");
        await settled(page);
        await page.screenshot({ path: join(screenshots, `provider-speech-${theme}-${width}.png`), fullPage: true });
        await page.getByTestId("provider-speech-model").click();
        await expect(page.getByRole("option")).toHaveCount(4);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
        await page.keyboard.press("Escape");
      });
    }
  });

for (const theme of ["light", "dark"] as const)
  test(`understanding results are accessible in ${theme} at desktop and mobile widths`, async ({ page, api }) => {
    const status = await bindUnderstanding(api);
    const input = await localUnderstandingInput(api, "image");
    const request = { inputs: [input.id], connection: "understanding", revision: status.revision, allowUpload: true, maxOutputTokens: 64 } as const;
    for (const [phase, marker] of [
      ["ready", "success"],
      ["incomplete", "incomplete"],
      ["unknown", "unknown"],
      ["canceled", "hold"],
    ]) {
      const id = `understanding-audit-${theme}-${phase}`;
      await api.media.understanding.create({ ...request, inputs: [...request.inputs], id, prompt: `[understanding:${marker}] Explain the synthetic image.` });
      if (phase === "canceled") {
        await expect.poll(async () => (await api.media.job.get({ id })).phase).toBe("generating");
        await api.media.job.cancel({ id });
      }
      await expect.poll(async () => (await api.media.job.get({ id })).phase).toBe(phase);
    }
    await page.addInitScript((value) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme: value })), theme);
    await page.goto("/media");
    await page.getByTestId("media-mode-understanding").click();
    await expect(page.locator("#opening")).toHaveCount(0);
    const screenshots = join(import.meta.dirname, "../.screens");
    mkdirSync(screenshots, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await settled(page);
      expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze()).violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      for (const phase of ["form", "ready", "incomplete", "unknown", "canceled"]) {
        const target =
          phase === "form"
            ? page.getByTestId("understanding-files")
            : page.locator(`[data-testid="understanding-job"][data-id="understanding-audit-${theme}-${phase}"]`);
        await target.evaluate((element) => element.scrollIntoView({ block: "center" }));
        await settled(page);
        await page.screenshot({ path: join(screenshots, `understanding-${phase}-${theme}-${width}.png`), fullPage: true });
      }
    }
    for (const phase of ["unknown", "canceled"]) await api.media.understanding.cleanup({ id: `understanding-audit-${theme}-${phase}` });
  });
