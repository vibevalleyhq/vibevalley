import { defineConfig } from "vite-plus";

// The whole app under Playwright: it loads the page from apps/web/dist, so the page is built first. Not cached: it
// starts Electron and a real server.
export default defineConfig({
  run: { tasks: { e2e: { command: ["vpx scripts/build.ts", "playwright test"], dependsOn: ["vibevalley-web#build"], cache: false } } },
});
