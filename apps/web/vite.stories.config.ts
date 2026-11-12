import { renameSync } from "node:fs";
import { join } from "node:path";

import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import type { Plugin } from "vite-plus";

// stories.html: served at / in dev and written as index.html in the build, so the folder serves like any site.
const atRoot = (): Plugin => ({
  name: "vibevalley-stories-root",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/" || req.url?.startsWith("/?") === true) req.url = `/stories.html${req.url.slice(1)}`;
      next();
    });
  },
  writeBundle: {
    order: "pre",
    sequential: true,
    handler(options) {
      const directory = options.dir ?? join(import.meta.dirname, "dist-stories");
      renameSync(join(directory, "stories.html"), join(directory, "index.html"));
    },
  },
});

export default defineConfig({
  worker: { format: "es" },
  plugins: lazyPlugins(() => [tailwindcss(), solid(), atRoot()]) ?? [],
  build: { outDir: "dist-stories", rollupOptions: { input: join(import.meta.dirname, "stories.html") } },
});
