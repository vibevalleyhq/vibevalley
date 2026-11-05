import { resolve } from "node:path";

const cliRoot = resolve(import.meta.dirname, "..");

/** What the package script copies beside the bundle: every path cliFile is given lies under one of these. */
export const cliFiles = ["src/guide"] as const;

export const cliFile = (path: `${(typeof cliFiles)[number]}${string}`) => resolve(cliRoot, path);
