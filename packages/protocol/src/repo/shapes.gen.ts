// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

export const GitHubAuthModeValues = ["token", "gh", "none"] as const;
export type GitHubAuthMode = (typeof GitHubAuthModeValues)[number];

export type GitHubStatus = { installed: boolean,
/**
 * gh's version, when it says one.
 */
version?: string, loggedIn: boolean,
/**
 * The logged-in account, when logged in.
 */
account?: string,
/**
 * Active GitHub authentication mode (`token`, `gh`, or `none`).
 */
authMode: GitHubAuthMode,
/**
 * Why it is not usable, when it is not.
 */
reason: string, checkedAt: number, };

export type DayCount = { day: string, commits: number, };

export type Author = { name: string, commits: number, };

export type RepoActivity = { repo: string, at: number, days: Array<DayCount>, authors: Array<Author>, total: number, first?: number, last?: number, };

export type LanguageCount = { name: string, files: number, code: number, comments: number, blanks: number, };

export type RepoLanguages = { repo: string, at: number, languages: Array<LanguageCount>, };

export type RepoStack = { name: string, label: string, test?: string, lint?: string, build?: string, };

export type TemplateBlank = { start: number, end: number, };

export type IssueTemplate = { id: string, title: string, done: string, text: string, blank?: TemplateBlank, };

export type TemplateKind = { id: string, name: string, icon: string, templates: Array<IssueTemplate>, };

export type RepoTemplates = { repo: string, stack: RepoStack, recent: Array<string>, kinds: Array<TemplateKind>, };

export type PullRequestCapability = { available: boolean, reason: string, };

export type RepoSummary = { name: string, path: string, git: boolean, external: boolean, last?: number, maxSessions: number, pullRequest: PullRequestCapability, health?: RepoHealth, };

export const RepoHealthStatusValues = ["on_track", "at_risk", "off_track"] as const;
export type RepoHealthStatus = (typeof RepoHealthStatusValues)[number];

export const RepoHealthReasonValues = ["stuck_issues", "failed_checks", "overdue_issues", "asking_user", "blocked_issues", "no_active_progress", "stale_activity", "healthy"] as const;
export type RepoHealthReason = (typeof RepoHealthReasonValues)[number];

export type RepoHealth = { repo: string, status: RepoHealthStatus, reasons: Array<RepoHealthReason>, openIssues: number, inProgressIssues: number, inReviewIssues: number, blockedIssues: number, stuckIssues: number, askingIssues: number, failedChecks: number, overdueIssues: number, lastCommitAt?: number, evaluatedAt: number, };

export type NewRepo = { name: string, github?: string, };

export type MountRepo = { path: string, name?: string, initGit?: boolean, };

export type RepoUnmountInput = { id: string, };

export type Commit = { hash: string, subject: string, at: number, };

export type UncommittedItem = { path: string, status: string, };

export type SubmitBranch = { cwd: string, branch: string, sha: string, base: string, title: string, body: string, dryRun?: boolean, };

export const PublishPlatformValues = ["github", "gitlab"] as const;
export type PublishPlatform = (typeof PublishPlatformValues)[number];

export const BranchCheckValues = ["preview", "passed", "not-run"] as const;
export type BranchCheck = (typeof BranchCheckValues)[number];

export const BranchPublicationStateValues = ["open"] as const;
export type BranchPublicationState = (typeof BranchPublicationStateValues)[number];

export type BranchPublication = { platform: PublishPlatform, repository: string, branch: string, sha: string, base: string, check: BranchCheck, pushed: boolean, url?: string, number?: number, reused?: boolean, state?: BranchPublicationState, };

/**
 * A repo the farm works in, and how many commits helpers made in it.
 */
export type Repo = { path: string, commits: number, };

export type Conflict = { base: string, files: Array<string>, };

export type ChangedFile = { path: string, status: string, added: number, removed: number, patch?: string, };

export type ReviewRevision = { baseCommit: string, tree: string, };

export type Changes = { revision?: ReviewRevision, sinceReview?: Array<ChangedFile>, repo: string, base: string, branch?: string, commits: Array<Commit>, files: Array<ChangedFile>, uncommitted: Array<UncommittedItem>, conflicts: Array<string>, behind: number, };

export type RepoLanguageListInput = { id: string, };

export type RepoTemplateListInput = { id: string, };

export type RepoActivityGetInput = { id: string, };
