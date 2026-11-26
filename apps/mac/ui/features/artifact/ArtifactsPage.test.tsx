import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { type Artifact, type ArtifactId, userId } from "@vibevalley/protocol";

import { responses as artifactResponses } from "../../fixtures/artifacts";
import { fakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";

function makeOutlineArtifact(id: string): Artifact {
  return {
    id: id as ArtifactId,
    title: "Responsive Outline",
    artifactType: "outline",
    isDefault: false,
    by: userId,
    byName: "You",
    version: 0,
    seq: 1,
    versions: [],
    at: SCENARIO_NOW - 60_000,
    updated: SCENARIO_NOW - 60_000,
  };
}

async function mountOutlineAt(width: number, height: number) {
  setLocale("en");
  const art = makeOutlineArtifact("art-resp-outline");
  const fake = fakeHost(scenarios.typical, { route: `/artifacts/${art.id}`, locale: "en" });
  for (const [op, answer] of Object.entries(artifactResponses)) {
    fake.respond(op, answer);
  }
  fake.respond("artifact.get", () => art);
  fake.respond("artifact.list", () => [art]);
  fake.respond("artifact.file.list", () => ({ artifactId: art.id, seq: 1, files: [] }));

  const app = await open("../../app/main.tsx", {
    width,
    height,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:artifact-header") === 1);
  return { app, fake };
}

test("ArtifactsPage defaults rightPanel to none below lg (900x720) so docs/outline editor stays full-width and opens chat on toggle", async () => {
  const { app, fake } = await mountOutlineAt(900, 720);

  expect(app.count("id:artifact-rail")).toBe(0);
  const headerBox = app.layout("id:artifact-header");
  expect(headerBox).not.toBeNull();
  expect(headerBox!.width).toBeGreaterThan(500);

  await app.press("id:artifact-rail-toggle");
  await fake.pumpUntil(app, () => app.count("id:artifact-rail") === 1);
  expect(app.count("id:artifact-rail")).toBe(1);
});

test("ArtifactsPage keeps chat rail open by default at lg >= 1024px (1280x800)", async () => {
  const { app } = await mountOutlineAt(1280, 800);
  expect(app.count("id:artifact-rail")).toBe(1);
});
