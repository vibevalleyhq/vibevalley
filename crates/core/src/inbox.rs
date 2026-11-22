//! What waits on the user, gathered from the state.

use std::collections::{HashMap, HashSet};

use vibevalley_i18n::t;
use vibevalley_protocol::*;

use crate::rules::{Need, actor_role_of, clip, cut, default_of, need_of, one_line, slice};
use crate::status::is_farm_worker;

/// An inbox item with where it belongs and what the patrol says of it.
/// `channel` `None`: the general channel; `since` `None`: from when the
/// reader first saw it.
#[derive(Debug, Clone, PartialEq)]
pub struct InboxEntry {
    pub item: InboxItem,
    pub channel: Option<String>,
    pub since: Option<i64>,
    /// The patrol's line for it, `{ago}` left to fill.
    pub brief: String,
}

/// The patrol's words (`watch/prompts.ts`); VibeValley writes them in
/// Chinese for the model whatever the user's language.
pub mod brief {
    pub fn ask(who: &str, questions: usize, question: &str) -> String {
        format!("{who}问了用户 {questions} 个问题，{{ago}}没人回：「{question}」")
    }
    pub fn review(who: &str, brief: &str) -> String {
        format!("{who}的活做完 {{ago}}了还没人看：「{brief}」")
    }
    pub fn fix(who: &str, summary: &str) -> String {
        format!("{who}这一轮没做成，{{ago}}没人管了：「{summary}」")
    }
    pub fn interrupted(who: &str, brief: &str) -> String {
        format!("{who}这一轮停在了半路，{{ago}}没人管了：「{brief}」")
    }
    pub fn conflict(who: &str, files: usize) -> String {
        format!("{who}的活合进主分支会冲突（{files} 个文件），{{ago}}没人管了")
    }
    pub fn quiet(who: &str, label: &str) -> String {
        let at = if label.is_empty() {
            "想事情".to_string()
        } else {
            format!("「{label}」")
        };
        format!("{who}在干活，{{ago}}没动静了，最后在{at}")
    }
    pub fn cron(name: &str, id: &str) -> String {
        format!("定时「{name}」（{id}）等用户同意，{{ago}}了")
    }
    pub fn mention(name: &str, address: &str, text: &str) -> String {
        format!("{name} 在 {address} 问用户的话，{{ago}}没人回：「{text}」")
    }
    /// `patrolWho`: a session as the model is told of it.
    pub fn who(name: &str, id: &str) -> String {
        format!("{name}（{id}）")
    }
    /// `patrolAgo`: hours from two on, minutes before.
    pub fn ago(ms: i64) -> String {
        if ms >= 2 * 60 * 60_000 {
            format!("{} 小时", (ms as f64 / (60.0 * 60_000.0)).round() as i64)
        } else {
            format!("{} 分钟", ((ms as f64 / 60_000.0).round() as i64).max(1))
        }
    }
}

/// `inbox`: newest first; items of the same moment in the order gathered.
pub fn inbox(state: &SpaceState) -> Vec<InboxItem> {
    let mut items: Vec<InboxItem> = inbox_entries(state).into_iter().map(|e| e.item).collect();
    items.sort_by_key(|i| std::cmp::Reverse(i.at));
    items
}

