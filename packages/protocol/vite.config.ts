import { defineConfig } from "vite-plus";

// The rules read local times of day (schedules, the patrol) and their tests are written at UTC+8: every machine,
// CI included, runs the tests there.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], env: { TZ: "Asia/Shanghai" } },
  // The types other packages check against (package.json's exports.
  pack: {
    entry: ["src/index.ts", "src/rules/index.ts", "src/schema.ts", "src/api.ts", "src/rpc.ts", "src/host.ts"],
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
