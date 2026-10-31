// What the projects hand to the modules that use them (a workplace, what a merge did or why it did not): shapes and
// errors only, so a rule elsewhere can name them without the git and processes behind project.ts.

import { Schema } from "effect";

import { t } from "@vibevalley/i18n";
import type { PullRequest } from "@vibevalley/protocol";

export interface Workplace {
  readonly project: string;
  readonly cwd: string;
  /** Empty when it works in the project folder itself. */
  readonly branch?: string;
}

/** A retained branch or worktree still belongs to its issue, even after a failed dispatch. */
export type WorkplaceRelease = { readonly kept: false } | { readonly kept: true; readonly reason: string };
export type WorkplaceCleanup = "discard" | "preserve";

export interface ProjectFolder {
  readonly name: string;
  readonly path: string;
  readonly git: boolean;
}

export interface Merged {
  readonly pullRequest?: PullRequest;
  readonly text: string;
  readonly commits: number;
  readonly hashes?: readonly string[];
  /** Publication succeeded; these resources could not be removed. */
  readonly warning?: string;
}

/** Why a merge did not go in: a conflict (and with what), the check, or git. */
/** Work that did not merge: a conflict (with the base and its files), a failed check, or anything else. */
export class MergeFailure extends Schema.TaggedError<MergeFailure, { readonly brand: unique symbol }>()("MergeFailure", {
  kind: Schema.Literals(["conflict", "check", "error"]),
  reasonText: Schema.String,
  base: Schema.String,
  files: Schema.Array(Schema.String),
  message: Schema.String,
}) {
  static conflict(base: string, files: readonly string[]) {
    return new MergeFailure({
      kind: "conflict",
      reasonText: "",
      base,
      files,
      message: t("server.project.conflict", { base }),
    });
  }
  static failedCheck(why: string) {
    return new MergeFailure({ kind: "check", reasonText: why, base: "", files: [], message: why });
  }
  static error(why: string) {
    return new MergeFailure({ kind: "error", reasonText: why, base: "", files: [], message: why });
  }
}

export class ProjectError extends Schema.TaggedError<ProjectError, { readonly brand: unique symbol }>()("ProjectError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

/** Where, in a worktree's git directory (git rev-parse --git-path), its helper leaves the pull request's title and body:
 * outside the tree, so it is never committed. */
export const pullRequestFile = "vibevalley-pr.md";

/** The title and body a helper wrote: the first line (a leading # dropped) and what follows it; undefined when it gave
 * no title. */
export function pullRequestText(text: string): { readonly title: string; readonly body: string } | undefined {
  const [first = "", ...rest] = text.replace(/\r\n/gu, "\n").trim().split("\n");
  const title = first.replace(/^#+\s*/u, "").trim();
  return title === "" ? undefined : { title, body: rest.join("\n").trim() };
}
