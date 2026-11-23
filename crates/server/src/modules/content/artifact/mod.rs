//! Artifacts (VibeValley `modules/artifact/artifact.ts`): an html page kept
//! version by version (each version's bytes an attachment), a page of blocks
//! written together (`blocks.rs`), or a structured entry store (`entries.rs`)
//! with progressive-disclosure type guides (`types.rs`). Made with content or
//! entries, it is announced in a channel with its card; the `artifact.*`
//! endpoints, the `artifact.follow`, `artifact.entry.follow`, and
//! `artifact.suggestion.follow` subscriptions, the quotes of blocks a chat
//! message carries, and VibeValley's `artifact.page` / `artifact.view`.

mod blocks;
mod collab;
mod db;
mod entries;
mod types;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};

use parking_lot::{Mutex, MutexGuard};
use sqlx::{Connection, SqliteConnection};
use vibevalley_core::artifact::{
    artifact_headers, artifact_problem, html_check, html_edit, html_problem, infer_artifact_from_name, shell_theme_of, starter_entries_for_type, with_shell,
};
use vibevalley_core::collab::{CommitMeta, PresenceHub};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Artifact as Wire, ArtifactBody, ArtifactCard, ArtifactContent, ArtifactDisplay, ArtifactEntryBatchRequest, ArtifactEntryGetRequest,
    ArtifactEntryKind, ArtifactEntryOp, ArtifactEntryWriteInput, ArtifactHtmlEdit, ArtifactKind, ArtifactListRequest, ArtifactMarkdown, ArtifactPage,
    ArtifactPageInput, ArtifactPresenceEvent, ArtifactRequest, ArtifactSaid, ArtifactType, ArtifactUpdateRequest, ArtifactVersion, ArtifactVersionRequest,
    BizCode, BlockAck, BlockCreate, BlockDelete, BlockRef, BlockSnapshot, BlockUpdate, Preview, QuotedBlock, USER_ID, native_ops, ops, subscriptions,
};

pub use blocks::spans_of;
use db::ArtifactRow;
use entries::EntryChange;

use crate::base::{LookIn, missing, open_sqlx_db};
use crate::modules::collab::channel::{Chat, Made, Posting};
use crate::modules::content::attachment::Attachments;
use crate::modules::team::agent::Agents;
use crate::{Hub, now};

/// How many the farm-wide list shows.
const LISTED_MAX: i64 = 200;

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::ArtifactRefused, text.into())
}

