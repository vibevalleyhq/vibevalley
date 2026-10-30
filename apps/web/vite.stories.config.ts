import { defineConfig, lazyPlugins } from "vite-plus";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { renameSync } from "node:fs";
import { join } from "node:path";
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
  writeBundle(options) {
    const dir = options.dir ?? join(import.meta.dirname, "dist-stories");
    renameSync(join(dir, "stories.html"), join(dir, "index.html"));
  },
});

export default defineConfig({
  worker: { format: "es" },
  resolve: { tsconfigPaths: true },
  plugins: lazyPlugins(() => [solid(), tailwindcss(), atRoot()]) ?? [],
  build: { outDir: "dist-stories", rollupOptions: { input: join(import.meta.dirname, "stories.html") } },
});
