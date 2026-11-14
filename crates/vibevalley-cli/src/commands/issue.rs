//! `issue list|show [--watch]|watch|create|edit|status|comment|review|diff|timeline|delete`.

use std::time::Duration;

use clap::{ArgMatches, Command};
use serde::Deserialize;
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ActWords, Changes, Issue, IssueAction, IssueCommentCreateInput, IssueDeleteInput, IssueDiffGetInput, IssueFilter, IssueGetInput, IssueRequest,
    IssueReviewInput, IssueStageKind, IssueStatus, IssueStatusUpdateInput, IssueTimelineGetInput, IssueUpdateInput, IssueWatch, Priority, ops,
};

use crate::farm::{Ctx, Done, Failure, Format, decode_failure, exit, issue_ref, line, out, stdin_text};
use crate::tree::{all, arg, choice, cmd, flag, get, group, int, joined, many, number, on, pos, pos_choice, text, words};

fn statuses() -> impl Iterator<Item = &'static str> {
    IssueStatus::ALL.iter().map(|s| s.as_str())
}

fn issue_arg() -> clap::Arg {
    pos("issue", "cli.arg.issue")
}

fn priority_flag() -> clap::Arg {
    choice("priority", Priority::ALL.iter().map(|p| p.as_str()), "cli.flag.priority")
}

fn agent_of(i: &Issue) -> Option<&str> {
    i.assignments.last().map(|a| a.agent.as_str())
}

/// The issue a change answered with.
fn applied(a: &vibevalley_protocol::AppliedIssue) -> Issue {
    serde_json::to_value(a)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_else(|| serde_json::from_value(serde_json::json!({})).expect("an issue"))
}

/// One line an issue: its number first, then its status, title, whose it is and where.
pub fn issue_line(i: &Issue) -> String {
    let agent = agent_of(i).map(|a| format!("@{a}")).unwrap_or_default();
    let repo = i.repo.as_ref().map(|r| format!("[{r}]")).unwrap_or_default();
    line(&[&format!("#{}", i.number), i.status.as_str(), &i.title, &agent, &repo])
}

/// What can be done with it now, as the commands that do it.
fn doable(i: &Issue) -> Vec<String> {
    let session = i.latest_session_id().map(String::as_str);
    i.stage
        .acts
        .iter()
        .filter_map(|a| {
            let (mut run, words) = vibevalley_core::rules::act_command(i, a, session)?;
            if words == ActWords::Required {
                if matches!(a, IssueAction::Move { .. }) {
                    run.extend(["--comment".into(), "…".into()]);
                } else {
                    run.push("…".into());
                }
            }
            Some(run.join(" "))
        })
        .collect()
}

fn issue_text(i: &Issue) -> String {
    let agent = agent_of(i).map(|a| format!("@{a}")).unwrap_or_default();
    let repo = i.repo.as_ref().map(|r| format!("[{r}]")).unwrap_or_default();
    let stage = match &i.stage.stuck {
        Some(stuck) => format!("{} ({})", i.stage.state.as_str(), stuck.as_str()),
        None => i.stage.state.as_str().to_string(),
    };
    let mut lines = vec![
        format!("#{}  {}", i.number, i.title),
        line(&[i.status.as_str(), i.priority.as_str(), &repo, &agent]),
        t("cli.issue.stage", &[("stage", stage.into())]),
    ];
    if !i.description.trim().is_empty() {
        lines.extend([String::new(), i.description.trim().to_string()]);
    }
    if !i.criteria.is_empty() {
        lines.extend([String::new(), t("cli.issue.criteria", &[])]);
        lines.extend(i.criteria.iter().enumerate().map(|(n, c)| format!("  {}. {c}", n + 1)));
    }
    if !i.questions.is_empty() {
        lines.extend([String::new(), t("cli.issue.questions", &[])]);
        lines.extend(i.questions.iter().map(|q| {
            let options = if q.options.is_empty() {
                String::new()
            } else {
                format!("  ({})", q.options.join(" | "))
            };
            format!("  ? {}{options}", q.question)
        }));
    }
    let can = doable(i);
    if !can.is_empty() {
        lines.extend([String::new(), t("cli.issue.can", &[])]);
        lines.extend(can.iter().map(|c| format!("  vibevalley {c}")));
    }
    lines.join("\n")
}

