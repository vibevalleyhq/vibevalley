import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { type Artifact, type ArtifactId, userId } from "@vibevalley/protocol";

import { responses as artifactResponses } from "../../fixtures/artifacts";
import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";
import { formatDatasetLabel } from "./views/StructuredViews";

async function mountArtifactRoute(route: string, configure?: (fake: FakeHost) => void) {
  const fake = fakeHost(scenarios.typical, { route, locale: "en" });
  for (const [op, answer] of Object.entries(artifactResponses)) {
    fake.respond(op, answer);
  }
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 800,
    colorScheme: "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:artifact-header") === 1);
  return { app, fake };
}

test("formatDatasetLabel prettifies raw filenames while preserving uppercase acronyms", () => {
  expect(formatDatasetLabel("sample.json")).toBe("Sample");
  expect(formatDatasetLabel("slo_metrics.json")).toBe("Slo Metrics");
  expect(formatDatasetLabel("SLO-summary.csv")).toBe("SLO Summary");
  expect(formatDatasetLabel("dora_weekly")).toBe("Dora Weekly");
});

test("Artifact header title displays full text at rest and supports click-to-edit rename and Escape cancel", async () => {
  setLocale("en");
  const longTitle = "Release 0.2 UX Polish & Launch Checklist";
  let currentTitle = longTitle;
  const aid = "art-long-title" as ArtifactId;
  const updates: { id: string; title: string }[] = [];

  const makeArt = (): Artifact => ({
    id: aid,
    title: currentTitle,
    artifactType: "outline",
    isDefault: false,
    by: userId,
    byName: "You",
    version: 0,
    seq: 1,
    versions: [],
    at: SCENARIO_NOW - 60_000,
    updated: SCENARIO_NOW - 60_000,
  });

  const { app, fake } = await mountArtifactRoute(`/artifacts/${aid}`, (f) => {
    f.respond("artifact.get", () => makeArt());
    f.respond("artifact.list", () => [makeArt()]);
    f.respond("artifact.file.list", () => ({ artifactId: aid, seq: 1, files: [] }));
    f.respond("artifact.update", (p: { id: string; title?: string }) => {
      if (p.title !== undefined) {
        currentTitle = p.title;
        updates.push({ id: p.id, title: p.title });
      }
      return makeArt();
    });
  });

  // At rest, full title text renders cleanly inside the clickable title button without clipping.
  expect(app.count("id:artifact-title")).toBe(1);
  expect(app.texts()).toContain(longTitle);

  // Right chat drawer gives the bottom context bar close button breathing room from the window edge.
  const clearBtn = app.layout("id:artifact-context-clear");
  expect(clearBtn).not.toBeNull();
  expect(clearBtn!.x + clearBtn!.width).toBeLessThan(1280 - 12);

  // Clicking enters inline edit mode; Escape restores the original title without calling artifact.update.
  await app.press("id:artifact-title");
  await fake.pump(app);
  expect(app.value("id:artifact-title")).toBe(longTitle);
  await app.type("id:artifact-title", " (draft)");
  await fake.pump(app);
  await app.keyboard.press("escape");
  await fake.pump(app);
  expect(updates).toHaveLength(0);
  expect(app.texts()).toContain(longTitle);

  // Clicking again and committing saves the renamed title.
  await app.press("id:artifact-title");
  await fake.pump(app);
  await app.type("id:artifact-title", " v2");
  await fake.pump(app);
  await app.keyboard.press("enter");
  await fake.pumpUntil(app, () => updates.length === 1);
  expect(updates[0]).toEqual({ id: aid, title: `${longTitle} v2` });
});

test("DashboardView renders single-framed chart matching viewport width and prettified dataset header", async () => {
  setLocale("en");
  const aid = "art-dash-ux" as ArtifactId;
  const dashboardArt: Artifact = {
    id: aid,
    title: "Service Reliability Dashboard",
    artifactType: "dashboard",
    isDefault: false,
    by: userId,
    byName: "You",
    version: 0,
    seq: 1,
    versions: [],
    at: SCENARIO_NOW - 60_000,
    updated: SCENARIO_NOW - 60_000,
  };
  const dashJson = JSON.stringify({
    title: "SLO",
    panels: [{ id: "p1", label: "Availability", format: "percent", source: { dataset: "structure/data/sample.json", field: "availability", agg: "avg" } }],
  });
  const sampleJson = JSON.stringify({
    schema: [
      { name: "service", label: "Service", type: "string" },
      { name: "availability", label: "Availability", type: "number" },
    ],
    rows: [
      { service: "Gateway", availability: 99.95 },
      { service: "Core", availability: 99.99 },
    ],
  });

  const { app } = await mountArtifactRoute(`/artifacts/${aid}`, (f) => {
    f.respond("artifact.get", () => dashboardArt);
    f.respond("artifact.list", () => [dashboardArt]);
    f.respond("artifact.file.list", () => ({
      artifactId: aid,
      seq: 1,
      files: [
        { path: "structure/dashboard.json", mime: "application/json", size: dashJson.length, hash: "h1", updatedAt: SCENARIO_NOW },
        { path: "structure/data/sample.json", mime: "application/json", size: sampleJson.length, hash: "h2", updatedAt: SCENARIO_NOW },
      ],
    }));
    f.respond("artifact.file.get", (p: { path: string }) => {
      const content = p.path === "structure/dashboard.json" ? dashJson : sampleJson;
      return { artifactId: aid, path: p.path, mime: "application/json", encoding: "utf8", content, size: content.length, hash: "h", updatedAt: SCENARIO_NOW };
    });
  });

  expect(app.count("id:artifact-dashboard-view")).toBe(1);
  expect(app.count("id:dashboard-chart-sample.json")).toBe(1);
  expect(app.count("id:dashboard-dataset-label-sample.json")).toBe(1);
  const texts = app.texts();
  expect(texts).toContain("Sample");
  expect(texts).not.toContain("sample.json");
});
