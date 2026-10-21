import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test",
  timeout: 90_000,
  outputDir: "test-results",
  reporter: "list",
});
