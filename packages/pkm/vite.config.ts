import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  pack: {
    entry: [
      "src/index.ts",
      "src/days.ts",
      "src/editing.ts",
      "src/graph.ts",
      "src/markdown.ts",
      "src/para.ts",
      "src/selection.ts",
      "src/view.ts",
      "src/writer.ts",
    ],
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
