import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  pack: {
    entry: [
      "src/moss.ts",
      "src/moss/server.ts",
      "src/agora/server.ts",
      "src/agora/captions.ts",
      "src/transcription.ts",
      "src/deepseek/models.ts",
      "src/deepseek/request.ts",
      "src/deepseek/response.ts",
      "src/deepseek/server.ts",
    ],
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
