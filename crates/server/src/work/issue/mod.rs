//! Issues: the board (`board.rs`: create, move, tell, queue, deliver,
//! close; `edits.rs`: fields, delete, review; `family.rs`: split and join;
//! `refine.rs`: drafting) and the `issue.*` endpoints on it, with the parts
//! of settling and `nextSteps` the board does not do itself. Refusals carry
//! VibeValley's words and codes.

mod board;
pub(crate) mod db;
mod edits;
mod family;
mod refine;

pub use board::{IssueStore, NewIssue, Sent};
pub use db::SqliteIssueStore;
pub use family::{ChildDraft, MAX_CHILDREN};

use std::path::PathBuf;
use std::sync::Arc;

use vibevalley_core::Clock;
use vibevalley_core::Move;
use vibevalley_core::brief::{findings_of, milestones_of, resume_words};
use vibevalley_core::rules::short_title;
use vibevalley_i18n::{Params, t};
use vibevalley_protocol::{
    ActWords, ApiError, Applied, AppliedIssue, BizCode, Caller, ChangedFile, Changes, Commit, Issue, IssueAction, IssueFilter, IssueHistory, IssueRefineInput,
    IssueRequest, IssueReviewInput, IssueSplitInput, IssueStageKind, IssueStatus, IssueStatusPreviewUpdateInput, IssueStatusUpdateInput, IssueTimeline,
    IssueUpdate, IssueUpdateInput, Next, Preview, Run, Session, StuckReason, UncommittedItem,
};

use crate::app::port::ChannelAnnouncePort;
use crate::app::refusal::LookIn;
use crate::team::agent::AgentStore;
use crate::work::ledger::{BoardError, Undelivered};

fn refused(key: &str, params: Params) -> ApiError {
    ApiError::new(BizCode::IssueRefused, t(key, params))
}

fn look_in_issues() -> Next {
    Next {
        say: t("server.lookIn.issue", &[]),
        run: Some(vec!["issue".into(), "list".into()]),
    }
}

/// A board error as the endpoint refuses with it.
fn api(board: &IssueStore, e: BoardError) -> ApiError {
    match e {
        BoardError::NoIssue(r) => ApiError::new(BizCode::IssueNotFound, t("server.issue.issueRef", &[("ref", r.into())])).with_next(vec![look_in_issues()]),
        BoardError::Refused(r) => ApiError::new(BizCode::IssueRefused, r.text()),
        BoardError::WordsRequired => refused("server.issue.roundNeedsWords", &[]),
        BoardError::NotDelivered(Undelivered::Conflict { base, files }) => refused(
            "server.issue.does.conflicts",
            &[("base", base.into()), ("files", vibevalley_i18n::list(&files).into())],
        ),
        BoardError::Store(e) => ApiError::new(BizCode::InternalError, e.to_string()),
        BoardError::Api(e) => e,
        other => {
            let _ = board;
            ApiError::new(BizCode::IssueRefused, other.to_string())
        }
    }
}

/// `get`: by id, number or `#number`, else IssueNotFound.
async fn get_async(board: &IssueStore, reference: &str) -> Result<Issue, ApiError> {
    board
        .issue_async(reference)
        .await
        .map_err(|e| api(board, e))?
        .ok_or_else(|| api(board, BoardError::NoIssue(reference.to_string())))
}

/// `nextSteps`: what the user can do with the issue, as words and commands.
pub fn next_steps(item: &Issue) -> Vec<Next> {
    let n = item.number.to_string();
    let session = item.latest_session_id().map(String::as_str);
    let mut out: Vec<Next> = item
        .stage
        .acts
        .iter()
        .filter_map(|a| {
            let label = t(&format!("shared.act.{}", a.act().as_str()), &[]);
            let (run, words) = vibevalley_core::rules::act_command(item, a, session)?;
            if words == ActWords::Required {
                let tail = if matches!(a, IssueAction::Move { .. }) {
                    vec!["--comment", "…"]
                } else {
                    vec!["…"]
                };
                let command = run.iter().map(String::as_str).chain(tail).collect::<Vec<_>>().join(" ");
                return Some(Next {
                    say: t("server.issue.move.withWords", &[("say", label.into()), ("command", command.into())]),
                    run: None,
                });
            }
            Some(Next { say: label, run: Some(run) })
        })
        .collect();
    let pressed: Vec<IssueStatus> = item
        .stage
        .acts
        .iter()
        .filter_map(|a| match a {
            IssueAction::Move { status, .. } => Some(*status),
            _ => None,
        })
        .collect();
    for to in vibevalley_core::status_moves(item).into_iter().filter(|to| !pressed.contains(to)) {
        let say = t(
            "server.issue.move.moveTo",
            &[("status", t(&format!("shared.status.{}", to.as_str()), &[]).into())],
        );
        let run = vec!["issue".to_string(), "status".into(), n.clone(), to.as_str().into()];
        out.push(if vibevalley_core::status_move(item, to) == Ok(Move::Round) {
            let command = run.iter().map(String::as_str).chain(["--comment", "…"]).collect::<Vec<_>>().join(" ");
            Next {
                say: t("server.issue.move.roundWithText", &[("say", say.into()), ("command", command.into())]),
                run: None,
            }
        } else {
            Next { say, run: Some(run) }
        });
    }
    out
}