fn changes_text(c: &Changes) -> String {
    let mut lines: Vec<String> = c.commits.iter().map(|x| format!("{}  {}", &x.hash[..x.hash.len().min(7)], x.subject)).collect();
    lines.extend(
        c.files
            .iter()
            .map(|f| format!("  {}  {}  +{} -{}", f.status.as_str(), f.path, f.added, f.removed)),
    );
    if !c.conflicts.is_empty() {
        lines.push(t("cli.issue.conflicts", &[("files", c.conflicts.join(", ").into())]));
    }
    if lines.is_empty() { t("cli.issue.noChanges", &[]) } else { lines.join("\n") }
}

/// `--description`: as given, or `-` for what comes on stdin.
fn description_of(m: &ArgMatches) -> Option<String> {
    match get(m, "description").as_deref() {
        Some("-") => Some(stdin_text()),
        other => other.map(String::from).filter(|d| !d.is_empty()),
    }
}

pub fn command() -> Command {
    group(
        "issue",
        "cli.group.issue.about",
        vec![
            cmd(
                "list",
                "cli.command.issue.list",
                &[
                    ("vibevalley issue list", "cli.example.issueList.about"),
                    ("vibevalley issue list --wants-user", "cli.example.issueWantsUser.about"),
                ],
            )
            .args([
                choice("status", statuses(), "cli.flag.issueStatus"),
                text("repo", "cli.flag.repo"),
                text("text", "cli.flag.text"),
                flag("wants-user", "cli.flag.wantsUser"),
                flag("closed", "cli.flag.closed"),
                int("limit", "cli.flag.limit").default_value("20"),
            ]),
            cmd(
                "show",
                "cli.command.issue.show",
                &[
                    ("vibevalley issue show 12", "cli.example.issueShow.about"),
                    ("vibevalley issue show 12 --watch --timeout 600", "cli.example.issueWatch.about"),
                ],
            )
            .args([issue_arg(), flag("watch", "cli.flag.issueWatch"), int("timeout", "cli.flag.timeout")]),
            cmd(
                "watch",
                "cli.command.issue.watch",
                &[("vibevalley issue watch 12 --jsonl", "cli.example.issueObserve.about")],
            )
            .args([issue_arg(), flag("follow", "cli.flag.follow"), flag("jsonl", "cli.flag.jsonl")]),
            cmd(
                "create",
                "cli.command.issue.create",
                &[("cli.example.issueCreate.run", "cli.example.issueCreate.about")],
            )
            .args([
                words("title", "cli.arg.title"),
                text("description", "cli.flag.description"),
                text("repo", "cli.flag.repo"),
                text("agent", "cli.flag.agent"),
                priority_flag(),
                many("criterion", "cli.flag.criterion"),
                text("key", "cli.flag.key"),
            ]),
            cmd(
                "edit",
                "cli.command.issue.edit",
                &[("vibevalley issue edit 12 --priority high", "cli.example.issueEdit.about")],
            )
            .args([
                issue_arg(),
                text("title", "cli.flag.title"),
                text("description", "cli.flag.description"),
                text("repo", "cli.flag.repo"),
                text("agent", "cli.flag.agent"),
                priority_flag(),
                many("criterion", "cli.flag.criteria"),
            ]),
            cmd(
                "status",
                "cli.command.issue.status",
                &[
                    ("vibevalley issue status 12 todo", "cli.example.issueStatus.about"),
                    ("vibevalley issue status 12 done --dry-run", "cli.example.issueDone.about"),
                ],
            )
            .args([
                issue_arg(),
                pos_choice("status", statuses(), "cli.arg.status"),
                text("comment", "cli.flag.statusComment"),
            ]),
            cmd(
                "comment",
                "cli.command.issue.comment",
                &[("cli.example.issue.comment.run", "cli.example.issue.comment.about")],
            )
            .args([issue_arg(), words("words", "cli.arg.comment")]),
            cmd(
                "review",
                "cli.command.issue.review",
                &[
                    ("vibevalley issue review 12 --pass", "cli.example.issueReviewPass.about"),
                    ("cli.example.issueReviewFail.run", "cli.example.issueReviewFail.about"),
                ],
            )
            .args([
                issue_arg(),
                flag("pass", "cli.flag.pass"),
                flag("fail", "cli.flag.fail"),
                many("finding", "cli.flag.finding"),
                text("comment", "cli.flag.reviewComment"),
            ]),
            cmd("diff", "cli.command.issue.diff", &[("vibevalley issue diff 12", "cli.example.issueDiff.about")]).arg(issue_arg()),
            cmd(
                "timeline",
                "cli.command.issue.timeline",
                &[("vibevalley issue timeline 12", "cli.example.issueTimeline.about")],
            )
            .arg(issue_arg()),
            cmd(
                "delete",
                "cli.command.issue.delete",
                &[("vibevalley issue delete 12 --dry-run", "cli.example.issueDelete.about")],
            )
            .arg(issue_arg()),
        ],
    )
}

