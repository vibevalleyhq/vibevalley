import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  // The types other packages check against (package.json's exports.
  pack: {
    entry: ["src/index.ts", "src/core.ts", "src/agora.ts", "src/captions.ts", "src/moss.ts", "src/moss-server.ts", "src/transcribe.ts"],
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: {
    tasks: {
      build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } },
      test: "vp test run",
    },
  },
});
