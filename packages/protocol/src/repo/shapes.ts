export interface RepoActivity {
  repo: string;
  at: number;
  days: DayCount[];
  authors: Author[];
  total: number;
  first?: number;
  last?: number;
}

export interface DayCount {
  day: string;
  commits: number;
}

export interface RepoLanguages {
  repo: string;
  at: number;
  languages: LanguageCount[];
}

export interface RepoTemplates {
  repo: string;
  stack: RepoStack;
  recent: string[];
  kinds: TemplateKind[];
}

export interface RepoStack {
  name: string;
  label: string;
  test?: string;
  lint?: string;
  build?: string;
}

export interface TemplateKind {
  id: string;
  name: string;
  icon: string;
  templates: IssueTemplate[];
}

export interface IssueTemplate {
  id: string;
  title: string;
  done: string;
  text: string;
  blank?: TemplateBlank;
}

export interface TemplateBlank {
  start: number;
  end: number;
}

export interface LanguageCount {
  name: string;
  files: number;
  code: number;
  comments: number;
  blanks: number;
}

export interface GitHubStatus {
  installed: boolean;
  /** gh's version, when it says one. */
  version?: string;
  loggedIn: boolean;
  /** The logged-in account, when logged in. */
  account?: string;
  /** Why it is not usable, when it is not. */
  reason: string;
  checkedAt: number;
}

export interface PullRequestCapability {
  available: boolean;
  reason: string;
}

export interface RepoSummary {
  name: string;
  path: string;
  git: boolean;
  last?: number;
  maxSessions: number;
  pullRequest: PullRequestCapability;
}

export interface NewRepo {
  name: string;
  github?: string;
}

export interface Author {
  name: string;
  commits: number;
}

export interface Commit {
  hash: string;
  subject: string;
  at: number;
}

export interface UncommittedItem {
  path: string;
  status: string;
}