/// A move settled before anything changes (`settledMove`).
struct Settled {
    mv: Move,
    said: String,
}

fn settle(item: &Issue, to: IssueStatus, text: &str) -> Result<Settled, ApiError> {
    let mv = vibevalley_core::status_move(item, to).map_err(|r| ApiError::new(BizCode::IssueRefused, r.text()).with_next(next_steps(item)))?;
    let said = text.trim().to_string();
    if mv == Move::Round && said.is_empty() && item.stage.state != IssueStageKind::Stuck {
        return Err(refused("server.issue.roundNeedsWords", &[]));
    }
    if mv == Move::Round && said.is_empty() && item.stage.stuck == Some(StuckReason::Quiet) {
        return Err(refused("server.issue.roundNeedsWords", &[]));
    }
    if mv == Move::Complete && item.deliver == vibevalley_protocol::Deliverable::PullRequest && item.pull_request.is_none() {
        return Err(refused("server.issue.deliveryNeedsPr", &[]));
    }
    Ok(Settled { mv, said })
}

async fn helper_name_async(board: &IssueStore, item: &Issue) -> String {
    match item.latest_session_id() {
        Some(s) => board.session_async(s).await.map(|s| s.name).unwrap_or_else(|| t("server.issue.helper", &[])),
        None => t("server.issue.helper", &[]),
    }
}

/// `movesWords`: a settled move in words, one step a line.
async fn moves_words_async(board: &IssueStore, agents: Option<&AgentStore>, item: &Issue, s: &Settled) -> Result<Vec<String>, ApiError> {
    let name = match (agents, s.mv) {
        // `readyOf`: what starting it would refuse, its preview refuses.
        (Some(agents), Move::Start) => {
            let id = item.assigned_agent().map(str::trim).filter(|a| !a.is_empty());
            let pick = || {
                vec![
                    LookIn::Agent.next(),
                    Next {
                        say: t("server.issue.pickHint", &[("n", item.number.into())]),
                        run: None,
                    },
                ]
            };
            let Some(id) = id else {
                return Err(refused("server.issue.noAssignee", &[]).with_next(pick()));
            };
            let Some(profile) = agents.profiles.agent(id) else {
                return Err(refused("server.issue.profileGone", &[("id", id.into())]).with_next(pick()));
            };
            Some(profile.name)
        }
        _ => None,
    };
    Ok(move_lines_async(board, item, s, name).await)
}

