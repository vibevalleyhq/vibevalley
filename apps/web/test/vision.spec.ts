import assert from "node:assert/strict";

import type { Page, WebSocketRoute } from "@playwright/test";

import { choose, expect, test } from "./fixtures";
import { insecureContext } from "./marks";

async function virtualCapture(page: Page, delayed = false) {
  await page.addInitScript((delayed) => {
    const acquire = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    const streams: MediaStream[] = [];
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      document.documentElement.dataset.acquired = String(Number(document.documentElement.dataset.acquired ?? 0) + 1);
      const stream = await acquire(constraints);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => {
          if (track.readyState !== "ended") document.documentElement.dataset.stopped = String(Number(document.documentElement.dataset.stopped ?? 0) + 1);
          stop();
        };
      }
      streams.push(stream);
      if (delayed) {
        await new Promise<void>((resolve) => {
          window.addEventListener("grant-capture", () => resolve(), { once: true });
          document.documentElement.dataset.permissionPending = "true";
        });
      }
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = () => navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    window.addEventListener("lose-capture", () => {
      for (const stream of streams) for (const track of stream.getTracks()) track.dispatchEvent(new Event("ended"));
    });
  }, delayed);
}

async function visionRelay(page: Page, holdFrames = false) {
  const frames: Buffer[] = [];
  const inputs: string[] = [];
  let route: WebSocketRoute | undefined;
  let pending: number | undefined;
  let sequence = 0;
  let timestamp = -Infinity;
  await page.routeWebSocket("**/api/v1/voice/vision/line", (socket) => {
    route = socket;
    socket.onMessage((message) => {
      if (typeof message !== "string") {
        expect(pending).toBeDefined();
        expect(message.byteLength).toBeLessThanOrEqual(256 * 1024);
        expect(message[0]).toBe(255);
        expect(message[1]).toBe(216);
        frames.push(message);
        socket.send(JSON.stringify({ type: "input.frame.accepted", seq_no: pending }));
        pending = undefined;
        sequence++;
        return;
      }
      const input: unknown = JSON.parse(message);
      assert(typeof input === "object" && input !== null && "type" in input && typeof input.type === "string");
      inputs.push(input.type);
      if (input.type === "session.configure") {
        socket.send(JSON.stringify({ type: "session.configured", max_frame_bytes: 256 * 1024 }));
        socket.send(JSON.stringify({ type: "session.ready", turn_id: 0 }));
      } else if (input.type === "input.frame") {
        assert("seq_no" in input && typeof input.seq_no === "number" && "timestamp" in input && typeof input.timestamp === "number");
        expect(pending).toBeUndefined();
        expect(input.seq_no).toBe(sequence);
        expect(input.timestamp - timestamp).toBeGreaterThanOrEqual(1);
        timestamp = input.timestamp;
        pending = input.seq_no;
        if (!holdFrames) socket.send(JSON.stringify({ type: "input.frame.ready", seq_no: pending }));
      } else if (input.type === "input.prompt") {
        assert("seq_no" in input && typeof input.seq_no === "number");
        expect(input.seq_no).toBe(sequence++);
        socket.send(JSON.stringify({ type: "input.prompt.accepted", seq_no: input.seq_no }));
        socket.send(JSON.stringify({ type: "response.text.delta", response_id: "r1", response_seq: 0, turn_id: 1, delta: "fixture response" }));
        socket.send(JSON.stringify({ type: "response.done", response_id: "r1", response_seq: 0, turn_id: 1 }));
        if ("final" in input && input.final === true) socket.send(JSON.stringify({ type: "session.done", reason: "completed" }));
      }
    });
    socket.send(JSON.stringify({ type: "session.created", session_id: "fixture" }));
  });
  return { frames, inputs, send: (event: object) => route?.send(JSON.stringify(event)), close: () => route?.close({ code: 1011, reason: "fixture" }) };
}

test.use({
  farm: "vision",
  permissions: ["camera", "microphone"],
  launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
});

