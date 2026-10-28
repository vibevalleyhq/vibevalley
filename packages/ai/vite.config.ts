import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

// VIBEVALLEY_GOLDEN=update makes a run write the golden data (vp run golden:update -- ai): a run with it set never
// replays one without. budgets prints the test pyramid's shape, as the server's run does.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  run: { tasks: { test: { command: "vp test run", cache: { env: ["VIBEVALLEY_GOLDEN"] } } } },
});
