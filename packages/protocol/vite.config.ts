import { defineConfig } from "vite-plus";

import pkg from "./package.json" with { type: "json" };

// The rules read local times of day (schedules, the patrol) and their tests are written at UTC+8: every machine,
// CI included, runs the tests there.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], env: { TZ: "Asia/Shanghai" } },
  pack: {
    entry: Object.values(pkg.exports).map((e) => e.default),
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
