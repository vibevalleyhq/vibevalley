import assert from "node:assert/strict";

import type { Page, WebSocketRoute } from "@playwright/test";

import { choose, expect, test } from "./fixtures";
import { disableWorkers } from "./marks";

test.use({
  farm: "moss-lifecycle",
  permissions: ["camera", "microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

// The playground's line goes through the server, which holds the key: with none saved, the server's refusal reaches the
// page and the line goes back to idle.
test("the MOSS Live playground shows the server's refusal while no key is saved", async ({ page }) => {
  await page.goto("/settings/moss");
  const line = page.getByTestId("moss-line");
  await expect(line).toHaveAttribute("data-state", "idle");
  // The line's quality and messages are folded under 调试 until asked for.
  await expect(line.getByTestId("moss-qos")).toBeHidden();
  await line.getByTestId("moss-debug").locator("summary").click();
  await expect(line.getByTestId("moss-qos")).toBeVisible();
  await line.getByTestId("moss-talk").click();
  await expect(line.getByRole("alert")).not.toBeEmpty();
  await expect(line).toHaveAttribute("data-state", "idle");
  await expect(line.getByTestId("moss-events")).toBeVisible();
});

async function liveFixture(page: Page, delayFirst = false) {
  await page.addInitScript(disableWorkers);
  await page.addInitScript((delayFirst) => {
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    let calls = 0;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const call = ++calls;
      const stream = await acquire(constraints);
      document.documentElement.dataset.micAcquisitions = String(call);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          if (track.readyState !== "ended") document.documentElement.dataset.stopped = String(Number(document.documentElement.dataset.stopped ?? 0) + 1);
          stop();
        };
      }
      if (delayFirst && call === 1) {
        await new Promise<void>((resolve) => {
          window.addEventListener("grant-old-mic", () => resolve(), { once: true });
          document.documentElement.dataset.pendingMic = "true";
        });
      }
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = () => navigator.mediaDevices.getUserMedia({ video: true });
  }, delayFirst);
  const events: string[] = [];
  const frames: Buffer[] = [];
  let route: WebSocketRoute | undefined;
  await page.routeWebSocket("**/api/v1/voice/moss/line", (socket) => {
    route = socket;
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        expect(events).toContain("media.mode");
        if (message[0] === 0) expect(message.byteLength).toBe(641);
        else {
          expect([1, 2]).toContain(message[0]);
          expect(message.byteLength).toBeLessThanOrEqual(256 * 1024 + 1);
          expect(message[1]).toBe(255);
          expect(message[2]).toBe(216);
        }
        frames.push(message);
        return;
      }
      const event: unknown = JSON.parse(message);
      assert(typeof event === "object" && event !== null && "action" in event && typeof event.action === "string");
      events.push(event.action);
      if (event.action === "attach_session")
        socket.send(
          JSON.stringify({
            action: "session_attached",
            data: { session_id: "fixture", memory_scope: "session", delegation: "none" },
          }),
        );
      else if (event.action === "session.update") socket.send(JSON.stringify({ action: "session.updated", data: { error: "" } }));
    });
  });
  return { events, frames, send: (event: object) => route?.send(JSON.stringify(event)), audio: (pcm: Buffer) => route?.send(pcm) };
}