fn status_of(s: &str) -> Option<IssueStatus> {
    IssueStatus::ALL.iter().copied().find(|x| x.as_str() == s)
}

fn priority_of(m: &ArgMatches) -> Option<Priority> {
    get(m, "priority").and_then(|p| Priority::ALL.iter().copied().find(|x| x.as_str() == p))
}

pub fn run(ctx: &Ctx, m: &ArgMatches) -> Done {
    let Some((verb, m)) = m.subcommand() else { return Ok(()) };
    let id = || issue_ref(&arg(m, "issue"));
    match verb {
        "list" => {
            let limit = number(m, "limit").unwrap_or(20).max(1);
            let filter = IssueFilter {
                limit: Some(limit + 1),
                status: get(m, "status").as_deref().and_then(status_of),
                repo: get(m, "repo"),
                text: get(m, "text"),
                wants_user: on(m, "wants-user").then_some(true),
                closed: on(m, "closed").then_some(true),
            };
            let issues = ctx.ask::<ops::IssueList>(&filter)?;
            let shown: Vec<Issue> = issues.iter().take(limit as usize).cloned().collect();
            ctx.show(&shown, |list| {
                let mut lines: Vec<String> = list.iter().map(issue_line).collect();
                if issues.len() as i64 > limit {
                    lines.push(t("cli.more", &[("flag", format!("--limit {}", limit * 2).into())]));
                }
                if lines.is_empty() { t("cli.issue.none", &[]) } else { lines.join("\n") }
            });
            Ok(())
        }
        "show" => {
            let issue = ctx.ask::<ops::IssueGet>(&IssueGetInput { id: id() })?;
            if !on(m, "watch") {
                ctx.show(&issue, issue_text);
                return Ok(());
            }
            followed(ctx, &issue, number(m, "timeout"))?;
            let answer = ctx.ask::<ops::IssueGet>(&IssueGetInput { id: issue.id.clone() })?;
            ctx.show(&answer, issue_text);
            Ok(())
        }
        "watch" => {
            if ctx.format == Format::Json {
                return Err(Failure::usage("WatchFormat", t("cli.issue.watchFormat", &[])));
            }
            let issue = ctx.ask::<ops::IssueGet>(&IssueGetInput { id: id() })?;
            observe(ctx, &issue.id, on(m, "follow"), on(m, "jsonl"))
        }
        "create" => {
            let request = IssueRequest {
                title: joined(m, "title"),
                description: description_of(m),
                repo: get(m, "repo"),
                agent: get(m, "agent"),
                priority: priority_of(m),
                criteria: Some(all(m, "criterion")).filter(|c| !c.is_empty()),
                request_key: get(m, "key"),
                ..Default::default()
            };
            ctx.change::<ops::IssueCreate>("issue create", None, &request, |a| issue_line(&applied(a)))
        }
        "edit" => {
            let request = IssueUpdateInput {
                id: id(),
                title: get(m, "title"),
                description: description_of(m),
                repo: get(m, "repo"),
                agent: get(m, "agent"),
                priority: priority_of(m),
                criteria: Some(all(m, "criterion")).filter(|c| !c.is_empty()),
                ..Default::default()
            };
            ctx.change::<ops::IssueUpdate>("issue edit", None, &request, |a| issue_line(&applied(a)))
        }
        "status" => {
            let request = IssueStatusUpdateInput {
                id: id(),
                status: status_of(&arg(m, "status")).unwrap_or(IssueStatus::Backlog),
                text: get(m, "comment"),
                agent: None,
                edit: None,
                request_key: None,
            };
            ctx.change::<ops::IssueStatusUpdate>("issue status", Some("issue.status.previewUpdate"), &request, |a| issue_line(&applied(a)))
        }
        "comment" => {
            let n = id();
            let request = IssueCommentCreateInput {
                id: n.clone(),
                text: joined(m, "words"),
                ..Default::default()
            };
            ctx.change::<ops::IssueCommentCreate>("issue comment", None, &request, |_| {
                t("cli.issue.commented", &[("issue", format!("#{n}").into())])
            })
        }
        "review" => {
            let (pass, fail) = (on(m, "pass"), on(m, "fail"));
            if pass == fail {
                return Err(Failure::usage("InvalidValue", t("cli.issue.passOrFail", &[])));
            }
            let request = IssueReviewInput {
                id: id(),
                pass,
                findings: Some(all(m, "finding")).filter(|f| !f.is_empty()),
                text: get(m, "comment"),
            };
            ctx.change::<ops::IssueReview>("issue review", None, &request, issue_line)
        }
        "diff" => {
            let c = ctx.ask::<ops::IssueDiffGet>(&IssueDiffGetInput { id: id() })?;
            ctx.show(&c, changes_text);
            Ok(())
        }
        "timeline" => {
            let tl = ctx.ask::<ops::IssueTimelineGet>(&IssueTimelineGetInput { id: id() })?;
            ctx.show(&tl, |x| {
                let mut lines: Vec<String> = x
                    .milestones
                    .iter()
                    .map(|m| {
                        let who = m.who.as_ref().map(|w| format!("  {w}")).unwrap_or_default();
                        format!("{}  {}{who}  {}", minute_of(m.at), m.kind.as_str(), m.text)
                    })
                    .collect();
                if let Some(s) = &x.spent {
                    let cny = s.cny.map(|c| format!("{:.2}", c.0)).unwrap_or_else(|| "-".into());
                    lines.push(t("cli.issue.spent", &[("tokens", s.tokens.into()), ("cny", cny.into())]));
                }
                lines.join("\n")
            });
            Ok(())
        }
        "delete" => {
            let n = id();
            ctx.change::<ops::IssueDelete>("issue delete", Some("issue.previewDelete"), &IssueDeleteInput { id: n.clone() }, |_| {
                t("cli.issue.deleted", &[("issue", format!("#{n}").into())])
            })
        }
        _ => Ok(()),
    }
}

