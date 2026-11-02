import { Effect } from "effect";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";

import { issueBranch, type Project } from "@/project/project.ts";
import { MergeFailure, type Workplace } from "@/project/shapes.ts";

export function acceptanceAncestors(issue: T.Issue, all: readonly T.Issue[]): T.Issue[] {
  const byId = new Map<string, T.Issue>(all.map((item) => [item.id, item]));
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const before of byId.get(id)?.blockedBy ?? []) visit(before);
  };
  for (const id of issue.blockedBy) visit(id);
  return all.filter((item) => visited.has(item.id) && item.status === "done" && item.constraints?.acceptance === true);
}

export const verifyChild = Effect.fn("Issue.verifyChild")(function* (
  projects: Project["Service"],
  child: T.Issue,
  parent: T.Issue,
  all: readonly T.Issue[],
  place: Workplace,
) {
  const constraints = child.constraints;
  const inherited = acceptanceAncestors(child, all);
  const changed = () => projects.changedFiles(place.cwd, issueBranch(parent.number)).pipe(Effect.mapError((error) => MergeFailure.error(error.message)));
  if (constraints?.acceptance === true) {
    if (!constraints.check) return yield* MergeFailure.failedCheck(t("server.issue.verification.acceptanceNeedsCheck"));
    if ((yield* projects.run(place.cwd, constraints.check)).ok)
      return yield* MergeFailure.failedCheck(t("server.issue.verification.acceptancePassed", { check: constraints.check }));
    return { ...constraints, frozen: yield* changed() };
  }
  const frozen = new Set(inherited.flatMap((item) => item.constraints?.frozen ?? []));
  const checkFrozen = Effect.gen(function* () {
    const touched = (yield* changed()).filter((file) => frozen.has(file));
    if (touched.length > 0) return yield* MergeFailure.failedCheck(t("server.issue.verification.frozen", { files: list(touched) }));
  });
  if (frozen.size > 0) yield* checkFrozen;
  const leaf = !all.some((item) => item.parent === child.parent && item.status !== "canceled" && item.blockedBy.includes(child.id));
  const checks = new Set([constraints?.check, ...(leaf ? inherited.map((item) => item.constraints?.check) : [])].flatMap((check) => (check ? [check] : [])));
  yield* Effect.forEach(
    checks,
    (check) =>
      Effect.gen(function* () {
        const result = yield* projects.run(place.cwd, check);
        if (!result.ok) return yield* MergeFailure.failedCheck(t("server.issue.verification.failed", { check, output: result.output }));
      }),
    { discard: true },
  );
  if (frozen.size > 0) yield* checkFrozen;
  return constraints;
});
