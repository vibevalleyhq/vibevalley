import { defineConfig } from "vite-plus";

// The rules read local times of day (schedules, the patrol) and the golden data was recorded at UTC+8: every machine,
// CI included, runs the tests there.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], env: { TZ: "Asia/Shanghai" } },
  // The types other packages check against (package.json's exports: types is dist/, default the source every run
  // compiles), with maps back to the source for the editor.
  pack: {
    entry: ["src/index.ts", "src/rules/index.ts", "src/schema.ts", "src/api.ts", "src/rpc.ts", "src/host.ts"],
    format: "esm",
    platform: "neutral",
    outDir: "dist",
    clean: true,
    dts: { sourcemap: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
