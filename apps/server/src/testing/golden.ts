import { resolve } from "node:path";

import { goldenCasesAt } from "@vibevalley/testkit/golden";

export { checkCases } from "@vibevalley/testkit/golden";

/** The cases of a module's file, by the module's folder under src. */
export const goldenCases = (pkg: string, file = "rules.jsonl.gz") => goldenCasesAt(resolve(import.meta.dirname, "..", pkg, "testdata", file));
