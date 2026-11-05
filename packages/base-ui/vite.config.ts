import solid from "@solidjs/vite-plugin";
import { defineConfig, lazyPlugins } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

// The components' tests run in headless Chromium: a real <dialog> top layer, focus, keyboard and layout, which a fake
// DOM does not have. Behaviour, focus and ARIA are tested here; how it looks is the app's.
export default defineConfig({
  plugins: lazyPlugins(() => [solid()]),
  // Bundled before the first test: found mid-run, Vite reloads the page and the run fails on a cold cache (as on CI).
  optimizeDeps: { include: ["solid-js", "@solidjs/web", "@floating-ui/dom", "axe-core"] },
  test: {
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: "chromium" }] },
  },
  // The types other packages check against (package.json's exports: types is dist/, default the source every run
  // compiles), declarations only, with maps back to the source for the editor.
  pack: { entry: ["src/index.ts"], outDir: "dist", clean: true, fixedExtension: false, dts: { sourcemap: true, emitDtsOnly: true } },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
