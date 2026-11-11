import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import solid from "@solidjs/vite-plugin";
import stylex from "@stylexjs/unplugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, lazyPlugins } from "vite-plus";
import type { Plugin } from "vite-plus";

// The bar's words in every language, from the catalogs: the bar shows before any script of the page, so it cannot call t().
const openingKeys = {
  name: "web.opening.name",
  waking: "web.opening.waking",
  label: "web.opening.label",
  cannotStart: "web.opening.cannotStart",
  starting: "web.opening.starting",
  connecting: "web.opening.connecting",
  reading: "web.opening.reading",
  loading: "web.opening.loading",
  ready: "web.opening.ready",
  waiting: "web.opening.waiting",
  failed: "web.opening.failed",
  updating: "web.opening.updating",
  stopping: "web.opening.stopping",
  swapping: "web.opening.swapping",
  kept: "web.opening.kept",
  keptNewFarm: "web.opening.keptNewFarm",
  updateFailed: "web.opening.updateFailed",
  download: "web.opening.download",
} as const;
const openingWords = () => {
  const locales = join(import.meta.dirname, "../../packages/i18n/locales");
  const words: Record<string, Record<string, string>> = {};
  for (const locale of readdirSync(locales)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the locales' own files, checked by scripts/i18n.ts
    const catalog = JSON.parse(readFileSync(join(locales, locale, "web.json"), "utf8")) as { opening: Record<string, string> };
    words[locale] = Object.fromEntries(Object.entries(openingKeys).map(([name, key]) => [name, catalog.opening[key.slice("web.opening.".length)] ?? ""]));
  }
  return JSON.stringify(words);
};
const withOpeningWords = (html: string) => {
  if (!html.includes('"__OPENING_WORDS__"')) throw new Error("opening: public/opening.html needs the words' marker");
  return html.replace('"__OPENING_WORDS__"', openingWords());
};

// index.html starts on the bar public/opening.html shows (its comment says why).
const opening = (): Plugin => ({
  name: "vibevalley-opening",
  transformIndexHtml(html) {
    const source = readFileSync(join(import.meta.dirname, "public/opening.html"), "utf8");
    const part = /<!-- opening -->([\s\S]*?)<!-- \/opening -->/u.exec(source)?.[1];
    if (part === undefined || !html.includes("<!-- opening -->")) throw new Error("opening: public/opening.html and index.html each need the opening marker");
    return html.replace("<!-- opening -->", withOpeningWords(part.trim()));
  },
  writeBundle(options) {
    const file = join(options.dir ?? join(import.meta.dirname, "dist"), "opening.html");
    writeFileSync(file, withOpeningWords(readFileSync(file, "utf8")));
  },
});

// In a browser tab (vite dev) the API is the server on its usual port; served by the server, it is the same origin.
export default defineConfig({
  // A worker is an ES module, so its own dynamic imports split into chunks (ui/code: one per language) instead of being
  // inlined into it.
  worker: { format: "es" },
  plugins:
    lazyPlugins(() => [
      stylex.vite({
        useCSSLayers: { before: ["theme", "base", "components", "utilities"], after: [], prefix: "stylex" },
        sxPropName: false,
        aliases: { "#/*": [join(import.meta.dirname, "src/*")] },
      }),
      tailwindcss(),
      solid(),
      opening(),
    ]) ?? [],
  server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
  // *.test.ts runs without a DOM; Playwright alone collects *.spec.ts.
  test: { include: ["src/**/*.test.ts", "test/**/*.test.ts"], environment: "node" },
  run: {
    tasks: {
      test: "vp test run",
      build: { command: "vp build", cache: { input: [{ auto: true }, "!node_modules", "!node_modules/.vite-temp/**"] } },
      // The stories (vite.stories.config.ts), built beside the page so a story that no longer compiles fails the check.
      "build:stories": {
        command: "vp build --config vite.stories.config.ts",
        cache: { input: [{ auto: true }, "!node_modules", "!node_modules/.vite-temp/**"] },
      },
    },
  },
});
