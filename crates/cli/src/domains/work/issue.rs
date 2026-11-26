//! `issue list|show|watch|create|edit|status|comment|review|diff|timeline|delete`.

use std::collections::HashMap;
use std::time::Duration;

use clap::{ArgGroup, Args, Subcommand, ValueEnum};
use tokio_util::sync::CancellationToken;
use vibevalley_protocol::{
    ActWords, ActorRef, AppliedIssue, BoardSlice, Changes, Issue, IssueAction, IssueCommentCreateInput, IssueDeleteInput, IssueDiffGetInput, IssueFilter,
    IssueGetInput, IssueRequest, IssueReviewInput, IssueStageKind, IssueStatus, IssueStatusUpdateInput, IssueTimelineGetInput, IssueUpdateInput, IssueWatch,
    Priority, ReviewRevision, ops,
};

use crate::client::{Client, Done, Failure, decode_failure, exit};
use crate::output::{issue_ref, line, minute_of, out, read_text_input, url_segment};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum IssueStatusArg {
    Backlog,
    Todo,
    #[value(name = "in_progress")]
    InProgress,
    #[value(name = "in_review")]
    InReview,
    Done,
    Canceled,
}

impl From<IssueStatusArg> for IssueStatus {
    fn from(value: IssueStatusArg) -> Self {
        match value {
            IssueStatusArg::Backlog => IssueStatus::Backlog,
            IssueStatusArg::Todo => IssueStatus::Todo,
            IssueStatusArg::InProgress => IssueStatus::InProgress,
            IssueStatusArg::InReview => IssueStatus::InReview,
            IssueStatusArg::Done => IssueStatus::Done,
            IssueStatusArg::Canceled => IssueStatus::Canceled,
        }
    }
}

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum PriorityArg {
    Urgent,
    High,
    Medium,
    Low,
}

impl From<PriorityArg> for Priority {
    fn from(value: PriorityArg) -> Self {
        match value {
            PriorityArg::Urgent => Priority::Urgent,
            PriorityArg::High => Priority::High,
            PriorityArg::Medium => Priority::Medium,
            PriorityArg::Low => Priority::Low,
        }
    }
}

#[derive(Debug, Args)]
#[command(arg_required_else_help = true, subcommand_required = true)]
pub struct IssueCmd {
    #[command(subcommand)]
    pub action: IssueActionCmd,
}