/// `inboxEntries`.
pub fn inbox_entries(state: &SpaceState) -> Vec<InboxEntry> {
    gathered(state)
        .into_iter()
        .map(|g| InboxEntry {
            item: worded(g.item),
            channel: g.channel,
            since: g.since,
            brief: g.brief,
        })
        .collect()
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

struct Gathered {
    item: Bare,
    channel: Option<String>,
    since: Option<i64>,
    brief: String,
}

enum Want<'a> {
    Ask(&'a [Question]),
    Review,
    Fix,
    Interrupted,
    Conflict,
    Quiet(i64),
}

fn gathered(state: &SpaceState) -> Vec<Gathered> {
    let chat = state.chat.as_ref();
    let general = default_of(chat).map(|c| c.id.clone());
    let mut out = vec![];
    let issues: HashMap<&str, &Issue> = state.issues.iter().map(|i| (i.id.as_str(), i)).collect();
    let mut children: HashMap<&str, Vec<&Issue>> = HashMap::new();
    for item in &state.issues {
        if let Some(p) = &item.parent {
            children.entry(p.as_str()).or_default().push(item);
        }
    }
    let session_ids: HashSet<&str> = state.sessions.iter().map(|s| s.id.as_str()).collect();

    for h in &state.sessions {
        if !is_farm_worker(h) {
            continue;
        }
        let Some(want) = want_of(h, &issues) else { continue };
        let channel = h.channel_id().map(str::to_string).or_else(|| general.clone());
        let from = InboxFrom::Session(InboxFromSession {
            id: h.id.clone(),
            name: h.name.clone(),
            agent: h.profile.clone().unwrap_or_default(),
        });
        let target = InboxTarget::Session(InboxTargetSession { id: h.id.clone() });
        let at = h.last_run.as_ref().map_or(h.hired_at, |r| r.at);
        let summary = match &h.last_run {
            Some(r) if !r.summary.is_empty() => r.summary.clone(),
            _ => h.brief.clone(),
        };
        let who = brief::who(&h.name, &h.id);
        let (id, kind, text, at, brief) = match want {
            Want::Ask(questions) => {
                let question = questions.first().map_or("", |q| q.question.as_str());
                (
                    format!("{}:ask:{}", h.id, h.runs),
                    InboxKind::Ask,
                    cut(question, 40),
                    at,
                    brief::ask(&who, questions.len(), &slice(question, 0, Some(60))),
                )
            }
            Want::Review => (
                format!("{}:review:{}", h.id, h.runs),
                InboxKind::Review,
                cut(&summary, 40),
                at,
                brief::review(&who, &slice(&h.brief, 0, Some(60))),
            ),
            Want::Fix => (
                format!("{}:fix:{}", h.id, h.runs),
                InboxKind::Fix,
                cut(&summary, 40),
                at,
                brief::fix(&who, &slice(&summary, 0, Some(60))),
            ),
            Want::Interrupted => (
                format!("{}:interrupted:{}", h.id, h.runs),
                InboxKind::Interrupted,
                cut(&summary, 40),
                at,
                brief::interrupted(&who, &slice(&h.brief, 0, Some(60))),
            ),
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
                    brief::conflict(&who, files),
                )
            }
            Want::Quiet(since) => {
                let label = match &h.phase {
                    Phase::Working(p) => p.doing.label.as_str(),
                    _ => "",
                };
                (
                    format!("{}:quiet:{since}", h.id),
                    InboxKind::Quiet,
                    cut(&h.brief, 40),
                    since,
                    brief::quiet(&who, label),
                )
            }
        };
        out.push(Gathered {
            item: Bare {
                id,
                kind,
                from,
                text,
                at,
                target,
            },
            channel,
            since: Some(at),
            brief,
        });
    }

    let orchestrator = || InboxFrom::Orchestrator(InboxFromOrchestrator {});
    for issue in &state.issues {
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
        let brief = if conflicted {
            brief::conflict(&issue.title, issue.conflict.as_ref().map_or(0, |c| c.files.len()))
        } else {
            brief::review(&issue.title, &format!("vv://issue/{}", issue.id))
        };
        out.push(Gathered {
            item: Bare {
                id: format!("{}:{word}:{at}", issue.id),
                kind,
                from: orchestrator(),
                text: cut(&issue.title, 40),
                at,
                target: InboxTarget::Issue(InboxTargetIssue { id: issue.id.clone() }),
            },
            channel: general.clone(),
            since: Some(at),
            brief,
        });
    }

    for sc in state.crons.iter().filter(|c| c.pending) {
        out.push(Gathered {
            item: Bare {
                id: format!("{}:ask", sc.id),
                kind: InboxKind::CronAsk,
                from: orchestrator(),
                text: cut(&sc.name, 40),
                at: sc.created,
                target: InboxTarget::Chat(InboxTargetChat { channel: sc.channel.clone() }),
            },
            channel: Some(sc.channel.clone()),
            since: Some(sc.created),
            brief: brief::cron(&sc.name, &sc.id),
        });
    }

    for UserMention { message: m, channel, address } in chat.map_or(&[][..], |c| &c.user_mentions[..]) {
        let from = if actor_role_of(&m.actor) == Some(AgentRole::Worker) {
            InboxFrom::Session(InboxFromSession {
                id: m.session.clone().unwrap_or_else(|| m.from.clone()),
                name: m.name.clone(),
                agent: m.agent.clone().unwrap_or_default(),
            })
        } else {
            orchestrator()
        };
        out.push(Gathered {
            item: Bare {
                id: m.id.clone(),
                kind: InboxKind::Mention,
                from,
                text: cut(&m.text, 40),
                at: m.at,
                target: InboxTarget::Chat(InboxTargetChat { channel: m.channel.clone() }),
            },
            channel: Some(channel.clone()),
            since: Some(m.at),
            brief: brief::mention(&m.name, address, &slice(&one_line(&m.text), 0, Some(80))),
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
    };
    InboxWords { label, title, body, tray }
}

/// `freshOf`: the items that are news to `known`. `None` is the first
/// look, which knows them all and has no news.
pub fn fresh_of(known: Option<&HashSet<String>>, items: &[InboxItem]) -> (Vec<InboxItem>, HashSet<String>) {
    let mut next: HashSet<String> = known.cloned().unwrap_or_default();
    let fresh: Vec<InboxItem> = items.iter().filter(|i| !next.contains(&i.id)).cloned().collect();
    next.extend(fresh.iter().map(|i| i.id.clone()));
    (if known.is_none() { vec![] } else { fresh }, next)
}
