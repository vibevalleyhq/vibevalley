//! What waits on the user, gathered from the state.

use std::collections::{HashMap, HashSet};

use vibevalley_i18n::t;
use vibevalley_protocol::*;

use crate::rules::{Need, actor_role_of, clip, cut, need_of};
use crate::status::is_farm_worker;

/// `inbox`: newest first; items of the same moment in the order gathered,
/// followed by durable runtime alerts folded via `Fact::RuntimeInboxChanged`.
pub(crate) fn inbox(state: &SpaceState) -> Vec<InboxItem> {
    let user_mentions = state.chat.as_ref().map_or(&[][..], |c| &c.user_mentions[..]);
    inbox_items(&state.issues, &state.sessions, &state.crons, user_mentions, &state.runtime_inbox_items)
}

/// Pure inbox projection from domain slices and runtime alerts.
pub(crate) fn inbox_items(
    issues: &[Issue],
    sessions: &[Session],
    crons: &[Cron],
    user_mentions: &[UserMention],
    runtime_inbox_items: &[InboxItem],
) -> Vec<InboxItem> {
    let mut items: Vec<InboxItem> = gathered(issues, sessions, crons, user_mentions).into_iter().map(worded).collect();
    if !runtime_inbox_items.is_empty() {
        items.extend(runtime_inbox_items.iter().cloned());
    }
    items.sort_by_key(|i| std::cmp::Reverse(i.at));
    items
}

/// An item before its words.
struct Bare {
    id: String,
    kind: InboxKind,
    from: InboxFrom,
    text: String,
    at: i64,
    target: InboxTarget,
}

enum Want<'a> {
    Ask(&'a [Question]),
    Review,
    Fix,
    Interrupted,
    Conflict,
    Quiet(i64),
}

fn gathered(issues_slice: &[Issue], sessions: &[Session], crons: &[Cron], user_mentions: &[UserMention]) -> Vec<Bare> {
    let mut out = vec![];
    let issues: HashMap<&str, &Issue> = issues_slice.iter().map(|i| (i.id.as_str(), i)).collect();
    let mut children: HashMap<&str, Vec<&Issue>> = HashMap::new();
    for item in issues_slice {
        if let Some(p) = &item.parent {
            children.entry(p.as_str()).or_default().push(item);
        }
    }
    let session_ids: HashSet<&str> = sessions.iter().map(|s| s.id.as_str()).collect();

    for h in sessions {
        if !is_farm_worker(h) {
            continue;
        }
        let Some(want) = want_of(h, &issues) else { continue };
        let from = InboxFrom::Session(InboxFromSession {
            id: h.id.clone(),
            name: h.name.clone(),
            agent: h.profile.clone().unwrap_or_default(),
        });
        let target = InboxTarget::Session(InboxTargetSession { id: h.id.clone() });
        let at = h.last_run.as_ref().map_or(h.hired_at, |r| r.at);
        let summary = match &h.last_run {
            Some(r) if !r.summary.is_empty() => r.summary.as_str(),
            _ => h.brief.as_str(),
        };
        let (id, kind, text, at) = match want {
            Want::Ask(questions) => {
                let question = questions.first().map_or("", |q| q.question.as_str());
                (format!("{}:ask:{}", h.id, h.runs), InboxKind::Ask, cut(question, 40), at)
            }
            Want::Review => (format!("{}:review:{}", h.id, h.runs), InboxKind::Review, cut(summary, 40), at),
            Want::Fix => (format!("{}:fix:{}", h.id, h.runs), InboxKind::Fix, cut(summary, 40), at),
            Want::Interrupted => (format!("{}:interrupted:{}", h.id, h.runs), InboxKind::Interrupted, cut(summary, 40), at),
            Want::Conflict => {
                let files = h
                    .issue_id()
                    .and_then(|i| issues.get(i))
                    .and_then(|i| i.conflict.as_ref())
                    .map_or(0, |c| c.files.len());
                (
                    format!("{}:conflict:{}", h.id, h.runs),
                    InboxKind::Conflict,
                    t("server.inbox.conflictFiles", &[("files", files.into())]),
                    at,
                )
            }
            Want::Quiet(since) => (format!("{}:quiet:{since}", h.id), InboxKind::Quiet, cut(&h.brief, 40), since),
        };
        out.push(Bare {
            id,
            kind,
            from,
            text,
            at,
            target,
        });
    }

    let orchestrator = || InboxFrom::Orchestrator(InboxFromOrchestrator {});
    for issue in issues_slice {
        let conflicted = issue.stage.state == IssueStageKind::Stuck && issue.stage.stuck == Some(StuckReason::Conflict);
        if issue.stage.state != IssueStageKind::Reviewing && !conflicted {
            continue;
        }
        if issue.latest_session_id().is_some_and(|s| session_ids.contains(s.as_str())) {
            continue;
        }
        let Some(kids) = children.get(issue.id.as_str()).filter(|k| !k.is_empty()) else {
            continue;
        };
        let at = kids.iter().map(|c| c.closed_at.unwrap_or(c.created_at)).fold(issue.created_at, i64::max);
        let (kind, word) = if conflicted {
            (InboxKind::Conflict, "conflict")
        } else {
            (InboxKind::Review, "review")
        };
        out.push(Bare {
            id: format!("{}:{word}:{at}", issue.id),
            kind,
            from: orchestrator(),
            text: cut(&issue.title, 40),
            at,
            target: InboxTarget::Issue(InboxTargetIssue { id: issue.id.clone() }),
        });
    }

    for sc in crons.iter().filter(|c| c.pending) {
        out.push(Bare {
            id: format!("{}:ask", sc.id),
            kind: InboxKind::CronAsk,
            from: orchestrator(),
            text: cut(&sc.name, 40),
            at: sc.created,
            target: InboxTarget::Chat(InboxTargetChat { channel: sc.channel.clone() }),
        });
    }

    for UserMention { message: m, .. } in user_mentions {
        let from = if actor_role_of(&m.actor) == Some(AgentRole::Worker) {
            InboxFrom::Session(InboxFromSession {
                id: m.session.clone().unwrap_or_else(|| m.from.clone()),
                name: m.name.clone(),
                agent: m.agent.clone().unwrap_or_default(),
            })
        } else {
            orchestrator()
        };
        out.push(Bare {
            id: m.id.clone(),
            kind: InboxKind::Mention,
            from,
            text: cut(&m.text, 40),
            at: m.at,
            target: InboxTarget::Chat(InboxTargetChat { channel: m.channel.clone() }),
        });
    }
    out
}

