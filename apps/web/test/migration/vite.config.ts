import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import solid from "@solidjs/vite-plugin";
import stylex from "@stylexjs/unplugin";
import { defineConfig } from "vite-plus";

const host = process.env.VIBEVALLEY_MIGRATION_HOST ?? resolve(import.meta.dirname, "../../../..");
const output = process.env.VIBEVALLEY_MIGRATION_OUTPUT ?? resolve(host, ".test/style-migration/viewer-candidate");

export default defineConfig(async () => {
  const legacyPath = process.env.VIBEVALLEY_MIGRATION_LEGACY_PLUGIN;
  const candidate = resolve(import.meta.dirname, "../../../..");
  if (host !== candidate && legacyPath === undefined) throw new Error("The original viewer requires its baseline-owned compiler plugin");
  if (host === candidate && legacyPath !== undefined) throw new Error("The candidate viewer must not load the original compiler");
  // The original compiler exists only in the user-selected baseline worktree, not in candidate dependencies.
  const legacy = legacyPath === undefined ? [] : [(await import(pathToFileURL(legacyPath).href)).default()];
  return {
    root: import.meta.dirname,
    publicDir: resolve(host, "apps/web/public"),
    resolve: {
      dedupe: ["solid-js", "@solidjs/web"],
      alias: [
        { find: /^@vibevalley\/stories$/u, replacement: resolve(host, "packages/stories/src/index.ts") },
        { find: /^@vibevalley\/stories\/style\.css$/u, replacement: resolve(host, "packages/stories/src/StoriesApp.css") },
        { find: "virtual:viewer-host.css", replacement: resolve(host, "apps/web/src/stories.css") },
      ],
    },
    plugins: [
      stylex.vite({
        useCSSLayers: { before: ["theme", "base", "components"], after: ["utilities"], prefix: "stylex" },
        sxPropName: false,
        aliases: { "#/*": [resolve(host, "apps/web/src/*")] },
      }),
      solid(),
      ...legacy,
    ],
    build: { outDir: output, emptyOutDir: true },
  };
});