async fn move_lines_async(board: &IssueStore, item: &Issue, s: &Settled, name: Option<String>) -> Vec<String> {
    let n = format!("#{}", item.number);
    let helper = helper_name_async(board, item).await;
    let agent = || name.clone().unwrap_or_else(|| item.assigned_agent().unwrap_or("claude").to_string());
    match s.mv {
        Move::Start => {
            let full = board.no_room_async(item).await;
            if !full.is_empty() {
                return vec![
                    t("server.issue.does.sendTo", &[("n", n.into()), ("agent", agent().into())]),
                    t("server.issue.does.noRoom", &[("full", full.into())]),
                ];
            }
            vec![match &item.repo {
                Some(repo) => t(
                    "server.issue.does.startIn",
                    &[("n", n.into()), ("agent", agent().into()), ("repo", repo.clone().into())],
                ),
                None => t("server.issue.does.start", &[("n", n.into()), ("agent", agent().into())]),
            }]
        }
        Move::Unqueue => vec![t("server.issue.does.unqueue", &[("n", n.into())])],
        Move::Round => {
            if s.said.is_empty() {
                let key = match item.stage.stuck {
                    Some(StuckReason::Conflict) => "server.issue.does.resolve",
                    Some(StuckReason::Interrupted) => "server.issue.does.resume",
                    _ => "server.issue.does.cure",
                };
                return vec![t(key, &[("helper", helper.into()), ("words", resume_words().into())])];
            }
            if item.stage.state == IssueStageKind::Reviewing {
                return vec![t(
                    "server.issue.does.reject",
                    &[
                        ("n", item.number.into()),
                        ("findings", findings_of(&s.said).len().into()),
                        ("helper", helper.into()),
                    ],
                )];
            }
            vec![t("server.issue.does.round", &[("helper", helper.into()), ("said", s.said.clone().into())])]
        }
        Move::Reopen => {
            let mut out = vec![t("server.issue.does.reopen", &[("n", n.into())])];
            if !s.said.is_empty() {
                out.push(t("server.issue.does.thisTime", &[("said", s.said.clone().into())]));
            }
            out
        }
        Move::Revive => vec![t("server.issue.does.revive", &[("n", n.into())])],
        Move::Complete => {
            let changes = match item.repo.as_ref() {
                Some(_) => board.changes_async(&item.id).await.ok(),
                None => None,
            };
            let commits = changes.as_ref().map(|c| c.commits.len()).unwrap_or(0);
            if commits == 0 || item.deliver == vibevalley_protocol::Deliverable::Answer {
                return vec![
                    t("server.issue.does.completeNone", &[("n", n.into())]),
                    t("server.issue.does.helperLeaves", &[("helper", helper.into())]),
                ];
            }
            if matches!(
                item.deliver,
                vibevalley_protocol::Deliverable::Branch | vibevalley_protocol::Deliverable::PullRequest
            ) || vibevalley_core::pr::goes_by_pull_request(item, false)
            {
                return vec![
                    t("server.issue.does.completeKept", &[("n", n.into()), ("commits", commits.into())]),
                    t("server.issue.does.helperLeaves", &[("helper", helper.into())]),
                ];
            }
            let mut out = Vec::new();
            let Some(c) = changes else { return out };
            if !c.uncommitted.is_empty() {
                out.push(t(
                    "server.issue.does.commitFirst",
                    &[("helper", helper.into()), ("files", c.uncommitted.len().into())],
                ));
            }
            if !c.conflicts.is_empty() {
                let files: Vec<String> = c.conflicts.iter().map(|f| f.to_string_lossy().into_owned()).collect();
                out.push(t(
                    "server.issue.does.conflicts",
                    &[("base", c.base.into()), ("files", vibevalley_i18n::list(&files).into())],
                ));
                return out;
            }
            out.push(t("server.issue.does.check", &[]));
            out.push(t(
                "server.issue.does.merge",
                &[("base", c.base.into()), ("commits", commits.into()), ("helper", helper.into())],
            ));
            out
        }
        Move::Cancel => vec![
            t("server.issue.does.cancel", &[("n", n.into())]),
            t("server.issue.does.cancelLeaves", &[("helper", helper.into())]),
        ],
        Move::Drop => {
            let mut out = vec![t("server.issue.does.drop", &[("n", n.into())])];
            if let Some(r) = &item.refining {
                out.push(t("server.issue.does.drafterLeaves", &[("name", r.name.clone().into())]));
            }
            out
        }
    }
}

fn resolve_agent(profiles: Option<&AgentStore>, agent: &str) -> String {
    let agent = agent.trim();
    match profiles {
        Some(agents) if !agent.is_empty() => agents.agent_key(agent),
        _ => agent.to_string(),
    }
}