#[derive(Debug, Subcommand)]
pub enum IssueActionCmd {
    /// List issues with optional filters
    #[command(after_help = "Examples:\n  vibevalley issue list\n  vibevalley issue list --wants-user\n  vibevalley issue list --status in_review --json")]
    List {
        /// Filter by status
        #[arg(long, value_enum)]
        status: Option<IssueStatusArg>,
        /// Filter by repository name
        #[arg(long)]
        repo: Option<String>,
        /// Filter by title/description substring
        #[arg(long)]
        text: Option<String>,
        /// Only show issues waiting on user action
        #[arg(long)]
        wants_user: bool,
        /// Include closed (done/canceled) issues
        #[arg(long)]
        closed: bool,
        /// Maximum number of issues to print
        #[arg(long, default_value_t = 20)]
        limit: i64,
    },
    /// Show an issue's details, criteria, questions, and next actions
    #[command(after_help = "Examples:\n  vibevalley issue show 12\n  vibevalley issue show 12 --watch --timeout 600")]
    Show {
        /// Issue number or id (e.g. 12 or #12)
        issue: String,
        /// Wait until the issue needs user action or settles before printing
        #[arg(long)]
        watch: bool,
        /// Maximum seconds to wait with --watch
        #[arg(long)]
        timeout: Option<i64>,
    },
    /// Stream live issue state and worker trajectory events (use --json for JSONL)
    #[command(after_help = "Examples:\n  vibevalley issue watch 12\n  vibevalley issue watch 12 --json --follow")]
    Watch {
        /// Issue number or id
        issue: String,
        /// Keep streaming after the issue settles
        #[arg(long)]
        follow: bool,
    },
    /// Create a new issue
    #[command(after_help = "Examples:\n  vibevalley issue create Fix login redirect --repo web --priority high")]
    Create {
        /// Issue title
        #[arg(required = true, num_args = 1..)]
        title: Vec<String>,
        /// Description text, '-' for stdin, or '@file'
        #[arg(long)]
        description: Option<String>,
        /// Repository name
        #[arg(long)]
        repo: Option<String>,
        /// Assigned agent profile id
        #[arg(long)]
        agent: Option<String>,
        /// Final owner ('self', 'user:<id>', or 'agent:<id>')
        #[arg(long)]
        owner: Option<String>,
        /// Priority level
        #[arg(long, value_enum)]
        priority: Option<PriorityArg>,
        /// Acceptance criterion (repeatable)
        #[arg(long)]
        criterion: Vec<String>,
        /// Blocker issue number or id (repeatable)
        #[arg(long)]
        blocked_by: Vec<String>,
        /// Uploaded attachment id (repeatable)
        #[arg(long)]
        attach: Vec<String>,
        /// Idempotency key
        #[arg(long)]
        key: Option<String>,
    },
    /// Edit an existing issue
    #[command(after_help = "Examples:\n  vibevalley issue edit 12 --priority high --title 'New title'")]
    Edit {
        /// Issue number or id
        issue: String,
        /// New title
        #[arg(long)]
        title: Option<String>,
        /// New description text, '-' for stdin, or '@file'
        #[arg(long)]
        description: Option<String>,
        /// New repository name
        #[arg(long)]
        repo: Option<String>,
        /// New assigned agent profile id
        #[arg(long)]
        agent: Option<String>,
        /// New final owner ('self', 'user:<id>', 'agent:<id>', or '' to clear)
        #[arg(long)]
        owner: Option<String>,
        /// New priority level
        #[arg(long, value_enum)]
        priority: Option<PriorityArg>,
        /// Replace acceptance criteria (repeatable)
        #[arg(long)]
        criterion: Vec<String>,
        /// Replace blocker issue numbers or ids (repeatable)
        #[arg(long)]
        blocked_by: Vec<String>,
        /// Clear all blockers
        #[arg(long, conflicts_with = "blocked_by")]
        clear_blocked_by: bool,
        /// Replace attachments with uploaded attachment ids (repeatable)
        #[arg(long)]
        attach: Vec<String>,
    },
    /// Transition an issue to a new status
    #[command(after_help = "Examples:\n  vibevalley issue status 12 todo\n  vibevalley issue status 12 done --dry-run")]
    Status {
        /// Issue number or id
        issue: String,
        /// Target status
        #[arg(value_enum)]
        status: IssueStatusArg,
        /// Optional comment attached to the transition
        #[arg(long)]
        comment: Option<String>,
    },
    /// Post a comment or answer an issue's open question
    #[command(after_help = "Examples:\n  vibevalley issue comment 12 Use port 8790")]
    Comment {
        /// Issue number or id
        issue: String,
        /// Comment body
        #[arg(required = true, num_args = 1..)]
        words: Vec<String>,
    },
    /// Record a review verdict (--pass or --fail) on an issue
    #[command(
        group = ArgGroup::new("verdict").required(true).multiple(false),
        after_help = "Examples:\n  vibevalley issue review 12 --pass\n  vibevalley issue review 12 --fail --finding 'Missing test'"
    )]
    Review {
        /// Issue number or id
        issue: String,
        /// Mark the review as passed
        #[arg(long, group = "verdict")]
        pass: bool,
        /// Mark the review as failed
        #[arg(long, group = "verdict")]
        fail: bool,
        /// Review finding (repeatable)
        #[arg(long)]
        finding: Vec<String>,
        /// Optional review comment
        #[arg(long)]
        comment: Option<String>,
        /// Base commit SHA for reviewed revision (requires --tree and --pass)
        #[arg(long, requires = "tree", requires = "pass")]
        base_commit: Option<String>,
        /// Tree SHA for reviewed revision (requires --base-commit and --pass)
        #[arg(long, requires = "base_commit", requires = "pass")]
        tree: Option<String>,
    },
    /// Show commits and changed files in an issue's worktree
    #[command(after_help = "Examples:\n  vibevalley issue diff 12")]
    Diff {
        /// Issue number or id
        issue: String,
        /// Optional tree SHA to diff against
        #[arg(long)]
        since_tree: Option<String>,
    },
    /// Show an issue's milestone timeline and token spend
    #[command(after_help = "Examples:\n  vibevalley issue timeline 12")]
    Timeline {
        /// Issue number or id
        issue: String,
    },
    /// Delete an issue
    #[command(after_help = "Examples:\n  vibevalley issue delete 12 --dry-run")]
    Delete {
        /// Issue number or id
        issue: String,
    },
}

