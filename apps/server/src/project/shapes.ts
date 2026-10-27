// What the projects hand to the modules that use them (a workplace, what a merge did or why it did not): shapes and
// errors only, so a rule elsewhere can name them without the git and processes behind project.ts.

import { projectWording } from "./words.ts";
import type { PullRequest } from "@vibevalley/protocol";
import { Data } from "effect";

export interface Workplace {
  readonly project: string;
  readonly cwd: string;
  /** Empty when it works in the project folder itself. */
  readonly branch?: string;
}

/** A retained branch or worktree still belongs to its issue, even after a failed dispatch. */
export type WorkplaceRelease = { readonly kept: false } | { readonly kept: true; readonly reason: string };
export type WorkplaceCleanup = "discard" | "preserve";

export interface Project {
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
export class MergeFailure extends Data.TaggedError("MergeFailure")<{
  readonly kind: "conflict" | "check" | "error";
  readonly reasonText: string;
  readonly base: string;
  readonly files: readonly string[];
  readonly message: string;
}> {
  static conflict(base: string, files: readonly string[]) {
    return new MergeFailure({
      kind: "conflict",
      reasonText: "",
      base,
      files,
      message: projectWording().conflict(base),
    });
  }
  static check(why: string) {
    return new MergeFailure({ kind: "check", reasonText: why, base: "", files: [], message: why });
  }
  static error(why: string) {
    return new MergeFailure({ kind: "error", reasonText: why, base: "", files: [], message: why });
  }
}

export class ProjectError extends Data.TaggedError("ProjectError")<{ readonly message: string }> {}
