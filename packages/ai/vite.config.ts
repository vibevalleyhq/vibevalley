import { defineConfig } from "vite-plus";

// VIBEVALLEY_GOLDEN=update makes a run write the golden data (vp run golden:update -- ai): a run with it set never
// replays one without.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"] },
  run: { tasks: { test: { command: "vp test run", cache: { env: ["VIBEVALLEY_GOLDEN"] } } } },
});
