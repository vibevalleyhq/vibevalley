import { describe, expect, it } from "vite-plus/test";

import { buildStepPlan, parseGalleryArgs, parseScenarioMatrixStdout, validateDumpAndShots } from "./ui-gallery.ts";

describe("ui-gallery", () => {
  it("parses default options and custom flags cleanly", () => {
    expect(parseGalleryArgs([], "/repo")).toEqual({
      outDir: "/tmp/vv-ui-report",
      skipBuild: false,
      scenarios: ["typical", "edge"],
    });
    expect(parseGalleryArgs(["--out", "artifacts/ui", "--skip-build", "--scenarios=edge"], "/repo")).toEqual({
      outDir: "/repo/artifacts/ui",
      skipBuild: true,
      scenarios: ["edge"],
    });
    expect(() => parseGalleryArgs(["--scenarios=unknown"], "/repo")).toThrow(/unsupported gallery scenario/u);
  });

  it("builds deterministic script steps ending with quit and expected shot paths", () => {
    const plan = buildStepPlan("typical", "/tmp/out/shots");
    expect(plan.expectedShots).toContain("/tmp/out/shots/typical-issues-light.png");
    expect(plan.expectedShots).toContain("/tmp/out/shots/typical-whiteboard-light.png");
    expect(plan.expectedShots).toContain("/tmp/out/shots/typical-whiteboard-dark.png");
    expect(plan.expectedShots).toContain("/tmp/out/shots/typical-workspace-dark.png");
    expect(plan.expectedShots).toContain("/tmp/out/shots/typical-farm.png");
    expect(plan.steps.at(-1)).toBe('{"shell":"quit"}');

    const edgePlan = buildStepPlan("edge", "/tmp/out/shots");
    expect(edgePlan.expectedShots).toEqual([
      "/tmp/out/shots/edge-issues-light.png",
      "/tmp/out/shots/edge-issues-dark.png",
      "/tmp/out/shots/edge-library-light.png",
    ]);
  });

  it("validates dump readiness, error lists, and non-empty PNG outputs", () => {
    const shots = ["/tmp/out/shots/typical-issues-light.png", "/tmp/out/shots/typical-workspace-dark.png"];
    const cleanDump = {
      loaded: true,
      load_error: null,
      sidebar: { ready: true, errors: [] },
      workbench: { ready: true, errors: [] },
      palette: null,
      projects: [{ tabs: [{ hosted: { ready: true, errors: [] } }] }],
    };
    expect(validateDumpAndShots("typical", cleanDump, shots, () => 4096)).toEqual([]);

    const brokenDump = {
      loaded: false,
      load_error: "bundle missing",
      sidebar: { errors: ["sidebar init failed"] },
      workbench: { errors: ["uncaught render error"] },
      palette: { view: { errors: ["palette error"] } },
      projects: [{ tabs: [{ hosted: { errors: ["pane error"] } }] }],
    };
    const problems = validateDumpAndShots("typical", brokenDump, shots, (p) => (p.endsWith("light.png") ? 0 : null));
    expect(problems).toHaveLength(8);
    expect(problems.join("\n")).toContain("shell.loaded is false");
    expect(problems.join("\n")).toContain("pane error");
    expect(problems.join("\n")).toContain("missing or empty screenshot");
  });

  it("extracts @@SCENARIO_MATRIX JSON line from scenarios test output", () => {
    const out = ["ok", '@@SCENARIO_MATRIX [{"density":"typical","stepsPassed":9}]', "done"].join("\n");
    expect(parseScenarioMatrixStdout(out)).toBe('[{"density":"typical","stepsPassed":9}]');
    expect(parseScenarioMatrixStdout("no matrix line")).toBeNull();
  });
});