/// `wantOf`: what a session asks of the user; its issue's stage says it.
fn want_of<'a>(h: &Session, issues: &HashMap<&str, &'a Issue>) -> Option<Want<'a>> {
    let issue = h
        .issue_id()
        .and_then(|i| issues.get(i).copied())
        .filter(|i| i.latest_session_id().is_some_and(|s| *s == h.id));
    let Some(issue) = issue else {
        return match need_of(h, None)? {
            Need::Retrying { .. } => None,
            Need::Review => Some(Want::Review),
            Need::Fix => Some(Want::Fix),
            Need::Conflict { .. } => Some(Want::Conflict),
            Need::Quiet { since } => Some(Want::Quiet(since)),
        };
    };
    let st = &issue.stage;
    match st.state {
        IssueStageKind::Asking => Some(Want::Ask(&issue.questions)),
        IssueStageKind::Reviewing => issue.parent.is_none().then_some(Want::Review),
        IssueStageKind::Stuck => Some(match st.stuck {
            Some(StuckReason::Failed) | None => Want::Fix,
            Some(StuckReason::Interrupted) => Want::Interrupted,
            Some(StuckReason::Conflict) => Want::Conflict,
            Some(StuckReason::Quiet) => Want::Quiet(st.since.unwrap_or(h.hired_at)),
        }),
        _ => None,
    }
}

fn worded(b: Bare) -> InboxItem {
    let who = match &b.from {
        InboxFrom::Session(s) => s.name.clone(),
        InboxFrom::Orchestrator(_) => t("server.inbox.orchestrator", &[]),
        InboxFrom::Runtime(_) => "runtime".to_string(),
    };
    let words = inbox_words(b.kind, &who, &clip(&b.text, 140));
    InboxItem {
        id: b.id,
        kind: b.kind,
        from: b.from,
        who,
        text: b.text,
        at: b.at,
        target: b.target,
        words,
    }
}

fn inbox_words(kind: InboxKind, who: &str, text: &str) -> InboxWords {
    let w = |k: &str| t(k, &[("who", who.into())]);
    let plain = |k: &str| t(k, &[]);
    let (label, title, body, tray) = match kind {
        InboxKind::Review => (
            plain("server.inbox.item.review.label"),
            w("server.inbox.item.review.title"),
            text.to_string(),
            w("server.inbox.item.review.tray"),
        ),
        InboxKind::Ask => (
            plain("server.inbox.item.ask.label"),
            w("server.inbox.item.ask.title"),
            text.to_string(),
            String::new(),
        ),
        InboxKind::Fix => (
            plain("server.inbox.item.fix.label"),
            w("server.inbox.item.fix.title"),
            text.to_string(),
            w("server.inbox.item.fix.tray"),
        ),
        InboxKind::Interrupted => (
            plain("shared.stuck.interrupted"),
            w("server.inbox.item.interrupted.title"),
            text.to_string(),
            String::new(),
        ),
        InboxKind::Conflict => (
            plain("server.inbox.item.conflict.label"),
            w("server.inbox.item.conflict.title"),
            text.to_string(),
            w("server.inbox.item.conflict.tray"),
        ),
        InboxKind::Quiet => (
            plain("server.inbox.item.quiet.label"),
            w("server.inbox.item.quiet.title"),
            plain("server.inbox.item.quiet.body"),
            w("server.inbox.item.quiet.tray"),
        ),
        InboxKind::Mention => (
            plain("server.inbox.item.mention.label"),
            w("server.inbox.item.mention.title"),
            text.to_string(),
            String::new(),
        ),
        InboxKind::CronAsk => (
            plain("server.inbox.item.cron-ask.label"),
            plain("server.inbox.item.cron-ask.title"),
            t("server.inbox.item.cron-ask.body", &[("text", text.into())]),
            t("server.inbox.item.cron-ask.tray", &[("text", text.into())]),
        ),
        InboxKind::BudgetReached => ("budget_reached".to_string(), who.to_string(), text.to_string(), text.to_string()),
    };
    InboxWords { label, title, body, tray }
}
