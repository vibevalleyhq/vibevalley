import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { Note } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";

import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { responses as noteResponses } from "../../fixtures/notes";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

async function mountPreviewNote(route: string, configure?: (fake: FakeHost) => void) {
  const fake = fakeHost(scenarios.typical, { route, locale: "en" });
  for (const [op, answer] of Object.entries(noteResponses)) {
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
  await fake.pumpUntil(app, () => app.count("id:note-header") === 1);
  return { app, fake };
}

test("Note preview block captures cover after settle when missing or stale", async () => {
  setLocale("en");
  const { app, fake } = await mountPreviewNote("/notes/art-login", (f) => {
    f.respond("host.captureWebView", () => ({
      mime: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      width: 640,
      height: 400,
    }));
    f.respond("note.cover.set", (p: { id: string; seq: number; mime: string; width?: number; height?: number }) => ({
      path: `/tmp/${p.id}-cover-${p.seq}.png`,
      url: `/api/v1/note/${p.id}/cover?seq=${p.seq}`,
      mime: p.mime,
      seq: p.seq,
      width: p.width,
      height: p.height,
      updatedAt: SCENARIO_NOW,
    }));
  });

  const clock = app.clock;
  if (!clock) throw new Error("virtual clock required");

  await clock.fastForward(400);
  await fake.pump(app);
  expect(fake.calls.some((c) => c.op === "host.captureWebView")).toBe(false);

  await clock.fastForward(600);
  await fake.pumpUntil(app, () => fake.calls.some((c) => c.op === "note.cover.set"));

  const setCall = fake.calls.findLast((c) => c.op === "note.cover.set");
  expect(setCall?.payload).toMatchObject({
    id: "art-login",
    seq: 2,
    mime: "image/png",
  });
});

test("Note preview skips cover capture when cover seq matches or upload fails silently", async () => {
  setLocale("en");
  const baseGet = noteResponses["note.get"] as (p: unknown) => Note;

  const upToDate = await mountPreviewNote("/notes/art-login", (f) => {
    f.respond("note.get", (p: unknown) => ({
      ...baseGet(p),
      cover: {
        path: "/tmp/art-login-cover-2.png",
        url: "/api/v1/note/art-login/cover?seq=2",
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

  const failing = await mountPreviewNote("/notes/art-login", (f) => {
    f.respond("host.captureWebView", () => ({ mime: "image/png", data: "AAAA", width: 640, height: 400 }));
    f.respond("note.cover.set", () => ({ bizCode: BizCode.Refused, message: "cover upload failed" }));
  });
  await failing.app.clock!.fastForward(1_000);
  await failing.fake.pump(failing.app);
  expect(failing.app.texts()).not.toContain("cover upload failed");
});
