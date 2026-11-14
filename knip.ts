/**
 * What is dead: files nothing reaches, exports nothing imports, dependencies nothing uses (`vp run deadcode`, through
 * scripts/audit/deadcode.ts, which says what to do about each). A file is alive when an entry reaches it. knip finds most
 * entries itself (package.json's scripts, the Vite, Vitest and Playwright configs); the ones listed below are run some
 * other way: scripts by vpx, the site's documents by its prerender. A package's exports are entries too, and
 * includeEntryExports reports the ones no other workspace imports: the packages are ours, nobody outside uses them. An
 * app's entries keep theirs: a config's default export is read by its tool.
 */

import type { KnipConfig } from "knip";

const config: KnipConfig = {
  // A type its own file uses is the shape of something exported (a component's props, a function's options): it is
  // exported for the reader of that signature. A type nothing uses, in its file or elsewhere, is still reported.
  ignoreExportsUsedInFile: { interface: true, type: true },
  workspaces: {
    ".": {
      entry: ["scripts/*/*.ts"],
      project: ["scripts/**/*.ts"],
    },
    "apps/site": {
      // scripts/images.ts reads the scene exports through Vite's ssrLoadModule.
      entry: ["src/{App,Document}.tsx", "src/base/scene.ts", "scripts/*.ts", "test/**/*.ts", "test/prerender/fixture/{App,Document}.tsx"],
      project: ["src/**/*.{ts,tsx}", "scripts/**/*.ts", "test/**/*.{ts,tsx}"],
      // Imported by src/ui/global.css (@import "tailwindcss"), which knip does not read.
      ignoreDependencies: ["tailwindcss"],
    },
    "packages/*": {
      project: ["src/**/*.{ts,tsx}"],
      includeEntryExports: true,
    },
    "packages/tsrs": {
      // Run by path from its shell scripts (bin/tsgolint, tsdk/tsgo), which knip does not read.
      ignoreDependencies: ["tsrs"],
    },
  },
  // Programs on the machine, not packages: Xcode's swift and Rust's cargo.
  ignoreBinaries: ["swift", "cargo"],
  // Swift, with its own tools.
  // apps/mac/ui is bundled by nsh from App.tsx and its stories, which knip does not read.
  ignoreWorkspaces: ["apps/island", "apps/mac/ui"],
};

export default config;
