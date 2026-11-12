import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface RepoHandlers {
  readonly "repo.pr.submit": (a: T.SubmitBranch) => Promise<T.BranchPublication>;
  readonly "github.get": () => Promise<T.GitHubStatus>;
  readonly "github.refresh": () => Promise<T.GitHubStatus>;
  readonly "repo.list": () => Promise<T.RepoSummary[]>;
  /** The first thing Create would refuse in this repo, without making it. */
  readonly "repo.validate": (a: T.NewRepo) => Promise<T.Validation>;
  readonly "repo.create": (a: T.NewRepo) => Promise<T.RepoSummary>;
  readonly "repo.language.list": (a: { readonly id: string }) => Promise<T.RepoLanguages>;
  readonly "repo.template.list": (a: { readonly id: string }) => Promise<T.RepoTemplates>;
  readonly "repo.activity.get": (a: { readonly id: string }) => Promise<T.RepoActivity>;
}

export const repoEndpoints: readonly Endpoint[] = [
  { op: "repo.pr.submit", about: [], input: S.SubmitBranch, result: S.BranchPublication, can: ["user"] },
  {
    op: "github.get",
    about: [],
    input: undefined,
    result: S.GitHubStatus,
    can: ["user", "remote"],
  },
  {
    op: "github.refresh",
    about: [],
    input: undefined,
    result: S.GitHubStatus,
    can: ["user", "remote"],
  },
  {
    op: "repo.list",
    about: [],
    input: undefined,
    result: z.array(S.RepoSummary),
    can: ["user", "remote", "orchestrator"],
  },
  {
    op: "repo.validate",
    about: [],
    input: S.NewRepo,
    result: S.Validation,
    can: ["user", "remote"],
  },
  {
    op: "repo.create",
    about: [],
    input: S.NewRepo,
    result: S.RepoSummary,
    can: ["user", "remote"],
  },
  {
    op: "repo.language.list",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.RepoLanguages,
    can: ["user", "remote"],
  },
  {
    op: "repo.template.list",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.RepoTemplates,
    can: ["user", "remote"],
  },
  {
    op: "repo.activity.get",
    about: ["id"],
    input: input({ id: z.string() }),
    result: S.RepoActivity,
    can: ["user", "remote"],
  },
];