fn q(e: sqlx::Error) -> ApiError {
    crate::base::internal(e)
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// `head`: at most n UTF-16 units, whole characters.
fn head(s: &str, n: usize) -> String {
    let mut out = String::new();
    let mut len = 0;
    for c in s.chars() {
        if len + c.len_utf16() > n {
            break;
        }
        len += c.len_utf16();
        out.push(c);
    }
    out
}

/// Who makes it: `from` says so in the channel (the user, a session, an
/// orchestrator), `by` is the profile or the user, `run` the run it is made in.
#[derive(Debug, Clone)]
pub struct Maker {
    pub from: String,
    pub by: String,
    pub run: Option<String>,
}

impl Maker {
    pub fn user() -> Maker {
        Maker {
            from: USER_ID.into(),
            by: USER_ID.into(),
            run: None,
        }
    }
}

#[derive(Debug, Clone)]
struct Change {
    artifact: String,
    ack: BlockAck,
}

type SuggestionsNow = (String, Vec<vibevalley_protocol::Suggestion>);
type PresenceExtra = HashMap<(String, String), (Option<String>, Option<String>)>;

pub struct Artifacts {
    db: Mutex<SqliteConnection>,
    /// One change of an artifact's row at a time: a version's number is the
    /// latest's plus one.
    rows: Mutex<()>,
    /// One batch of block ops at a time.
    batches: Mutex<()>,
    /// Per-artifact write lock for structured entry store batches.
    entry_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    files: Arc<Attachments>,
    chat: Arc<Chat>,
    changes: Mutex<Vec<flume::Sender<Change>>>,
    entry_changes: Mutex<Vec<flume::Sender<EntryChange>>>,
    suggestion_changes: Mutex<Vec<flume::Sender<SuggestionsNow>>>,
    /// Pure in-memory Loro EphemeralStore presence hubs keyed by artifact_id (never written to SQLite).
    presences: Mutex<HashMap<String, PresenceHub>>,
    presence_extra: Mutex<PresenceExtra>,
    presence_changes: Mutex<Vec<flume::Sender<(String, ArtifactPresenceEvent)>>>,
    demo_on: AtomicBool,
    closed: AtomicBool,
    stop: Mutex<Option<flume::Sender<()>>>,
    prune_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// The demo's tick, 1 s (`demoTickMs`); tests shorten it.
    demo_tick_ms: std::sync::atomic::AtomicU64,
}

impl Artifacts {
    /// The tables in `<home>/server.db`, and the daily prune of old batches
    /// and texts. Open it after the chat: its messages are joined.
    pub fn open(home: &std::path::Path, files: Arc<Attachments>, chat: Arc<Chat>) -> Result<Arc<Artifacts>, ApiError> {
        let mut conn = pollster::block_on(open_sqlx_db(home)).map_err(q)?;
        pollster::block_on(sqlx::raw_sql(db::SCHEMA).execute(&mut conn)).map_err(q)?;
        let (stop_tx, stop_rx) = flume::bounded::<()>(0);
        let me = Arc::new(Artifacts {
            db: Mutex::new(conn),
            rows: Mutex::default(),
            batches: Mutex::default(),
            entry_locks: Mutex::default(),
            files,
            chat,
            changes: Mutex::default(),
            entry_changes: Mutex::default(),
            suggestion_changes: Mutex::default(),
            presences: Mutex::default(),
            presence_extra: Mutex::default(),
            presence_changes: Mutex::default(),
            demo_on: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            stop: Mutex::new(Some(stop_tx)),
            prune_thread: Mutex::new(None),
            demo_tick_ms: std::sync::atomic::AtomicU64::new(blocks::DEMO_TICK_MS),
        });
        if let Some(handle) = prune_daily(Arc::downgrade(&me), stop_rx) {
            *me.prune_thread.lock() = Some(handle);
        }
        Ok(me)
    }

    /// How long the demo's tick is.
    pub fn set_demo_tick(&self, ms: u64) {
        self.demo_tick_ms.store(ms, Ordering::Relaxed);
    }

    /// Stops the demo and the prune.
    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        let _ = self.stop.lock().take();
        if let Some(handle) = self.prune_thread.lock().take()
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
    }

    fn db(&self) -> MutexGuard<'_, SqliteConnection> {
        self.db.lock()
    }

    fn found(&self, db: &mut SqliteConnection, id: &str) -> Result<ArtifactRow, ApiError> {
        db::artifact(db, id)
            .map_err(q)?
            .ok_or_else(|| missing(t("server.artifact.missing", &[("id", id.into())]), LookIn::Artifact))
    }

    fn assemble(&self, db: &mut SqliteConnection, row: ArtifactRow) -> Result<Wire, ApiError> {
        let versions = if row.body == "html" { db::versions(db, &row.id).map_err(q)? } else { vec![] };
        let channel = row.channel_id.clone().unwrap_or_default();
        let body = match row.body.as_str() {
            "html" => ArtifactBody::Html,
            "store" => ArtifactBody::Store,
            _ => ArtifactBody::Blocks,
        };
        Ok(Wire {
            id: row.id,
            title: row.title,
            body,
            artifact_type: row.artifact_type.as_deref().and_then(artifact_type_of),
            is_default: row.is_default != 0,
            display: row.display.as_deref().and_then(display_of),
            channel: row.channel_id,
            said: match (row.said_channel, row.said_number) {
                (Some(channel), Some(number)) => Some(ArtifactSaid { channel, number }),
                _ => None,
            },
            issue: row.issue,
            by: row.by_id,
            by_name: row.by_name,
            version: row.version,
            seq: row.seq,
            versions: versions
                .into_iter()
                .map(|v| ArtifactVersion {
                    version: v.version,
                    size: v.size,
                    note: v.note.unwrap_or_default(),
                    by: v.by_id,
                    by_name: v.by_name,
                    at: v.created_at,
                    channel: v.message_channel.unwrap_or_else(|| channel.clone()),
                    number: v.message_number,
                })
                .collect(),
            at: row.created_at,
            updated: row.updated_at,
        })
    }

    fn get_now(&self, id: &str) -> Result<Wire, ApiError> {
        let mut db = self.db();
        let row = self.found(&mut db, id)?;
        self.assemble(&mut db, row)
    }

    pub fn list(&self, req: &ArtifactListRequest) -> Result<Vec<Wire>, ApiError> {
        let mut db = self.db();
        let channel = req.channel.as_deref().filter(|c| !c.is_empty());
        let rows = match (req.issue.as_deref().filter(|i| !i.is_empty()), channel) {
            (Some(issue), _) => db::artifacts_for_issue(&mut db, issue),
            (None, Some(channel)) => db::artifacts_in_channel(&mut db, channel),
            (None, None) => db::artifacts(&mut db, LISTED_MAX),
        }
        .map_err(q)?;
        // Both given: the issue's, in that channel; filtered by artifact_type when set.
        rows.into_iter()
            .filter(|r| channel.is_none_or(|c| r.channel_id.as_deref() == Some(c)))
            .filter(|r| req.artifact_type.is_none_or(|ty| r.artifact_type.as_deref() == Some(ty.as_str())))
            .map(|r| self.assemble(&mut db, r))
            .collect()
    }

    pub fn get(&self, id: &str) -> Result<Wire, ApiError> {
        self.get_now(id)
    }

    fn version_of(&self, db: &mut SqliteConnection, id: &str, version: Option<i64>) -> Result<(ArtifactRow, db::VersionRow), ApiError> {
        let row = self.found(db, id)?;
        let n = version.unwrap_or(row.version);
        let Some(v) = db::version(db, id, n).map_err(q)? else {
            return Err(ApiError::new(
                BizCode::ArtifactNotFound,
                t(
                    "server.artifact.noVersion",
                    &[("title", row.title.as_str().into()), ("version", n.into()), ("latest", row.version.into())],
                ),
            ));
        };
        Ok((row, v))
    }

    /// `pageOf`: a file gone from disk is a version that cannot be read.
    fn page_of(&self, row: &ArtifactRow, v: &db::VersionRow) -> Result<String, ApiError> {
        std::fs::read(self.files.path_of(&v.attachment_id))
            .map(|b| String::from_utf8_lossy(&b).into_owned())
            .map_err(|e| {
                eprintln!("vibevalley-server: artifact {} version {}: its page could not be read: {e}", row.id, v.version);
                ApiError::new(
                    BizCode::ArtifactNotFound,
                    t("server.artifact.noFile", &[("title", row.title.as_str().into()), ("version", v.version.into())]),
                )
            })
    }

    /// An html one's version as made; a blocks one's Markdown now; a store one's
    /// manifest summary, its version its seq.
    pub fn content(&self, id: &str, version: Option<i64>) -> Result<(ArtifactContent, ArtifactBody), ApiError> {
        let row = self.found(&mut self.db(), id)?;
        if row.body == "blocks" {
            return Ok((
                ArtifactContent {
                    version: row.seq,
                    content: self.markdown(id)?,
                },
                ArtifactBody::Blocks,
            ));
        }
        if row.body == "store" {
            let summary = self.store_summary(&row)?;
            return Ok((
                ArtifactContent {
                    version: row.seq,
                    content: summary,
                },
                ArtifactBody::Store,
            ));
        }
        let (row, v) = self.version_of(&mut self.db(), id, version)?;
        let content = self.page_of(&row, &v)?;
        Ok((ArtifactContent { version: v.version, content }, ArtifactBody::Html))
    }

    /// An html version's file on disk; none when there is none.
    pub fn file(&self, id: &str, version: i64) -> Option<PathBuf> {
        let mut db = self.db();
        let row = db::artifact(&mut db, id).ok()??;
        if row.body != "html" {
            return None;
        }
        db::version(&mut db, id, version).ok()?.map(|v| self.files.path_of(&v.attachment_id))
    }

    /// `keep`: a version's bytes as an attachment.
    fn keep(&self, bytes: &[u8], title: &str) -> Result<String, ApiError> {
        Ok(self.files.keep(bytes, &format!("{title}.html"), "text/html")?.id)
    }

    pub(super) fn words(base: String, note: Option<&str>) -> String {
        match note {
            Some(note) => t("server.artifact.withNote", &[("said", base.into()), ("note", note.into())]),
            None => base,
        }
    }

    /// Without content, an empty blocks or store one. With content or entries, a
    /// hand-in: html kept whole, Markdown read into blocks, or store entries
    /// committed, announced when appropriate.
    pub fn create(&self, maker: &Maker, req: &ArtifactRequest) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock();
        let trimmed = req.title.trim();
        let inferred = (req.kind.is_none() && req.artifact_type.is_none() && !trimmed.is_empty())
            .then(|| infer_artifact_from_name(trimmed, req.content.as_deref()))
            .filter(|inf| inf.title != trimmed || inf.display.is_some() || inf.artifact_type.is_some());

        let effective_title = if let Some(inf) = &inferred {
            inf.title.clone()
        } else if trimmed.is_empty() {
            t("server.artifact.untitled", &[])
        } else {
            trimmed.to_string()
        };

        let inferred_type = inferred
            .as_ref()
            .filter(|_| req.content.is_none() || inferred.as_ref().is_some_and(|i| i.kind == ArtifactKind::Markdown))
            .and_then(|i| i.artifact_type);
        let artifact_type = req.artifact_type.or(inferred_type);

        if req.is_default == Some(true) && artifact_type != Some(ArtifactType::DesignSystem) {
            return Err(refused(t("server.artifact.defaultDesignSystemOnly", &[])));
        }

        let wants_store = artifact_type.is_some_and(|ty| ty.body() == ArtifactBody::Store)
            || req.kind == Some(ArtifactKind::Store)
            || (req.entries.is_some() && req.content.is_none() && req.kind != Some(ArtifactKind::Html) && req.kind != Some(ArtifactKind::Markdown));

        if wants_store {
            let store_type = artifact_type.filter(|ty| ty.body() == ArtifactBody::Store);
            return self.create_store(maker, req, &effective_title, store_type);
        }

        let docs_type = artifact_type.filter(|ty| ty.body() == ArtifactBody::Blocks);
        let Some(content) = &req.content else {
            let problem = artifact_problem(Some(&effective_title), None, None);
            if !problem.is_empty() {
                return Err(refused(problem));
            }
            if req.display.is_some() {
                return Err(refused(t("server.artifact.displayHtmlOnly", &[])));
            }
            let channel = match req.channel.as_deref() {
                Some(c) => Some(self.chat.place_of(&maker.from, c)?),
                None => None,
            };
            return self.start_blocks(maker, &effective_title, docs_type, channel, req.issue.clone());
        };

        let kind = req.kind.or_else(|| inferred.as_ref().map(|i| i.kind)).unwrap_or(ArtifactKind::Markdown);
        let bytes = content.as_bytes();
        let title_for_check = if inferred.is_some() { effective_title.as_str() } else { req.title.as_str() };
        let mut problem = artifact_problem(Some(title_for_check), Some(kind.as_str()), Some(bytes.len()));
        if problem.is_empty() && kind == ArtifactKind::Html {
            problem = html_problem(&html_check(content));
        }
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let html = kind == ArtifactKind::Html;
        if !html && req.display.is_some() {
            return Err(refused(t("server.artifact.displayHtmlOnly", &[])));
        }
        let display = html.then(|| {
            req.display
                .or_else(|| inferred.as_ref().and_then(|i| i.display))
                .unwrap_or(ArtifactDisplay::Page)
        });
        let final_type = if html { None } else { docs_type };
        let channel = self.chat.place_of(&maker.from, req.channel.as_deref().unwrap_or(""))?;
        let file = if html { self.keep(bytes, &effective_title)? } else { String::new() };
        let id = new_id();
        let note = req.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
        let version = if html { 1 } else { 0 };
        let card = ArtifactCard {
            id: id.clone(),
            title: effective_title.clone(),
            body: if html { ArtifactBody::Html } else { ArtifactBody::Blocks },
            version,
            note: note.unwrap_or("").into(),
            display,
            artifact_type: final_type,
        };
        let mut initial = None;
        self.chat.post_with(
            Posting {
                from: maker.from.clone(),
                channel,
                text: Self::words(t("server.artifact.made", &[("title", effective_title.as_str().into())]), note),
                made: Some(Made::Card(card)),
                run: maker.run.clone(),
                ..Posting::default()
            },
            |db, said| {
                let at = now();
                db::add_artifact(
                    db,
                    db::NewArtifact {
                        id: id.clone(),
                        title: effective_title.clone(),
                        body: if html { "html" } else { "blocks" }.into(),
                        artifact_type: final_type.map(|ty| ty.as_str().into()),
                        is_default: 0,
                        display: display.map(|d| d.as_str().into()),
                        channel_id: Some(said.channel.clone()),
                        issue: req.issue.clone(),
                        by_id: maker.by.clone(),
                        by_name: said.name.clone(),
                        version,
                        created_at: at,
                    },
                )
                .map_err(q)?;
                db::artifact_said(db, &id, &said.id).map_err(q)?;
                if html {
                    db::add_version(
                        db,
                        db::NewVersion {
                            artifact_id: id.clone(),
                            version: 1,
                            attachment_id: file.clone(),
                            size: bytes.len() as i64,
                            note: note.map(str::to_owned),
                            by_id: maker.by.clone(),
                            by_name: said.name.clone(),
                            created_at: at,
                        },
                    )
                    .map_err(q)?;
                    db::version_announced(db, &id, 1, &said.id).map_err(q)?;
                    let meta = collab::commit_meta_for_maker(maker, note.map(str::to_owned), at);
                    self.sync_html_to_collab(db, &id, None, content, &meta)?;
                }
                let fill_meta = collab::commit_meta_for_maker(maker, note.map(str::to_owned), at);
                initial = if html {
                    None
                } else {
                    self.fill_with_meta(db, &id, content, &maker.by, &fill_meta)?
                };
                Ok(())
            },
        )?;
        if let Some(ack) = initial {
            self.publish_change(&id, &ack);
        }
        self.get_now(&id)
    }

    fn create_store(&self, maker: &Maker, req: &ArtifactRequest, title: &str, artifact_type: Option<ArtifactType>) -> Result<Wire, ApiError> {
        let title_for_check = if req.title.trim().is_empty() { title } else { req.title.as_str() };
        let problem = artifact_problem(Some(title_for_check), None, None);
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        if req.display.is_some() {
            return Err(refused(t("server.artifact.displayHtmlOnly", &[])));
        }
        let is_default = req.is_default == Some(true);
        if is_default && artifact_type != Some(ArtifactType::DesignSystem) {
            return Err(refused(t("server.artifact.defaultDesignSystemOnly", &[])));
        }

        let has_entries = req.entries.as_ref().is_some_and(|e| !e.is_empty());
        let should_announce = req.announce.unwrap_or_else(|| (maker.by != USER_ID && has_entries) || req.channel.is_some());
        let resolved_channel = if should_announce || req.channel.is_some() || maker.by != USER_ID {
            Some(self.chat.place_of(&maker.from, req.channel.as_deref().unwrap_or(""))?)
        } else {
            None
        };

        let id = new_id();
        let at = now();
        let initial_name = if maker.by == USER_ID {
            t("server.channel.name.user", &[])
        } else {
            maker.by.clone()
        };

        {
            let mut db = self.db();
            let mut tx = pollster::block_on(db.begin()).map_err(q)?;
            if is_default {
                db::clear_default_design_system(&mut tx, at).map_err(q)?;
            }
            db::add_artifact(
                &mut tx,
                db::NewArtifact {
                    id: id.clone(),
                    title: title.into(),
                    body: "store".into(),
                    artifact_type: artifact_type.map(|ty| ty.as_str().into()),
                    is_default: i64::from(is_default),
                    display: None,
                    channel_id: resolved_channel.clone(),
                    issue: req.issue.clone(),
                    by_id: maker.by.clone(),
                    by_name: initial_name,
                    version: 0,
                    created_at: at,
                },
            )
            .map_err(q)?;
            pollster::block_on(tx.commit()).map_err(q)?;
        }

        let mut seq = 0;
        let initial_entries = match &req.entries {
            Some(entries) => entries.clone(),
            None => artifact_type.map(|ty| starter_entries_for_type(ty, title)).unwrap_or_default(),
        };
        if !initial_entries.is_empty() {
            let seeded = self.batch_entries(
                maker,
                &ArtifactEntryBatchRequest {
                    id: id.clone(),
                    writes: initial_entries,
                    note: None,
                    announce: Some(false),
                },
            )?;
            seq = seeded.seq;
        }

        if should_announce && let Some(channel) = resolved_channel {
            let note = req.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
            let card = ArtifactCard {
                id: id.clone(),
                title: title.into(),
                body: ArtifactBody::Store,
                version: seq,
                note: note.unwrap_or("").into(),
                display: None,
                artifact_type,
            };
            let (said, _) = self.chat.post(Posting {
                from: maker.from.clone(),
                channel,
                text: Self::words(t("server.artifact.made", &[("title", title.into())]), note),
                made: Some(Made::Card(card)),
                run: maker.run.clone(),
                ..Posting::default()
            })?;
            db::artifact_said(&mut self.db(), &id, &said.id).map_err(q)?;
        }

        self.get_now(&id)
    }

    /// An empty blocks one the user starts on the page.
    fn start_blocks(
        &self,
        maker: &Maker,
        title: &str,
        artifact_type: Option<ArtifactType>,
        channel: Option<String>,
        issue: Option<String>,
    ) -> Result<Wire, ApiError> {
        let id = new_id();
        let name = if maker.by == USER_ID {
            t("server.channel.name.user", &[])
        } else {
            maker.by.clone()
        };
        let mut db = self.db();
        db::add_artifact(
            &mut db,
            db::NewArtifact {
                id: id.clone(),
                title: title.into(),
                body: "blocks".into(),
                artifact_type: artifact_type.map(|ty| ty.as_str().into()),
                is_default: 0,
                display: None,
                channel_id: channel,
                issue,
                by_id: maker.by.clone(),
                by_name: name,
                version: 0,
                created_at: now(),
            },
        )
        .map_err(q)?;
        let row = self.found(&mut db, &id)?;
        self.assemble(&mut db, row)
    }

    /// An html one's next version; a blocks or store one is refused.
    pub fn version(&self, maker: &Maker, req: &ArtifactVersionRequest) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock();
        self.version_locked(maker, req, None)
    }

    pub fn version_with_meta(&self, maker: &Maker, req: &ArtifactVersionRequest, meta: &CommitMeta) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock();
        self.version_locked(maker, req, Some(meta))
    }

    fn version_locked(&self, maker: &Maker, req: &ArtifactVersionRequest, explicit_meta: Option<&CommitMeta>) -> Result<Wire, ApiError> {
        let (row, prior_html) = {
            let mut db = self.db();
            let row = self.found(&mut db, &req.id)?;
            let prior = if row.body == "html" && row.version > 0 {
                db::version(&mut db, &row.id, row.version).map_err(q)?.and_then(|v| self.page_of(&row, &v).ok())
            } else {
                None
            };
            (row, prior)
        };
        if row.body != "html" {
            return Err(refused(t("server.artifact.notHtml", &[("title", row.title.as_str().into())])));
        }
        let bytes = req.content.as_bytes();
        let mut problem = artifact_problem(None, None, Some(bytes.len()));
        if problem.is_empty() {
            problem = html_problem(&html_check(&req.content));
        }
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let file = self.keep(bytes, &row.title)?;
        let next = row.version + 1;
        let note = req.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
        let card = ArtifactCard {
            id: row.id.clone(),
            title: row.title.clone(),
            body: ArtifactBody::Html,
            version: next,
            note: note.unwrap_or("").into(),
            display: row.display.as_deref().and_then(display_of),
            artifact_type: None,
        };
        self.chat.post_with(
            Posting {
                from: maker.from.clone(),
                channel: row.channel_id.clone().unwrap_or_default(),
                text: Self::words(
                    t("server.artifact.versioned", &[("title", row.title.as_str().into()), ("version", next.into())]),
                    note,
                ),
                made: Some(Made::Card(card)),
                run: maker.run.clone(),
                ..Posting::default()
            },
            |db, said| {
                let at = now();
                db::add_version(
                    db,
                    db::NewVersion {
                        artifact_id: row.id.clone(),
                        version: next,
                        attachment_id: file.clone(),
                        size: bytes.len() as i64,
                        note: note.map(str::to_owned),
                        by_id: maker.by.clone(),
                        by_name: said.name.clone(),
                        created_at: at,
                    },
                )
                .map_err(q)?;
                db::version_announced(db, &row.id, next, &said.id).map_err(q)?;
                db::artifact_versioned(db, &row.id, next, at).map_err(q)?;
                let meta = explicit_meta
                    .cloned()
                    .unwrap_or_else(|| collab::commit_meta_for_maker(maker, note.map(str::to_owned), at));
                self.sync_html_to_collab(db, &row.id, prior_html.as_deref(), &req.content, &meta)?;
                Ok(())
            },
        )?;
        self.get_now(&row.id)
    }

    /// The user's words in place of some in the latest version (or a store entry
    /// when `path` is given), kept as the next version or entry revision.
    pub fn html_edit(&self, maker: &Maker, req: &ArtifactHtmlEdit) -> Result<Wire, ApiError> {
        if let Some(path) = req.path.as_deref() {
            let entry = self.get_entry(&ArtifactEntryGetRequest {
                id: req.id.clone(),
                path: path.into(),
            })?;
            let source = entry.value.as_deref().unwrap_or("");
            let edited = html_edit(source, &req.anchor, &req.text).map_err(refused)?;
            let res = self.batch_entries(
                maker,
                &ArtifactEntryBatchRequest {
                    id: req.id.clone(),
                    writes: vec![ArtifactEntryWriteInput {
                        op: ArtifactEntryOp::Set,
                        path: path.into(),
                        kind: Some(ArtifactEntryKind::Text),
                        value: Some(edited),
                        from: None,
                        mime: Some(entry.mime),
                        if_rev: Some(entry.rev),
                    }],
                    note: None,
                    announce: Some(false),
                },
            )?;
            if !res.applied {
                return Err(refused(t(
                    "server.artifact.edit.stale",
                    &[("version", entry.rev.into()), ("latest", res.seq.into())],
                )));
            }
            return self.get_now(&req.id);
        }
        let _rows = self.rows.lock();
        let (row, v) = self.version_of(&mut self.db(), &req.id, Some(req.version))?;
        if row.body != "html" {
            return Err(refused(t("server.artifact.notHtml", &[("title", row.title.as_str().into())])));
        }
        // Over the latest only: a later version's changes would be lost under an edit of an older one.
        if v.version != row.version {
            return Err(refused(t(
                "server.artifact.edit.stale",
                &[("version", v.version.into()), ("latest", row.version.into())],
            )));
        }
        let source = self.page_of(&row, &v)?;
        let edited = html_edit(&source, &req.anchor, &req.text).map_err(refused)?;
        let note = t(
            "server.artifact.edit.note",
            &[("old", head(req.anchor.exact.trim(), 40).into()), ("new", head(req.text.trim(), 40).into())],
        );
        self.version_locked(
            maker,
            &ArtifactVersionRequest {
                id: req.id.clone(),
                content: edited,
                note: Some(note),
            },
            None,
        )
    }

    /// Its title, how an html one is shown, or whether a design-system is the farm's default.
    pub fn update(&self, req: &ArtifactUpdateRequest) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock();
        let mut db = self.db();
        let row = self.found(&mut db, &req.id)?;
        if let Some(title) = &req.title {
            let problem = artifact_problem(Some(title), None, None);
            if !problem.is_empty() {
                return Err(refused(problem));
            }
        }
        if req.display.is_some() && row.body != "html" {
            return Err(refused(t("server.artifact.displayHtmlOnly", &[])));
        }
        if req.is_default == Some(true) && row.artifact_type.as_deref() != Some(ArtifactType::DesignSystem.as_str()) {
            return Err(refused(t("server.artifact.defaultDesignSystemOnly", &[])));
        }
        let at = now();
        let mut tx = pollster::block_on(db.begin()).map_err(q)?;
        if let Some(title) = &req.title {
            db::artifact_renamed(&mut tx, &req.id, title.trim(), at).map_err(q)?;
        }
        if let Some(display) = req.display {
            db::artifact_shown(&mut tx, &req.id, display.as_str(), at).map_err(q)?;
        }
        if let Some(is_default) = req.is_default {
            if is_default {
                db::clear_default_design_system(&mut tx, at).map_err(q)?;
            }
            db::set_artifact_default(&mut tx, &req.id, is_default, at).map_err(q)?;
        }
        pollster::block_on(tx.commit()).map_err(q)?;
        let row = self.found(&mut db, &req.id)?;
        self.assemble(&mut db, row)
    }

    pub fn preview_remove(&self, id: &str) -> Result<Preview, ApiError> {
        let row = self.found(&mut self.db(), id)?;
        let what = if row.body == "html" {
            t(
                "server.artifact.preview.remove",
                &[("title", row.title.as_str().into()), ("n", row.version.into())],
            )
        } else if row.body == "store" {
            let n = self.entry_count(id)?;
            t(
                "server.artifact.preview.removeEntries",
                &[("title", row.title.as_str().into()), ("n", n.into())],
            )
        } else {
            let n = self.live_blocks(id)?.len();
            t("server.artifact.preview.removeBlocks", &[("title", row.title.as_str().into()), ("n", n.into())])
        };
        let mut does = vec![what];
        if row.channel_id.is_some() {
            does.push(t("server.artifact.preview.cards", &[]));
        }
        Ok(Preview { does })
    }

    /// It and its versions, blocks, or entries go; the versions' attachments stay.
    pub fn remove(&self, id: &str) -> Result<(), ApiError> {
        let _rows = self.rows.lock();
        let mut db = self.db();
        self.found(&mut db, id)?;
        db::delete_artifact(&mut db, id).map_err(q)?;
        self.drop_presence_state(id);
        Ok(())
    }

    pub fn snapshot(&self, id: &str) -> Result<BlockSnapshot, ApiError> {
        let blocks = self.live_blocks(id)?;
        Ok(BlockSnapshot {
            artifact: self.get_now(id)?,
            blocks,
        })
    }

    /// `quoteBlocks`: the blocks a message quotes as they are now, so later
    /// edits leave the quote as it was; one that cannot be read is left out.
    pub fn quote(&self, refs: &[BlockRef]) -> Vec<QuotedBlock> {
        let mut out = vec![];
        for r in refs {
            match self.snapshot(&r.artifact_id) {
                Ok(s) => {
                    let b = s.blocks.iter().find(|b| b.id == r.block_id);
                    out.push(QuotedBlock {
                        artifact_id: r.artifact_id.clone(),
                        block_id: r.block_id.clone(),
                        rev: r.rev,
                        title: s.artifact.title.clone(),
                        r#type: b.and_then(|b| serde_json::to_value(b.r#type).ok()?.as_str().map(str::to_string)),
                        text: b.map(|b| vibevalley_core::artifact::plain(&b.text)),
                        now_rev: b.map(|b| b.rev),
                        deleted: b.is_none().then_some(true),
                    });
                }
                Err(e) => eprintln!("vibevalley-server: quoting a block failed: {}", e.message),
            }
        }
        out
    }

    /// VibeValley's `artifact.page`: what `GET /api/v1/artifact/:id/:version`
    /// answers. Plain, the version's bytes; with `shell`, the workbench's
    /// view of it in its theme (`artifactContent` in `gateway/http/api.ts`).
    pub fn page(&self, req: &ArtifactPageInput) -> Result<ArtifactPage, ApiError> {
        let gone = || ApiError::new(BizCode::ArtifactNotFound, t("server.artifact.missing", &[("id", req.id.as_str().into())]));
        if req.version < 1 {
            return Err(gone());
        }
        let path = self.file(&req.id, req.version).ok_or_else(gone)?;
        let headers = artifact_headers(req.print == Some(true));
        if req.shell != Some(true) {
            let content = std::fs::read(&path).map_err(|_| gone())?;
            return Ok(ArtifactPage {
                content: String::from_utf8_lossy(&content).into_owned(),
                headers,
            });
        }
        let (page, _) = self.content(&req.id, Some(req.version))?;
        let shown = self.get_now(&req.id)?;
        let theme = shell_theme_of(req.theme.as_deref());
        let wrapped = with_shell(&page.content, shown.display.unwrap_or(ArtifactDisplay::Page), theme);
        Ok(ArtifactPage {
            content: self.inject_presence_highlights(&req.id, wrapped, false),
            headers,
        })
    }
}

