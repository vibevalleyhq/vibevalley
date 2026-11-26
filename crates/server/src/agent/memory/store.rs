//! Persistence, recall, search, and endpoint handlers for [`Memory`].

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ActorKind, ApiError, BizCode, Caller, Memory as MemoryItem, MemoryCreateInput, MemoryDeleteInput, MemoryFound, MemoryKind, MemoryList, MemoryListInput,
    MemoryRecallInput, MemoryScope, MemorySearch, MemorySearchInput, MemorySourceInfo, Outcome, Preview, RecallPreview, Session,
};

use super::rules as m;
use crate::BoxFuture;
use crate::agent::profile::Profile;
use crate::context::Context;
use crate::context::error::AsyncRequestKeys;
use crate::context::port::MemoryRecallPort;
use crate::service::DbError;
use crate::service::memory::NewMemory;

/// Fading marks the ones that would go if this many more were kept.
const FADING_SOON: usize = 10;
pub const LOCAL: &str = "local";

fn db_failed(e: DbError) -> ApiError {
    ApiError::new(BizCode::MemoryRefused, format!("{}: {e}", t("server.memory.dbFailed", &[])))
}

fn refused(text: String) -> ApiError {
    ApiError::new(BizCode::MemoryRefused, text)
}

/// Who writes a note: the user, an orchestrator, or a session (kept with it).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum By {
    User,
    Orchestrator,
    Session(String),
}

/// A memory written outside a run.
#[derive(Debug, Clone)]
pub struct Note {
    pub agent: String,
    pub text: String,
    pub repo: String,
    pub by: By,
}

/// One finished run, as the memory keeps it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FinishedRun {
    pub agent: String,
    pub session: String,
    pub issue: Option<String>,
    pub repo: String,
    pub brief: String,
    pub outcome: Outcome,
    pub summary: String,
}

/// Agent memory service backed by `ctx.service.memory`.
pub struct Memory {
    ctx: Arc<Context>,
    profile: Arc<Profile>,
    create_keys: AsyncRequestKeys<MemoryItem>,
}

fn to_rules(x: MemoryItem) -> m::Memory {
    m::Memory {
        id: x.id,
        agent: x.agent,
        kind: match x.kind {
            MemoryKind::Note => m::MemoryKind::Note,
            MemoryKind::Issue => m::MemoryKind::Issue,
        },
        text: x.text,
        author: match x.author {
            ActorKind::User => m::ActorKind::User,
            ActorKind::Agent => m::ActorKind::Agent,
            ActorKind::System => m::ActorKind::System,
        },
        repo: x.repo,
        session: x.session,
        at: x.at,
        recalled: x.recalled,
        recalled_at: x.recalled_at,
        fading: x.fading,
        source: x.source,
    }
}

fn to_wire(x: m::Memory) -> MemoryItem {
    MemoryItem {
        id: x.id,
        agent: x.agent,
        kind: match x.kind {
            m::MemoryKind::Note => MemoryKind::Note,
            m::MemoryKind::Issue => MemoryKind::Issue,
        },
        text: x.text,
        author: match x.author {
            m::ActorKind::User => ActorKind::User,
            m::ActorKind::Agent => ActorKind::Agent,
            m::ActorKind::System => ActorKind::System,
        },
        repo: x.repo,
        session: x.session,
        at: x.at,
        recalled: x.recalled,
        recalled_at: x.recalled_at,
        fading: x.fading,
        source: x.source,
    }
}

fn build_note_entry(n: &Note, at: i64) -> Result<(NewMemory, MemoryItem), ApiError> {
    let body = m::clip(&n.text, m::NOTE_MAX_CHARS);
    if body.is_empty() {
        return Err(refused(t("server.memory.empty", &[])));
    }
    let repo = Some(n.repo.trim().to_string()).filter(|r| !r.is_empty());
    let (author, session) = match &n.by {
        By::User => (ActorKind::User, None),
        By::Orchestrator => (ActorKind::Agent, None),
        By::Session(s) => (ActorKind::Agent, Some(s.clone()).filter(|s| !s.is_empty())),
    };
    let id = uuid::Uuid::now_v7().to_string();
    let entry = NewMemory {
        id: id.clone(),
        agent: n.agent.clone(),
        kind: MemoryKind::Note,
        body: body.clone(),
        repo: repo.clone(),
        session: session.clone(),
        author,
        created_at: at,
    };
    let wire = MemoryItem {
        id,
        agent: n.agent.clone(),
        kind: MemoryKind::Note,
        text: body,
        author,
        repo,
        session,
        at,
        recalled: 0,
        recalled_at: None,
        fading: false,
        source: None,
    };
    Ok((entry, wire))
}

