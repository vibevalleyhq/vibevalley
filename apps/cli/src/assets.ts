// The files the command line reads at run time, by their path from apps/cli. One folder up from here is apps/cli whether
// this runs as src/assets.ts (the repository) or inside dist/main.mjs (the packaged app's bundle, which carries these
// files beside it at the same paths: apps/desktop/scripts/package.ts).

import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dirname, "..");

/** What the package script copies beside the bundle: every path cliFile is given lies under one of these. */
export const cliFiles = ["src/guide"] as const;

export const cliFile = (path: `${(typeof cliFiles)[number]}${string}`) => resolve(cliRoot, path);
