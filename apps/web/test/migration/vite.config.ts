import { resolve } from "node:path";

import solid from "@solidjs/vite-plugin";
import stylex from "@stylexjs/unplugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

const host = process.env.VIBEVALLEY_MIGRATION_HOST ?? resolve(import.meta.dirname, "../../../..");
const output = process.env.VIBEVALLEY_MIGRATION_OUTPUT ?? resolve(host, ".test/style-migration/viewer-candidate");

export default defineConfig({
  root: import.meta.dirname,
  publicDir: resolve(host, "apps/web/public"),
  resolve: {
    dedupe: ["solid-js", "@solidjs/web"],
    alias: {
      "@vibevalley/stories": resolve(host, "packages/stories/src/index.ts"),
      "virtual:viewer-host.css": resolve(host, "apps/web/src/stories.css"),
    },
  },
  plugins: [
    stylex.vite({ useCSSLayers: { before: ["theme", "base", "components"], after: ["utilities"], prefix: "stylex" }, sxPropName: false }),
    solid(),
    tailwindcss(),
  ],
  build: { outDir: output, emptyOutDir: true },
});