/// A moment as the timeline says it: YYYY-MM-DD HH:MM, in UTC.
fn minute_of(at: i64) -> String {
    jiff::Timestamp::from_millisecond(at)
        .map(|t| t.strftime("%Y-%m-%d %H:%M").to_string())
        .unwrap_or_default()
}

/// Only what `--watch` reads of a state frame.
#[derive(Deserialize)]
struct Frame {
    state: Issues,
}

#[derive(Deserialize)]
struct Issues {
    issues: Vec<Brief>,
}

#[derive(Deserialize)]
struct Brief {
    id: String,
    status: IssueStatus,
    stage: Stage,
}

#[derive(Deserialize)]
struct Stage {
    state: IssueStageKind,
}

/// Follows the issue until it waits on the user or is over, each change on stderr.
fn followed(ctx: &Ctx, issue: &Issue, timeout: Option<i64>) -> Done {
    let mut last: Option<(IssueStatus, IssueStageKind)> = None;
    let timed_out = || {
        Failure::new(
            exit::OTHER,
            "Timeout",
            t(
                "cli.issue.timeout",
                &[("issue", format!("#{}", issue.number).into()), ("seconds", timeout.unwrap_or(0).into())],
            ),
        )
    };
    let followed = ctx.events("/api/v1/state", timeout.map(|s| Duration::from_secs(s.max(0) as u64)), |data| {
        let frame: Frame = serde_json::from_str(data).map_err(decode_failure)?;
        let Some(now) = frame.state.issues.into_iter().find(|i| i.id == issue.id) else {
            return Err(Failure::new(exit::MISSING, "Missing", t("cli.failure.gone", &[("n", issue.number.into())])));
        };
        let at = (now.status, now.stage.state);
        if last == Some(at) {
            return Ok(true);
        }
        last = Some(at);
        eprintln!(
            "{}",
            serde_json::json!({ "issue": issue.number, "status": now.status, "stage": now.stage.state })
        );
        let settled = matches!(now.status, IssueStatus::InReview | IssueStatus::Done | IssueStatus::Canceled);
        Ok(!(settled || vibevalley_core::rules::stage_wants_user(now.stage.state)))
    });
    match followed {
        Err(f) if f.tag == "Timeout" => Err(timed_out()),
        other => other,
    }
}

