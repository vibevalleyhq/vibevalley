//! `resource_read` (`gateway/tool/resource.ts`): paged reads of `vv://`
//! resources over a per-session snapshot. An issue, a channel's messages and
//! a session's trajectory; triggers, envelopes and GitHub threads are not
//! kept here, so they read as missing.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use vibevalley_protocol::{Issue, IssueFilter, Session};

use crate::app::port::ResourcePort;
use crate::collab::channel::Chat;
use crate::transport::api::BoxFuture;
use crate::work::issue::IssueStore;
use crate::work::pull::PullStore;
use crate::work::session::TrajectoryStore;

#[derive(Deserialize)]
pub struct ResourceReadArgs {
    pub uri: String,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

const DEFAULT_LIMIT: usize = 4000;
const MAX_LIMIT: usize = 16000;
/// What all snapshots together may hold, in UTF-16 units.
const CACHE_UNITS: usize = 8 * 1024 * 1024;

fn invalid_uri(uri: &str) -> String {
    format!("不认识资源 URI：{uri}")
}
fn forbidden(uri: &str) -> String {
    format!("这次会话没有权限读 {uri}")
}
fn missing(uri: &str) -> String {
    format!("没有找到资源：{uri}")
}
const SNAPSHOT_MISSING: &str = "这一页的快照已经不在了；从 offset 0 重新读。";
const SNAPSHOT_TOO_LARGE: &str = "这个资源超过单个会话快照的上限，不能稳定分页。";

enum Ref {
    Issue(String),
    Channel(String),
    Session(String),
    GithubPull {
        repo: String,
        number: i64,
        section: Option<String>,
    },
    /// Kinds the TypeScript server kept that this one does not.
    Absent,
}

fn parse(uri: &str) -> Option<Ref> {
    let rest = uri.strip_prefix("vv://")?;
    if rest.contains(['?', '#', '@']) {
        return None;
    }
    let mut parts = rest.split('/').filter(|p| !p.is_empty());
    let host = parts.next()?;
    let path: Vec<String> = parts.map(percent_decode).collect::<Option<_>>()?;
    match (host, path.as_slice()) {
        ("issue", [id]) => Some(Ref::Issue(id.clone())),
        ("channel", [id, m]) if m == "messages" => Some(Ref::Channel(id.clone())),
        ("session", [id, t]) if t == "trajectory" => Some(Ref::Session(id.clone())),
        ("trigger" | "envelope", [_]) => Some(Ref::Absent),
        ("github", [repo, pulls, n]) if pulls == "pulls" => {
            let number = n.parse::<i64>().ok().filter(|&v| v > 0)?;
            Some(Ref::GithubPull {
                repo: repo.clone(),
                number,
                section: None,
            })
        }
        ("github", [repo, pulls, n, section]) if pulls == "pulls" => {
            let number = n.parse::<i64>().ok().filter(|&v| v > 0)?;
            Some(Ref::GithubPull {
                repo: repo.clone(),
                number,
                section: Some(section.clone()),
            })
        }
        ("github", [owner, repo, pulls, n]) if pulls == "pulls" => {
            let number = n.parse::<i64>().ok().filter(|&v| v > 0)?;
            Some(Ref::GithubPull {
                repo: format!("{owner}/{repo}"),
                number,
                section: None,
            })
        }
        ("github", [owner, repo, pulls, n, section]) if pulls == "pulls" => {
            let number = n.parse::<i64>().ok().filter(|&v| v > 0)?;
            Some(Ref::GithubPull {
                repo: format!("{owner}/{repo}"),
                number,
                section: Some(section.clone()),
            })
        }
        _ => None,
    }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Snapshots by `<session>:<uri>`, oldest dropped first.
#[derive(Default)]
struct Cache {
    texts: HashMap<String, Vec<u16>>,
    order: VecDeque<String>,
    units: usize,
}

impl Cache {
    fn put(&mut self, key: String, text: Vec<u16>) -> bool {
        if text.len() > CACHE_UNITS {
            return false;
        }
        if let Some(old) = self.texts.remove(&key) {
            self.units -= old.len();
            self.order.retain(|k| k != &key);
        }
        while self.units + text.len() > CACHE_UNITS {
            let Some(oldest) = self.order.pop_front() else { break };
            if let Some(t) = self.texts.remove(&oldest) {
                self.units -= t.len();
            }
        }
        self.units += text.len();
        self.order.push_back(key.clone());
        self.texts.insert(key, text);
        true
    }
}

pub struct ResourceStore {
    issues: Arc<IssueStore>,
    chat: Arc<Chat>,
    trajectories: Arc<TrajectoryStore>,
    pulls: Option<Arc<PullStore>>,
    cache: Mutex<Cache>,
}

impl ResourceStore {
    pub fn new(issues: Arc<IssueStore>, chat: Arc<Chat>, trajectories: Arc<TrajectoryStore>) -> Arc<ResourceStore> {
        Arc::new(ResourceStore {
            issues,
            chat,
            trajectories,
            pulls: None,
            cache: Mutex::new(Cache::default()),
        })
    }

    pub fn with_pulls(issues: Arc<IssueStore>, chat: Arc<Chat>, trajectories: Arc<TrajectoryStore>, pulls: Arc<PullStore>) -> Arc<ResourceStore> {
        Arc::new(ResourceStore {
            issues,
            chat,
            trajectories,
            pulls: Some(pulls),
            cache: Mutex::new(Cache::default()),
        })
    }

    /// One page as `resource_read` answers it (JSON text), or the refusal.
    /// `reader` is a session; `None` reads as the orchestrator.
    pub async fn read_async(&self, reader: Option<&Session>, args: &ResourceReadArgs) -> Result<String, String> {
        let uri = args.uri.trim().to_string();
        let r = parse(&uri).ok_or_else(|| invalid_uri(&uri))?;
        let offset = match args.offset {
            None => 0,
            Some(o) if o >= 0 => o as usize,
            Some(_) => return Err("offset 不能小于 0。".into()),
        };
        let orchestrator = reader.is_none_or(|s| s.is_orchestrator());
        let key = format!("{}:{uri}", reader.map(|s| s.id.as_str()).unwrap_or("orchestrator"));
        let text: Vec<u16> = if offset == 0 {
            let loaded = self.load_async(r, reader, orchestrator, &uri).await?;
            let units: Vec<u16> = loaded.encode_utf16().collect();
            if !self.cache.lock().put(key, units.clone()) {
                return Err(SNAPSHOT_TOO_LARGE.into());
            }
            units
        } else {
            let cache = self.cache.lock();
            cache.texts.get(&key).cloned().ok_or(SNAPSHOT_MISSING)?
        };
        let limit = args.limit.unwrap_or(DEFAULT_LIMIT as i64).clamp(1, MAX_LIMIT as i64) as usize;
        let start = offset.min(text.len());
        let end = (offset + limit).min(text.len());
        let mut page = json!({
            "uri": uri,
            "offset": offset,
            "totalChars": text.len(),
            "text": String::from_utf16_lossy(&text[start..end]),
        });
        if end < text.len() {
            page["nextOffset"] = json!(end);
        }
        serde_json::to_string_pretty(&page).map_err(|e| e.to_string())
    }

    async fn load_async(&self, r: Ref, reader: Option<&Session>, orchestrator: bool, uri: &str) -> Result<String, String> {
        let pretty = |v: Value| serde_json::to_string_pretty(&v).map_err(|e| e.to_string());
        match r {
            Ref::Absent => Err(missing(uri)),
            Ref::Issue(id) => {
                let all_issues = self.issues.list_async(&IssueFilter::default()).await.unwrap_or_default();
                let issue = find_issue(&all_issues, &id).ok_or_else(|| missing(uri))?;
                if !orchestrator && !reader.is_some_and(|s| may_read_issue(s, &issue, &all_issues)) {
                    return Err(forbidden(uri));
                }
                let runs = self.issues.runs_async(&issue.id).await.unwrap_or_default();
                let messages = self.chat.issue_messages_async(&issue.id).await.unwrap_or_default();
                pretty(json!({ "issue": issue, "runs": runs, "messages": messages }))
            }
            Ref::Channel(id) => {
                if !orchestrator && !reader.is_some_and(|s| self.may_read_channel(s, &id)) {
                    return Err(forbidden(uri));
                }
                let messages = self.chat.history_async(&id, None, Some(200)).await.map_err(|e| e.message)?;
                let latest_page = messages.len() == 200;
                pretty(json!({ "messages": messages, "latestPage": latest_page }))
            }
            Ref::Session(id) => {
                if !orchestrator && reader.is_none_or(|s| s.id != id) {
                    return Err(forbidden(uri));
                }
                let events = self.trajectories.events_async(&id, None).await.ok_or_else(|| missing(uri))?;
                pretty(json!({ "events": events }))
            }
            Ref::GithubPull { repo, number, section } => {
                let Some(pulls) = &self.pulls else {
                    return Err(missing(uri));
                };
                let snap = pulls.snapshot_async(&repo, number).await.map_err(|e| e.message)?;
                match section.as_deref() {
                    None => pretty(serde_json::to_value(&snap).map_err(|e| e.to_string())?),
                    Some("checks") => pretty(json!({ "repo": snap.repo, "number": snap.number, "head": snap.head, "checks": snap.checks })),
                    Some("reviews") => pretty(json!({ "repo": snap.repo, "number": snap.number, "reviews": snap.reviews })),
                    Some("comments") => pretty(json!({ "repo": snap.repo, "number": snap.number, "comments": snap.comments })),
                    Some(_) => Err(missing(uri)),
                }
            }
        }
    }

    fn may_read_channel(&self, s: &Session, channel: &str) -> bool {
        s.channel_id() == Some(channel) || self.chat.home_of(&s.id).as_deref() == Some(channel)
    }
}

fn find_issue(issues: &[Issue], key: &str) -> Option<Issue> {
    let k = key.trim_start_matches('#');
    issues.iter().find(|i| i.id == key || i.number.to_string() == k).cloned()
}

/// Its own issue, the parent, and every issue its own waits on.
fn may_read_issue(s: &Session, target: &Issue, issues: &[Issue]) -> bool {
    let Some(own) = s.issue_id() else { return false };
    if own == target.id {
        return true;
    }
    let all: HashMap<&str, &Issue> = issues.iter().map(|i| (i.id.as_str(), i)).collect();
    let Some(mine) = all.get(own) else { return false };
    if mine.parent.as_deref() == Some(target.id.as_str()) {
        return true;
    }
    let mut seen: HashSet<&str> = HashSet::new();
    let mut todo: Vec<&str> = mine.blocked_by.iter().map(String::as_str).collect();
    while let Some(id) = todo.pop() {
        if !seen.insert(id) {
            continue;
        }
        if let Some(i) = all.get(id) {
            todo.extend(i.blocked_by.iter().map(String::as_str));
        }
    }
    seen.contains(target.id.as_str())
}

impl ResourcePort for ResourceStore {
    fn read_async<'a>(&'a self, reader: Option<&'a Session>, uri: &'a str, offset: Option<i64>, limit: Option<i64>) -> BoxFuture<'a, Result<String, String>> {
        let args = ResourceReadArgs {
            uri: uri.to_string(),
            offset,
            limit,
        };
        Box::pin(async move { ResourceStore::read_async(self, reader, &args).await })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris_parse_as_the_typescript_server_reads_them() {
        assert!(matches!(parse("vv://issue/abc"), Some(Ref::Issue(id)) if id == "abc"));
        assert!(matches!(parse("vv://channel/c%201/messages"), Some(Ref::Channel(id)) if id == "c 1"));
        assert!(matches!(parse("vv://session/w3/trajectory"), Some(Ref::Session(id)) if id == "w3"));
        assert!(matches!(parse("vv://trigger/t1"), Some(Ref::Absent)));
        assert!(matches!(
            parse("vv://github/demo/pulls/3/checks"),
            Some(Ref::GithubPull { repo, number: 3, section }) if repo == "demo" && section.as_deref() == Some("checks")
        ));
        assert!(matches!(
            parse("vv://github/acme/demo/pulls/7"),
            Some(Ref::GithubPull { repo, number: 7, section: None }) if repo == "acme/demo"
        ));
        assert!(parse("vv://issue/a/b").is_none());
        assert!(parse("vv://issue/a?x=1").is_none());
        assert!(parse("https://issue/a").is_none());
        assert!(parse("vv://github/demo/pulls/0/checks").is_none());
    }

    #[test]
    fn the_cache_drops_the_oldest_snapshot_first() {
        let mut c = Cache::default();
        assert!(c.put("a".into(), vec![0; CACHE_UNITS / 2]));
        assert!(c.put("b".into(), vec![0; CACHE_UNITS / 2]));
        assert!(c.put("c".into(), vec![0; 10]));
        assert!(!c.texts.contains_key("a"));
        assert!(c.texts.contains_key("b") && c.texts.contains_key("c"));
        assert!(!c.put("d".into(), vec![0; CACHE_UNITS + 1]));
    }
}
