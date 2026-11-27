#![allow(clippy::large_enum_variant, clippy::enum_variant_names)]

use serde::{Deserialize, Serialize};
use serde_with::skip_serializing_none;
#[cfg(feature = "ts-gen")]
use ts_rs::TS;

use crate::wire::*;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum GitHubAuthMode {
    #[serde(rename = "token")]
    Token,
    #[serde(rename = "gh")]
    Gh,
    #[default]
    #[serde(rename = "none")]
    None,
}

impl GitHubAuthMode {
    pub const ALL: [GitHubAuthMode; 3] = [GitHubAuthMode::Token, GitHubAuthMode::Gh, GitHubAuthMode::None];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            GitHubAuthMode::Token => "token",
            GitHubAuthMode::Gh => "gh",
            GitHubAuthMode::None => "none",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct GitHubStatus {
    pub installed: bool,
    /// gh's version, when it says one.
    pub version: Option<String>,
    pub logged_in: bool,
    /// The logged-in account, when logged in.
    pub account: Option<String>,
    /// Active GitHub authentication mode (`token`, `gh`, or `none`).
    pub auth_mode: GitHubAuthMode,
    /// Why it is not usable, when it is not.
    pub reason: String,
    pub checked_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct DayCount {
    pub day: String,
    pub commits: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: String,
    pub commits: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoActivity {
    pub repo: String,
    pub at: i64,
    pub days: Vec<DayCount>,
    pub authors: Vec<Author>,
    pub total: i64,
    pub first: Option<i64>,
    pub last: Option<i64>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct LanguageCount {
    pub name: String,
    pub files: i64,
    pub code: i64,
    pub comments: i64,
    pub blanks: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoLanguages {
    pub repo: String,
    pub at: i64,
    pub languages: Vec<LanguageCount>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoStack {
    pub name: String,
    pub label: String,
    pub test: Option<String>,
    pub lint: Option<String>,
    pub build: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TemplateBlank {
    pub start: JsNumber,
    pub end: JsNumber,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct IssueTemplate {
    pub id: String,
    pub title: String,
    pub done: String,
    pub text: String,
    pub blank: Option<TemplateBlank>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct TemplateKind {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub templates: Vec<IssueTemplate>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoTemplates {
    pub repo: String,
    pub stack: RepoStack,
    pub recent: Vec<String>,
    pub kinds: Vec<TemplateKind>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCapability {
    pub available: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum RepoHealthStatus {
    #[serde(rename = "on_track")]
    OnTrack,
    #[serde(rename = "at_risk")]
    AtRisk,
    #[serde(rename = "off_track")]
    OffTrack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum RepoHealthReason {
    #[serde(rename = "stuck_issues")]
    StuckIssues,
    #[serde(rename = "failed_checks")]
    FailedChecks,
    #[serde(rename = "overdue_issues")]
    OverdueIssues,
    #[serde(rename = "asking_user")]
    AskingUser,
    #[serde(rename = "blocked_issues")]
    BlockedIssues,
    #[serde(rename = "no_active_progress")]
    NoActiveProgress,
    #[serde(rename = "stale_activity")]
    StaleActivity,
    #[serde(rename = "healthy")]
    Healthy,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoHealth {
    pub repo: String,
    pub status: RepoHealthStatus,
    pub reasons: Vec<RepoHealthReason>,
    pub open_issues: i64,
    pub in_progress_issues: i64,
    pub in_review_issues: i64,
    pub blocked_issues: i64,
    pub stuck_issues: i64,
    pub asking_issues: i64,
    pub failed_checks: i64,
    pub overdue_issues: i64,
    pub last_commit_at: Option<i64>,
    pub evaluated_at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub name: String,
    pub path: String,
    pub git: bool,
    #[serde(default)]
    pub external: bool,
    pub last: Option<i64>,
    pub max_sessions: i64,
    pub pull_request: PullRequestCapability,
    #[serde(default)]
    pub health: Option<RepoHealth>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct NewRepo {
    pub name: String,
    pub github: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct MountRepo {
    pub path: String,
    pub name: Option<String>,
    pub init_git: Option<bool>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoUnmountInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub subject: String,
    pub at: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct UncommittedItem {
    pub path: String,
    pub status: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct SubmitBranch {
    pub cwd: String,
    pub branch: String,
    pub sha: String,
    pub base: String,
    pub title: String,
    pub body: String,
    pub dry_run: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum PublishPlatform {
    #[serde(rename = "github")]
    Github,
    #[serde(rename = "gitlab")]
    Gitlab,
}

impl PublishPlatform {
    pub const ALL: [PublishPlatform; 2] = [PublishPlatform::Github, PublishPlatform::Gitlab];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            PublishPlatform::Github => "github",
            PublishPlatform::Gitlab => "gitlab",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum BranchCheck {
    #[serde(rename = "preview")]
    Preview,
    #[serde(rename = "passed")]
    Passed,
    #[serde(rename = "not-run")]
    NotRun,
}

impl BranchCheck {
    pub const ALL: [BranchCheck; 3] = [BranchCheck::Preview, BranchCheck::Passed, BranchCheck::NotRun];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            BranchCheck::Preview => "preview",
            BranchCheck::Passed => "passed",
            BranchCheck::NotRun => "not-run",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
pub enum BranchPublicationState {
    #[serde(rename = "open")]
    Open,
}

impl BranchPublicationState {
    pub const ALL: [BranchPublicationState; 1] = [BranchPublicationState::Open];

    /// The string on the wire.
    pub fn as_str(self) -> &'static str {
        match self {
            BranchPublicationState::Open => "open",
        }
    }
}

#[skip_serializing_none]
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct BranchPublication {
    pub platform: PublishPlatform,
    pub repository: String,
    pub branch: String,
    pub sha: String,
    pub base: String,
    pub check: BranchCheck,
    pub pushed: bool,
    pub url: Option<String>,
    pub number: Option<i64>,
    pub reused: Option<bool>,
    pub state: Option<BranchPublicationState>,
}

/// A repo the farm works in, and how many commits helpers made in it.
#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub path: String,
    pub commits: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub base: String,
    pub files: Vec<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub status: String,
    pub added: i64,
    pub removed: i64,
    pub patch: Option<String>,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct ReviewRevision {
    pub base_commit: String,
    pub tree: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct Changes {
    pub revision: Option<ReviewRevision>,
    pub since_review: Option<Vec<ChangedFile>>,
    pub repo: String,
    pub base: String,
    pub branch: Option<String>,
    pub commits: Vec<Commit>,
    pub files: Vec<ChangedFile>,
    pub uncommitted: Vec<UncommittedItem>,
    pub conflicts: Vec<String>,
    pub behind: i64,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoLanguageListInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoTemplateListInput {
    pub id: String,
}

#[skip_serializing_none]
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts-gen", derive(TS))]
#[cfg_attr(feature = "ts-gen", ts(optional_fields))]
#[serde(rename_all = "camelCase")]
pub struct RepoActivityGetInput {
    pub id: String,
}

#[cfg(feature = "ts-gen")]
crate::typescript::module! {
    "repo";
    types: [GitHubAuthMode,
    GitHubStatus,
    DayCount,
    Author,
    RepoActivity,
    LanguageCount,
    RepoLanguages,
    RepoStack,
    TemplateBlank,
    IssueTemplate,
    TemplateKind,
    RepoTemplates,
    PullRequestCapability,
    RepoSummary,
    RepoHealthStatus,
    RepoHealthReason,
    RepoHealth,
    NewRepo,
    MountRepo,
    RepoUnmountInput,
    Commit,
    UncommittedItem,
    SubmitBranch,
    PublishPlatform,
    BranchCheck,
    BranchPublicationState,
    BranchPublication,
    Repo,
    Conflict,
    ChangedFile,
    ReviewRevision,
    Changes,
    RepoLanguageListInput,
    RepoTemplateListInput,
    RepoActivityGetInput];
    aliases: [];
}
