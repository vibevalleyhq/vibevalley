/**
 * What is dead: files nothing reaches, exports nothing imports, dependencies nothing uses (`vp run deadcode`, through
 * scripts/audit/deadcode.ts, which says what to do about each). A file is alive when an entry reaches it. knip finds most
 * entries itself (package.json's scripts, index.html, the Vite, Vitest, Playwright and Expo configs); the ones listed
 * below are run some other way: scripts by vpx, the stories' page, the desktop shell's main and preload. A package's
 * exports are entries too, and includeEntryExports reports the ones no other workspace imports: the packages are ours,
 * nobody outside uses them. An app's entries keep theirs: a config's default export is read by its tool.
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
      // Named by tools, not imports: effect-tsgo runs in vite.config.ts's effect:check, effect is the version it checks
      // against, tsconfig.base.json names the editor plugin @effect/language-service, and lightningcss/parse5 stay in the
      // root catalog until the next lockfile prune.
      ignoreDependencies: ["@effect/tsgo", "effect", "@effect/language-service", "lightningcss", "parse5"],
    },
    "apps/server": {
      // main.ts and chat.ts run through vpx (`vp run start`, `vp run chat`, the desktop app and the e2e), which knip does
      // not read in a script; both are the pack block's entries, and chat.ts is what the command line runs.
      entry: ["scripts/*.ts", "src/main.ts", "src/chat/main.ts"],
      project: ["src/**/*.ts", "scripts/**/*.ts"],
    },
    "apps/cli": {
      // main.ts runs through vpx (`vp run start`, the acceptance sandbox) and is the pack block's entry.
      // Session launches worker.ts directly; the desktop package includes its standalone worker.mjs bundle.
      entry: ["src/main.ts", "src/worker.ts"],
      project: ["src/**/*.ts"],
    },
    "apps/web": {
      entry: ["index.html", "stories.html", "src/stories.tsx", "vite.stories.config.ts", "test/**/*.ts"],
      project: ["src/**/*.{ts,tsx}", "test/**/*.ts"],
      // Imported by src/style.css (@import "tailwindcss/…"), which knip does not read.
      ignoreDependencies: ["tailwindcss"],
    },
    "apps/site": {
      // scripts/images.ts reads the scene exports through Vite's ssrLoadModule.
      entry: ["src/{App,Document}.tsx", "src/base/scene.ts", "scripts/*.ts", "test/**/*.ts", "test/prerender/fixture/{App,Document}.tsx"],
      project: ["src/**/*.{ts,tsx}", "scripts/**/*.ts", "test/**/*.{ts,tsx}"],
      // Imported by the site's stylesheet once it is on Tailwind (vv-tailwind); knip does not read CSS either way.
      ignoreDependencies: ["tailwindcss"],
    },
    "apps/desktop": {
      entry: ["src/main.ts", "src/preload/preload.ts", "scripts/*.ts", "test/**/*.ts"],
      project: ["src/**/*.ts", "scripts/**/*.ts", "test/**/*.ts"],
    },
    "apps/mobile": {
      entry: ["scripts/*.ts"],
      project: ["*.{ts,tsx}", "src/**/*.{ts,tsx}", "scripts/**/*.ts"],
      // knip's Expo plugin infers these from app.json (expo-system-ui for userInterfaceStyle, expo-updates unless updates
      // are turned off), not from an import. Adding them changes the phone's native build, so it is the phone's own
      // change, checked on a simulator (apps/mobile/README.md).
      ignoreDependencies: ["expo-system-ui", "expo-updates"],
    },
    "packages/*": {
      project: ["src/**/*.{ts,tsx}"],
      includeEntryExports: true,
    },
    "packages/tsrs": {
      // Run by path from its shell scripts (bin/tsgolint, tsdk/tsgo), which knip does not read.
      ignoreDependencies: ["tsrs", "@effect/tsgo"],
    },
    "packages/base-ui": {
      project: ["src/**/*.{ts,tsx}"],
      includeEntryExports: true,
      // vite-plus/test/browser-playwright, the browser mode's provider in vite.config.ts, needs it beside it.
      ignoreDependencies: ["@vitest/browser-playwright"],
    },
  },
  // Programs on the machine, not packages: Xcode's swift, macOS's plutil and ditto, and the voice line's tunnel.
  ignoreBinaries: ["swift", "plutil", "ditto", "cloudflared"],
  // Swift, with its own tools.
  ignoreWorkspaces: ["apps/island"],
};

export default config;