impl Memory {
    pub fn open(ctx: Arc<Context>, profile: Arc<Profile>) -> Arc<Memory> {
        Arc::new(Memory {
            ctx,
            profile,
            create_keys: AsyncRequestKeys::default(),
        })
    }

    pub async fn list_async(&self, agent: &str) -> Result<Vec<m::Memory>, ApiError> {
        let rows = self.ctx.service.memory.list(agent).await.map_err(db_failed)?;
        Ok(rows.into_iter().map(to_rules).collect())
    }

    /// The memories with the ones that would go next marked fading.
    pub(super) async fn listed_async(&self, agent: &str) -> Vec<m::Memory> {
        let all = self.list_async(agent).await.unwrap_or_default();
        let fading: HashSet<String> = m::next_forgotten(&all, FADING_SOON).into_iter().collect();
        all.into_iter()
            .map(|x| m::Memory {
                fading: fading.contains(&x.id),
                ..x
            })
            .collect()
    }

    /// How well each memory shares the text's words (the store's index).
    fn matches(&self, memories: &[m::Memory], text: &str) -> HashMap<String, f64> {
        let words = m::terms_of(text);
        if words.is_empty() {
            return HashMap::new();
        }
        memories
            .iter()
            .filter_map(|x| {
                let shared = m::terms_of(&x.text).intersection(&words).count();
                (shared > 0).then(|| (x.id.clone(), 0.1 * shared as f64 / words.len() as f64))
            })
            .collect()
    }

    pub async fn write_async(&self, n: &Note) -> Result<MemoryItem, ApiError> {
        let (entry, wire) = build_note_entry(n, self.ctx.now())?;
        self.ctx.service.memory.insert(&entry).await.map_err(db_failed)?;
        Ok(wire)
    }

    /// `rewrite_async`: the agent's own notes replaced atomically; the user's stay.
    pub async fn rewrite_async(&self, agent: &str, texts: &[String], by: By) -> Result<usize, ApiError> {
        let mut entries = Vec::with_capacity(texts.len());
        for text in texts {
            let (entry, _) = build_note_entry(
                &Note {
                    agent: agent.into(),
                    text: text.clone(),
                    repo: String::new(),
                    by: by.clone(),
                },
                self.ctx.now(),
            )?;
            entries.push(entry);
        }
        self.ctx.service.memory.rewrite_agent_notes(agent, &entries).await.map_err(db_failed)
    }

    async fn forgettable_async(&self, agent: &str, id: &str) -> Result<m::Memory, ApiError> {
        self.list_async(agent).await?.into_iter().find(|x| x.id == id).ok_or_else(|| {
            ApiError::new(
                BizCode::MemoryNotFound,
                t("server.memory.noMemory", &[("agent", agent.into()), ("id", id.into())]),
            )
            .with_next(vec![vibevalley_protocol::Next {
                say: t("server.lookIn.memories", &[]),
                run: Some(vec!["memory".into(), "list".into(), agent.into()]),
            }])
        })
    }

    pub async fn forget_async(&self, agent: &str, id: &str) -> Result<(), ApiError> {
        self.forgettable_async(agent, id).await?;
        self.ctx.service.memory.delete(agent, id).await.map_err(db_failed)?;
        Ok(())
    }

    pub async fn preview_forget_async(&self, agent: &str, id: &str) -> Result<Preview, ApiError> {
        let x = self.forgettable_async(agent, id).await?;
        Ok(Preview {
            does: vec![t("server.memory.forget", &[("agent", agent.into()), ("text", x.text.into())])],
        })
    }

