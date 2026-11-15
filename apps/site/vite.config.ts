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
      assets: {
        command: "vpx scripts/prepare.ts",
        cache: { input: [{ auto: true }, "../web/public/**", "../../docs/images/**", "!src/base/images.generated.json", "!public/gen/**"] },
      },
      check: { command: "vp test run", dependsOn: ["assets"] },
      build: {
        command: "vpx scripts/build.ts",
        dependsOn: ["assets"],
        cache: { input: [{ auto: true }, "!dist/**", "!node_modules/**"], output: ["dist/**"] },
      },
      "test:prerender": { command: "playwright test --config test/prerender/playwright.config.ts", cache: false },
      "test:production": { command: "playwright test --config test/production/playwright.config.ts", dependsOn: ["build"], cache: false },
    },
  },
});
