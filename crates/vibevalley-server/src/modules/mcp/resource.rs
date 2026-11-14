//! `resource_read` (`gateway/tool/resource.ts`): paged reads of `vv://`
//! resources over a per-session snapshot. An issue, a channel's messages and
//! a session's trajectory; triggers, envelopes and GitHub threads are not
//! kept here, so they read as missing.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use vibevalley_protocol::{AgentRole, Issue, Session};

use crate::modules::channel::Chat;
use crate::modules::issue::Board;
use crate::modules::session::Trajectories;

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
        ("github", [_, pulls, n, ..]) if pulls == "pulls" && n.parse::<u64>().is_ok_and(|n| n > 0) => Some(Ref::Absent),
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

pub struct Resources {
    board: Board,
    chat: Arc<Chat>,
    trajectories: Arc<Trajectories>,
    cache: Mutex<Cache>,
}

impl Resources {
    pub fn new(board: Board, chat: Arc<Chat>, trajectories: Arc<Trajectories>) -> Arc<Resources> {
        Arc::new(Resources {
            board,
            chat,
            trajectories,
            cache: Mutex::new(Cache::default()),
        })
    }

    /// One page as `resource_read` answers it (JSON text), or the refusal.
    /// `reader` is a session id; `None` reads as the orchestrator.
    pub fn read(&self, reader: Option<&Session>, args: &Value) -> Result<String, String> {
        let uri = args["uri"].as_str().unwrap_or("").trim().to_string();
        let r = parse(&uri).ok_or_else(|| invalid_uri(&uri))?;
        let offset = match &args["offset"] {
            Value::Null => 0,
            v => v.as_i64().filter(|o| *o >= 0).ok_or("offset 不能小于 0。")? as usize,
        };
        let orchestrator = reader.is_none_or(|s| s.role == AgentRole::Orchestrator);
        let key = format!("{}:{uri}", reader.map(|s| s.id.as_str()).unwrap_or("orchestrator"));
        let text: Vec<u16> = if offset == 0 {
            let loaded = self.load(r, reader, orchestrator, &uri)?;
            let units: Vec<u16> = loaded.encode_utf16().collect();
            if !self.cache.lock().unwrap_or_else(|e| e.into_inner()).put(key, units.clone()) {
                return Err(SNAPSHOT_TOO_LARGE.into());
            }
            units
        } else {
            let cache = self.cache.lock().unwrap_or_else(|e| e.into_inner());
            cache.texts.get(&key).cloned().ok_or(SNAPSHOT_MISSING)?
        };
        let limit = args["limit"].as_i64().unwrap_or(DEFAULT_LIMIT as i64).clamp(1, MAX_LIMIT as i64) as usize;
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

    fn load(&self, r: Ref, reader: Option<&Session>, orchestrator: bool, uri: &str) -> Result<String, String> {
        let pretty = |v: Value| serde_json::to_string_pretty(&v).map_err(|e| e.to_string());
        match r {
            Ref::Absent => Err(missing(uri)),
            Ref::Issue(id) => {
                let issue = self.issue(&id).ok_or_else(|| missing(uri))?;
                if !orchestrator && !reader.is_some_and(|s| self.may_read_issue(s, &issue)) {
                    return Err(forbidden(uri));
                }
                let runs = self.board.runs(&issue.id).unwrap_or_default();
                let messages = self.chat.issue_messages(&issue.id).unwrap_or_default();
                pretty(json!({ "issue": issue, "runs": runs, "messages": messages }))
            }
            Ref::Channel(id) => {
                if !orchestrator && !reader.is_some_and(|s| self.may_read_channel(s, &id)) {
                    return Err(forbidden(uri));
                }
                let messages = self.chat.history(&id, None, Some(200)).map_err(|e| e.message)?;
                let latest_page = messages.len() == 200;
                pretty(json!({ "messages": messages, "latestPage": latest_page }))
            }
            Ref::Session(id) => {
                if !orchestrator && reader.is_none_or(|s| s.id != id) {
                    return Err(forbidden(uri));
                }
                let events = self.trajectories.events(&id, None).ok_or_else(|| missing(uri))?;
                pretty(json!({ "events": events }))
            }
        }
    }

    fn issue(&self, key: &str) -> Option<Issue> {
        let k = key.trim_start_matches('#');
        self.board.read(|s| s.issues.iter().find(|i| i.id == key || i.number.to_string() == k).cloned())
    }

    fn may_read_channel(&self, s: &Session, channel: &str) -> bool {
        s.channel.as_deref() == Some(channel) || self.chat.home_of(&s.id).as_deref() == Some(channel)
    }

    /// Its own issue, the parent, and every issue its own waits on.
    fn may_read_issue(&self, s: &Session, target: &Issue) -> bool {
        let Some(own) = s.issue.as_ref() else { return false };
        if own == &target.id {
            return true;
        }
        self.board.read(|state| {
            let all: HashMap<&str, &Issue> = state.issues.iter().map(|i| (i.id.as_str(), i)).collect();
            let Some(mine) = all.get(own.as_str()) else { return false };
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
        })
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
        assert!(matches!(parse("vv://github/demo/pulls/3/checks"), Some(Ref::Absent)));
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
