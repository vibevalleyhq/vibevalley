import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "pages.spec.ts",
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "../../.test/prerender/results.json" }]],
  outputDir: "../../.test/prerender/artifacts",
  use: { browserName: "chromium", viewport: { width: 1000, height: 700 }, trace: "retain-on-failure" },
});
