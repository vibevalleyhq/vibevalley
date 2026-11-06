import { defineConfig } from "vite-plus";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
  // The types other packages check against (package.json's exports.
  pack: {
    entry: ["src/index.ts", "src/testing.ts", "src/socket.ts"],
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
