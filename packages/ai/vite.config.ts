import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  // The types other packages check against (package.json's exports.
  pack: {
    entry: [
      "src/llm/client.ts",
      "src/llm/llm.ts",
      "src/base/messages.ts",
      "src/base/models.ts",
      "src/llm/response.ts",
      "src/testing/testing.ts",
      "src/base/tools.ts",
      "src/audio/audio.ts",
      "src/audio/transcription.ts",
      "src/realtime/moss.ts",
      "src/realtime/turns.ts",
      "src/realtime/moss-session.ts",
      "src/realtime/playback.ts",
    ],
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: {
    tasks: {
      build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } },
      test: { command: "vp test run" },
    },
  },
});
