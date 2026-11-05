import { resolve } from "node:path";

const serverRoot = resolve(import.meta.dirname, "..");

/** What the package script copies beside the bundle: every path serverFile is given lies under one of these. */
export const serverFiles = ["db/migrations", "src/memory/data", "src/agent/templates"] as const;

export const serverFile = (path: `${(typeof serverFiles)[number]}${string}`) => resolve(serverRoot, path);
