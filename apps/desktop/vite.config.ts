import { defineConfig } from "vite-plus";

// test: the main process's rules (src/*.test.ts). e2e: the whole app under Playwright: it loads the page from
// apps/web/dist, so the page is built first. Not cached: it starts Electron and a real server.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  run: {
    tasks: {
      test: "vp test run",
      e2e: { command: ["vpx scripts/build.ts", "playwright test"], dependsOn: ["@vibevalley/web#build"], cache: false },
    },
  },
});
