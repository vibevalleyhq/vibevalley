import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "pages.spec.ts",
  workers: 1,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "../../.test/production/results.json" }]],
  outputDir: "../../.test/production/artifacts",
  use: { browserName: "chromium", trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" } },
    { name: "mobile-reduced", use: { viewport: { width: 390, height: 900 }, reducedMotion: "reduce" } },
  ],
});
