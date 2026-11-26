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
    "apps/mac/ui": {
      // nsh loads App.tsx (workbench) and ShellApp.tsx (lightweight panes), and tests open entry points by filename.
      entry: ["App.tsx", "ShellApp.tsx", "**/*.{test,story,stories}.{ts,tsx}", "**/main.tsx", "**/story.tsx"],
      project: ["**/*.{ts,tsx}", "!.nsh/**", "!build/**", "!build-shell/**"],
      // nsh provides these modules inside its runtime, without npm packages.
      ignoreDependencies: ["nsh", "nsh/*"],
    },
    "apps/mobile": {
      // nsh loads App.tsx, and tests open entry points by filename.
      entry: ["App.tsx", "**/*.{test,story,stories}.{ts,tsx}", "**/main.tsx", "**/story.tsx"],
      project: ["**/*.{ts,tsx}", "!.nsh/**", "!build/**"],
      // nsh provides these modules inside its runtime, without npm packages.
      ignoreDependencies: ["nsh", "nsh/*"],
    },
    "packages/*": {
      project: ["src/**/*.{ts,tsx}"],
      includeEntryExports: true,
    },
    "scripts/tsrs": {
      // Run by path from its shell scripts (bin/tsgolint, tsdk/tsgo), which knip does not read.
      ignoreDependencies: ["tsrs"],
    },
  },
  // Programs on the machine, not packages: Xcode's swift, Rust's cargo, make, and macOS packaging tools (hdiutil, sips).
  ignoreBinaries: ["swift", "cargo", "make", "hdiutil", "sips"],
  // Rust owns the complete wire contract; unused TS projections are not dead Rust API types.
  // Handwritten re-exports and schemas remain checked.
  ignoreIssues: { "packages/protocol/src/**/*.gen.ts": ["exports", "types"] },
  // Swift, with its own tools.
  ignoreWorkspaces: ["apps/island"],
};

export default config;
