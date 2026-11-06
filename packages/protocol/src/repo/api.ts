import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface RepoHandlers<R = never> {
  readonly "github.get": () => Effect.Effect<T.GitHubStatus, ApiError, R>;
  readonly "github.refresh": () => Effect.Effect<T.GitHubStatus, ApiError, R>;
  readonly "repo.list": () => Effect.Effect<T.RepoSummary[], ApiError, R>;
  /** The first thing Create would refuse in this repo, without making it. */
  readonly "repo.validate": (a: T.NewRepo) => Effect.Effect<T.Validation, ApiError, R>;
  readonly "repo.create": (a: T.NewRepo) => Effect.Effect<T.RepoSummary, ApiError, R>;
  readonly "repo.language.list": (a: { readonly id: string }) => Effect.Effect<T.RepoLanguages, ApiError, R>;
  /** The issue templates for the repo: its stack, the titles sent out there before, and the template catalog filled in for it. */
  readonly "repo.template.list": (a: { readonly id: string }) => Effect.Effect<T.RepoTemplates, ApiError, R>;
  readonly "repo.activity.get": (a: { readonly id: string }) => Effect.Effect<T.RepoActivity, ApiError, R>;
}

export const repoEndpoints: readonly Endpoint[] = [
  {
    op: "github.get",
    about: [],
    input: undefined,
    result: S.GitHubStatus,
    can: ["owner", "remote"],
  },
  {
    op: "github.refresh",
    about: [],
    input: undefined,
    result: S.GitHubStatus,
    can: ["owner", "remote"],
  },
  {
    op: "repo.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.RepoSummary)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "repo.validate",
    about: [],
    input: S.NewRepo,
    result: S.Validation,
    can: ["owner", "remote"],
  },
  {
    op: "repo.create",
    about: [],
    input: S.NewRepo,
    result: S.RepoSummary,
    can: ["owner", "remote"],
  },
  {
    op: "repo.language.list",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.RepoLanguages,
    can: ["owner", "remote"],
  },
  {
    op: "repo.template.list",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.RepoTemplates,
    can: ["owner", "remote"],
  },
  {
    op: "repo.activity.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.RepoActivity,
    can: ["owner", "remote"],
  },
];
