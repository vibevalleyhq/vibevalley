//! `resource_read` and MCP `resources/*`: reads of `vv://` resources.
//! Covers open issues (`vv://issues`), single issues (`vv://issue/{id}`) with
//! resolved local attachment CAS paths, channel messages, session trajectories,
//! and GitHub pulls; triggers and envelopes are absent here and read as missing.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use vibevalley_protocol::{Issue, Session};

use crate::channel::Chat;
use crate::context::Context;
use crate::issue::Pull;
use crate::runtime::Runtime;
use crate::storage::Storage;

#[derive(Deserialize)]
pub struct ResourceReadArgs {
    pub uri: String,
    pub offset: Option<i64>,
    pub limit: Option<i64>,
}

/// Caller identity governing `vv://` resource visibility.
#[derive(Clone, Copy)]
pub enum ResourceReader<'a> {
    Orchestrator,
    Helper(&'a Session),
    /// Unauthenticated loopback MCP caller restricted to read-only issue URIs.
    LocalReadOnly,
}

/// Standard MCP resource listing entry (`resources/list`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceWire {
    pub uri: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub mime_type: String,
}

/// Standard MCP resource template entry (`resources/templates/list`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceTemplateWire {
    pub uri_template: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub mime_type: String,
}

/// Standard MCP resource read item (`resources/read`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpResourceContentWire {
    pub uri: String,
    pub mime_type: String,
    pub text: String,
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
    Issues,
    Issue(String),
    Channel(String),
    Session(String),
    GithubPull { repo: String, number: i64, section: Option<String> },
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
        ("issues", []) => Some(Ref::Issues),
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

/// Paged `vv://` resource reader backed by `ctx.service`, `Chat`, `Runtime`, and optional `Pull`.
pub struct Resource {
    ctx: Arc<Context>,
    chat: Arc<Chat>,
    runtime: Arc<Runtime>,
    pull: Option<Arc<Pull>>,
    cache: Mutex<Cache>,
}

impl Resource {
    pub fn new(ctx: Arc<Context>, chat: Arc<Chat>, runtime: Arc<Runtime>) -> Arc<Resource> {
        Arc::new(Resource {
            ctx,
            chat,
            runtime,
            pull: None,
            cache: Mutex::new(Cache::default()),
        })
    }

