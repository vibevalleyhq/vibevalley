import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

// The agent's tests start real child processes and MCP servers: a slow machine under that load needs more than 5 s.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 20_000, reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  // The types other packages check against (package.json's exports.
  pack: {
    entry: [
      "src/brain.ts",
      "src/coding.ts",
      "src/core/errors.ts",
      "src/core/loop.ts",
      "src/core/tool.ts",
      "src/dag.ts",
      "src/mcp.ts",
      "src/mcpTransport.ts",
      "src/memory.ts",
      "src/messages.ts",
      "src/self.ts",
      "src/session.ts",
      "src/testing.ts",
      "src/todo.ts",
      "src/todoStore.ts",
    ],
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
