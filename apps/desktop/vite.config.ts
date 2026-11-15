import { defineConfig } from "vite-plus";

const helpers = process.platform === "darwin" ? ["@vibevalley/island#build", "@vibevalley/pty#build"] : [];

const bundle = (entry: Record<string, string>, clean: boolean) => ({
  entry,
  format: "cjs" as const,
  platform: "node" as const,
  target: "node22",
  outDir: "build",
  fixedExtension: true,
  clean,
  dts: false,
  deps: { neverBundle: ["electron"], alwaysBundle: [/^(?!electron$)/u], onlyBundle: false as const },
});

// Separate pack configs keep build/preload.cjs self-contained without shared chunks, as Electron's sandboxed preload has no filesystem require.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  pack: [bundle({ main: "src/main.ts" }, true), bundle({ preload: "src/preload/preload.ts" }, false)],
  run: {
    tasks: {
      build: {
        command: "vp pack --concurrency 1",
        dependsOn: helpers,
        cache: { input: [{ auto: true }, "!build/**", "!dist/**"] },
      },
      test: "vp test run",
      e2e: { command: "playwright test", dependsOn: ["build", "@vibevalley/web#build"], cache: false },
    },
  },
});
