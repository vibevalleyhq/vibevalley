import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  // The types other packages check against (package.json's exports.
  pack: {
    entry: [
      "src/client.ts",
      "src/llm.ts",
      "src/messages.ts",
      "src/models.ts",
      "src/response.ts",
      "src/testing.ts",
      "src/tools.ts",
      "src/audio.ts",
      "src/transcription.ts",
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