test("visual sessions capture bounded JPEGs and continue after response.done without Live configuration", async ({ page }, info) => {
  await virtualCapture(page);
  const relay = await visionRelay(page);
  await page.goto("/settings/moss");
  await expect(page.locator("html")).not.toHaveAttribute("data-acquired");
  await page.getByTestId("vision-start").click();
  await expect(page.getByTestId("vision-line")).toHaveAttribute("data-state", "ready");
  await expect.poll(() => relay.frames.length).toBeGreaterThanOrEqual(2);
  const jpeg = relay.frames[0];
  if (!jpeg) throw new Error("fixture received no JPEG");
  const dimensions = await page.evaluate(
    async (bytes) => {
      const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));
      const result = { width: image.width, height: image.height };
      image.close();
      return result;
    },
    [...jpeg],
  );
  expect(dimensions.width).toBeLessThanOrEqual(640);
  expect(dimensions.height).toBeLessThanOrEqual(480);
  await page.getByTestId("vision-prompt").fill("Describe the fixture");
  await page.getByTestId("vision-send").click();
  await expect(page.getByTestId("vision-transcript").locator("[data-state=done]")).toHaveCount(1);
  await expect(page.getByTestId("vision-line")).toHaveAttribute("data-state", "ready");
  await expect(page.getByTestId("moss-line")).toHaveAttribute("data-state", "idle");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("vision-390.png"), fullPage: true });
  await page.getByTestId("vision-stop").click();
  await expect(page.getByTestId("vision-line")).toHaveAttribute("data-state", "ended");
  await expect(page.locator("html")).toHaveAttribute("data-stopped", "1");
  expect(relay.inputs).toContain("session.abort");
});

test("regression: a visual question submitted during frame admission is sent after that frame", async ({ page }) => {
  await virtualCapture(page);
  const relay = await visionRelay(page, true);
  await page.goto("/settings/moss");
  await page.getByTestId("vision-start").click();
  await expect.poll(() => relay.inputs).toContain("input.frame");
  await page.getByTestId("vision-prompt").fill("Describe the fixture");
  await expect(page.getByTestId("vision-send")).toBeEnabled();
  await page.getByTestId("vision-send").click();
  await expect(page.getByTestId("vision-prompt")).toHaveValue("");
  expect(relay.inputs).not.toContain("input.prompt");
  relay.send({ type: "input.frame.ready", seq_no: 0 });
  await expect(page.getByTestId("vision-transcript").locator("[data-state=done]")).toHaveCount(1);
  expect(relay.inputs.filter((type) => type === "input.prompt")).toEqual(["input.prompt"]);
  await page.getByTestId("vision-stop").click();
  await expect(page.getByTestId("vision-line")).toHaveAttribute("data-state", "ended");
});

test("regression: frame.ready gates binary and a pending frame does not accumulate later captures", async ({ page }) => {
  await virtualCapture(page);
  const relay = await visionRelay(page, true);
  await page.clock.install();
  await page.goto("/settings/moss");
  await page.getByTestId("vision-start").click();
  await expect.poll(() => relay.inputs.filter((type) => type === "input.frame").length).toBe(1);
  await page.clock.runFor(5000);
  expect(relay.frames).toHaveLength(0);
  expect(relay.inputs.filter((type) => type === "input.frame")).toHaveLength(1);
  relay.send({ type: "input.frame.ready", seq_no: 0 });
  await expect.poll(() => relay.frames.length).toBe(1);
  relay.send({ type: "error", code: "context_exhausted" });
  await expect(page.getByTestId("vision-line")).toHaveAttribute("data-state", "error");
  await expect(page.locator("html")).toHaveAttribute("data-stopped", "1");
});

