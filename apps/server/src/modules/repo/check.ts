import { delimiter, join } from "node:path";

import { Config, Effect, type FileSystem } from "effect";

import { t } from "@vibevalley/i18n";

import { reason, type run } from "./git.ts";
import { lexists } from "./stats.ts";
import { MergeFailure } from "./workplace.ts";

export const checkRepository = Effect.fn("Repo.checkRepository")(function* (fs: FileSystem.FileSystem, cwd: string, timeoutMs: number, execute: typeof run) {
  const file = join(cwd, ".vibevalley", "check");
  if (!(yield* lexists(fs, file))) return "not-run" as const;
  const inheritedPath = yield* Config.String("PATH").pipe(
    Config.withDefault(""),
    Effect.mapError((e) => MergeFailure.failedCheck(t("server.repo.check.failed", { why: e.message }))),
  );
  const path = [join(cwd, "node_modules", ".bin"), ...inheritedPath.split(delimiter).filter((p) => !p.includes("node_modules/.bin"))];
  const r = yield* execute(file, [], { cwd, timeoutMs, env: { ...process.env, PATH: path.join(delimiter) } });
  if (r.code === 0) return "passed" as const;
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
  return yield* MergeFailure.failedCheck(why + "\n" + lines.join("\n"));
});
