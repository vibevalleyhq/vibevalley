import { list, t } from "@vibevalley/i18n";

import type { Conflict } from "@vibevalley/protocol";

import type { MergeFailure } from "@/project/shapes.ts";
export const conflictBrief = (base: string, files: readonly string[]) => t("server.session.conflictBrief", { base, files: list(files) });

/** The conflict a preview of the session's branch shows; none when it goes in clean. */
export const conflictOf = (changes: { readonly base: string; readonly conflicts?: readonly string[] }): Conflict | undefined =>
  changes.conflicts && changes.conflicts.length > 0 ? { base: changes.base, files: [...changes.conflicts] } : undefined;

export const sameConflict = (a: Conflict | undefined, b: Conflict | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Who settles a conflict when the work does not go in: the owner (an issue: told what to tell the helper), or the helper
 * at once (a task graph's step). */
export type Settle = "owner" | "helper";

/** What a take-in that did not go through means. The session stays with its branch and worktree either way. fix: what
 * the helper is sent back with ("" when it is left to the owner); owner: what the owner is told; notice: the farm's line;
 * short: the line a task graph keeps. */
export function notTakenIn(
  f: MergeFailure,
  name: string,
  settle: Settle,
): { readonly fix: string; readonly owner: string; readonly notice: string; readonly short: string } {
  switch (f.kind) {
    case "conflict": {
      const files = list(f.files);
      return {
        fix: settle === "helper" ? conflictBrief(f.base, f.files) : "",
        owner: t("server.session.notTaken.conflictOwner", { base: f.base, files, name, brief: conflictBrief(f.base, f.files) }),
        notice: t("server.session.notTaken.conflictNotice", { name, base: f.base, files }),
        short: t("server.session.notTaken.conflictShort", { base: f.base, files }),
      };
    }
    case "check":
      return {
        fix: t("server.session.notTaken.checkFix", { reason: f.reasonText }),
        owner: t("server.session.notTaken.owner", { why: f.reasonText, name }),
        notice: t("server.session.notTaken.notice", { name, why: f.reasonText }),
        short: t("server.session.notTaken.checkShort"),
      };
    case "error": {
      const why = f.reasonText || f.message;
      return { fix: "", owner: t("server.session.notTaken.owner", { why, name }), notice: t("server.session.notTaken.notice", { name, why }), short: why };
    }
  }
}
