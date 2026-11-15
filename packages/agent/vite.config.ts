import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

import pkg from "./package.json" with { type: "json" };

// The agent's tests start real MCP servers as child processes: a slow machine under that load needs more than 5 s.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 20_000, reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  pack: { entry: Object.values(pkg.exports).map((e) => e.default), fixedExtension: false, dts: { sourcemap: true, emitDtsOnly: true } },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
