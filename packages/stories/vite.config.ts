import { defineConfig } from "vite-plus";

// The tree's rules are pure; the viewer is seen through the page's stories (apps/web/test/stories.spec.ts).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  // The types other packages check against (package.json's exports.
  pack: { entry: ["src/index.ts"], outDir: "dist", clean: true, fixedExtension: false, dts: { sourcemap: true, emitDtsOnly: true } },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
