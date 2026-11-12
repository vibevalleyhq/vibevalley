import { fileURLToPath } from "node:url";

import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins } from "vite-plus";

export default defineConfig({
  plugins: lazyPlugins(() => [tailwindcss(), solid({ ssr: true, start: { renderMode: "async" } })]) ?? [],
  resolve: { alias: { "@game": fileURLToPath(new URL("../web/public", import.meta.url)) } },
  build: { assetsInlineLimit: 0 },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
  run: {
    tasks: {
      check: { command: "vp run assets && vp run test", cache: false },
      build: { command: "vp run assets && vpx scripts/build.ts", cache: false },
      "test:prerender": { command: "playwright test --config test/prerender/playwright.config.ts", cache: false },
      "test:production": { command: "vp run build && playwright test --config test/production/playwright.config.ts", cache: false },
      test: "vp test run",
    },
  },
});
