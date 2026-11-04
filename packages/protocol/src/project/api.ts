// The endpoints of projects and GitHub: their answers (ProjectHandlers) and their lines in the table (api.ts puts the
// concepts together).

import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface ProjectHandlers<R = never> {
  readonly "github.get": () => Effect.Effect<T.GitHubStatus, ApiError, R>;
  readonly "github.refresh": () => Effect.Effect<T.GitHubStatus, ApiError, R>;
  readonly "project.list": () => Effect.Effect<T.ProjectSummary[], ApiError, R>;
  /** The first thing Create would refuse in this project, without making it. */
  readonly "project.validate": (a: T.NewProject) => Effect.Effect<T.Validation, ApiError, R>;
  readonly "project.create": (a: T.NewProject) => Effect.Effect<T.ProjectSummary, ApiError, R>;
  readonly "project.language.list": (a: { readonly id: string }) => Effect.Effect<T.ProjectLanguages, ApiError, R>;
  /** The issue templates for the project: its stack, the titles sent out there before, and the template catalog filled in for it. */
  readonly "project.template.list": (a: { readonly id: string }) => Effect.Effect<T.ProjectTemplates, ApiError, R>;
  readonly "project.activity.get": (a: { readonly id: string }) => Effect.Effect<T.ProjectActivity, ApiError, R>;
}

export const projectEndpoints: readonly Endpoint[] = [
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
    op: "project.list",
    about: [],
    input: undefined,
    result: Schema.mutable(Schema.Array(S.ProjectSummary)),
    can: ["owner", "remote", "orchestrator"],
  },
  {
    op: "project.validate",
    about: [],
    input: S.NewProject,
    result: S.Validation,
    can: ["owner", "remote"],
  },
  {
    op: "project.create",
    about: [],
    input: S.NewProject,
    result: S.ProjectSummary,
    can: ["owner", "remote"],
  },
  {
    op: "project.language.list",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.ProjectLanguages,
    can: ["owner", "remote"],
  },
  {
    op: "project.template.list",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.ProjectTemplates,
    can: ["owner", "remote"],
  },
  {
    op: "project.activity.get",
    about: ["id"],
    input: input({ id: Schema.String }),
    result: S.ProjectActivity,
    can: ["owner", "remote"],
  },
];
