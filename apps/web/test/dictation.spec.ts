import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Page } from "@playwright/test";

import { expect, test, settled } from "./fixtures";

async function countAudio(page: Page) {
  await page.addInitScript(() => {
    const Real = AudioWorkletNode;
    window.heard = 0;
    window.AudioWorkletNode = class extends Real {
      constructor(...a: ConstructorParameters<typeof AudioWorkletNode>) {
        super(...a);
        this.port.addEventListener("message", () => (window.heard = (window.heard ?? 0) + 1));
      }
    };
  });
}

const said = "hello there";

test.use({
  farm: "dictation",
  permissions: ["microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

test("dictation records the microphone as 16 kHz WAV and puts the words in the field", async ({ page, api }) => {
  const uploads: Buffer[] = [];
  const transcriber = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (p: Buffer) => parts.push(p));
    req.on("end", () => {
      uploads.push(Buffer.concat(parts));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: said }));
    });
  });
  await new Promise<void>((resolve) => transcriber.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = transcriber.address() as AddressInfo;
    await api.setting.update({ dictation: { via: "own", url: `http://127.0.0.1:${port}/v1`, model: "whisper" } });
    await countAudio(page);
    await page.goto("/chat");
    const dictate = page.getByTestId("dictate");
    await expect(dictate).toBeEnabled();
    await dictate.click();
    await expect.poll(() => page.evaluate(() => window.heard ?? 0)).toBeGreaterThan(2);
    await expect(dictate).toHaveAttribute("data-state", "recording");
    // The box's row is the recording's while it listens; its key is done.
    await expect(page.getByTestId("dictation-bar")).toBeVisible();
    await expect(page.getByTestId("send")).toBeHidden();
    await dictate.click();
    await expect(page.locator("textarea")).toHaveValue(new RegExp(said, "u"));
    await expect(page.getByTestId("dictation-bar")).toBeHidden();

    expect(uploads).toHaveLength(1);
    const wav = uploads[0]!.subarray(uploads[0]!.indexOf("RIFF"));
    expect(wav.readUInt32LE(24)).toBe(16000);
    const bytes = wav.readUInt32LE(40);
    // Whole runs of 4096 16-bit samples, at least the three counted.
    expect(bytes % 8192).toBe(0);
    expect(bytes).toBeGreaterThanOrEqual(3 * 8192);
  } finally {
    transcriber.close();
  }
});

test("Esc while the box listens drops the recording: nothing is sent and the box is as it was", async ({ page, api }) => {
  // An address nothing answers at: a recording sent there would come back as a problem in the box.
  await api.setting.update({ dictation: { via: "own", url: "http://127.0.0.1:9/v1", model: "whisper" } });
  await page.goto("/chat");
  const dictate = page.getByTestId("dictate");
  await dictate.click();
  await expect(dictate).toHaveAttribute("data-state", "recording");
  await page.getByTestId("composer-input").press("Escape");
  await expect(dictate).toHaveAttribute("data-state", "idle");
  await expect(page.getByTestId("dictation-bar")).toBeHidden();
  await expect(page.getByTestId("dictation-problem")).toBeHidden();
  await expect(page.getByTestId("send")).toBeVisible();
});

for (const theme of ["light", "dark"] as const) {
  test(`dictation failure preserves the draft in ${theme} on a narrow screen`, async ({ page, api }, info) => {
    let uploads = 0;
    const transcriber = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        uploads++;
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "local transcription fixture unavailable" } }));
      });
    });
    await new Promise<void>((resolve) => transcriber.listen(0, "127.0.0.1", resolve));
    try {
      const address = transcriber.address();
      if (address === null || typeof address === "string") throw new Error("fixture did not bind a port");
      await api.setting.update({ dictation: { via: "own", url: `http://127.0.0.1:${address.port}/v1`, model: "fixture" } });
      await countAudio(page);
      await page.addInitScript((theme) => localStorage.setItem("vibevalley.prefs", JSON.stringify({ theme })), theme);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/chat");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const input = page.getByTestId("composer-input");
      await input.fill("preserved draft");
      const dictate = page.getByTestId("dictate");
      await dictate.click();
      await expect.poll(() => page.evaluate(() => window.heard ?? 0)).toBeGreaterThan(2);
      await dictate.click();
      await expect(page.getByTestId("dictation-problem")).toBeVisible();
      await expect(input).toHaveValue("preserved draft");
      expect(uploads).toBe(1);
      await settled(page);
      await page.screenshot({ path: info.outputPath(`dictation-${theme}-390.png`), fullPage: true });
    } finally {
      transcriber.closeAllConnections();
      transcriber.close();
    }
  });
}