fn summary_line(number: i64, status: IssueStatus, title: &str, agent: Option<&str>, repo: Option<&str>) -> String {
    let agent = agent.map(|a| format!("@{a}")).unwrap_or_default();
    let repo = repo.map(|r| format!("[{r}]")).unwrap_or_default();
    line(&[&format!("#{number}"), status.as_str(), title, &agent, &repo])
}

fn issue_line(issue: &Issue) -> String {
    let agent = issue.assignments.last().map(|a| a.agent.as_str());
    summary_line(issue.number, issue.status, &issue.title, agent, issue.repo.as_deref())
}

fn applied_line(applied: &AppliedIssue) -> String {
    let agent = applied.assignments.last().map(|a| a.agent.as_str());
    summary_line(applied.number, applied.status, &applied.title, agent, applied.repo.as_deref())
}

fn doable(issue: &Issue) -> Vec<String> {
    let session = issue.latest_session_id().map(String::as_str);
    issue
        .stage
        .acts
        .iter()
        .filter_map(|act| {
            let (mut run, words) = vibevalley_core::rules::act_command(issue, act, session)?;
            if words == ActWords::Required {
                if matches!(act, IssueAction::Move { .. }) {
                    run.extend(["--comment".into(), "…".into()]);
                } else {
                    run.push("…".into());
                }
            }
            Some(run.join(" "))
        })
        .collect()
}

fn format_owner(owner: Option<&ActorRef>) -> String {
    match owner {
        Some(ActorRef::User { id }) => format!("user:{id}"),
        Some(ActorRef::Agent { id }) => format!("agent:{id}"),
        None => String::new(),
    }
}

fn parse_actor_ref(raw: &str) -> Result<ActorRef, Failure> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(ActorRef::User { id: String::new() });
    }
    if trimmed == "self" {
        return Ok(ActorRef::self_user());
    }
    if let Some((kind, id)) = trimmed.split_once(':') {
        let id = id.trim().to_string();
        return match kind.trim() {
            "user" => Ok(ActorRef::User { id }),
            "agent" => Ok(ActorRef::Agent { id }),
            other => Err(Failure::new(
                exit::OTHER,
                "InvalidOwner",
                format!("invalid owner kind '{other}': expected 'user:<id>', 'agent:<id>', or 'self'"),
            )),
        };
    }
    Err(Failure::new(
        exit::OTHER,
        "InvalidOwner",
        format!("invalid owner '{trimmed}': expected 'user:<id>', 'agent:<id>', or 'self'"),
    ))
}

