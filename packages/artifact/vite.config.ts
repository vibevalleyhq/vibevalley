import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"], reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  pack: {
    entry: ["src/index.ts", "src/blocks.ts", "src/editor.ts", "src/html.ts", "src/markdown.ts", "src/ops.ts"],
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