pub(crate) async fn changes_of_async(board: &IssueStore, item: &Issue, since_tree: Option<&str>) -> Result<Changes, ApiError> {
    // A parent is worked through its children: their merges are its changes.
    let all_issues = board.issues_async().await.map_err(|e| api(board, e))?;
    let has_children = all_issues.iter().any(|i| i.parent.as_deref() == Some(item.id.as_str()));
    if item.repo.is_none() || !(item.was_sent() || has_children) {
        return Err(refused("server.issue.notStarted", &[]));
    }
    let c = board.changes_since_async(&item.id, since_tree).await.map_err(|e| api(board, e))?;
    let letter = |d: &vibevalley_git::FileDiff| -> String {
        use vibevalley_git::Change::*;
        match d.change {
            Added | Untracked => "A",
            Deleted => "D",
            Renamed => "R",
            Copied => "C",
            TypeChanged => "T",
            Conflicted => "U",
            _ => "M",
        }
        .into()
    };
    let path = |d: &vibevalley_git::FileDiff| -> String {
        d.new_path
            .as_ref()
            .or(d.old_path.as_ref())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let changed_file = |d: &vibevalley_git::FileDiff| ChangedFile {
        path: path(d),
        status: letter(d),
        added: if d.binary { -1 } else { d.added.into() },
        removed: if d.binary { -1 } else { d.removed.into() },
        patch: (!d.binary).then(|| patch_of(d, &path(d))),
    };
    Ok(Changes {
        repo: item.repo.clone().unwrap_or_default(),
        base: c.base.clone(),
        branch: Some(c.branch.clone()),
        commits: c
            .commits
            .iter()
            .map(|x| Commit {
                hash: x.short_id.clone(),
                subject: x.summary.clone(),
                at: x.time * 1000,
            })
            .collect(),
        revision: Some(c.revision.clone()),
        since_review: c.since_review.as_deref().map(|files| files.iter().map(&changed_file).collect()),
        files: c.files.iter().map(&changed_file).collect(),
        uncommitted: c
            .uncommitted
            .iter()
            .map(|d| UncommittedItem {
                path: path(d),
                status: letter(d),
            })
            .collect(),
        conflicts: c.conflicts.iter().map(|f| f.to_string_lossy().into_owned()).collect(),
        behind: c.behind as i64,
    })
}

/// A file's diff as `git diff` prints it.
fn patch_of(d: &vibevalley_git::FileDiff, path: &str) -> String {
    let mut out = format!("diff --git a/{path} b/{path}\n");
    for h in &d.hunks {
        out.push_str(&h.header);
        out.push('\n');
        for l in &h.lines {
            out.push(match l.kind {
                vibevalley_git::LineKind::Added => '+',
                vibevalley_git::LineKind::Removed => '-',
                _ => ' ',
            });
            out.push_str(&l.text);
            out.push('\n');
        }
    }
    out
}

/// `issue.review`: the verdict on what was handed back.
pub(crate) async fn review_async(board: &IssueStore, input: IssueReviewInput) -> Result<Issue, ApiError> {
    let item = get_async(board, &input.id).await?;
    if item.status != IssueStatus::InReview {
        return Err(refused("server.issue.nothingToAccept", &[]).with_next(next_steps(&item)));
    }
    board
        .review_async(
            &item.id,
            input.pass,
            &input.findings.unwrap_or_default(),
            input.text.as_deref().unwrap_or(""),
            input.revision.as_ref(),
        )
        .await
        .map_err(|e| api(board, e))
}

/// `issue.comment.create`: words to the issue's helper.
pub(crate) async fn comment_async(board: &IssueStore, id: &str, text: &str) -> Result<(), ApiError> {
    let item = get_async(board, id).await?;
    if item.status.is_closed() {
        return Err(refused("server.issue.closedReopen", &[]));
    }
    board.tell_async(&item.id, text).await.map_err(|e| api(board, e))
}

async fn split_async(board: &IssueStore, input: &IssueSplitInput) -> Result<String, ApiError> {
    let mut parent = get_async(board, &input.id).await?;
    if let Some(title) = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        parent = board
            .edit_async(
                &parent.id,
                &IssueUpdate {
                    title: Some(title.into()),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| api(board, e))?;
    }
    let drafts = input
        .tasks
        .iter()
        .map(|d| ChildDraft {
            id: d.id.clone(),
            title: d.title.clone().unwrap_or_default(),
            brief: d.brief.clone(),
            needs: d.needs.clone().unwrap_or_default(),
            acceptance: d.acceptance.unwrap_or(false),
            check: d.check.clone(),
            scope: d.scope.clone().unwrap_or_default(),
            agent: d.agent.clone().filter(|a| !a.trim().is_empty()),
        })
        .collect();
    let made = board.split_async(&parent.id, drafts).await.map_err(|e| api(board, e))?;
    let mut out = t("server.issue.split.created", &[("n", parent.number.into()), ("count", made.len().into())]);
    for child in made {
        out.push_str(&format!("\n{}: vv://issue/{}", child.title, child.id));
    }
    Ok(out)
}

impl IssueStore {
    pub(crate) async fn issue_list_endpoint_async(&self, filter: &IssueFilter, clock: &dyn Clock) -> Result<Vec<Issue>, ApiError> {
        let issues = self.issues_async().await.map_err(|e| api(self, e))?;
        Ok(vibevalley_core::pick_issues(&issues, filter, clock.now_ms()))
    }

    pub(crate) async fn issue_get_endpoint_async(&self, id: &str) -> Result<Issue, ApiError> {
        get_async(self, id).await
    }

    pub(crate) async fn issue_create_endpoint_async(&self, agents: Option<&AgentStore>, req: &IssueRequest) -> Result<AppliedIssue, ApiError> {
        let key = req.request_key.clone();
        self.0
            .create_keys
            .once(key.as_deref(), async move {
                let issue = create_async(self, agents, req).await?;
                Ok(AppliedIssue::from_issue(issue, self.seq()))
            })
            .await
    }

    pub(crate) async fn issue_update_endpoint_async(&self, agents: Option<&AgentStore>, input: IssueUpdateInput) -> Result<AppliedIssue, ApiError> {
        let issue = update_async(self, agents, input).await?;
        Ok(AppliedIssue::from_issue(issue, self.seq()))
    }

    pub(crate) async fn issue_delete_endpoint_async(&self, id: &str) -> Result<(), ApiError> {
        let id = get_async(self, id).await?.id;
        self.remove_async(&id).await.map_err(|e| api(self, e))
    }

    pub(crate) async fn issue_preview_delete_endpoint_async(&self, id: &str) -> Result<Preview, ApiError> {
        let item = get_async(self, id).await?;
        if item.was_sent() {
            return Err(refused("server.issue.started", &[]));
        }
        let mut does = vec![t(
            "server.issue.does.deleteIssue",
            &[("n", item.number.into()), ("title", short_title(&item.title).into())],
        )];
        if let Some(r) = &item.refining {
            does.push(t("server.issue.does.drafterLeaves", &[("name", r.name.clone().into())]));
        }
        if item.repo.is_some() {
            does.push(t("server.issue.does.cleanWorktree", &[]));
        }
        Ok(Preview { does })
    }

    pub(crate) async fn issue_status_update_endpoint_async(
        &self,
        agents: Option<&AgentStore>,
        input: &IssueStatusUpdateInput,
    ) -> Result<AppliedIssue, ApiError> {
        let key = input.request_key.clone();
        self.0
            .status_keys
            .once(key.as_deref(), async move {
                let issue = status_async(self, agents, input).await?;
                Ok(AppliedIssue::from_issue(issue, self.seq()))
            })
            .await
    }

    pub(crate) async fn issue_status_preview_update_endpoint_async(
        &self,
        agents: Option<&AgentStore>,
        input: &IssueStatusPreviewUpdateInput,
    ) -> Result<Preview, ApiError> {
        let mut item = get_async(self, &input.id).await?;
        Self::verify_approval(&item, input.status, input.revision.as_ref()).map_err(|e| api(self, e))?;
        if let Some(edit) = &input.edit {
            if edit_rewords(edit) && item.was_sent() {
                return Err(refused("server.issue.started", &[]));
            }
            apply_preview_edit(&mut item, edit);
        }
        if let Some(raw_agent) = &input.agent {
            let agent = resolve_agent(agents, raw_agent);
            if !agent.is_empty() && item.assigned_agent() != Some(agent.as_str()) {
                if input.status != IssueStatus::Todo {
                    return Err(refused("server.issue.handOverOnTodo", &[]));
                }
                if let Some(agents) = agents
                    && agents.profiles.agent(&agent).is_none()
                {
                    return Err(refused("server.issue.profileGone", &[("id", agent.into())]));
                }
                edits::assign(&mut item, &agent, 0);
                if item.status == IssueStatus::Todo {
                    let settled = Settled {
                        mv: Move::Start,
                        said: input.text.as_deref().unwrap_or("").trim().to_string(),
                    };
                    return Ok(Preview {
                        does: moves_words_async(self, agents, &item, &settled).await?,
                    });
                }
            }
        }
        let settled = settle(&item, input.status, input.text.as_deref().unwrap_or(""))?;
        Ok(Preview {
            does: moves_words_async(self, agents, &item, &settled).await?,
        })
    }

    pub(crate) async fn issue_review_endpoint_async(&self, input: IssueReviewInput) -> Result<Issue, ApiError> {
        review_async(self, input).await
    }

    pub(crate) async fn issue_comment_endpoint_async(&self, id: &str, text: &str) -> Result<Applied, ApiError> {
        comment_async(self, id, text).await?;
        Ok(Applied { seq: self.seq() })
    }

    pub(crate) async fn issue_refine_endpoint_async(&self, channel: Option<&dyn ChannelAnnouncePort>, input: &IssueRefineInput) -> Result<Issue, ApiError> {
        refine_async(self, channel, input).await
    }

    pub(crate) async fn issue_split_endpoint_async(&self, input: &IssueSplitInput) -> Result<String, ApiError> {
        split_async(self, input).await
    }

    pub(crate) async fn issue_timeline_endpoint_async(&self, id: &str) -> Result<IssueTimeline, ApiError> {
        let item = get_async(self, id).await?;
        let runs = self.runs_async(&item.id).await.map_err(|e| api(self, e))?;
        let sessions = self.sessions_async().await.map_err(|e| api(self, e))?;
        Ok(milestones_of(&item, &runs, |s| sessions.iter().find(|x| x.id == s).map(|x| x.name.clone())))
    }

    pub(crate) async fn issue_run_list_endpoint_async(&self, id: &str) -> Result<Vec<Run>, ApiError> {
        let item = get_async(self, id).await?;
        self.runs_async(&item.id).await.map_err(|e| api(self, e))
    }

    pub(crate) async fn issue_diff_endpoint_async(
        &self,
        caller: Caller,
        id: &str,
        since_tree: Option<&str>,
        on_reviewed: Option<&dyn Fn(&str)>,
    ) -> Result<Changes, ApiError> {
        let item = get_async(self, id).await?;
        let changes = changes_of_async(self, &item, since_tree).await?;
        if let Some(on_reviewed) = on_reviewed
            && caller == Caller::User
            && let Some(session) = item.latest_session_id()
            && self.session_async(session).await.is_some()
        {
            on_reviewed(session);
        }
        Ok(changes)
    }

    pub(crate) async fn issue_history_list_endpoint_async(&self) -> Result<Vec<IssueHistory>, ApiError> {
        let issues = self.issues_async().await.map_err(|e| api(self, e))?;
        let active_sessions = self.sessions_async().await.map_err(|e| api(self, e))?;
        let mut out = Vec::with_capacity(issues.len());
        for issue in issues {
            let ids: Vec<String> = issue.executions().map(|e| e.session().to_string()).collect();
            let mut sessions: Vec<Session> = ids.iter().filter_map(|id| active_sessions.iter().find(|x| &x.id == id).cloned()).collect();
            for id in &ids {
                if !sessions.iter().any(|x| &x.id == id)
                    && let Some(past) = self.past_session_async(id).await
                {
                    sessions.push(past);
                }
            }
            let missing_sessions = ids.iter().filter(|id| !sessions.iter().any(|x| &x.id == *id)).cloned().collect();
            out.push(IssueHistory {
                issue,
                sessions,
                missing_sessions,
            });
        }
        Ok(out)
    }

    pub(crate) async fn issue_conversation_endpoint_async(&self, channel: Option<&dyn ChannelAnnouncePort>, id: &str) -> Result<Option<String>, ApiError> {
        let item = get_async(self, id).await?;
        Ok(channel.and_then(|c| c.issue_thread_id(&item.id)))
    }
}

fn edit_rewords(edit: &IssueUpdate) -> bool {
    edit.title.is_some()
        || edit.description.is_some()
        || edit.repo.is_some()
        || edit.agent.is_some()
        || edit.machine_id.is_some()
        || edit.priority.is_some()
        || edit.criteria.is_some()
        || edit.before.is_some()
}

/// `withEdit`: the issue as a move would see it once the edit is saved.
fn apply_preview_edit(item: &mut Issue, edit: &IssueUpdate) {
    if let Some(v) = &edit.title {
        item.title = v.clone();
    }
    if let Some(v) = &edit.description {
        item.description = v.clone();
    }
    if let Some(v) = &edit.repo {
        item.repo = Some(v.clone()).filter(|r| !r.is_empty());
    }
    if let Some(v) = &edit.machine_id {
        let trimmed = v.trim();
        item.machine_id = (!trimmed.is_empty()).then(|| trimmed.to_string());
    }
    if let Some(v) = edit.priority {
        item.priority = v;
    }
    if let Some(v) = &edit.criteria {
        item.criteria = v.clone();
    }
    if let Some(v) = edit.deliver {
        item.deliver = v;
    }
}

pub(crate) async fn create_async(board: &IssueStore, profiles: Option<&AgentStore>, req: &IssueRequest) -> Result<Issue, ApiError> {
    let agent = req.agent.clone().unwrap_or_default();
    let agent = match profiles {
        Some(agents) => agents.agent_key(&agent),
        None => agent,
    };
    let on_duty = profiles.is_some_and(|a| a.profiles.is_orchestrator(&agent));
    let new = NewIssue {
        title: req.title.clone(),
        description: req.description.clone().unwrap_or_default(),
        criteria: req.criteria.clone().unwrap_or_default(),
        repo: req.repo.as_deref().map(str::trim).filter(|r| !r.is_empty()).map(PathBuf::from),
        agent,
        machine_id: req.machine_id.clone(),
        // An issue for the orchestrator asks for an answer; any other a change (lifecycle.ts `create`).
        deliver: req.deliver.unwrap_or(if on_duty {
            vibevalley_protocol::Deliverable::Answer
        } else {
            vibevalley_protocol::Deliverable::Change
        }),
        priority: req.priority.unwrap_or_default(),
        parent: req.parent.clone(),
        blocked_by: req.blocked_by.clone().unwrap_or_default(),
        constraints: req.constraints.clone(),
        cron: None,
        auto_submit_pr: req.auto_submit_pr == Some(true),
    };
    let issue = board.create_async(new).await.map_err(|e| api(board, e))?;
    Ok(issue)
}

pub(crate) async fn update_async(board: &IssueStore, profiles: Option<&AgentStore>, input: IssueUpdateInput) -> Result<Issue, ApiError> {
    let upd = IssueUpdate {
        title: input.title,
        description: input.description,
        repo: input.repo,
        agent: input.agent.map(|a| resolve_agent(profiles, &a)),
        machine_id: input.machine_id,
        priority: input.priority,
        criteria: input.criteria,
        deliver: input.deliver,
        before: input.before,
    };
    let id = get_async(board, &input.id).await?.id;
    let issue = board.edit_async(&id, &upd).await.map_err(|e| api(board, e))?;
    Ok(issue)
}

pub(crate) fn status_async<'a>(
    board: &'a IssueStore,
    profiles: Option<&'a AgentStore>,
    input: &'a IssueStatusUpdateInput,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Issue, ApiError>> + Send + 'a>> {
    Box::pin(async move {
        let mut item = get_async(board, &input.id).await?;
        IssueStore::verify_approval(&item, input.status, input.revision.as_ref()).map_err(|e| api(board, e))?;
        if let Some(mut edit) = input.edit.clone() {
            edit.agent = edit.agent.map(|a| resolve_agent(profiles, &a));
            item = board.edit_async(&item.id, &edit).await.map_err(|e| api(board, e))?;
        }
        if let Some(raw_agent) = &input.agent {
            let agent = resolve_agent(profiles, raw_agent);
            if !agent.is_empty() && item.assigned_agent() != Some(agent.as_str()) {
                if input.status != IssueStatus::Todo {
                    return Err(refused("server.issue.handOverOnTodo", &[]));
                }
                if item.was_sent() {
                    let raw_text = input.text.as_deref().unwrap_or("");
                    let said = if item.status == IssueStatus::Todo {
                        raw_text.trim().to_string()
                    } else {
                        settle(&item, input.status, raw_text)?.said
                    };
                    let words = (!said.is_empty()).then_some(said.as_str());
                    let findings = if item.stage.state == IssueStageKind::Reviewing && !said.is_empty() {
                        findings_of(&said)
                    } else {
                        vec![]
                    };
                    board
                        .hand_over_and_move_async(&item.id, &agent, words, &findings)
                        .await
                        .map_err(|e| api(board, e))?;
                    return get_async(board, &item.id).await;
                }
                let edit = IssueUpdate {
                    agent: Some(agent),
                    ..Default::default()
                };
                item = board.edit_async(&item.id, &edit).await.map_err(|e| api(board, e))?;
            }
        }
        let settled = settle(&item, input.status, input.text.as_deref().unwrap_or(""))?;
        let words = (!settled.said.is_empty()).then_some(settled.said.as_str());
        if settled.mv == Move::Round && words.is_some() && item.stage.state == IssueStageKind::Reviewing {
            board
                .review_async(&item.id, false, &findings_of(&settled.said), "", None)
                .await
                .map_err(|e| api(board, e))?;
        } else {
            board
                .move_reviewed_async(&item.id, input.status, words, input.revision.as_ref())
                .await
                .map_err(|e| api(board, e))?;
        }
        get_async(board, &item.id).await
    })
}

pub(crate) async fn refine_async(board: &IssueStore, channel: Option<&dyn ChannelAnnouncePort>, input: &IssueRefineInput) -> Result<Issue, ApiError> {
    let mut item = get_async(board, &input.id).await?;
    if let Some(edit) = &input.edit {
        item = board.edit_async(&item.id, edit).await.map_err(|e| api(board, e))?;
    }
    if item.status != IssueStatus::Backlog {
        return Err(refused("server.issue.refinement.onlyBacklog", &[]).with_next(next_steps(&item)));
    }
    if let Some(r) = &item.refining {
        return Err(refused("server.issue.refinement.drafting", &[("name", r.name.clone().into())]));
    }
    let said = input.text.as_deref().unwrap_or("").trim().to_string();
    let discussion = if let Some(channel) = channel {
        let thread = channel.issue_thread_async(&item.id, &item.title, None).await?;
        let discussion = channel
            .history_async(&thread, 40)
            .await?
            .into_iter()
            .map(|m| m.text)
            .collect::<Vec<_>>()
            .join("\n\n");
        if !said.is_empty() {
            channel.say_in_async(&thread, &said, String::new()).await?;
        }
        discussion
    } else {
        String::new()
    };
    board.refine_with_async(&item.id, &said, &discussion).await.map_err(|e| api(board, e))?;
    get_async(board, &item.id).await
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use vibevalley_core::ManualClock;
    use vibevalley_protocol::{IssueFilter, IssueLastRun, Landing, Outcome};
    use vibevalley_runtime::oar::Registry;

    use super::*;
    use crate::app::live::LiveOverlay;
    use crate::app::outbox::Outbox;
    use crate::app::runtime::Runtime;
    use crate::app::slice::SliceProjector;
    use crate::db::ServerDb;
    use crate::work::ledger::BoardConfig;

    #[tokio::test]
    async fn issue_list_uses_injected_clock_for_patrol_order() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("server.db");
        let db = ServerDb::open_config(&crate::db::DatabaseConfig::Sqlite { path: db_path.clone() }).unwrap();
        let live = LiveOverlay::new();
        let projector = SliceProjector::new();
        let outbox = Outbox::new(db);
        let runtime = Runtime::new();
        let board = IssueStore::open_async(
            &db_path,
            live,
            projector,
            outbox,
            runtime.clone(),
            Arc::new(Registry::new()),
            BoardConfig::under(dir.path()),
            None,
        )
        .await
        .unwrap();
        let clock = ManualClock::new(1_000);

        // A parent whose children are all closed is InReview with `stage.since == None`,
        // so `pick_issues(..., clock.now_ms())` falls back to `clock.now_ms()`.
        let first = board
            .create_async(NewIssue {
                title: "no-since".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        let mut child = board
            .create_async(NewIssue {
                title: "closed-child".into(),
                parent: Some(first.id.clone()),
                ..Default::default()
            })
            .await
            .unwrap();
        child.delivered = Some(Landing::Merged);
        child.closed_at = Some(900);

        let mut second = board
            .create_async(NewIssue {
                title: "explicit-since".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        second.last_run = Some(IssueLastRun {
            started_at: 4_000,
            ended_at: Some(5_000),
            outcome: Some(Outcome::Completed),
        });
        board.ledger().put_issues_async(&[child, second]).await.unwrap();

        let filter = IssueFilter {
            wants_user: Some(true),
            ..Default::default()
        };
        // At clock=1_000, `first` falls back to `clock.now_ms()` (1_000) < 5_000, so `first` sorts before `second`.
        let list_early = board.issue_list_endpoint_async(&filter, &clock).await.unwrap();
        let titles_early: Vec<&str> = list_early.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles_early, vec!["no-since", "explicit-since"]);

        // Advancing ManualClock past 5_000 flips the patrol ordering deterministically.
        clock.advance(Duration::from_secs(10));
        let list_late = board.issue_list_endpoint_async(&filter, &clock).await.unwrap();
        let titles_late: Vec<&str> = list_late.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles_late, vec!["explicit-since", "no-since"]);

        board.close();
        let _ = runtime.shutdown(Duration::from_secs(1)).await;
    }
}
