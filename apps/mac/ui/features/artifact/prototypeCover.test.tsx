import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Artifact } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { responses as artifactResponses } from "../../fixtures/artifacts";
import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";
import { resetCapturedCoverCache } from "./views/PrototypeView";

async function mountPrototype(route: string, configure?: (fake: FakeHost) => void) {
  resetCapturedCoverCache();
  const fake = fakeHost(scenarios.typical, { route, locale: "en" });
  for (const [op, answer] of Object.entries(artifactResponses)) {
    fake.respond(op, answer);
  }
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: 1200,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:artifact-prototype-webview") === 1);
  return { app, fake };
}

test("PrototypeView silently captures cover after settle when missing or stale", async () => {
  setLocale("en");
  const { app, fake } = await mountPrototype("/artifacts/art-login", (f) => {
    f.respond("host.captureWebView", () => ({
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      width: 640,
      height: 400,
    }));
    f.respond("artifact.cover.set", (p: { id: string; seq: number; mime: string; width?: number; height?: number }) => ({
      path: `/tmp/${p.id}-cover-${p.seq}.png`,
      url: `/api/v1/artifact/${p.id}/cover?seq=${p.seq}`,
      mime: p.mime,
      seq: p.seq,
      width: p.width,
      height: p.height,
      updatedAt: SCENARIO_NOW,
    }));
  });

  const clock = app.clock;
  if (!clock) throw new Error("virtual clock required");

  // Before settle delay, no capture yet.
  await clock.fastForward(400);
  await fake.pump(app);
  expect(fake.calls.some((c) => c.op === "host.captureWebView")).toBe(false);

  // After settle delay, capture runs and uploads cover.
  await clock.fastForward(500);
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "artifact.cover.set"));

  const captureCall = fake.calls.findLast((c) => c.op === "host.captureWebView");
  expect(captureCall?.payload).toEqual({ width: 640, height: 400 });

  const setCall = fake.calls.findLast((c) => c.op === "artifact.cover.set");
  expect(setCall?.payload).toMatchObject({
    id: "art-login",
    seq: 2,
    mime: "image/png",
    width: 640,
    height: 400,
  });
});

test("PrototypeView skips capture when cover seq already matches or viewing historical version", async () => {
  setLocale("en");
  const baseGet = artifactResponses["artifact.get"] as (p: unknown) => Artifact;

  const upToDate = await mountPrototype("/artifacts/art-login", (f) => {
    f.respond("artifact.get", (p: unknown) => ({
      ...baseGet(p),
      cover: {
        path: "/tmp/art-login-cover-2.png",
        url: "/api/v1/artifact/art-login/cover?seq=2",
        mime: "image/png",
        seq: 2,
        width: 640,
        height: 400,
        updatedAt: SCENARIO_NOW,
      },
    }));
    f.respond("host.captureWebView", () => ({ mime: "image/png", data: "AAAA", width: 640, height: 400 }));
  });
  await upToDate.app.clock!.fastForward(1_200);
  await upToDate.fake.pump(upToDate.app);
  expect(upToDate.fake.calls.some((c) => c.op === "host.captureWebView")).toBe(false);

  const historical = await mountPrototype("/artifacts/art-login?v=1", (f) => {
    f.respond("host.captureWebView", () => ({ mime: "image/png", data: "AAAA", width: 640, height: 400 }));
  });
  await historical.app.clock!.fastForward(1_200);
  await historical.fake.pump(historical.app);
  expect(historical.fake.calls.some((c) => c.op === "host.captureWebView")).toBe(false);
});

test("PrototypeView silently ignores background cover capture failures without showing error toast", async () => {
  setLocale("en");
  const { app, fake } = await mountPrototype("/artifacts/art-login", (f) => {
    f.respond("host.captureWebView", () => ({ mime: "image/png", data: "AAAA", width: 640, height: 400 }));
    f.respond("artifact.cover.set", () => ({ bizCode: BizCode.Refused, message: "cover upload failed" }));
  });
  await app.clock!.fastForward(1_000);
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "artifact.cover.set"));
  expect(app.texts()).not.toContain("cover upload failed");
});
