import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

// The agent's tests start real child processes and MCP servers: a slow machine under that load needs more than 5 s.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], testTimeout: 20_000, reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"] },
  // The types other packages check against (package.json's exports.
  pack: {
    entry: [
      "src/brain/brain.ts",
      "src/tools/coding.ts",
      "src/core/errors.ts",
      "src/core/loop.ts",
      "src/core/tool.ts",
      "src/base/dag.ts",
      "src/infra/mcp.ts",
      "src/infra/mcpTransport.ts",
      "src/tools/memory.ts",
      "src/base/messages.ts",
      "src/tools/self.ts",
      "src/brain/session.ts",
      "src/tools/skills.ts",
      "src/testing/testing.ts",
      "src/tools/todo.ts",
      "src/tools/todoStore.ts",
    ],
    outDir: "dist",
    clean: true,
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
