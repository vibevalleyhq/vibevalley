import { defineConfig } from "@playwright/test";

// Each worker runs its own server (test/fixtures.ts) with a temporary home; the page is the built dist/.
export default defineConfig({
  testDir: "test",
  timeout: 60_000,
  outputDir: "test-results",
  reporter: "list",
  globalSetup: "./test/global-setup.ts",
  // On CI a failed test keeps its trace (the page's console and network), as the runner is gone afterwards.
  use: { viewport: { width: 1280, height: 800 }, locale: "zh-CN", trace: process.env.CI ? "retain-on-failure" : "off" },
});