    /// What a run on `agent` recalls (`recallable`); with `peek` nothing is
    /// counted and a cue with no repo recalls nothing.
    pub async fn recall_async(&self, agent: &str, session: Option<&str>, repo: &str, text: &str, peek: bool) -> Vec<(String, String)> {
        if peek && repo.is_empty() {
            return vec![];
        }
        let all = self.list_async(agent).await.unwrap_or_default();
        let cue = m::Cue {
            session: if peek { None } else { session },
            repo,
            text,
            skip: HashSet::new(),
            now: self.ctx.now(),
            matches: self.matches(&all, text),
        };
        let picked = m::pick(&all, &cue);
        if !peek && !picked.is_empty() {
            let at = self.ctx.now();
            let ids: Vec<String> = picked.iter().map(|x| x.id.clone()).collect();
            let _ = self.ctx.service.memory.record_recalled(&ids, at).await;
        }
        picked.iter().map(|x| (x.id.clone(), m::line_of(x, repo))).collect()
    }

    /// The lines a run is told; "" when none.
    pub async fn recalled_text_async(&self, agent: &str, session: Option<&str>, repo: &str, text: &str) -> String {
        self.recall_async(agent, session, repo, text, false)
            .await
            .into_iter()
            .map(|(_, l)| l)
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// `keep_async`: a finished round's issue memory, then the oldest past the limit go.
    pub async fn keep_async(&self, run: &FinishedRun) {
        if run.outcome == Outcome::Interrupted {
            return;
        }
        let issue_entry = run.issue.as_ref().map(|_| NewMemory {
            id: uuid::Uuid::now_v7().to_string(),
            agent: run.agent.clone(),
            kind: MemoryKind::Issue,
            body: m::issue_memory_text(&run.brief, &run.summary, run.outcome == Outcome::Failed),
            repo: Some(run.repo.clone()),
            session: Some(run.session.clone()),
            author: ActorKind::System,
            created_at: self.ctx.now(),
        });
        let agent = run.agent.clone();
        let service = self.ctx.service.clone();
        let res: Result<(), DbError> = self
            .ctx
            .service
            .transaction(|tx| {
                Box::pin(async move {
                    if let Some(entry) = &issue_entry {
                        service.memory.upsert_issue_memory_in_tx(tx, entry).await?;
                    }
                    let all: Vec<m::Memory> = service.memory.list_in_tx(tx, &agent).await?.into_iter().map(to_rules).collect();
                    let to_forget = m::next_forgotten(&all, 0);
                    if !to_forget.is_empty() {
                        service.memory.delete_many_in_tx(tx, &agent, &to_forget).await?;
                    }
                    Ok(())
                })
            })
            .await;
        if let Err(error) = res {
            eprintln!("could not keep the completed run for {}: {error}", run.session);
        }
    }

    /// `search_async`: one agent's, or every profile's when none is named.
    pub async fn search_async(&self, agent: &str, repo: &str, text: &str, limit: usize) -> MemorySearch {
        let agents: Vec<String> = if agent.is_empty() {
            self.profile.agents().into_iter().map(|a| a.id).collect()
        } else {
            vec![agent.into()]
        };
        let mut all = vec![];
        for a in &agents {
            all.extend(self.list_async(a).await.unwrap_or_default());
        }
        let matches = self.matches(&all, text);
        let found = m::search(&all, repo, text, None, limit, &matches)
            .into_iter()
            .map(|(x, score)| {
                let scope = match &x.repo {
                    None => MemoryScope::Global {},
                    Some(r) => MemoryScope::Repo { repo: r.clone() },
                };
                let w = to_wire(x);
                MemoryFound {
                    id: w.id,
                    agent: w.agent,
                    kind: w.kind,
                    text: w.text,
                    author: w.author,
                    repo: w.repo,
                    session: w.session,
                    at: w.at,
                    recalled: w.recalled,
                    recalled_at: w.recalled_at,
                    fading: w.fading,
                    source: LOCAL.into(),
                    score: score.into(),
                    scope,
                }
            })
            .collect();
        MemorySearch { found, coverage: vec![] }
    }

    pub fn sources(&self) -> Vec<MemorySourceInfo> {
        vec![MemorySourceInfo {
            name: LOCAL.into(),
            label: vibevalley_i18n::maybe(&format!("server.memory.source.{LOCAL}")).unwrap_or_else(|| LOCAL.into()),
            on: true,
            off: String::new(),
            can_list: true,
            can_forget: true,
            transcripts: false,
        }]
    }

    pub async fn keep_session_reported_async(&self, session: &Session) {
        if !(session.is_board_worker() || session.is_direct_talker()) {
            return;
        }
        let Some(agent) = session.profile.clone() else { return };
        let summary = session.last_run.as_ref().map(|l| l.summary.clone()).unwrap_or_default();
        let outcome = session.last_run.as_ref().map(|l| l.outcome).unwrap_or(Outcome::Completed);
        self.keep_async(&FinishedRun {
            agent,
            session: session.id.clone(),
            issue: session.issue_id().map(String::from),
            repo: session.repo_name().unwrap_or_default().to_string(),
            brief: session.brief.clone(),
            outcome,
            summary,
        })
        .await;
    }

    /// Registers `memory.session_remember` on the durable [`crate::context::Outbox`] so committed
    /// session reports can persist round learnings asynchronously without a `Runtime` hook.
    pub(crate) fn register_outbox(self: &Arc<Self>) {
        let store = Arc::downgrade(self);
        self.ctx.outbox.register(crate::context::outbox::OUTBOX_SESSION_REMEMBER, move |delivery| {
            let store = store.clone();
            async move {
                let Some(store) = store.upgrade() else {
                    return Ok::<(), String>(());
                };
                if let crate::context::OutboxEvent::SessionRemember { agent, text, repo } =
                    delivery.decode_event().map_err(|e| format!("invalid remember outbox event: {e}"))?
                    && let Err(e) = store
                        .write_async(&Note {
                            agent,
                            text,
                            repo: repo.unwrap_or_default(),
                            by: By::Session(String::new()),
                        })
                        .await
                {
                    return Err(e.message);
                }
                Ok(())
            }
        });
    }

    pub(crate) async fn list_endpoint_async(&self, input: MemoryListInput) -> Result<MemoryList, ApiError> {
        Ok(MemoryList {
            memories: self.listed_async(&input.agent).await.into_iter().map(to_wire).collect(),
            sources: self.sources(),
        })
    }

    pub(crate) async fn recall_endpoint_async(&self, input: MemoryRecallInput) -> Result<RecallPreview, ApiError> {
        let lines: Vec<String> = self
            .recall_async(
                &input.agent,
                None,
                input.repo.as_deref().unwrap_or(""),
                input.text.as_deref().unwrap_or(""),
                true,
            )
            .await
            .into_iter()
            .map(|(_, l)| l)
            .collect();
        let chars = lines.iter().map(|l| l.encode_utf16().count() as i64 + 1).sum();
        Ok(RecallPreview {
            lines,
            chars,
            limit: m::RECALL_CHARS as i64,
        })
    }

    pub(crate) async fn create_endpoint_async(&self, caller: Caller, client_id: Option<&str>, input: MemoryCreateInput) -> Result<MemoryItem, ApiError> {
        let by = match caller {
            Caller::Session => By::Session(client_id.unwrap_or_default().to_string()),
            Caller::Orchestrator => By::Orchestrator,
            Caller::User | Caller::Remote => By::User,
        };
        self.create_keys
            .once(input.request_key.as_deref(), async move {
                self.write_async(&Note {
                    agent: input.agent.clone(),
                    text: input.text.clone(),
                    repo: input.repo.clone().unwrap_or_default(),
                    by,
                })
                .await
            })
            .await
    }

    pub(crate) async fn search_endpoint_async(&self, input: MemorySearchInput) -> Result<MemorySearch, ApiError> {
        let agent = input
            .agent
            .as_deref()
            .map(|a| self.profile.named(a).map(|p| p.id).unwrap_or_else(|| a.to_string()));
        Ok(self
            .search_async(
                agent.as_deref().unwrap_or(""),
                input.repo.as_deref().unwrap_or(""),
                input.text.as_deref().unwrap_or(""),
                0,
            )
            .await)
    }

    pub(crate) async fn delete_endpoint_async(&self, input: MemoryDeleteInput) -> Result<(), ApiError> {
        self.forget_async(&input.agent, &input.memory).await
    }

    pub(crate) async fn preview_delete_endpoint_async(&self, input: MemoryDeleteInput) -> Result<Preview, ApiError> {
        self.preview_forget_async(&input.agent, &input.memory).await
    }
}

impl MemoryRecallPort for Memory {
    fn recall_text<'a>(&'a self, agent: &'a str, session: Option<&'a str>, repo: &'a str, query: &'a str) -> BoxFuture<'a, String> {
        Box::pin(self.recalled_text_async(agent, session, repo, query))
    }
}
