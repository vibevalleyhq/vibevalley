import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";

import type { VdpDriver } from "../release/vdp-client.ts";
import { defineScenario, renderScenarioGalleryHtml, runScenarios, type VdpRpcTransport, type VdpScenarioContext, writeScenarioArtifacts } from "./dsl.ts";
import { parseVdpRunArgs } from "./run.ts";
import { listScenarios, SCENARIOS } from "./scenarios/index.ts";

interface RecordedRpcCall {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function createFakeHarness(
  outDir: string,
  options?: { readonly shellErrors?: readonly string[] },
): {
  readonly transport: VdpRpcTransport;
  readonly driver: VdpDriver;
  readonly rpcCalls: RecordedRpcCall[];
} {
  const rpcCalls: RecordedRpcCall[] = [];
  let route = "/";
  let dark = false;

  const transport: VdpRpcTransport = {
    async call(method, params = {}) {
      rpcCalls.push({ method, params });
      if (method === "Server.invoke") {
        const rpcMethod = typeof params.method === "string" ? params.method : "";
        if (rpcMethod === "note.create") {
          return { bizCode: 0, message: "ok", data: { id: "n_created", title: "Demo" } };
        }
        if (rpcMethod === "fail.method") {
          return { bizCode: 4001, message: "invalid payload" };
        }
        return { bizCode: 0, message: "ok", data: {} };
      }
      return { ok: true };
    },
    async callDecoded<T>(method: string, params: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
      const val = await transport.call(method, params);
      return schema.parse(val);
    },
  };

  const driver: VdpDriver = {
    async navigate(next) {
      route = next;
    },
    async resize() {},
    async setTheme(theme) {
      dark = theme === "dark";
    },
    async getState() {
      return {
        loaded: true,
        load_error: null,
        route,
        theme_dark: dark,
        workbench: { ready: true, errors: [...(options?.shellErrors ?? [])] },
      };
    },
    async getMetrics() {
      return { width: 1440, height: 900, scaleFactor: 2, themeDark: dark, lastFrameMs: 4.2 };
    },
    async uiQuery(query) {
      if (query.testId === "box-with-bounds") {
        return {
          view: "workbench",
          route,
          count: 1,
          nodes: [{ testId: "box-with-bounds", role: "button", bounds: { x: 100, y: 200, width: 80, height: 40 } }],
        };
      }
      if (query.testId === "box-no-bounds") {
        return {
          view: "workbench",
          route,
          count: 1,
          nodes: [{ testId: "box-no-bounds", role: "button" }],
        };
      }
      if (query.testId === "route:current") {
        return {
          view: "workbench",
          route,
          count: 1,
          nodes: [{ testId: "route:current", role: "route", text: route, route }],
        };
      }
      return { view: "workbench", route, count: 0, nodes: [] };
    },
    async uiPress() {
      return { pressed: true };
    },
    async uiWaitFor(wait) {
      return { found: true, node: { testId: wait.testId ?? "ok", role: "region" } };
    },
    async uiGetTree() {
      return { view: "workbench", route, nodes: [{ testId: "root", children: [{ testId: "leaf" }] }] };
    },
    async captureScreenshot(outPath) {
      writeFileSync(outPath, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
      return { path: outPath, mime: "image/png", width: 1440, height: 900, bytes: 8 };
    },
    async settle() {},
  };

  expect(outDir.length).toBeGreaterThan(0);
  return { transport, driver, rpcCalls };
}

describe("vdp TS embedded DSL", () => {
  it("unwraps Server.invoke envelopes, resolves clickTestId centers, and records shots", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "vv-vdp-dsl-test-"));
    try {
      const { transport, driver, rpcCalls } = createFakeHarness(outDir);
      const scenario = defineScenario({
        id: "demo",
        description: "Demo scenario",
        async run(v: VdpScenarioContext) {
          const created = await v.rpc("note.create", { title: "Demo", noteType: "doc" }, z.object({ id: z.string(), title: z.string() }));
          expect(created.id).toBe("n_created");

          const clicked = await v.clickTestId("box-with-bounds", { offsetX: 5, offsetY: -4 });
          expect(clicked).toEqual({
            x: 145,
            y: 216,
            bounds: { x: 100, y: 200, width: 80, height: 40 },
          });

          await expect(v.clickTestId("box-no-bounds")).rejects.toThrow(/none with bounds/u);
          await expect(v.rpc("fail.method", {})).rejects.toThrow(/bizCode=4001/u);

          await v.forThemes(["light", "dark"], async (theme) => {
            await v.nav(`/notes/${created.id}`);
            expect(await v.waitRoute(`/notes/${created.id}`)).toBe(`/notes/${created.id}`);
            await v.wait("note-block-doc-view");
            await v.assertPresent("box-with-bounds", 1);
            await v.assertClean(`clean-${theme}`);
            await v.shot(`doc_${theme}`, { label: `Doc (${theme})`, settleMs: 0 });
          });
        },
      });

      const manifest = await runScenarios([scenario], {
        transport,
        driver,
        outDir,
        mode: "sandbox",
        themes: ["light", "dark"],
        viewport: { width: 1440, height: 900 },
      });

      expect(manifest.summary.allPassed).toBe(true);
      expect(manifest.summary.totalShots).toBe(2);
      expect(manifest.summary.totalChecks).toBe(4);
      expect(rpcCalls.some((c) => c.method === "Input.dispatchMouse" && c.params.x === 145 && c.params.y === 216)).toBe(true);

      const { manifestPath, htmlPath } = writeScenarioArtifacts(outDir, manifest);
      const html = renderScenarioGalleryHtml(manifest);
      expect(html).toContain("doc_light.png");
      expect(html).toContain("doc_dark.png");
      expect(readFileSync(manifestPath, "utf8")).toContain('"allPassed": true');
      expect(readFileSync(htmlPath, "utf8")).toContain("VibeValley VDP Scenario Report");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("marks scenarios failed when shell errors are present", async () => {
    const outDir = mkdtempSync(join(tmpdir(), "vv-vdp-dsl-err-"));
    try {
      const { transport, driver } = createFakeHarness(outDir, { shellErrors: ["workbench: uncaught error"] });
      const scenario = defineScenario({
        id: "broken",
        description: "Detects shell error",
        async run(v) {
          await v.assertClean("broken-check");
        },
      });
      const manifest = await runScenarios([scenario], {
        transport,
        driver,
        outDir,
        mode: "attached",
        themes: ["light"],
        viewport: { width: 1280, height: 800 },
      });
      expect(manifest.summary.allPassed).toBe(false);
      expect(manifest.scenarios[0]?.passed).toBe(false);
      expect(manifest.scenarios[0]?.error).toContain("uncaught error");
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it("parses run CLI flags including --ui-only, --skip-build, --themes, and --attach", () => {
    const uiOnly = parseVdpRunArgs(["note", "--ui-only", "--themes", "dark", "--width=1280", "--height=720", "--out", "/tmp/x"], "/repo");
    expect(uiOnly.scenarioIds).toEqual(["note"]);
    expect(uiOnly.buildMode).toBe("ui-only");
    expect(uiOnly.themes).toEqual(["dark"]);
    expect(uiOnly.width).toBe(1280);
    expect(uiOnly.height).toBe(720);
    expect(uiOnly.outDir).toBe("/tmp/x");

    const attached = parseVdpRunArgs(["all", "--attach", "/tmp/sandbox", "--skip-build", "--list"], "/repo");
    expect(attached.scenarioIds).toEqual(["all"]);
    expect(attached.buildMode).toBe("skip-build");
    expect(attached.attach).toBe("/tmp/sandbox");
    expect(attached.list).toBe(true);

    const ids = listScenarios().map((s) => s.id);
    expect(ids).toEqual(["note", "doc-editor", "issues", "chat", "library", "dashboard", "settings", "agent-play"]);
    for (const id of ids) {
      expect(SCENARIOS[id]?.id).toBe(id);
    }
  });
});
