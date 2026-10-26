import { defineConfig } from "vite-plus";

// Tests run real git and a database in every file at once: a slow machine under that load needs more than 5 s.
// The rules read the owner's local clock (reset times, night and weekend achievements) and the golden data was
// recorded at UTC+8: every machine, CI included, runs the tests there.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 20_000, env: { TZ: "Asia/Shanghai" } },
  run: { tasks: { test: "vp test run" } },
});
