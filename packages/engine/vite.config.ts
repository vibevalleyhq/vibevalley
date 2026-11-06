import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  // The types other packages check against (package.json's exports.
  pack: {
    entry: ["src/pixi/index.ts", "src/nav/index.ts", "src/audio/index.ts", "src/clock.ts", "src/framing.ts"],
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
