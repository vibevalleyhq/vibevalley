import { defineConfig } from "vite-plus";

// The tests run the command line against a whole farm in the process (@vibevalley/server/testing), with real git: a slow machine needs more than 5 s.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 30_000, env: { TZ: "Asia/Shanghai" } },
  // The packaged app's command line (apps/desktop/scripts/package.ts): src/main.ts and everything it uses in one module for Node 24.
  pack: {
    entry: ["src/main.ts", "src/worker.ts"],
    format: "esm",
    platform: "node",
    target: "node24",
    outDir: "dist",
    clean: true,
    dts: false,
    deps: { alwaysBundle: [/./u] },
  },
  run: {
    tasks: {
      build: { command: "vp pack", cache: { input: [{ auto: true }, "!node_modules", "!dist/**"] } },
      test: { command: "vp test run", cache: { env: ["VIBEVALLEY_GOLDEN"] } },
    },
  },
});
