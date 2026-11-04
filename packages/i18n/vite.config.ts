import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  // The types other packages check against (package.json's exports: types is dist/, default the source every run
  // compiles), with maps back to the source for the editor.
  pack: { entry: ["src/index.ts", "src/format.ts"], format: "esm", platform: "neutral", outDir: "dist", clean: true, dts: { sourcemap: true } },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
