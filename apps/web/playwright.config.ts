import { defineConfig } from "@playwright/test";

// Each worker runs its own server (test/fixtures.ts) with a temporary home; the page is the built dist/.
export default defineConfig({
  testDir: "test",
  timeout: 60_000,
  outputDir: "test-results",
  reporter: "list",
  globalSetup: "./test/global-setup.ts",
  use: { viewport: { width: 1280, height: 800 }, locale: "zh-CN" },
});
