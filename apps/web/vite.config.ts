import { defineConfig, lazyPlugins } from "vite-plus";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite-plus";

// The bar's words in every language, from the catalogs: the bar shows before any script of the page, so it cannot call
// t(). Named here so that scripts/i18n.ts check counts them as used.
const openingKeys = { waking: "web.opening.waking", label: "web.opening.label", cannotStart: "web.opening.cannotStart" } as const;
const openingWords = () => {
  const locales = join(import.meta.dirname, "../../packages/i18n/locales");
  const words: Record<string, Record<string, string>> = {};
  for (const locale of readdirSync(locales)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the locales' own files, checked by scripts/i18n.ts
    const catalog = JSON.parse(readFileSync(join(locales, locale, "web.json"), "utf8")) as { opening: Record<string, string> };
    words[locale] = Object.fromEntries(Object.entries(openingKeys).map(([name, key]) => [name, catalog.opening[key.slice("web.opening.".length)]!]));
  }
  return JSON.stringify(words);
};
const withOpeningWords = (html: string) => {
  if (!html.includes('"__OPENING_WORDS__"')) throw new Error("opening: public/opening.html needs the words' marker");
  return html.replace('"__OPENING_WORDS__"', openingWords());
};

// index.html starts on the bar public/opening.html shows (its comment says why): the part between its markers, written
// where index.html has the opening marker, so that the two cannot drift apart. The desktop app loads opening.html itself
// from the build, so the copy there gets its words too.
const opening = (): Plugin => ({
  name: "vibevalley-opening",
  transformIndexHtml(html) {
    const source = readFileSync(join(import.meta.dirname, "public/opening.html"), "utf8");
    const part = /<!-- opening -->([\s\S]*?)<!-- \/opening -->/.exec(source)?.[1];
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
  // @/ is src/, as tsconfig.json says.
  resolve: { tsconfigPaths: true },
  plugins: lazyPlugins(() => [solid(), tailwindcss(), opening()]) ?? [],
  server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
  // The rules' tests, pure, without a DOM (the Solid plugin would give them jsdom); test/ is Playwright's.
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  // test: the rules' tests; e2e (package.json) is Playwright against real servers, not cached. The build's input leaves
  // out the listing of this package's node_modules (only links into the root's .pnpm, whose files stay tracked) and
  // .vite-temp, where Vite writes its bundled config and removes it: else the cache misses whenever that folder comes
  // or goes, as on CI's fresh checkout.
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
