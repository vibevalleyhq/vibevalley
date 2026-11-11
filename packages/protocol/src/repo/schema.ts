import { z } from "zod";

import type { Codec } from "../codec";
import * as T from "./shapes";

export const GitHubStatus = z.object({
  installed: z.boolean(),
  version: z.exactOptional(z.string()),
  loggedIn: z.boolean(),
  account: z.exactOptional(z.string()),
  reason: z.string(),
  checkedAt: z.number(),
}) satisfies Codec<T.GitHubStatus>;

const DayCount = z.object({
  day: z.string(),
  commits: z.number(),
}) satisfies Codec<T.DayCount>;

const Author = z.object({
  name: z.string(),
  commits: z.number(),
}) satisfies Codec<T.Author>;

export const RepoActivity = z.object({
  repo: z.string(),
  at: z.number(),
  days: z.array(DayCount),
  authors: z.array(Author),
  total: z.number(),
  first: z.exactOptional(z.number()),
  last: z.exactOptional(z.number()),
}) satisfies Codec<T.RepoActivity>;

const LanguageCount = z.object({
  name: z.string(),
  files: z.number(),
  code: z.number(),
  comments: z.number(),
  blanks: z.number(),
}) satisfies Codec<T.LanguageCount>;

export const RepoLanguages = z.object({
  repo: z.string(),
  at: z.number(),
  languages: z.array(LanguageCount),
}) satisfies Codec<T.RepoLanguages>;

const RepoStack = z.object({
  name: z.string(),
  label: z.string(),
  test: z.exactOptional(z.string()),
  lint: z.exactOptional(z.string()),
  build: z.exactOptional(z.string()),
}) satisfies Codec<T.RepoStack>;

const TemplateBlank = z.object({
  start: z.number(),
  end: z.number(),
}) satisfies Codec<T.TemplateBlank>;

const IssueTemplate = z.object({
  id: z.string(),
  title: z.string(),
  done: z.string(),
  text: z.string(),
  blank: z.exactOptional(TemplateBlank),
}) satisfies Codec<T.IssueTemplate>;

const TemplateKind = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string(),
  templates: z.array(IssueTemplate),
}) satisfies Codec<T.TemplateKind>;

export const RepoTemplates = z.object({
  repo: z.string(),
  stack: RepoStack,
  recent: z.array(z.string()),
  kinds: z.array(TemplateKind),
}) satisfies Codec<T.RepoTemplates>;

const PullRequestCapability = z.object({
  available: z.boolean(),
  reason: z.string(),
}) satisfies Codec<T.PullRequestCapability>;

export const RepoSummary = z.object({
  name: z.string(),
  path: z.string(),
  git: z.boolean(),
  last: z.exactOptional(z.number()),
  maxSessions: z.number(),
  pullRequest: PullRequestCapability,
}) satisfies Codec<T.RepoSummary>;

export const NewRepo = z.object({
  name: z.string(),
  github: z.exactOptional(z.string()),
}) satisfies Codec<T.NewRepo>;

const Commit = z.object({
  hash: z.string(),
  subject: z.string(),
  at: z.number(),
}) satisfies Codec<T.Commit>;

const UncommittedItem = z.object({
  path: z.string(),
  status: z.string(),
}) satisfies Codec<T.UncommittedItem>;

export const SubmitBranch = z.object({
  cwd: z.string(),
  branch: z.string(),
  sha: z.string(),
  base: z.string(),
  title: z.string(),
  body: z.string(),
  dryRun: z.exactOptional(z.boolean()),
}) satisfies Codec<T.SubmitBranch>;

export const BranchPublication = z.object({
  platform: z.enum(T.PublishPlatformValues),
  repository: z.string(),
  branch: z.string(),
  sha: z.string(),
  base: z.string(),
  check: z.enum(T.BranchCheckValues),
  pushed: z.boolean(),
  url: z.exactOptional(z.string()),
  number: z.exactOptional(z.number().int()),
  reused: z.exactOptional(z.boolean()),
  state: z.exactOptional(z.enum(T.BranchPublicationStateValues)),
}) satisfies Codec<T.BranchPublication>;
export const Repo = z.object({
  path: z.string(),
  commits: z.number(),
}) satisfies Codec<T.Repo>;
export const Conflict = z.object({
  base: z.string(),
  files: z.array(z.string()),
}) satisfies Codec<T.Conflict>;
const ChangedFile = z.object({
  path: z.string(),
  status: z.string(),
  added: z.number(),
  removed: z.number(),
  patch: z.exactOptional(z.string()),
}) satisfies Codec<T.ChangedFile>;
export const Changes = z.object({
  repo: z.string(),
  base: z.string(),
  branch: z.exactOptional(z.string()),
  commits: z.array(Commit),
  files: z.array(ChangedFile),
  uncommitted: z.array(UncommittedItem),
  conflicts: z.array(z.string()),
  behind: z.number(),
}) satisfies Codec<T.Changes>;