test.describe("virtual Live lifecycle", () => {
  test("regression: cancelling a connecting call cannot install its late microphone into a newer call", async ({ page }) => {
    await liveFixture(page, true);
    await page.goto("/settings/moss");
    await page.getByTestId("moss-talk").click();
    await expect(page.locator("html")).toHaveAttribute("data-pending-mic", "true");
    await page.getByTestId("moss-hang-up").click();
    await page.getByTestId("moss-talk").click();
    await expect(page.getByTestId("moss-line")).toHaveAttribute("data-state", "live");
    await page.evaluate(() => window.dispatchEvent(new Event("grant-old-mic")));
    await expect(page.locator("html")).toHaveAttribute("data-stopped", "1");
    await expect(page.getByTestId("moss-line")).toHaveAttribute("data-state", "live");
    await page.getByTestId("moss-hang-up").click();
    await expect(page.locator("html")).toHaveAttribute("data-stopped", "2");
  });

  test("regression: dictation cancellation invalidates a late acquisition even when the same field starts again", async ({ page, api }) => {
    await liveFixture(page, true);
    await api.setting.update({ dictation: { via: "own", url: "http://127.0.0.1:9/v1", model: "fixture" } });
    await page.goto("/chat");
    await page.getByTestId("dictate").click();
    await expect(page.locator("html")).toHaveAttribute("data-pending-mic", "true");
    await page.getByTestId("composer-input").press("Escape");
    await page.getByTestId("dictate").click();
    await expect(page.locator("html")).toHaveAttribute("data-mic-acquisitions", "2");
    await page.evaluate(() => window.dispatchEvent(new Event("grant-old-mic")));
    await expect(page.locator("html")).toHaveAttribute("data-stopped", "1");
    await expect(page.getByTestId("dictate")).toHaveAttribute("data-state", "recording");
    await page.getByTestId("composer-input").press("Escape");
    await expect(page.locator("html")).toHaveAttribute("data-stopped", "2");
  });

  test("Live acknowledges only actually completed playback and stops interrupted audio", async ({ page }) => {
    const relay = await liveFixture(page);
    await page.goto("/settings/moss");
    await page.getByTestId("moss-talk").click();
    await expect(page.getByTestId("moss-line")).toHaveAttribute("data-state", "live");
    relay.send({ action: "response.audio.started", data: { run_id: "r1", turn_id: "t1" } });
    relay.send({ action: "response.audio.context", data: { run_id: "r1", turn_id: "t1", chunk_id: "c1" } });
    relay.audio(Buffer.alloc(9600));
    relay.send({ action: "response.audio.done", data: { run_id: "r1", turn_id: "t1" } });
    await expect.poll(() => relay.events.includes("playback.completed")).toBe(true);
    expect(relay.events.indexOf("playback.chunk.completed")).toBeLessThan(relay.events.indexOf("playback.completed"));
    relay.send({ action: "response.audio.started", data: { run_id: "r2", turn_id: "t2" } });
    relay.send({ action: "response.audio.context", data: { run_id: "r2", turn_id: "t2", chunk_id: "c2" } });
    relay.audio(Buffer.alloc(96000));
    relay.send({ action: "response.interrupted", data: { run_id: "r2", turn_id: "t2" } });
    await expect.poll(() => relay.events.includes("playback.stopped")).toBe(true);
    await page.getByTestId("moss-hang-up").click();
  });

  for (const source of ["camera", "screen"] as const) {
    test(`Live uploads tagged ${source} only on explicit request and releases it on session.closing`, async ({ page }) => {
      const relay = await liveFixture(page);
      await page.goto("/settings/moss");
      await page.getByTestId("moss-talk").click();
      await expect(page.getByTestId("moss-line")).toHaveAttribute("data-state", "live");
      await expect.poll(() => relay.frames.filter((frame) => frame[0] === 0).length).toBeGreaterThan(0);
      expect(relay.frames.some((frame) => frame[0] !== 0)).toBe(false);
      await choose(page.getByTestId("vision-line").getByTestId("visual-source"), source);
      await page.getByTestId("live-visual-start").click();
      await expect.poll(() => relay.frames.filter((frame) => frame[0] === (source === "camera" ? 1 : 2)).length).toBeGreaterThan(0);
      expect(relay.events).toContain("video.state");
      expect(relay.events).toContain("video.stream_focus");
      relay.send({ action: "session.closing", data: { reason: "fixture" } });
      await expect(page.getByTestId("moss-line")).toHaveAttribute("data-state", "idle");
      await expect(page.locator("html")).toHaveAttribute("data-stopped", "2");
    });
  }
});
