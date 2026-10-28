import { defineConfig, lazyPlugins } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";
import solid from "@solidjs/vite-plugin";

// The components' tests run in headless Chromium: a real <dialog> top layer, focus, keyboard and layout, which a fake
// DOM does not have. Behaviour, focus and ARIA are tested here; how it looks is the app's.
export default defineConfig({
  plugins: lazyPlugins(() => [solid()]),
  // Bundled before the first test: found mid-run, Vite reloads the page and the run fails on a cold cache (as on CI).
  optimizeDeps: { include: ["solid-js", "@solidjs/web", "@floating-ui/dom"] },
  test: {
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }] },
  },
  run: { tasks: { test: "vp test run" } },
});
