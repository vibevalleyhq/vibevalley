import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

// The agent's tests start real child processes and MCP servers: a slow machine under that load needs more than 5 s.
// budgets prints the test pyramid's shape, as the server's run does.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 20_000, reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  run: { tasks: { test: "vp test run" } },
});