    pub fn with_pull(ctx: Arc<Context>, chat: Arc<Chat>, runtime: Arc<Runtime>, pull: Arc<Pull>) -> Arc<Resource> {
        Arc::new(Resource {
            ctx,
            chat,
            runtime,
            pull: Some(pull),
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
        let caller = match reader {
            Some(s) if s.is_orchestrator() => ResourceReader::Orchestrator,
            Some(s) => ResourceReader::Helper(s),
            None => ResourceReader::Orchestrator,
        };
        let key = format!("{}:{uri}", reader.map(|s| s.id.as_str()).unwrap_or("orchestrator"));
        let text: Vec<u16> = if offset == 0 {
            let loaded = self.load_async(r, caller, &uri, None).await?;
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

    /// Lists standard MCP resources (`vv://issues` plus each open `vv://issue/{id}`).
    pub async fn list_mcp_resources_async(&self) -> Vec<McpResourceWire> {
        let mut out = vec![McpResourceWire {
            uri: "vv://issues".into(),
            name: "Open Issues".into(),
            description: Some("All open VibeValley issues with attachment metadata and local file paths".into()),
            mime_type: "application/json".into(),
        }];
        let mut issues: Vec<Issue> = self
            .ctx
            .service
            .issue
            .all()
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|i| !i.status.is_closed())
            .collect();
        issues.sort_by_key(|i| i.number);
        for issue in issues {
            let mut desc_parts = Vec::new();
            if let Some(repo) = issue.repo.as_deref().filter(|r| !r.is_empty()) {
                desc_parts.push(repo.to_string());
            }
            if !issue.attachments.is_empty() {
                desc_parts.push(format!("{} attachment(s)", issue.attachments.len()));
            }
            let description = (!desc_parts.is_empty()).then(|| desc_parts.join(" · "));
            out.push(McpResourceWire {
                uri: format!("vv://issue/{}", issue.id),
                name: format!("#{} {}", issue.number, vibevalley_core::rules::short_title(&issue.title)),
                description,
                mime_type: "application/json".into(),
            });
        }
        out
    }

    /// Lists standard MCP resource URI templates.
    pub fn list_mcp_resource_templates(&self) -> Vec<McpResourceTemplateWire> {
        vec![McpResourceTemplateWire {
            uri_template: "vv://issue/{id}".into(),
            name: "Issue Detail".into(),
            description: Some("Read a VibeValley issue by id or number, including attachments with local file paths, runs, and messages".into()),
            mime_type: "application/json".into(),
        }]
    }

    /// Reads one `vv://` resource for standard MCP `resources/read`.
    pub async fn read_mcp_async(&self, reader: ResourceReader<'_>, uri: &str, storage: Option<&Storage>) -> Result<McpResourceContentWire, String> {
        let uri = uri.trim();
        let r = parse(uri).ok_or_else(|| invalid_uri(uri))?;
        let text = self.load_async(r, reader, uri, storage).await?;
        Ok(McpResourceContentWire {
            uri: uri.to_string(),
            mime_type: "application/json".into(),
            text,
        })
    }

    fn attachment_path(&self, id: &str, storage: Option<&Storage>) -> Option<PathBuf> {
        if let Some(storage) = storage {
            return Some(storage.path_of(id));
        }
        self.runtime.config().data_dir.parent().map(|home| home.join("attachments").join(id))
    }

    fn attachments_with_paths(&self, issue: &Issue, storage: Option<&Storage>) -> Vec<Value> {
        issue
            .attachments
            .iter()
            .map(|a| {
                let mut item = json!({
                    "id": a.id,
                    "name": a.name,
                    "type": a.r#type,
                    "size": a.size,
                });
                if let Some(path) = self.attachment_path(&a.id, storage) {
                    item["path"] = json!(path.to_string_lossy());
                }
                item
            })
            .collect()
    }

    fn issue_with_attachment_paths(&self, issue: &Issue, storage: Option<&Storage>) -> Result<Value, String> {
        let mut value = serde_json::to_value(issue).map_err(|e| e.to_string())?;
        if let Some(obj) = value.as_object_mut() {
            obj.insert("attachments".to_string(), Value::Array(self.attachments_with_paths(issue, storage)));
        }
        Ok(value)
    }

    async fn load_async(&self, r: Ref, reader: ResourceReader<'_>, uri: &str, storage: Option<&Storage>) -> Result<String, String> {
        let pretty = |v: Value| serde_json::to_string_pretty(&v).map_err(|e| e.to_string());
        match r {
            Ref::Absent => match reader {
                ResourceReader::LocalReadOnly => Err(forbidden(uri)),
                ResourceReader::Orchestrator | ResourceReader::Helper(_) => Err(missing(uri)),
            },
            Ref::Issues => {
                let mut open: Vec<Issue> = self
                    .ctx
                    .service
                    .issue
                    .all()
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|i| !i.status.is_closed())
                    .collect();
                open.sort_by_key(|i| i.number);
                let mut items = Vec::with_capacity(open.len());
                for issue in &open {
                    items.push(self.issue_with_attachment_paths(issue, storage)?);
                }
                pretty(Value::Array(items))
            }
            Ref::Issue(id) => {
                let all_issues = self.ctx.service.issue.all().await.unwrap_or_default();
                let issue = find_issue(&all_issues, &id).ok_or_else(|| missing(uri))?;
                let runs = self.ctx.service.session.runs(&issue.id).await.unwrap_or_default();
                let messages = self.chat.issue_messages_async(&issue.id).await.unwrap_or_default();
                let issue_json = self.issue_with_attachment_paths(&issue, storage)?;
                let attachments = self.attachments_with_paths(&issue, storage);
                pretty(json!({
                    "issue": issue_json,
                    "attachments": attachments,
                    "runs": runs,
                    "messages": messages,
                }))
            }
            Ref::Channel(id) => {
                let allowed = match reader {
                    ResourceReader::Orchestrator => true,
                    ResourceReader::Helper(s) => self.may_read_channel(s, &id),
                    ResourceReader::LocalReadOnly => false,
                };
                if !allowed {
                    return Err(forbidden(uri));
                }
                let messages = self.chat.history_async(&id, None, Some(200)).await.map_err(|e| e.message)?;
                let latest_page = messages.len() == 200;
                pretty(json!({ "messages": messages, "latestPage": latest_page }))
            }
            Ref::Session(id) => {
                let allowed = match reader {
                    ResourceReader::Orchestrator => true,
                    ResourceReader::Helper(s) => s.id == id,
                    ResourceReader::LocalReadOnly => false,
                };
                if !allowed {
                    return Err(forbidden(uri));
                }
                let events = self.runtime.trajectory().events_async(&id, None).await.ok_or_else(|| missing(uri))?;
                pretty(json!({ "events": events }))
            }
            Ref::GithubPull { repo, number, section } => {
                if matches!(reader, ResourceReader::LocalReadOnly) {
                    return Err(forbidden(uri));
                }
                let Some(pull) = &self.pull else {
                    return Err(missing(uri));
                };
                let snap = pull.snapshot_async(&repo, number).await.map_err(|e| e.message)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris_parse_as_the_typescript_server_reads_them() {
        assert!(matches!(parse("vv://issues"), Some(Ref::Issues)));
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
