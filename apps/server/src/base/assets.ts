import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = dirname(fileURLToPath(import.meta.resolve("#package")));

/** What the package script copies beside the bundle: every path serverFile is given lies under one of these. */
export const serverFiles = [
  "db/migrations",
  "src/modules/memory/data",
  "src/modules/agent/templates",
  "src/modules/agent/skills",
  "src/modules/orchestrator/skills",
] as const;

export const serverFile = (path: `${(typeof serverFiles)[number]}${string}`) => resolve(serverRoot, path);