fn issue_text(issue: &Issue) -> String {
    let agent = issue.assignments.last().map(|a| format!("@{}", a.agent)).unwrap_or_default();
    let repo = issue.repo.as_ref().map(|r| format!("[{r}]")).unwrap_or_default();
    let owner = format_owner(issue.owner.as_ref());
    let stage = match &issue.stage.stuck {
        Some(stuck) => format!("{} ({})", issue.stage.state.as_str(), stuck.as_str()),
        None => issue.stage.state.as_str().to_string(),
    };
    let mut lines = vec![
        format!("#{}  {}", issue.number, issue.title),
        line(&[issue.status.as_str(), issue.priority.as_str(), &repo, &agent]),
        format!("stage: {stage}"),
    ];
    if !owner.is_empty() {
        lines.push(format!("owner: {owner}"));
    }
    if !issue.blocked_by.is_empty() {
        lines.push(format!("blocked_by: {}", issue.blocked_by.join(", ")));
    }
    if !issue.description.trim().is_empty() {
        lines.extend([String::new(), issue.description.trim().to_string()]);
    }
    if !issue.criteria.is_empty() {
        lines.extend([String::new(), "criteria:".into()]);
        lines.extend(issue.criteria.iter().enumerate().map(|(idx, c)| format!("  {}. {c}", idx + 1)));
    }
    if !issue.attachments.is_empty() {
        lines.extend([String::new(), "attachments:".into()]);
        lines.extend(issue.attachments.iter().map(|a| format!("  {}  {} ({}, {}B)", a.id, a.name, a.r#type, a.size)));
    }
    if !issue.questions.is_empty() {
        lines.extend([String::new(), "questions:".into()]);
        lines.extend(issue.questions.iter().map(|q| {
            let options = if q.options.is_empty() {
                String::new()
            } else {
                format!("  ({})", q.options.join(" | "))
            };
            format!("  ? {}{options}", q.question)
        }));
    }
    let can = doable(issue);
    if !can.is_empty() {
        lines.extend([String::new(), "next:".into()]);
        lines.extend(can.iter().map(|c| format!("  vibevalley {c}")));
    }
    lines.join("\n")
}

fn changes_text(changes: &Changes) -> String {
    let mut lines: Vec<String> = changes
        .commits
        .iter()
        .map(|c| format!("{}  {}", &c.hash[..c.hash.len().min(7)], c.subject))
        .collect();
    lines.extend(
        changes
            .files
            .iter()
            .map(|f| format!("  {}  {}  +{} -{}", f.status.as_str(), f.path, f.added, f.removed)),
    );
    if !changes.conflicts.is_empty() {
        lines.push(format!("conflicts: {}", changes.conflicts.join(", ")));
    }
    if lines.is_empty() { "no changes".into() } else { lines.join("\n") }
}

fn load_description(raw: Option<String>) -> Result<Option<String>, Failure> {
    match raw {
        None => Ok(None),
        Some(value) => Ok(Some(read_text_input(&value)?).filter(|s| !s.is_empty())),
    }
}

pub async fn run(client: &Client, cmd: IssueCmd) -> Done {
    match cmd.action {
        IssueActionCmd::List {
            status,
            repo,
            text,
            wants_user,
            closed,
            limit,
        } => {
            let limit = limit.max(1);
            let filter = IssueFilter {
                limit: Some(limit + 1),
                status: status.map(Into::into),
                repo,
                text,
                wants_user: wants_user.then_some(true),
                closed: closed.then_some(true),
            };
            let issues = client.ask::<ops::IssueList>(&filter).await?;
            let shown: Vec<Issue> = issues.iter().take(limit as usize).cloned().collect();
            client.output.show(&shown, |list| {
                let mut lines: Vec<String> = list.iter().map(issue_line).collect();
                if issues.len() as i64 > limit {
                    lines.push(format!("more available: pass --limit {}", limit * 2));
                }
                if lines.is_empty() { "no issues".into() } else { lines.join("\n") }
            });
            Ok(())
        }
        IssueActionCmd::Show { issue, watch, timeout } => {
            let found = client.ask::<ops::IssueGet>(&IssueGetInput { id: issue_ref(&issue) }).await?;
            if !watch {
                client.output.show(&found, issue_text);
                return Ok(());
            }
            wait_for_issue(client, &found, timeout).await?;
            let updated = client.ask::<ops::IssueGet>(&IssueGetInput { id: found.id }).await?;
            client.output.show(&updated, issue_text);
            Ok(())
        }
        IssueActionCmd::Watch { issue, follow } => {
            let found = client.ask::<ops::IssueGet>(&IssueGetInput { id: issue_ref(&issue) }).await?;
            observe(client, &found.id, follow).await
        }
        IssueActionCmd::Create {
            title,
            description,
            repo,
            agent,
            owner,
            priority,
            criterion,
            blocked_by,
            attach,
            key,
        } => {
            let owner = owner.as_deref().map(parse_actor_ref).transpose()?;
            let blocked_by = (!blocked_by.is_empty()).then(|| blocked_by.into_iter().map(|b| issue_ref(&b)).collect());
            let request = IssueRequest {
                title: title.join(" "),
                description: load_description(description)?,
                repo,
                agent,
                owner,
                priority: priority.map(Into::into),
                criteria: (!criterion.is_empty()).then_some(criterion),
                blocked_by,
                attachments: (!attach.is_empty()).then_some(attach),
                request_key: key,
                ..Default::default()
            };
            client.mutate::<ops::IssueCreate>("issue create", &request, applied_line).await
        }
        IssueActionCmd::Edit {
            issue,
            title,
            description,
            repo,
            agent,
            owner,
            priority,
            criterion,
            blocked_by,
            clear_blocked_by,
            attach,
        } => {
            let owner = owner.as_deref().map(parse_actor_ref).transpose()?;
            let blocked_by = if clear_blocked_by {
                Some(Vec::new())
            } else if !blocked_by.is_empty() {
                Some(blocked_by.into_iter().map(|b| issue_ref(&b)).collect())
            } else {
                None
            };
            let request = IssueUpdateInput {
                id: issue_ref(&issue),
                title,
                description: load_description(description)?,
                repo,
                agent,
                owner,
                priority: priority.map(Into::into),
                criteria: (!criterion.is_empty()).then_some(criterion),
                blocked_by,
                attachments: (!attach.is_empty()).then_some(attach),
                ..Default::default()
            };
            client.mutate::<ops::IssueUpdate>("issue edit", &request, applied_line).await
        }
        IssueActionCmd::Status { issue, status, comment } => {
            let request = IssueStatusUpdateInput {
                revision: None,
                id: issue_ref(&issue),
                status: status.into(),
                text: comment,
                agent: None,
                edit: None,
                request_key: None,
            };
            client.mutate::<ops::IssueStatusUpdate>("issue status", &request, applied_line).await
        }
        IssueActionCmd::Comment { issue, words } => {
            let id = issue_ref(&issue);
            let request = IssueCommentCreateInput {
                id: id.clone(),
                text: words.join(" "),
                ..Default::default()
            };
            client
                .mutate::<ops::IssueCommentCreate>("issue comment", &request, |_| format!("commented on #{id}"))
                .await
        }
        IssueActionCmd::Review {
            issue,
            pass,
            fail: _,
            finding,
            comment,
            base_commit,
            tree,
        } => {
            let revision = base_commit.zip(tree).map(|(base_commit, tree)| ReviewRevision { base_commit, tree });
            let request = IssueReviewInput {
                revision,
                id: issue_ref(&issue),
                pass,
                findings: (!finding.is_empty()).then_some(finding),
                text: comment,
            };
            client.mutate::<ops::IssueReview>("issue review", &request, issue_line).await
        }
        IssueActionCmd::Diff { issue, since_tree } => {
            let changes = client
                .ask::<ops::IssueDiffGet>(&IssueDiffGetInput {
                    id: issue_ref(&issue),
                    since_tree,
                })
                .await?;
            client.output.show(&changes, changes_text);
            Ok(())
        }
        IssueActionCmd::Timeline { issue } => {
            let timeline = client.ask::<ops::IssueTimelineGet>(&IssueTimelineGetInput { id: issue_ref(&issue) }).await?;
            client.output.show(&timeline, |tl| {
                let mut lines: Vec<String> = tl
                    .milestones
                    .iter()
                    .map(|m| {
                        let who = m.who.as_deref().unwrap_or_default();
                        let run = m.run.as_deref().unwrap_or_default();
                        let detail = match &m.said {
                            Some(said) if !said.is_empty() => format!("{}: {said}", m.text),
                            _ => m.text.clone(),
                        };
                        line(&[&minute_of(m.at), m.kind.as_str(), who, run, &detail])
                    })
                    .collect();
                if let Some(spent) = &tl.spent {
                    let cny = spent.cny.map(|c| format!("{:.2}", c.0)).unwrap_or_else(|| "-".into());
                    lines.push(format!("spent: {} tokens (¥{cny})", spent.tokens));
                }
                lines.join("\n")
            });
            Ok(())
        }
        IssueActionCmd::Delete { issue } => {
            let id = issue_ref(&issue);
            client
                .mutate::<ops::IssueDelete>("issue delete", &IssueDeleteInput { id: id.clone() }, |_| format!("deleted #{id}"))
                .await
        }
    }
}

async fn wait_for_issue(client: &Client, issue: &Issue, timeout: Option<i64>) -> Done {
    let mut last: Option<(IssueStatus, IssueStageKind)> = None;
    let res = client
        .sse("/api/v1/slice/board", timeout.map(|s| Duration::from_secs(s.max(0) as u64)), async |data| {
            let slice: BoardSlice = serde_json::from_str(data).map_err(decode_failure)?;
            let Some(now) = slice.issues.into_iter().find(|i| i.id == issue.id) else {
                return Err(Failure::new(exit::MISSING, "Missing", format!("issue #{} was removed", issue.number)));
            };
            let state = (now.status, now.stage.state);
            if last == Some(state) {
                return Ok(true);
            }
            last = Some(state);
            eprintln!(
                "{}",
                serde_json::json!({ "issue": issue.number, "status": now.status, "stage": now.stage.state })
            );
            let settled = matches!(now.status, IssueStatus::InReview | IssueStatus::Done | IssueStatus::Canceled);
            Ok(!(settled || now.stage.state.wants_user()))
        })
        .await;
    match res {
        Err(f) if f.tag == "Timeout" => Err(Failure::new(
            exit::OTHER,
            "Timeout",
            format!("timed out waiting for #{} after {}s", issue.number, timeout.unwrap_or(0)),
        )),
        other => other,
    }
}

const OBSERVE_RETRY_MIN: Duration = Duration::from_secs(1);
const OBSERVE_RETRY_MAX: Duration = Duration::from_secs(8);

fn observe_reconnect_delay(attempt: u32) -> Duration {
    let shift = attempt.min(3);
    OBSERVE_RETRY_MIN.saturating_mul(1u32 << shift).min(OBSERVE_RETRY_MAX)
}

async fn wait_observe_retry(delay: Duration, cancel: &CancellationToken) -> bool {
    tokio::select! {
        biased;
        () = cancel.cancelled() => false,
        () = tokio::time::sleep(delay) => true,
    }
}

async fn observe(client: &Client, id: &str, follow: bool) -> Done {
    let mut seen: HashMap<String, HashMap<i64, i64>> = HashMap::new();
    let mut previous = String::new();
    let mut gaps: HashMap<String, String> = HashMap::new();
    let mut unreachable_attempts: u32 = 0;
    let path = format!("/api/v1/issue/watch/{}", url_segment(id));
    loop {
        let mut received_event = false;
        let res = client
            .sse(&path, None, async |data| {
                received_event = true;
                let row: IssueWatch = serde_json::from_str(data).map_err(|e| Failure::new(exit::OTHER, "WatchProtocol", e.to_string()))?;
                let rows = match row {
                    IssueWatch::History { session, events } => events
                        .into_iter()
                        .map(|event| IssueWatch::Event {
                            session: session.clone(),
                            event,
                        })
                        .collect(),
                    other => vec![other],
                };
                for row in rows {
                    let fresh = match &row {
                        IssueWatch::Event { session, event } => {
                            let revisions = seen.entry(session.clone()).or_default();
                            let newer = revisions.get(&event.seq).is_none_or(|r| *r < event.revision);
                            if newer {
                                revisions.insert(event.seq, event.revision);
                            }
                            newer
                        }
                        IssueWatch::Gap { session, .. } => {
                            let printed = serde_json::to_string(&row).unwrap_or_default();
                            gaps.insert(session.clone(), printed.clone()).as_ref() != Some(&printed)
                        }
                        IssueWatch::State { session_ids, .. } => {
                            seen.retain(|s, _| session_ids.contains(s));
                            gaps.retain(|s, _| session_ids.contains(s));
                            let printed = serde_json::to_string(&row).unwrap_or_default();
                            std::mem::replace(&mut previous, printed.clone()) != printed
                        }
                        IssueWatch::Missing { .. } | IssueWatch::History { .. } => true,
                    };
                    if !fresh {
                        continue;
                    }
                    if client.output.json {
                        let mut value = serde_json::to_value(&row).unwrap_or_default();
                        value["version"] = 1.into();
                        out(&value.to_string());
                    } else {
                        out(&watch_text(&row));
                    }
                    match &row {
                        IssueWatch::Missing { .. } => return Ok(false),
                        IssueWatch::State { settled: true, .. } if !follow => return Ok(false),
                        _ => {}
                    }
                }
                Ok(true)
            })
            .await;
        if received_event {
            unreachable_attempts = 0;
        }
        match res {
            Ok(()) => return Ok(()),
            Err(f) if f.tag == "Unreachable" => {
                let delay = observe_reconnect_delay(unreachable_attempts);
                unreachable_attempts = unreachable_attempts.saturating_add(1);
                let cancel = CancellationToken::new();
                let interrupted = tokio::select! {
                    biased;
                    _ = tokio::signal::ctrl_c() => {
                        cancel.cancel();
                        true
                    }
                    cont = wait_observe_retry(delay, &cancel) => !cont,
                };
                if interrupted {
                    return Ok(());
                }
            }
            Err(f) => return Err(f),
        }
    }
}

fn watch_text(row: &IssueWatch) -> String {
    match row {
        IssueWatch::Event { session, event } => {
            let mut parts = vec![session.clone(), format!("{}.{}", event.seq, event.revision), event.r#type.as_str().to_string()];
            for p in [&event.action_text, &Some(event.text.clone()), &event.input, &event.output] {
                if let Some(p) = p.as_ref().filter(|p| !p.is_empty()) {
                    parts.push(p.clone());
                }
            }
            if let Some(ok) = event.ok {
                parts.push(ok.to_string());
            }
            parts.join(" ")
        }
        IssueWatch::Gap { session, before: None } => format!("gap: {session} trajectory unavailable"),
        IssueWatch::Gap { session, before: Some(b) } => format!("gap: {session} events omitted before seq {b}"),
        IssueWatch::Missing { issue } => format!("missing: {issue}"),
        IssueWatch::State {
            issue,
            sessions,
            omitted_sessions,
            ..
        } => {
            let state = serde_json::json!({
                "stage": issue.stage,
                "pullRequest": issue.pull_request,
                "delivered": issue.delivered,
                "questions": issue.questions,
                "sessions": sessions.iter().map(|s| serde_json::json!({ "id": s.id, "phase": s.phase, "toolConnections": s.tool_connections })).collect::<Vec<_>>(),
                "omittedSessions": omitted_sessions,
            });
            format!("#{} {}\n{state}", issue.number, issue.stage.state.as_str())
        }
        IssueWatch::History { .. } => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn observe_retry_backoff_caps_and_cancels_on_virtual_clock() {
        assert_eq!(observe_reconnect_delay(0), Duration::from_secs(1));
        assert_eq!(observe_reconnect_delay(1), Duration::from_secs(2));
        assert_eq!(observe_reconnect_delay(2), Duration::from_secs(4));
        assert_eq!(observe_reconnect_delay(3), Duration::from_secs(8));
        assert_eq!(observe_reconnect_delay(20), Duration::from_secs(8));

        let wall = std::time::Instant::now();
        let t0 = tokio::time::Instant::now();
        let cancel = CancellationToken::new();
        let child = cancel.child_token();
        let task = tokio::spawn(async move { wait_observe_retry(observe_reconnect_delay(3), &child).await });
        tokio::task::yield_now().await;
        tokio::time::advance(Duration::from_secs(7)).await;
        tokio::task::yield_now().await;
        assert!(!task.is_finished());

        tokio::time::advance(Duration::from_secs(1)).await;
        assert!(task.await.unwrap());
        assert_eq!(t0.elapsed(), Duration::from_secs(8));

        let c2 = cancel.child_token();
        let task2 = tokio::spawn(async move { wait_observe_retry(observe_reconnect_delay(2), &c2).await });
        tokio::task::yield_now().await;
        cancel.cancel();
        assert!(!task2.await.unwrap());
        assert!(wall.elapsed() < Duration::from_secs(1));
    }
}
