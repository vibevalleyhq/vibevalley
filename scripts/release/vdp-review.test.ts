import { describe, expect, it } from "vite-plus/test";

import {
  buildScreenMatrix,
  countUiTreeNodes,
  extractShellErrors,
  parseReviewArgs,
  renderContactSheetHtml,
  type ReviewManifest,
  ReviewManifestSchema,
  type SeededWorkspaceIds,
} from "./vdp-review.ts";

const sampleIds: SeededWorkspaceIds = {
  firstIssueId: "iss_01",
  issueIds: ["iss_01", "iss_02"],
  agentIds: ["ag_ada", "ag_milo"],
  channelIds: ["general", "ch_release"],
  artifacts: {
    docs: "art_docs",
    outline: "art_outline",
    dashboard: "art_dash",
    designSystem: "art_ds",
    whiteboard: "art_wb",
    slides: "art_slides",
    sheet: "art_sheet",
    prototype: "art_proto",
  },
};

describe("vdp-review", () => {
  it("parses default options and custom flags cleanly", () => {
    expect(parseReviewArgs([], "/repo")).toEqual({
      outDir: "/tmp/vv-ux-review",
      themes: ["light", "dark"],
      width: 1280,
      height: 840,
      skipBuild: false,
      keepSandbox: false,
      help: false,
    });

    expect(
      parseReviewArgs(["--out", "review-out", "--themes=dark,light,dark", "--width", "1440", "--height=900", "--skip-build", "--keep-sandbox"], "/repo"),
    ).toEqual({
      outDir: "/repo/review-out",
      themes: ["dark", "light"],
      width: 1440,
      height: 900,
      skipBuild: true,
      keepSandbox: true,
      help: false,
    });

    expect(parseReviewArgs(["--help"], "/repo").help).toBe(true);
    expect(() => parseReviewArgs(["--themes=sepia"], "/repo")).toThrow(/unsupported theme/u);
    expect(() => parseReviewArgs(["--width=0"], "/repo")).toThrow(/positive integer/u);
    expect(() => parseReviewArgs(["--unknown"], "/repo")).toThrow(/unknown option/u);
  });

  it("builds the full screen matrix across requested themes with seeded routes", () => {
    const entries = buildScreenMatrix(sampleIds, ["light", "dark"]);
    expect(entries).toHaveLength(30);

    const lightRoutes = entries.filter((e) => e.theme === "light").map((e) => [e.id, e.route, e.fileName]);
    expect(lightRoutes).toEqual([
      ["issues", "/issues", "issues-light.png"],
      ["issue-detail", "/issues/iss_01", "issue-detail-light.png"],
      ["chat", "/chat", "chat-light.png"],
      ["runs", "/runs", "runs-light.png"],
      ["agents", "/agents", "agents-light.png"],
      ["runtimes", "/runtimes", "runtimes-light.png"],
      ["library", "/library", "library-light.png"],
      ["artifact-outline", "/artifacts/art_outline", "artifact-outline-light.png"],
      ["artifact-dashboard", "/artifacts/art_dash", "artifact-dashboard-light.png"],
      ["artifact-design-system", "/artifacts/art_ds", "artifact-design-system-light.png"],
      ["artifact-whiteboard", "/artifacts/art_wb", "artifact-whiteboard-light.png"],
      ["artifact-prototype", "/artifacts/art_proto", "artifact-prototype-light.png"],
      ["artifact-prototype-webview", "/artifacts/art_proto", "artifact-prototype-webview-light.png"],
      ["settings", "/settings", "settings-light.png"],
      ["farm", "/farm", "farm-light.png"],
    ]);

    expect(buildScreenMatrix(sampleIds, ["light"])).toHaveLength(15);
  });

  it("counts nested UI tree nodes and extracts shell/view errors", () => {
    expect(countUiTreeNodes([{ testId: "root", children: [{ testId: "a" }, { testId: "b", children: [{ testId: "c" }] }] }, { testId: "footer" }])).toBe(5);

    const clean = extractShellErrors({
      loaded: true,
      load_error: null,
      route: "/library",
      sidebar: { ready: true, errors: [] },
      workbench: { ready: true, errors: [] },
      inspector: null,
      palette: null,
      projects: [{ tabs: [{ hosted: { ready: true, errors: [] } }] }],
    });
    expect(clean).toEqual({ loaded: true, route: "/library", errors: [] });

    const broken = extractShellErrors({
      loaded: false,
      load_error: "bundle load failed",
      startup_failure: { kind: "db", summary: "corrupt state" },
      sidebar: { errors: ["sidebar crash"] },
      workbench: { errors: ["render error"] },
      inspector: { errors: ["inspector error"] },
      palette: { view: { errors: ["palette error"] } },
      projects: [{ tabs: [{ hosted: { errors: ["pane error"] } }] }],
    });
    expect(broken.loaded).toBe(false);
    expect(broken.errors).toHaveLength(8);
    expect(broken.errors.join("\n")).toContain("bundle load failed");
    expect(broken.errors.join("\n")).toContain("pane: pane error");
  });

  it("validates manifest schema and renders an HTML contact sheet", () => {
    const manifest: ReviewManifest = ReviewManifestSchema.parse({
      generatedAt: "2026-11-26T12:00:00.000Z",
      outDir: "/tmp/vv-ux-review",
      viewport: { width: 1280, height: 840 },
      themes: ["light", "dark"],
      seeded: sampleIds,
      screens: [
        {
          id: "issues",
          label: "Issues Board",
          route: "/issues",
          theme: "light",
          pngPath: "/tmp/vv-ux-review/shots/issues-light.png",
          relPath: "shots/issues-light.png",
          bytes: 84_000,
          imageWidth: 2560,
          imageHeight: 1680,
          metrics: { width: 1280, height: 840, scaleFactor: 2, themeDark: false, lastFrameMs: 6.2 },
          uiNodeCount: 142,
          uiRoute: "/issues",
          shellRoute: "/issues",
          shellErrors: [],
        },
      ],
      summary: { totalScreens: 1, totalErrors: 0, totalBytes: 84_000 },
    });

    const html = renderContactSheetHtml(manifest);
    expect(html).toContain("VibeValley Live VDP UX Review");
    expect(html).toContain("shots/issues-light.png");
    expect(html).toContain("142 UI nodes");
    expect(html).toContain("CLEAN");
  });
});