fn display_of(s: &str) -> Option<ArtifactDisplay> {
    ArtifactDisplay::ALL.into_iter().find(|d| d.as_str() == s)
}

pub(super) fn artifact_type_of(s: &str) -> Option<ArtifactType> {
    ArtifactType::ALL.into_iter().find(|ty| ty.as_str() == s)
}

fn prune_daily(me: Weak<Artifacts>, stop_rx: flume::Receiver<()>) -> Option<std::thread::JoinHandle<()>> {
    std::thread::Builder::new()
        .name("vibevalley-artifact-prune".into())
        .spawn(move || {
            let day = std::time::Duration::from_millis(blocks::DAY_MS as u64);
            loop {
                {
                    let Some(a) = me.upgrade() else { return };
                    if a.closed.load(Ordering::Relaxed) {
                        return;
                    }
                    let before = now() - blocks::KEPT_DAYS * blocks::DAY_MS;
                    if let Err(e) = db::prune(&mut a.db(), before) {
                        eprintln!("vibevalley-server: artifact.prune failed: {e}");
                    }
                }
                if !matches!(stop_rx.recv_timeout(day), Err(flume::RecvTimeoutError::Timeout)) {
                    return;
                }
            }
        })
        .ok()
}

/// `idOf`: an issue by number (refused when there is none), by session, or
/// the reference as given.
fn issue_id(board: &crate::modules::work::issue::Board, reference: &str) -> Result<String, ApiError> {
    let r = reference.trim();
    let number = r.strip_prefix('#').unwrap_or(r);
    if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
        return board
            .issue(number)
            .map(|i| i.id)
            .ok_or_else(|| missing(t("server.issue.issueNumbered", &[("n", number.into())]), LookIn::Issue));
    }
    if let Some(issue) = board.session(r).and_then(|s| s.issue_id().map(String::from)) {
        return Ok(issue);
    }
    Ok(r.to_string())
}

