import { delimiter, join } from "node:path";

import { t } from "@vibevalley/i18n";

import { reason, type run } from "./git.ts";
import { lexists } from "./stats.ts";
import { MergeFailure } from "./workplace.ts";

/** The repo's .vibevalley/check at cwd: not-run when there is none, passed, or a MergeFailure with its last lines. */
export async function checkRepository(cwd: string, timeoutMs: number, execute: typeof run, signal?: AbortSignal): Promise<"not-run" | "passed"> {
  const file = join(cwd, ".vibevalley", "check");
  if (!(await lexists(file))) return "not-run";
  const inheritedPath = process.env.PATH ?? "";
  const path = [join(cwd, "node_modules", ".bin"), ...inheritedPath.split(delimiter).filter((p) => !p.includes("node_modules/.bin"))];
  const r = await execute(file, [], { cwd, timeoutMs, env: { ...process.env, PATH: path.join(delimiter) }, ...(signal === undefined ? {} : { signal }) });
  if (r.code === 0) return "passed";
  const why = r.timedOut
    ? t("server.repo.check.timedOut", { seconds: timeoutMs / 1000 })
    : r.code < 0
      ? t("server.repo.check.failed", { why: reason(r.stderr) })
      : t("server.repo.check.exited", { code: r.code });
  const lines = (r.stdout + r.stderr)
    .slice(-64 * 1024)
    .trim()
    .split("\n")
    .slice(-40);
  throw MergeFailure.failedCheck(why + "\n" + lines.join("\n"));
}
