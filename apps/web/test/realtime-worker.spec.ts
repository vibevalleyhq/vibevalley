import { choose, expect, test } from "./fixtures";

test.use({
  farm: "realtime-worker",
  permissions: ["camera", "microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

test.beforeEach(async ({ api, page }) => {
  const current = await api.provider.get();
  await api.provider.update({
    revision: current.revision,
    connections: [{ id: "realtime", name: "Realtime fixture", adapter: "moss", enabled: true, key: "realtime-fixture-not-a-vendor-key" }],
    dictation: null,
    image: null,
    understanding: null,
    speech: null,
    speakers: null,
    voiceDesign: null,
    transcription: null,
    live: { connection: "realtime", model: "moss-live-1.0-2026-11-02" },
    vision: { connection: "realtime", model: "moss-vl-realtime-1.0-2026-09-09" },
  });
  await page.addInitScript(() => {
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await acquire(constraints);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          if (track.readyState !== "ended") document.documentElement.dataset.stopped = String(Number(document.documentElement.dataset.stopped ?? 0) + 1);
          stop();
        };
      }
      return stream;
    };
  });
});

test("production Live web worker relays virtual audio and camera through the authenticated server and releases its ports", async ({ page }) => {
  await page.goto("/settings/moss");
  const before = page.workers().length;
  await page.getByTestId("moss-talk").click();
  await expect(page.getByTestId("moss-line")).toHaveAttribute("data-state", "live");
  await expect.poll(() => page.workers().length).toBeGreaterThan(before);
  await expect(page.getByTestId("moss-events")).toContainText("playback.completed");
  await expect(page.getByTestId("moss-said").locator("p")).toHaveCount(1);
  await choose(page.getByTestId("live-visual").getByTestId("visual-source"), "camera");
  await page.getByTestId("live-visual-start").click();
  await expect(page.getByTestId("moss-said").locator("p")).toHaveCount(2);
  await page.getByTestId("moss-hang-up").click();
  await expect(page.getByTestId("moss-line")).toHaveAttribute("data-state", "idle");
  await expect.poll(() => page.workers().length).toBe(before);
  await expect.poll(() => page.locator("html").getAttribute("data-stopped").then(Number)).toBeGreaterThanOrEqual(2);
});

test("independent visual session uses the real relay without starting Live and finishes a final prompt", async ({ page }) => {
  await page.goto("/settings/moss");
  const visual = page.getByTestId("vision-line");
  await choose(visual.getByTestId("visual-source"), "camera");
  await page.getByTestId("vision-start").click();
  await expect(visual).toHaveAttribute("data-state", "ready");
  await page.getByTestId("vision-prompt").fill("Describe the virtual camera");
  await page.getByTestId("vision-send").click();
  await expect(page.getByTestId("vision-transcript")).not.toBeEmpty();
  await page.getByTestId("vision-prompt").fill("Summarize the virtual camera");
  await page.getByTestId("vision-final").click();
  await expect(page.getByTestId("vision-final")).toBeChecked();
  await page.getByTestId("vision-send").click();
  await expect(visual).toHaveAttribute("data-state", "ended");
  await expect(page.getByTestId("moss-line")).toHaveAttribute("data-state", "idle");
  await expect.poll(() => page.locator("html").getAttribute("data-stopped").then(Number)).toBeGreaterThanOrEqual(1);
});
