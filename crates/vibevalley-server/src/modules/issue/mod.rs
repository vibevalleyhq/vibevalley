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

pub use board::{Board, NewIssue, Sent};
pub use family::{ChildDraft, MAX_CHILDREN};

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use vibevalley_core::Move;
use vibevalley_core::brief::{findings_of, milestones_of, resume_words};
use vibevalley_core::rules::short_title;
use vibevalley_i18n::{Params, t};
use vibevalley_protocol::{
    ActWords, ApiError, Applied, AppliedIssue, BizCode, ChangedFile, Changes, Commit, Issue, IssueAction, IssueHistory, IssueReviewInput, IssueStageKind,
    IssueStatus, IssueUpdate, Next, Preview, StuckReason, UncommittedItem, ops,
};

use crate::base::LookIn;
use crate::modules::agent::Agents;
use crate::modules::ledger::{BoardError, Undelivered};
use crate::{Hub, now};

const REQUEST_KEY_MAX: usize = 64;
const REQUEST_KEYS_KEPT: usize = 500;
const REQUEST_KEY_TTL_MS: i64 = 5 * 60_000;

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
fn api(board: &Board, e: BoardError) -> ApiError {
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
fn get(board: &Board, reference: &str) -> Result<Issue, ApiError> {
    board.issue(reference).ok_or_else(|| api(board, BoardError::NoIssue(reference.to_string())))
}

fn applied(hub: &Hub, issue: Issue) -> AppliedIssue {
    AppliedIssue::from_issue(issue, hub.seq())
}

/// `requestKeys`: a retry with the same key gets the first answer for
/// five minutes; a failure is forgotten.
#[derive(Default)]
struct RequestKeys {
    seen: Mutex<Seen>,
}

/// The keys oldest first, and each key's expiry and answer.
type Seen = (Vec<String>, HashMap<String, (i64, AppliedIssue)>);

impl RequestKeys {
    fn once(&self, key: Option<&str>, work: impl FnOnce() -> Result<AppliedIssue, ApiError>) -> Result<AppliedIssue, ApiError> {
        let Some(key) = key.filter(|k| !k.is_empty()) else { return work() };
        if key.chars().count() > REQUEST_KEY_MAX {
            return Err(ApiError::new(
                BizCode::RequestKeyTooLong,
                t("server.base.requestKeyLong", &[("max", REQUEST_KEY_MAX.into())]),
            ));
        }
        // Held while working: a duplicate waits for the first answer.
        let mut seen = self.seen.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((expires, done)) = seen.1.get(key)
            && *expires > now()
        {
            return Ok(done.clone());
        }
        let done = work()?;
        seen.0.retain(|k| k != key);
        seen.0.push(key.to_string());
        seen.1.insert(key.to_string(), (now() + REQUEST_KEY_TTL_MS, done.clone()));
        while seen.0.len() > REQUEST_KEYS_KEPT {
            let old = seen.0.remove(0);
            seen.1.remove(&old);
        }
        Ok(done)
    }
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

fn helper_name(board: &Board, item: &Issue) -> String {
    item.latest_session_id()
        .and_then(|s| board.session(s))
        .map(|s| s.name)
        .unwrap_or_else(|| t("server.issue.helper", &[]))
}

/// `movesWords`: a settled move in words, one step a line.
fn moves_words(board: &Board, agents: Option<&Agents>, item: &Issue, s: &Settled) -> Result<Vec<String>, ApiError> {
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
    Ok(move_lines(board, item, s, name))
}

fn move_lines(board: &Board, item: &Issue, s: &Settled, name: Option<String>) -> Vec<String> {
    let n = format!("#{}", item.number);
    let helper = || helper_name(board, item);
    let agent = || name.clone().unwrap_or_else(|| item.assigned_agent().unwrap_or("claude").to_string());
    match s.mv {
        Move::Start => {
            let full = board.no_room(item);
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
                return vec![t(key, &[("helper", helper().into()), ("words", resume_words().into())])];
            }
            if item.stage.state == IssueStageKind::Reviewing {
                return vec![t(
                    "server.issue.does.reject",
                    &[
                        ("n", item.number.into()),
                        ("findings", findings_of(&s.said).len().into()),
                        ("helper", helper().into()),
                    ],
                )];
            }
            vec![t("server.issue.does.round", &[("helper", helper().into()), ("said", s.said.clone().into())])]
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
            let changes = item.repo.as_ref().and_then(|_| board.changes(&item.id).ok());
            let commits = changes.as_ref().map(|c| c.commits.len()).unwrap_or(0);
            if commits == 0 || item.deliver == vibevalley_protocol::Deliverable::Answer {
                return vec![
                    t("server.issue.does.completeNone", &[("n", n.into())]),
                    t("server.issue.does.helperLeaves", &[("helper", helper().into())]),
                ];
            }
            if matches!(
                item.deliver,
                vibevalley_protocol::Deliverable::Branch | vibevalley_protocol::Deliverable::PullRequest
            ) || vibevalley_core::pr::goes_by_pull_request(item, false)
            {
                return vec![
                    t("server.issue.does.completeKept", &[("n", n.into()), ("commits", commits.into())]),
                    t("server.issue.does.helperLeaves", &[("helper", helper().into())]),
                ];
            }
            let mut out = Vec::new();
            let Some(c) = changes else { return out };
            if !c.uncommitted.is_empty() {
                out.push(t(
                    "server.issue.does.commitFirst",
                    &[("helper", helper().into()), ("files", c.uncommitted.len().into())],
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
                &[("base", c.base.into()), ("commits", commits.into()), ("helper", helper().into())],
            ));
            out
        }
        Move::Cancel => vec![
            t("server.issue.does.cancel", &[("n", n.into())]),
            t("server.issue.does.cancelLeaves", &[("helper", helper().into())]),
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

fn resolve_agent(profiles: Option<&Agents>, agent: &str) -> String {
    let agent = agent.trim();
    match profiles {
        Some(agents) if !agent.is_empty() => agents.agent_key(agent),
        _ => agent.to_string(),
    }
}

pub(crate) fn changes_of(board: &Board, item: &Issue) -> Result<Changes, ApiError> {
    // A parent is worked through its children: their merges are its changes.
    let has_children = board.read(|s| s.issues.iter().any(|i| i.parent.as_deref() == Some(item.id.as_str())));
    if item.repo.is_none() || !(item.was_sent() || has_children) {
        return Err(refused("server.issue.notStarted", &[]));
    }
    let c = board.changes(&item.id).map_err(|e| api(board, e))?;
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
        files: c
            .files
            .iter()
            .map(|d| ChangedFile {
                path: path(d),
                status: letter(d),
                added: if d.binary { -1 } else { d.added.into() },
                removed: if d.binary { -1 } else { d.removed.into() },
                patch: (!d.binary).then(|| patch_of(d, &path(d))),
            })
            .collect(),
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
pub(crate) fn review(board: &Board, input: IssueReviewInput) -> Result<Issue, ApiError> {
    let item = get(board, &input.id)?;
    if item.status != IssueStatus::InReview {
        return Err(refused("server.issue.nothingToAccept", &[]).with_next(next_steps(&item)));
    }
    board
        .review(&item.id, input.pass, &input.findings.unwrap_or_default(), input.text.as_deref().unwrap_or(""))
        .map_err(|e| api(board, e))
}

/// `issue.comment.create`: words to the issue's helper.
pub(crate) fn comment(board: &Board, id: &str, text: &str) -> Result<(), ApiError> {
    let item = get(board, id)?;
    if item.status.is_closed() {
        return Err(refused("server.issue.closedReopen", &[]));
    }
    board.tell(&item.id, text).map_err(|e| api(board, e))
}

fn split(board: &Board, input: &vibevalley_protocol::IssueSplitInput) -> Result<String, ApiError> {
    let mut parent = get(board, &input.id)?;
    if let Some(title) = input.title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        parent = board
            .edit(
                &parent.id,
                &IssueUpdate {
                    title: Some(title.into()),
                    ..Default::default()
                },
            )
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
    let made = board.split(&parent.id, drafts).map_err(|e| api(board, e))?;
    let mut out = t("server.issue.split.created", &[("n", parent.number.into()), ("count", made.len().into())]);
    for child in made {
        out.push_str(&format!("\n{}: vv://issue/{}", child.title, child.id));
    }
    Ok(out)
}

/// Every `issue.*` endpoint, answered by `board`, with an issue's agent a
/// runtime id. The board's facts must go into `hub`
/// (`Board::open_on(.., hub.clone())`).
pub fn install(hub: &Arc<Hub>, board: Board) {
    install_on(hub, board, None);
}

/// `install`, with an issue's agent one of `agents`' profiles (the board
/// opened with `Board::open_with(.., agents, ..)`).
pub fn install_on(hub: &Arc<Hub>, board: Board, agents: Option<Arc<Agents>>) {
    let names = agents;
    let b = board.clone();
    hub.on::<ops::IssueList>(move |_, filter| Ok(b.read(|s| vibevalley_core::pick_issues(&s.issues, &filter, now()))));
    let b = board.clone();
    hub.on::<ops::IssueGet>(move |_, input| get(&b, &input.id));

    let b = board.clone();
    let keys = Arc::new(RequestKeys::default());
    let profiles = names.clone();
    hub.on::<ops::IssueCreate>(move |ctx, req| {
        keys.once(req.request_key.as_deref(), || {
            let issue = create(&b, profiles.as_deref(), &req)?;
            Ok(applied(ctx.hub, issue))
        })
    });

    let b = board.clone();
    let profiles = names.clone();
    hub.on::<ops::IssueUpdate>(move |ctx, input| {
        let issue = update(&b, profiles.as_deref(), input)?;
        Ok(applied(ctx.hub, issue))
    });

    let b = board.clone();
    hub.on::<ops::IssueDelete>(move |_, input| {
        let id = get(&b, &input.id)?.id;
        b.remove(&id).map_err(|e| api(&b, e))
    });
    let b = board.clone();
    hub.on::<ops::IssuePreviewDelete>(move |_, input| {
        let item = get(&b, &input.id)?;
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
    });

    let b = board.clone();
    let keys = Arc::new(RequestKeys::default());
    let profiles = names.clone();
    hub.on::<ops::IssueStatusUpdate>(move |ctx, input| {
        keys.once(input.request_key.as_deref(), || Ok(applied(ctx.hub, status(&b, profiles.as_deref(), &input)?)))
    });

    let b = board.clone();
    let names = names.clone();
    hub.on::<ops::IssueStatusPreviewUpdate>(move |_, input| {
        let mut item = get(&b, &input.id)?;
        if let Some(edit) = &input.edit {
            if edit_rewords(edit) && item.was_sent() {
                return Err(refused("server.issue.started", &[]));
            }
            apply_preview_edit(&mut item, edit);
        }
        if let Some(raw_agent) = &input.agent {
            let agent = resolve_agent(names.as_deref(), raw_agent);
            if !agent.is_empty() && item.assigned_agent() != Some(agent.as_str()) {
                if input.status != IssueStatus::Todo {
                    return Err(refused("server.issue.handOverOnTodo", &[]));
                }
                if let Some(agents) = names.as_deref()
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
                        does: moves_words(&b, names.as_deref(), &item, &settled)?,
                    });
                }
            }
        }
        let settled = settle(&item, input.status, input.text.as_deref().unwrap_or(""))?;
        Ok(Preview {
            does: moves_words(&b, names.as_deref(), &item, &settled)?,
        })
    });

    let b = board.clone();
    hub.on::<ops::IssueReview>(move |_, input| review(&b, input));

    let b = board.clone();
    hub.on::<ops::IssueCommentCreate>(move |ctx, input| {
        comment(&b, &input.id, &input.text)?;
        Ok(Applied { seq: ctx.hub.seq() })
    });

    let b = board.clone();
    hub.on::<ops::IssueRefine>(move |_, input| refine(&b, None, &input));

    let b = board.clone();
    hub.on::<ops::IssueSplit>(move |_, input| split(&b, &input));

    let b = board.clone();
    hub.on::<ops::IssueTimelineGet>(move |_, input| {
        let item = get(&b, &input.id)?;
        let runs = b.runs(&item.id).map_err(|e| api(&b, e))?;
        Ok(milestones_of(&item, &runs, |s| b.session(s).map(|s| s.name)))
    });
    let b = board.clone();
    hub.on::<ops::IssueRunList>(move |_, input| {
        let item = get(&b, &input.id)?;
        b.runs(&item.id).map_err(|e| api(&b, e))
    });
    let b = board.clone();
    hub.on::<ops::IssueDiffGet>(move |_, input| {
        let item = get(&b, &input.id)?;
        changes_of(&b, &item)
    });
    let b = board.clone();
    hub.on::<ops::IssueHistoryList>(move |_, ()| {
        Ok(b.read(|s| {
            s.issues
                .iter()
                .map(|issue| {
                    let ids: Vec<String> = issue.executions().map(|e| e.session().to_string()).collect();
                    // A session that left is read from the board's past ones (lifecycle.ts keeps them in its table).
                    let sessions: Vec<_> = ids
                        .iter()
                        .filter_map(|id| s.sessions.iter().find(|x| &x.id == id).cloned().or_else(|| b.past_session(id)))
                        .collect();
                    let missing_sessions = ids.iter().filter(|id| !sessions.iter().any(|x| &x.id == *id)).cloned().collect();
                    IssueHistory {
                        issue: issue.clone(),
                        sessions,
                        missing_sessions,
                    }
                })
                .collect()
        }))
    });
    // Answered by `install_conversation` once the chat is open.
    let b = board.clone();
    hub.on::<ops::IssueConversationGet>(move |_, input| get(&b, &input.id).map(|_| None));
}

/// `issue.diff.get` that also tells the game: the user looking at a live
/// session's changes is a `reviewed` entry (issue.ts `changes`, `core.did`).
pub fn install_reviewed(hub: &Hub, board: Board, game: Arc<crate::modules::game::Game>) {
    hub.on::<ops::IssueDiffGet>(move |ctx, input| {
        let item = get(&board, &input.id)?;
        let changes = changes_of(&board, &item)?;
        if ctx.caller == vibevalley_protocol::Caller::User
            && let Some(session) = item.latest_session_id()
            && board.read(|s| s.sessions.iter().any(|h| &h.id == session))
        {
            game.record(vibevalley_protocol::LedgerEntry::Reviewed(vibevalley_protocol::LedgerEntryReviewed {
                at: 0,
                session: session.clone(),
            }));
        }
        Ok(changes)
    });
}

/// `issue.conversation.get`: the issue's thread in the chat, if one was
/// opened.
pub fn install_conversation(hub: &Hub, board: Board, chat: Arc<crate::modules::channel::Chat>) {
    let (b, c) = (board.clone(), chat.clone());
    hub.on::<ops::IssueConversationGet>(move |_, input| Ok(c.issue_thread_id(&get(&b, &input.id)?.id)));
    // refinement.ts `draft`: the issue's thread is opened, the user's words go in it, and what was said there is the
    // draft's discussion.
    hub.on::<ops::IssueRefine>(move |_, input| refine(&board, Some(&chat), &input));
}

fn edit_rewords(edit: &IssueUpdate) -> bool {
    edit.title.is_some()
        || edit.description.is_some()
        || edit.repo.is_some()
        || edit.agent.is_some()
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

pub(crate) fn create(board: &Board, profiles: Option<&Agents>, req: &vibevalley_protocol::IssueRequest) -> Result<Issue, ApiError> {
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
    let issue = board.create(new).map_err(|e| api(board, e))?;
    Ok(issue)
}

pub(crate) fn update(board: &Board, profiles: Option<&Agents>, input: vibevalley_protocol::IssueUpdateInput) -> Result<Issue, ApiError> {
    let upd = IssueUpdate {
        title: input.title,
        description: input.description,
        repo: input.repo,
        agent: input.agent.map(|a| resolve_agent(profiles, &a)),
        priority: input.priority,
        criteria: input.criteria,
        deliver: input.deliver,
        before: input.before,
    };
    let id = get(board, &input.id)?.id;
    let issue = board.edit(&id, &upd).map_err(|e| api(board, e))?;
    Ok(issue)
}

pub(crate) fn status(board: &Board, profiles: Option<&Agents>, input: &vibevalley_protocol::IssueStatusUpdateInput) -> Result<Issue, ApiError> {
    let mut item = get(board, &input.id)?;
    if let Some(mut edit) = input.edit.clone() {
        edit.agent = edit.agent.map(|a| resolve_agent(profiles, &a));
        item = board.edit(&item.id, &edit).map_err(|e| api(board, e))?;
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
                board.hand_over_and_move(&item.id, &agent, words, &findings).map_err(|e| api(board, e))?;
                return get(board, &item.id);
            }
            item = board
                .edit(
                    &item.id,
                    &IssueUpdate {
                        agent: Some(agent),
                        ..Default::default()
                    },
                )
                .map_err(|e| api(board, e))?;
        }
    }
    let settled = settle(&item, input.status, input.text.as_deref().unwrap_or(""))?;
    let words = (!settled.said.is_empty()).then_some(settled.said.as_str());
    if settled.mv == Move::Round && words.is_some() && item.stage.state == IssueStageKind::Reviewing {
        board.review(&item.id, false, &findings_of(&settled.said), "").map_err(|e| api(board, e))?;
    } else {
        board.move_to(&item.id, input.status, words).map_err(|e| api(board, e))?;
    }
    get(board, &item.id)
}

pub(crate) fn refine(board: &Board, chat: Option<&crate::modules::channel::Chat>, input: &vibevalley_protocol::IssueRefineInput) -> Result<Issue, ApiError> {
    let mut item = get(board, &input.id)?;
    if let Some(edit) = &input.edit {
        item = board.edit(&item.id, edit).map_err(|e| api(board, e))?;
    }
    if item.status != IssueStatus::Backlog {
        return Err(refused("server.issue.refinement.onlyBacklog", &[]).with_next(next_steps(&item)));
    }
    if let Some(r) = &item.refining {
        return Err(refused("server.issue.refinement.drafting", &[("name", r.name.clone().into())]));
    }
    let said = input.text.as_deref().unwrap_or("").trim().to_string();
    let discussion = if let Some(chat) = chat {
        let thread = chat.issue_thread(&item.id, &item.title, None)?;
        let discussion = chat
            .history(&thread, None, Some(40))?
            .into_iter()
            .map(|m| m.text)
            .collect::<Vec<_>>()
            .join("\n\n");
        if !said.is_empty() {
            chat.say(crate::modules::channel::Saying {
                text: said.clone(),
                channel: Some(thread),
                ..Default::default()
            })?;
        }
        discussion
    } else {
        String::new()
    };
    board.refine_with(&item.id, &said, &discussion).map_err(|e| api(board, e))?;
    get(board, &item.id)
}