/// `issue watch`: the issue's state and its helpers' events as they come, each once.
fn observe(ctx: &Ctx, id: &str, follow: bool, jsonl: bool) -> Done {
    let mut seen: std::collections::HashMap<String, std::collections::HashMap<i64, i64>> = Default::default();
    let mut previous = String::new();
    let mut gaps: std::collections::HashMap<String, String> = Default::default();
    loop {
        let watched = ctx.events(&format!("/api/v1/issue/watch/{id}"), None, |data| {
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
                        let print = serde_json::to_string(&row).unwrap_or_default();
                        gaps.insert(session.clone(), print.clone()).as_ref() != Some(&print)
                    }
                    IssueWatch::State { session_ids, .. } => {
                        seen.retain(|s, _| session_ids.contains(s));
                        gaps.retain(|s, _| session_ids.contains(s));
                        let print = serde_json::to_string(&row).unwrap_or_default();
                        std::mem::replace(&mut previous, print.clone()) != print
                    }
                    IssueWatch::Missing { .. } | IssueWatch::History { .. } => true,
                };
                if !fresh {
                    continue;
                }
                if jsonl {
                    let mut v = serde_json::to_value(&row).unwrap_or_default();
                    v["version"] = 1.into();
                    out(&v.to_string());
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
        });
        match watched {
            Ok(()) => return Ok(()),
            Err(f) if f.tag == "Unreachable" => std::thread::sleep(Duration::from_secs(1)),
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
        IssueWatch::Gap { session, before: None } => t("cli.issue.watchUnavailable", &[("session", session.clone().into())]),
        IssueWatch::Gap { session, before: Some(b) } => t("cli.issue.watchGap", &[("session", session.clone().into()), ("before", (*b).into())]),
        IssueWatch::Missing { issue } => t("cli.issue.watchMissing", &[("issue", issue.clone().into())]),
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
