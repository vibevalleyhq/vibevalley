import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
  // The types other packages check against (package.json's exports: types is dist/, default the source every run
  // compiles), declarations only, with maps back to the source for the editor.
  pack: {
    entry: ["src/budgets.ts", "src/golden.ts", "src/pyramid.ts", "src/source.ts", "src/temp.ts", "src/until.ts"],
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