test("regression: cancelled permission acquisition releases its late stream without opening a session", async ({ page }) => {
  await virtualCapture(page, true);
  const relay = await visionRelay(page);
  await page.goto("/settings/moss");
  await page.getByTestId("vision-start").click();
  await expect(page.locator("html")).toHaveAttribute("data-permission-pending", "true");
  await page.getByTestId("vision-stop").click();
  await page.evaluate(() => window.dispatchEvent(new Event("grant-capture")));
  await expect(page.locator("html")).toHaveAttribute("data-stopped", "1");
  expect(relay.inputs).toHaveLength(0);
});

for (const ending of ["device", "background", "leave", "disconnect", "complete"] as const) {
  test(`visual capture releases its stream on ${ending}`, async ({ page }) => {
    await virtualCapture(page);
    const relay = await visionRelay(page);
    await page.goto("/settings/moss");
    await choose(page.getByTestId("vision-line").getByTestId("visual-source"), "screen");
    await page.getByTestId("vision-start").click();
    await expect(page.getByTestId("vision-line")).toHaveAttribute("data-state", "ready");
    if (ending === "device") await page.evaluate(() => window.dispatchEvent(new Event("lose-capture")));
    else if (ending === "background")
      await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
    else if (ending === "leave") await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    else if (ending === "disconnect") await relay.close();
    else relay.send({ type: "session.done", reason: "completed" });
    await expect(page.locator("html")).toHaveAttribute("data-stopped", "1");
    await expect(page.getByTestId("vision-stop")).toHaveCount(0);
  });
}

test("permission denial leaves no session or captures", async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException("fixture", "NotAllowedError"));
  });
  const relay = await visionRelay(page);
  await page.goto("/settings/moss");
  await page.getByTestId("vision-start").click();
  await expect(page.getByTestId("vision-line").getByRole("alert")).toBeVisible();
  await expect(page.getByTestId("vision-stop")).toHaveCount(0);
  expect(relay.inputs).toHaveLength(0);
});

test("a final question ends capture while interrupted segments remain distinguishable", async ({ page }) => {
  await virtualCapture(page);
  const relay = await visionRelay(page);
  await page.goto("/settings/moss");
  await page.getByTestId("vision-start").click();
  await expect(page.getByTestId("vision-line")).toHaveAttribute("data-state", "ready");
  relay.send({ type: "response.text.delta", response_id: "old", response_seq: 0, turn_id: 0, delta: "partial" });
  relay.send({ type: "response.turn.interrupted", turn_id: 0, next_turn_id: 1, seq_no: 0 });
  await expect(page.getByTestId("vision-transcript").locator("[data-state=interrupted]")).toHaveCount(1);
  await page.getByTestId("vision-prompt").fill("Finish");
  await page.getByTestId("vision-final").click();
  await expect(page.getByTestId("vision-final")).toBeChecked();
  await page.getByTestId("vision-send").click();
  await expect(page.getByTestId("vision-line")).toHaveAttribute("data-state", "ended");
  await expect(page.locator("html")).toHaveAttribute("data-stopped", "1");
});

for (const name of ["mobile", "desktop"] as const) {
  test(`${name} shell does not advertise unsupported visual capture`, async ({ page }) => {
    await page.addInitScript((name) => {
      window.vibevalleyHost = { name };
    }, name);
    await page.goto("/settings/moss");
    if (name === "mobile") await expect(page.getByTestId("vision-start")).toBeDisabled();
    else {
      await expect(page.getByTestId("vision-start")).toBeEnabled();
      await page.getByTestId("vision-line").getByTestId("visual-source").click();
      await expect(page.locator('[role="option"][data-key="screen"]')).toBeDisabled();
    }
    await expect(page.getByTestId("live-visual-start")).toBeDisabled();
  });
}

test("insecure browser contexts do not request capture permissions", async ({ page }) => {
  await virtualCapture(page);
  await page.addInitScript(insecureContext);
  await page.goto("/settings/moss");
  await expect(page.getByTestId("vision-start")).toBeDisabled();
  await expect(page.getByTestId("live-visual-start")).toBeDisabled();
  await expect(page.locator("html")).not.toHaveAttribute("data-acquired");
});