/// Every `artifact.*` endpoint and subscription, as the user calls them
/// (`gateway/http/handlers/artifact.ts`).
pub fn install(hub: &Hub, artifacts: Arc<Artifacts>, agents: Arc<Agents>, board: crate::modules::work::issue::Board) {
    let a = artifacts;
    hub.on::<ops::ArtifactList>({
        let (a, board) = (a.clone(), board.clone());
        move |_, r| {
            let issue = r.issue.as_deref().filter(|i| !i.is_empty()).map(|i| issue_id(&board, i)).transpose()?;
            a.list(&ArtifactListRequest {
                channel: r.channel.filter(|c| !c.is_empty()),
                issue,
                artifact_type: r.artifact_type,
            })
        }
    });
    hub.on::<ops::ArtifactGet>({
        let a = a.clone();
        move |_, r| a.get(&r.id)
    });
    hub.on::<ops::ArtifactContentGet>({
        let a = a.clone();
        move |_, r| a.content(&r.id, r.version).map(|(c, _)| c)
    });
    hub.on::<ops::ArtifactCreate>({
        let a = a.clone();
        move |_, mut r| {
            if let Some(i) = r.issue.as_deref().filter(|i| !i.is_empty()) {
                r.issue = Some(issue_id(&board, i)?);
            } else {
                r.issue = None;
            }
            a.create(&Maker::user(), &r)
        }
    });
    hub.on::<ops::ArtifactVersionCreate>({
        let a = a.clone();
        move |_, r| a.version(&Maker::user(), &r)
    });
    hub.on::<ops::ArtifactHtmlEdit>({
        let a = a.clone();
        move |_, r| a.html_edit(&Maker::user(), &r)
    });
    hub.on::<ops::ArtifactUpdate>({
        let a = a.clone();
        move |_, r| a.update(&r)
    });
    hub.on::<ops::ArtifactDelete>({
        let a = a.clone();
        move |_, r| a.remove(&r.id)
    });
    hub.on::<ops::ArtifactPreviewDelete>({
        let a = a.clone();
        move |_, r| a.preview_remove(&r.id)
    });
    hub.on::<ops::ArtifactTypeList>({
        let a = a.clone();
        move |_, _| a.list_types()
    });
    hub.on::<ops::ArtifactTypeRead>({
        let a = a.clone();
        move |_, r| a.read_type(&r)
    });
    hub.on::<ops::ArtifactEntryList>({
        let a = a.clone();
        move |_, r| a.list_entries(&r)
    });
    hub.on::<ops::ArtifactEntryGet>({
        let a = a.clone();
        move |_, r| a.get_entry(&r)
    });
    hub.on::<ops::ArtifactEntryBatch>({
        let a = a.clone();
        move |_, r| a.batch_entries(&Maker::user(), &r)
    });
    hub.on::<ops::ArtifactBlockList>({
        let a = a.clone();
        move |_, r| a.snapshot(&r.id)
    });
    hub.on::<ops::ArtifactSubmit>({
        let a = a.clone();
        move |_, r| a.submit(&r.id, USER_ID, &r.batch_id, r.ops)
    });
    hub.on::<ops::ArtifactBlockCreate>({
        let a = a.clone();
        move |_, r| {
            let body = BlockCreate {
                r#type: r.r#type,
                level: r.level,
                checked: r.checked,
                language: r.language,
                text: r.text,
                after_block: r.after_block,
                parent_id: r.parent_id,
            };
            a.insert_block(&r.id, USER_ID, &body)
        }
    });
    hub.on::<ops::ArtifactBlockUpdate>({
        let a = a.clone();
        move |_, r| {
            let body = BlockUpdate {
                block: r.block,
                base_rev: r.base_rev,
                text: r.text,
                r#type: r.r#type,
                level: r.level,
                checked: r.checked,
                language: r.language,
            };
            a.update_block(&r.id, USER_ID, &body)
        }
    });
    hub.on::<ops::ArtifactBlockDelete>({
        let a = a.clone();
        move |_, r| a.delete_block(&r.id, USER_ID, &BlockDelete { block: r.block })
    });
    hub.on::<ops::ArtifactBlockPreviewDelete>({
        let a = a.clone();
        move |_, r| a.preview_delete_block(&r.id, &BlockDelete { block: r.block })
    });
    hub.on::<ops::ArtifactSuggestionList>({
        let a = a.clone();
        move |_, r| a.suggestions(&r.id)
    });
    hub.on::<ops::ArtifactSuggestionCreate>({
        let a = a.clone();
        move |_, r| {
            a.suggest(
                &r.id,
                USER_ID,
                &vibevalley_protocol::SuggestionCreate {
                    block: r.block,
                    base_rev: r.base_rev,
                    change: r.change,
                },
            )
        }
    });
    hub.on::<ops::ArtifactSuggestionAccept>({
        let a = a.clone();
        move |_, r| a.accept_suggestion(&r.id, &r.suggestion, USER_ID)
    });
    hub.on::<ops::ArtifactSuggestionReject>({
        let a = a.clone();
        move |_, r| a.reject_suggestion(&r.id, &r.suggestion, USER_ID)
    });
    hub.on::<ops::ArtifactMarkdownGet>({
        let a = a.clone();
        move |_, r| a.markdown(&r.id).map(|markdown| ArtifactMarkdown { markdown })
    });
    hub.on::<ops::ArtifactDemo>({
        let a = a.clone();
        move |_, r| a.demo(&r.id, &agents.profiles.agents())
    });
    hub.on::<ops::ArtifactPresenceUpdate>({
        let a = a.clone();
        move |_, r| a.update_presence(USER_ID, &r)
    });
    hub.on::<ops::ArtifactHistoryList>({
        let a = a.clone();
        move |_, r| a.history_list(&r)
    });
    hub.on::<ops::ArtifactHistoryPreview>({
        let a = a.clone();
        move |_, r| a.history_preview(&r)
    });
    hub.on::<ops::ArtifactHistoryRestore>({
        let a = a.clone();
        move |_, r| a.history_restore(&r)
    });
    hub.on::<ops::ArtifactHistoryFork>({
        let a = a.clone();
        move |_, r| a.history_fork(&r)
    });
    hub.on::<ops::ArtifactHistoryUndoOrigin>({
        let a = a.clone();
        move |_, r| a.history_undo_origin(&r)
    });
    hub.on::<ops::ArtifactHistoryCompact>({
        let a = a.clone();
        move |_, r| a.history_compact(&r)
    });
    hub.on::<native_ops::ArtifactPage>({
        let a = a.clone();
        move |_, r| a.page(&r)
    });
    hub.on::<native_ops::ArtifactView>({
        let a = a.clone();
        move |_, r| a.view(&r)
    });
    hub.on::<native_ops::ArtifactEntryWriteProps>({
        let a = a.clone();
        move |_, r| a.write_entry_props(&Maker::user(), &r)
    });
    hub.on::<native_ops::ArtifactTokensInspect>(move |_, r| Ok(Artifacts::inspect_tokens(&r)));
    hub.on_subscription::<subscriptions::ArtifactFollow>({
        let a = a.clone();
        move |_, p, sink| a.follow(&p.id, p.after, sink)
    });
    hub.on_subscription::<subscriptions::ArtifactEntryFollow>({
        let a = a.clone();
        move |_, p, sink| a.follow_entries(&p.id, p.after, sink)
    });
    hub.on_subscription::<subscriptions::ArtifactSuggestionFollow>({
        let a = a.clone();
        move |_, p, sink| a.follow_suggestions(&p.id, sink)
    });
    hub.on_subscription::<subscriptions::ArtifactPresenceFollow>(move |_, p, sink| a.follow_presence(&p.id, sink));
}
