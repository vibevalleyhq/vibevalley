// Dictation through Chromium's fake microphone: the page records it, the server hands the WAV to a transcriber (a fake
// one here, answering as OpenAI's transcription API does), and the words land in the field it was started from.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./fixtures";

type Counted = Window & { heard: number };

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
    // What the capture worklet hands the page is counted, so the recording stops once there is something to send.
    await page.addInitScript(() => {
      const Real = AudioWorkletNode;
      (window as unknown as Counted).heard = 0;
      window.AudioWorkletNode = class extends Real {
        constructor(...a: ConstructorParameters<typeof AudioWorkletNode>) {
          super(...a);
          this.port.addEventListener("message", () => (window as unknown as Counted).heard++);
        }
      };
      localStorage.setItem("vibevalley.title.seen", "true");
    });
    await page.goto("/chat");
    const dictate = page.getByTestId("dictate");
    await expect(dictate).toBeEnabled();
    await dictate.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as Counted).heard)).toBeGreaterThan(2);
    await expect(dictate).toHaveAttribute("data-state", "recording");
    await dictate.click();
    await expect(page.locator("textarea")).toHaveValue(new RegExp(said));

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
