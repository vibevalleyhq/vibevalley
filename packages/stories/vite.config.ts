import { defineConfig } from "vite-plus";

// The tree's rules are pure; the viewer is seen through the page's stories (apps/web/test/stories.spec.ts).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  run: { tasks: { test: "vp test run" } },
});
