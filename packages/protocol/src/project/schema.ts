import { Schema } from "effect";

import type { Codec } from "../codec";
import type * as T from "../shapes";

export const GitHubStatus: Codec<T.GitHubStatus> = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.optionalKey(Schema.String),
  loggedIn: Schema.Boolean,
  account: Schema.optionalKey(Schema.String),
  reason: Schema.String,
  checkedAt: Schema.Finite,
});

export const DayCount: Codec<T.DayCount> = Schema.Struct({
  day: Schema.String,
  commits: Schema.Finite,
});

export const Author: Codec<T.Author> = Schema.Struct({
  name: Schema.String,
  commits: Schema.Finite,
});

export const ProjectActivity: Codec<T.ProjectActivity> = Schema.Struct({
  project: Schema.String,
  at: Schema.Finite,
  days: Schema.mutable(Schema.Array(DayCount)),
  authors: Schema.mutable(Schema.Array(Author)),
  total: Schema.Finite,
  first: Schema.optionalKey(Schema.Finite),
  last: Schema.optionalKey(Schema.Finite),
});

export const LanguageCount: Codec<T.LanguageCount> = Schema.Struct({
  name: Schema.String,
  files: Schema.Finite,
  code: Schema.Finite,
  comments: Schema.Finite,
  blanks: Schema.Finite,
});

export const ProjectLanguages: Codec<T.ProjectLanguages> = Schema.Struct({
  project: Schema.String,
  at: Schema.Finite,
  languages: Schema.mutable(Schema.Array(LanguageCount)),
});

export const ProjectStack: Codec<T.ProjectStack> = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  test: Schema.optionalKey(Schema.String),
  lint: Schema.optionalKey(Schema.String),
  build: Schema.optionalKey(Schema.String),
});

export const TemplateBlank: Codec<T.TemplateBlank> = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
});

export const IssueTemplate: Codec<T.IssueTemplate> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.String,
  text: Schema.String,
  blank: Schema.optionalKey(TemplateBlank),
});

export const TemplateKind: Codec<T.TemplateKind> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  templates: Schema.mutable(Schema.Array(IssueTemplate)),
});

export const ProjectTemplates: Codec<T.ProjectTemplates> = Schema.Struct({
  project: Schema.String,
  stack: ProjectStack,
  recent: Schema.mutable(Schema.Array(Schema.String)),
  kinds: Schema.mutable(Schema.Array(TemplateKind)),
});

export const PullRequestCapability: Codec<T.PullRequestCapability> = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.String,
});

export const ProjectSummary: Codec<T.ProjectSummary> = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  git: Schema.Boolean,
  last: Schema.optionalKey(Schema.Finite),
  maxSessions: Schema.Finite,
  pullRequest: PullRequestCapability,
});

export const NewProject: Codec<T.NewProject> = Schema.Struct({
  name: Schema.String,
  github: Schema.optionalKey(Schema.String),
});

export const Commit: Codec<T.Commit> = Schema.Struct({
  hash: Schema.String,
  subject: Schema.String,
  at: Schema.Finite,
});

export const UncommittedItem: Codec<T.UncommittedItem> = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
});
