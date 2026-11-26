import "../../infra/polyfill";
import { expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import { type Artifact, type ArtifactPreview, type ArtifactType, userId } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { responses as artifactResponses } from "../../fixtures/artifacts";
import { fakeHost, type FakeHost } from "../../fixtures/fakeHost";
import { SCENARIO_NOW, scenarios } from "../../fixtures/scenarios";
import { artifactMetaLine } from "./Tiles";

function makeArtifact(over: {
  readonly id: string;
  readonly title: string;
  readonly artifactType: ArtifactType;
  readonly by?: string;
  readonly byName?: string;
  readonly version?: number;
  readonly seq?: number;
  readonly isDefault?: boolean;
  readonly preview?: ArtifactPreview;
  readonly cover?: Artifact["cover"];
}): Artifact {
  return {
    id: artifactId(over.id),
    title: over.title,
    artifactType: over.artifactType,
    isDefault: over.isDefault ?? false,
    by: over.by ?? userId,
    byName: over.byName ?? "You",
    version: over.version ?? 0,
    seq: over.seq ?? 1,
    versions: [],
    at: SCENARIO_NOW - 60_000,
    updated: SCENARIO_NOW - 60_000,
    ...(over.preview !== undefined ? { preview: over.preview } : {}),
    ...(over.cover !== undefined ? { cover: over.cover } : {}),
  };
}

async function mountLibrary(artifacts: readonly Artifact[], configure?: (fake: FakeHost) => void, opts?: { readonly colorScheme?: "light" | "dark" }) {
  const fake = fakeHost(scenarios.typical, { route: "/library", locale: "en" });
  for (const [op, answer] of Object.entries(artifactResponses)) {
    fake.respond(op, answer);
  }
  fake.respond("artifact.list", () => artifacts);
  configure?.(fake);
  const app = await open("../../app/main.tsx", {
    width: 1280,
    height: 800,
    colorScheme: opts?.colorScheme ?? "light",
    platform: "macos",
    clock: { time: SCENARIO_NOW },
    host: fake.options,
  });
  await fake.pumpUntil(app, () => app.count("id:library-artifacts") === 1);
  return { app, fake };
}

test("artifactMetaLine omits local default user name and shows agent collaborator name", () => {
  setLocale("en");
  const mine = makeArtifact({ id: "a-mine", title: "Spec", artifactType: "docs", by: userId, byName: "LocalUser", version: 2 });
  const lineMine = artifactMetaLine(mine, SCENARIO_NOW);
  expect(lineMine).toContain(t("web.artifact.types.docs"));
  expect(lineMine).toContain(t("web.library.inspector.versionBadge", { version: 2 }));
  expect(lineMine).not.toContain("LocalUser");

  const agent = makeArtifact({ id: "a-agent", title: "Deck", artifactType: "slides", by: "w1", byName: "Alex", version: 1 });
  const lineAgent = artifactMetaLine(agent, SCENARIO_NOW);
  expect(lineAgent).toContain(t("web.artifact.types.slides"));
  expect(lineAgent).toContain("Alex");
  expect(lineAgent).toContain(t("web.library.inspector.versionBadge", { version: 1 }));
});

test("ArtifactTiles renders all 12 structured previews, covers, and clean installed-applet footer", async () => {
  setLocale("en");
  const allTwelve: readonly Artifact[] = [
    makeArtifact({
      id: "p-docs",
      title: "Architecture RFC",
      artifactType: "docs",
      preview: { _tag: "docs", heading: "Core Goals", excerpt: "Keep storage consolidated and projections pure." },
    }),
    makeArtifact({
      id: "p-outline",
      title: "Release Checklist",
      artifactType: "outline",
      preview: {
        _tag: "outline",
        items: [
          { depth: 0, text: "Preflight", kind: "heading" },
          { depth: 1, text: "Run checks", kind: "todo", checked: true },
          { depth: 1, text: "Cut build", kind: "todo", checked: false },
        ],
        todoDone: 1,
        todoTotal: 2,
      },
    }),
    makeArtifact({
      id: "p-ds",
      title: "Papertrails Tokens",
      artifactType: "design-system",
      isDefault: true,
      preview: {
        _tag: "design-system",
        swatches: [
          { name: "page", light: "#fcfcfb", dark: "#151413" },
          { name: "accent", light: "#4d7a2a", dark: "#7fae4f" },
          { name: "wheat", light: "#e5a93c", dark: "#e5a93c" },
        ],
        fonts: ["PingFang SC", "Menlo"],
      },
    }),
    makeArtifact({
      id: "p-dash",
      title: "SLO Overview",
      artifactType: "dashboard",
      preview: {
        _tag: "dashboard",
        kpis: [
          { label: "Avail", value: "99.98%" },
          { label: "P99", value: "18ms" },
        ],
        series: [0.3, 0.5, 0.8, 0.6, 0.9],
      },
    }),
    makeArtifact({
      id: "p-sheet",
      title: "Benchmarks",
      artifactType: "sheet",
      preview: {
        _tag: "sheet",
        sheetName: "QPS",
        columns: ["Case", "QPS", "P99"],
        rows: [
          ["List", "1240", "8ms"],
          ["Write", "640", "14ms"],
        ],
        totalRows: 12,
        totalCols: 3,
      },
    }),
    makeArtifact({
      id: "p-slides",
      title: "Weekly Review",
      artifactType: "slides",
      preview: { _tag: "slides", firstTitle: "Q4 Highlights", firstSubtitle: "Native workbench", slideCount: 6 },
    }),
    makeArtifact({
      id: "p-wb",
      title: "System Map",
      artifactType: "whiteboard",
      preview: {
        _tag: "whiteboard",
        shapes: [
          { x: 0.1, y: 0.1, w: 0.3, h: 0.25, kind: "card", label: "Gateway" },
          { x: 0.55, y: 0.45, w: 0.3, h: 0.25, kind: "sticky", label: "Core" },
        ],
        nodeCount: 2,
      },
    }),
    makeArtifact({
      id: "p-diag",
      title: "Request Flow",
      artifactType: "diagram",
      preview: { _tag: "diagram", kind: "sequence", nodes: ["Client", "Gateway", "Core"], nodeCount: 3, edgeCount: 2 },
    }),
    makeArtifact({
      id: "p-design",
      title: "Workspace Frame",
      artifactType: "design",
      preview: { _tag: "design", artboard: "Desktop", width: 1440, height: 900, theme: "light", nodes: ["Header", "Grid"] },
    }),
    makeArtifact({
      id: "p-sb",
      title: "Launch Film",
      artifactType: "storyboard",
      preview: { _tag: "storyboard", shotCount: 4, firstShot: "Wide opening shot of workbench", durationSec: 12.5 },
    }),
    makeArtifact({
      id: "p-motion",
      title: "Launch Reel",
      artifactType: "motion",
      preview: { _tag: "motion", sceneCount: 3, durationSec: 8, firstScene: "Opening Hook" },
    }),
    makeArtifact({
      id: "p-proto-fallback",
      title: "Focus Timer",
      artifactType: "prototype",
      preview: { _tag: "prototype", heading: "Focus Studio", subtitle: "Ambient timer and task queue" },
    }),
    makeArtifact({
      id: "p-proto-covered",
      title: "Synth Pad",
      artifactType: "prototype",
      preview: { _tag: "prototype", heading: "Pocket Synth" },
      cover: {
        path: "/tmp/demo-cover-1.png",
        url: "/api/v1/artifact/p-proto-covered/cover?seq=1",
        mime: "image/png",
        seq: 1,
        width: 640,
        height: 400,
        updatedAt: SCENARIO_NOW,
      },
    }),
  ];

  const { app } = await mountLibrary(allTwelve, (fake) => {
    fake.respond("host.appletList", () => [
      {
        artifactId: "p-proto-covered",
        artifactType: "prototype",
        appName: "Synth Pad",
        bundleId: "dev.vibevalley.applet.p-proto-covered",
        bundlePath: "/Users/demo/Applications/VibeValley Apps/Synth Pad.app",
        alwaysOnTop: false,
        installed: true,
      },
    ]);
  });

  for (const art of allTwelve) {
    expect(app.count(`id:library-artifact-${art.id}`)).toBe(1);
  }
  expect(app.count("id:library-artifact-cover-p-proto-covered")).toBe(1);
  expect(app.count("id:library-artifact-preview-p-proto-covered")).toBe(0);
  expect(app.count("id:library-artifact-preview-p-proto-fallback")).toBe(1);
  expect(app.count("id:library-artifact-open-app-p-proto-covered")).toBe(1);
  expect(app.count("id:library-artifact-manage-app-p-proto-covered")).toBe(1);

  const texts = app.texts();
  expect(texts).toContain("Core Goals");
  expect(texts).toContain("1/2");
  expect(texts).toContain("99.98%");
  expect(texts).toContain("Q4 Highlights");
  expect(texts).toContain("Focus Studio");
  // Regression: never render the old overlapping "Installed" pill badge text on artifact cards.
  expect(texts).not.toContain(t("web.artifact.applet.badgeInstalled"));

  // Regression: at 1280px width, 3 cards fit cleanly on the first row without wrapping the 3rd card.
  const first = app.layout("id:library-artifact-p-docs");
  const second = app.layout("id:library-artifact-p-outline");
  const third = app.layout("id:library-artifact-p-ds");
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(third).not.toBeNull();
  expect(second!.y).toBe(first!.y);
  expect(third!.y).toBe(first!.y);
  expect(second!.x).toBeGreaterThan(first!.x);
  expect(third!.x).toBeGreaterThan(second!.x);
  // Regression: DesignSystemPreview frames each color swatch individually and light mode omits dark-only cover scrim.
  expect(app.count("id:design-system-swatch")).toBe(3);
  expect(app.count("id:library-artifact-cover-p-proto-covered-scrim")).toBe(0);
});

test("Library sidebar folds 0-count types behind collapsible toggle and dark mode adds prototype cover scrim", async () => {
  setLocale("en");
  const subset: readonly Artifact[] = [
    makeArtifact({
      id: "p-docs",
      title: "Architecture RFC",
      artifactType: "docs",
      preview: { _tag: "docs", heading: "Goals", excerpt: "Concise spec." },
    }),
    makeArtifact({
      id: "p-proto-covered",
      title: "Synth Pad",
      artifactType: "prototype",
      cover: {
        path: "/tmp/demo-cover-1.png",
        url: "/api/v1/artifact/p-proto-covered/cover?seq=1",
        mime: "image/png",
        seq: 1,
        width: 640,
        height: 400,
        updatedAt: SCENARIO_NOW,
      },
    }),
  ];

  const { app, fake } = await mountLibrary(subset, undefined, { colorScheme: "dark" });

  // Dark mode applies subtle scrim + inner border over captured covers.
  expect(app.count("id:library-artifact-cover-p-proto-covered-scrim")).toBe(1);

  // Populated artifact types are shown immediately; 0-count types are folded behind the quiet toggle.
  expect(app.count("id:content-nav-artifact-docs")).toBe(1);
  expect(app.count("id:content-nav-artifact-prototype")).toBe(1);
  expect(app.count("id:content-nav-artifact-sheet")).toBe(0);
  expect(app.count("id:content-nav-artifact-diagram")).toBe(0);
  expect(app.count("id:content-nav-artifacts-more")).toBe(1);
  expect(app.count("id:content-new-note-btn")).toBe(0);

  // Expanding the toggle reveals the remaining 0-count types.
  await app.press("id:content-nav-artifacts-more");
  await fake.pump(app);
  expect(app.count("id:content-nav-artifact-sheet")).toBe(1);
  expect(app.count("id:content-nav-artifact-diagram")).toBe(1);

  // Collapsing hides 0-count types again.
  await app.press("id:content-nav-artifacts-more");
  await fake.pump(app);
  expect(app.count("id:content-nav-artifact-sheet")).toBe(0);
});

test("LibraryPage filters artifacts and media by repo, issue, and channel and collapses filter bar on narrow widths", async () => {
  setLocale("en");
  const { app, fake } = await mountLibrary(
    [
      makeArtifact({ id: "art-vv", title: "VV Architecture", artifactType: "docs" }),
      makeArtifact({ id: "art-other", title: "Standalone Note", artifactType: "outline" }),
    ],
    (f) => {
      f.respond("artifact.list", [
        { ...makeArtifact({ id: "art-vv", title: "VV Architecture", artifactType: "docs" }), issue: "i18", channel: "general" },
        { ...makeArtifact({ id: "art-other", title: "Standalone Note", artifactType: "outline" }) },
      ]);
      f.respond("repo.list", [
        { name: "vibevalley", path: "/tmp/vibevalley", branch: "main", branches: ["main"], dirty: false, maxSessions: 4 },
        { name: "site", path: "/tmp/site", branch: "main", branches: ["main"], dirty: false, maxSessions: 2 },
      ]);
    },
  );

  expect(app.count("id:library-filter-bar")).toBe(1);
  expect(app.count("id:library-filter-repo")).toBe(1);
  expect(app.count("id:library-filter-issue")).toBe(1);
  expect(app.count("id:library-filter-channel")).toBe(1);
  expect(app.count("id:library-artifact-art-vv")).toBe(1);
  expect(app.count("id:library-artifact-art-other")).toBe(1);

  // Filter by repo `vibevalley`: narrows down to `art-vv` and media from `#general` (`vibevalley`), hiding `art-other`.
  await app.press("id:library-filter-repo");
  await fake.pump(app);
  await app.press("text:vibevalley");
  await fake.pump(app);
  expect(app.count("id:library-artifact-art-vv")).toBe(1);
  expect(app.count("id:library-artifact-art-other")).toBe(0);
  expect(app.count("id:library-filter-clear")).toBe(1);

  await app.press("id:library-filter-clear");
  await fake.pump(app);
  expect(app.count("id:library-artifact-art-other")).toBe(1);

  // Narrow viewport collapses inline filter bar into a filter popover cleanly.
  await app.setViewport(900, 720);
  await fake.pumpUntil(app, () => app.count("id:library-filter-popover") === 1);
  expect(app.count("id:library-filter-bar")).toBe(0);
});
