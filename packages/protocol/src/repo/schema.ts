import { Schema } from "effect";

import type { Codec } from "../codec";
import * as T from "./shapes";

export const GitHubStatus: Codec<T.GitHubStatus> = Schema.Struct({
  installed: Schema.Boolean,
  version: Schema.optionalKey(Schema.String),
  loggedIn: Schema.Boolean,
  account: Schema.optionalKey(Schema.String),
  reason: Schema.String,
  checkedAt: Schema.Finite,
});

const DayCount: Codec<T.DayCount> = Schema.Struct({
  day: Schema.String,
  commits: Schema.Finite,
});

const Author: Codec<T.Author> = Schema.Struct({
  name: Schema.String,
  commits: Schema.Finite,
});

export const RepoActivity: Codec<T.RepoActivity> = Schema.Struct({
  repo: Schema.String,
  at: Schema.Finite,
  days: Schema.mutable(Schema.Array(DayCount)),
  authors: Schema.mutable(Schema.Array(Author)),
  total: Schema.Finite,
  first: Schema.optionalKey(Schema.Finite),
  last: Schema.optionalKey(Schema.Finite),
});

const LanguageCount: Codec<T.LanguageCount> = Schema.Struct({
  name: Schema.String,
  files: Schema.Finite,
  code: Schema.Finite,
  comments: Schema.Finite,
  blanks: Schema.Finite,
});

export const RepoLanguages: Codec<T.RepoLanguages> = Schema.Struct({
  repo: Schema.String,
  at: Schema.Finite,
  languages: Schema.mutable(Schema.Array(LanguageCount)),
});

const RepoStack: Codec<T.RepoStack> = Schema.Struct({
  name: Schema.String,
  label: Schema.String,
  test: Schema.optionalKey(Schema.String),
  lint: Schema.optionalKey(Schema.String),
  build: Schema.optionalKey(Schema.String),
});

const TemplateBlank: Codec<T.TemplateBlank> = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
});

const IssueTemplate: Codec<T.IssueTemplate> = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  done: Schema.String,
  text: Schema.String,
  blank: Schema.optionalKey(TemplateBlank),
});

const TemplateKind: Codec<T.TemplateKind> = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  templates: Schema.mutable(Schema.Array(IssueTemplate)),
});

export const RepoTemplates: Codec<T.RepoTemplates> = Schema.Struct({
  repo: Schema.String,
  stack: RepoStack,
  recent: Schema.mutable(Schema.Array(Schema.String)),
  kinds: Schema.mutable(Schema.Array(TemplateKind)),
});

const PullRequestCapability: Codec<T.PullRequestCapability> = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.String,
});

export const RepoSummary: Codec<T.RepoSummary> = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  git: Schema.Boolean,
  last: Schema.optionalKey(Schema.Finite),
  maxSessions: Schema.Finite,
  pullRequest: PullRequestCapability,
});

export const NewRepo: Codec<T.NewRepo> = Schema.Struct({
  name: Schema.String,
  github: Schema.optionalKey(Schema.String),
});

const Commit: Codec<T.Commit> = Schema.Struct({
  hash: Schema.String,
  subject: Schema.String,
  at: Schema.Finite,
});

const UncommittedItem: Codec<T.UncommittedItem> = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
});

export const SubmitBranch: Codec<T.SubmitBranch> = Schema.Struct({
  cwd: Schema.String,
  branch: Schema.String,
  sha: Schema.String,
  base: Schema.String,
  title: Schema.String,
  body: Schema.String,
  dryRun: Schema.optionalKey(Schema.Boolean),
});

export const BranchPublication: Codec<T.BranchPublication> = Schema.Struct({
  platform: Schema.Literals(T.PublishPlatformValues),
  repository: Schema.String,
  branch: Schema.String,
  sha: Schema.String,
  base: Schema.String,
  check: Schema.Literals(T.BranchCheckValues),
  pushed: Schema.Boolean,
  url: Schema.optionalKey(Schema.String),
  number: Schema.optionalKey(Schema.Int),
  reused: Schema.optionalKey(Schema.Boolean),
  state: Schema.optionalKey(Schema.Literals(T.BranchPublicationStateValues)),
});
export const Repo: Codec<T.Repo> = Schema.Struct({
  path: Schema.String,
  commits: Schema.Finite,
});
export const Conflict: Codec<T.Conflict> = Schema.Struct({
  base: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
});
const ChangedFile: Codec<T.ChangedFile> = Schema.Struct({
  path: Schema.String,
  status: Schema.String,
  added: Schema.Finite,
  removed: Schema.Finite,
  patch: Schema.optionalKey(Schema.String),
});
export const Changes: Codec<T.Changes> = Schema.Struct({
  repo: Schema.String,
  base: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  commits: Schema.mutable(Schema.Array(Commit)),
  files: Schema.mutable(Schema.Array(ChangedFile)),
  uncommitted: Schema.mutable(Schema.Array(UncommittedItem)),
  conflicts: Schema.mutable(Schema.Array(Schema.String)),
  behind: Schema.Finite,
});
