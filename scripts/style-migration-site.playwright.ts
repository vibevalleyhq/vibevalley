import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: import.meta.dirname,
  testMatch: "style-migration-site.spec.ts",
  outputDir: "../.test/style-migration/site-motion-artifacts",
  workers: 1,
  retries: 0,
  use: { browserName: "chromium", locale: "en-US", timezoneId: "UTC", trace: "retain-on-failure" },
  projects: [
    { name: "desktop-motion", use: { viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" } },
    { name: "desktop-reduced", use: { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" } },
    { name: "mobile-motion", use: { viewport: { width: 390, height: 844 }, reducedMotion: "no-preference" } },
    { name: "mobile-reduced", use: { viewport: { width: 390, height: 844 }, reducedMotion: "reduce" } },
  ],
});
