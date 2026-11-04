// The files the server reads at run time, by their path from apps/server. One folder up from here is apps/server
// whether this runs as src/assets.ts (the repository, through tsx) or inside dist/main.js (the packaged app's bundle,
// which carries these files beside it at the same paths: apps/desktop/scripts/package.ts). So a file is found the
// same way in both; a module that read its own folder instead would look in dist/ once bundled.

import { resolve } from "node:path";

const serverRoot = resolve(import.meta.dirname, "..");

/** What the package script copies beside the bundle: every path serverFile is given lies under one of these. */
export const serverFiles = ["db/migrations", "src/memory/data", "src/agent/templates", "src/cli/guide"] as const;

export const serverFile = (path: `${(typeof serverFiles)[number]}${string}`) => resolve(serverRoot, path);
