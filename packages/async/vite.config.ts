import { defineConfig } from "vite-plus";

import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
  pack: { entry: Object.values(pkg.exports).map((e) => e.default), fixedExtension: false, dts: { sourcemap: true, emitDtsOnly: true } },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
