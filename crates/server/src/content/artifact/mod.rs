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
pub(super) mod db;
mod entries;
mod types;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use sea_orm::{ConnectionTrait, DbErr};
use tokio::sync::{Mutex as AsyncMutex, broadcast};
use tokio_util::sync::CancellationToken;
use vibevalley_core::artifact::{
    artifact_headers, artifact_problem, html_check, html_edit, html_problem, import_outline_markdown, infer_artifact_from_name, shell_theme_of,
    starter_entries_for_type, with_shell,
};
use vibevalley_core::collab::{CommitMeta, PresenceHub};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Artifact as Wire, ArtifactBody, ArtifactCard, ArtifactContent, ArtifactDisplay, ArtifactEntryBatchRequest, ArtifactEntryGetRequest,
    ArtifactEntryKind, ArtifactEntryOp, ArtifactEntryWriteInput, ArtifactHtmlEdit, ArtifactKind, ArtifactListRequest, ArtifactMarkdown,
    ArtifactOutlineImportRequest, ArtifactPage, ArtifactPageInput, ArtifactPresenceEvent, ArtifactRequest, ArtifactSaid, ArtifactType, ArtifactUpdateRequest,
    ArtifactVersion, ArtifactVersionRequest, BizCode, BlockAck, BlockCreate, BlockDelete, BlockRef, BlockSnapshot, BlockUpdate, Preview, QuotedBlock, USER_ID,
    native_ops, ops, subscriptions,
};

pub use blocks::spans_of;
use db::ArtifactRow;
use entries::EntryChange;

use crate::app::hub::ports::{ChannelAnnouncePort, ChannelQuotePort};
use crate::app::hub::refusal::{LookIn, missing};
use crate::content::attachment::AttachmentStore;
use crate::db::ServerDb;
use crate::db::begin_write_tx;
use crate::{Hub, now};

/// How many the farm-wide list shows.
const LISTED_MAX: i64 = 200;
/// Bounded ring capacity for artifact change/suggestion/presence broadcasts.
const STREAM_CAPACITY: usize = 256;

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::ArtifactRefused, text.into())
}

fn q(e: DbErr) -> ApiError {
    crate::app::hub::refusal::internal(e)
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

/// Read-only artifact block quoter backed directly by [`ServerDb`], enabling
/// bottom-up construction of `collab/channel::Chat` before `ArtifactStore` with
/// zero post-init cycle-breaking hooks.
pub struct BlockQuoter {
    db: Arc<ServerDb>,
}

impl BlockQuoter {
    pub fn new(db: Arc<ServerDb>) -> Self {
        Self { db }
    }
}

impl ChannelQuotePort for BlockQuoter {
    fn quote(&self, refs: &[BlockRef]) -> Vec<QuotedBlock> {
        vibevalley_runtime::rt::block_on(async {
            let conn = self.db.read_conn();
            let mut out = vec![];
            for r in refs {
                let row = match db::artifact(conn, &r.artifact_id).await {
                    Ok(Some(row)) => row,
                    Ok(None) => continue,
                    Err(e) => {
                        eprintln!("vibevalley-server: quoting a block failed: {e}");
                        continue;
                    }
                };
                let blocks = match db::blocks(conn, &r.artifact_id).await {
                    Ok(b) => b,
                    Err(e) => {
                        eprintln!("vibevalley-server: quoting a block failed: {e}");
                        continue;
                    }
                };
                let b = blocks.iter().find(|b| b.id == r.block_id && b.deleted.is_none());
                out.push(QuotedBlock {
                    artifact_id: r.artifact_id.clone(),
                    block_id: r.block_id.clone(),
                    rev: r.rev,
                    title: row.title,
                    r#type: b.and_then(|b| serde_json::to_value(b.r#type).ok()?.as_str().map(str::to_string)),
                    text: b.map(|b| vibevalley_core::artifact::plain(&b.text)),
                    now_rev: b.map(|b| b.rev),
                    deleted: b.is_none().then_some(true),
                });
            }
            out
        })
    }
}

pub struct ArtifactStore {
    db: Arc<ServerDb>,
    /// One change of an artifact's row at a time: a version's number is the
    /// latest's plus one.
    rows: AsyncMutex<()>,
    /// One batch of block ops at a time.
    batches: AsyncMutex<()>,
    /// Per-artifact write lock for structured entry store batches.
    entry_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    files: Arc<AttachmentStore>,
    channel: Arc<dyn ChannelAnnouncePort>,
    changes: broadcast::Sender<Change>,
    entry_changes: broadcast::Sender<EntryChange>,
    suggestion_changes: broadcast::Sender<SuggestionsNow>,
    /// Pure in-memory Loro EphemeralStore presence hubs keyed by artifact_id (never written to SQLite).
    presences: Mutex<HashMap<String, PresenceHub>>,
    presence_extra: Mutex<PresenceExtra>,
    presence_changes: broadcast::Sender<(String, ArtifactPresenceEvent)>,
    cancel: CancellationToken,
    prune_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// Temporary compatibility alias for unowned callers until spine cutover.
#[doc(hidden)]
pub type Artifacts = ArtifactStore;

impl ArtifactStore {
    /// Opens artifacts on the shared [`ServerDb`]. The daily prune task is
    /// attached to the hub's task tracker when [`install`] wires the endpoints.
    pub fn open(db: Arc<ServerDb>, files: Arc<AttachmentStore>, channel: Arc<dyn ChannelAnnouncePort>) -> Arc<ArtifactStore> {
        let (changes, _) = broadcast::channel(STREAM_CAPACITY);
        let (entry_changes, _) = broadcast::channel(STREAM_CAPACITY);
        let (suggestion_changes, _) = broadcast::channel(STREAM_CAPACITY);
        let (presence_changes, _) = broadcast::channel(STREAM_CAPACITY);
        Arc::new(ArtifactStore {
            db,
            rows: AsyncMutex::new(()),
            batches: AsyncMutex::new(()),
            entry_locks: Mutex::default(),
            files,
            channel,
            changes,
            entry_changes,
            suggestion_changes,
            presences: Mutex::default(),
            presence_extra: Mutex::default(),
            presence_changes,
            cancel: CancellationToken::new(),
            prune_task: Mutex::new(None),
        })
    }

    fn start_prune_ticker(self: &Arc<Self>, hub: &Hub) {
        let mut slot = self.prune_task.lock();
        if slot.is_some() || self.cancel.is_cancelled() {
            return;
        }
        let weak = Arc::downgrade(self);
        let cancel = self.cancel.clone();
        let hub_cancel = hub.child_token();
        let handle = hub.spawn_task(async move {
            let mut timer = tokio::time::interval(Duration::from_millis(blocks::DAY_MS as u64));
            timer.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return,
                    _ = hub_cancel.cancelled() => return,
                    _ = timer.tick() => {}
                }
                let Some(a) = weak.upgrade() else { return };
                if a.cancel.is_cancelled() {
                    return;
                }
                let before = now() - blocks::KEPT_DAYS * blocks::DAY_MS;
                if let Err(e) = db::prune(a.db.write_conn(), before).await {
                    eprintln!("vibevalley-server: artifact.prune failed: {e}");
                }
            }
        });
        *slot = Some(handle);
    }

    /// Stops the daily prune task and active subscription streams.
    pub fn close(&self) {
        self.cancel.cancel();
        if let Some(handle) = self.prune_task.lock().take() {
            handle.abort();
        }
    }

    async fn found<C: ConnectionTrait>(&self, db: &C, id: &str) -> Result<ArtifactRow, ApiError> {
        db::artifact(db, id)
            .await
            .map_err(q)?
            .ok_or_else(|| missing(t("server.artifact.missing", &[("id", id.into())]), LookIn::Artifact))
    }

    async fn assemble<C: ConnectionTrait>(&self, db: &C, row: ArtifactRow) -> Result<Wire, ApiError> {
        let versions = if row.body == "html" {
            db::versions(db, &row.id).await.map_err(q)?
        } else {
            vec![]
        };
        let mut message_ids = Vec::new();
        if let Some(id) = &row.message_id {
            message_ids.push(id.clone());
        }
        for v in &versions {
            if let Some(id) = &v.message_id {
                message_ids.push(id.clone());
            }
        }
        let locations = if message_ids.is_empty() {
            HashMap::new()
        } else {
            self.channel.message_locations(&message_ids).await
        };
        let channel = row.channel_id.clone().unwrap_or_default();
        let body = match row.body.as_str() {
            "html" => ArtifactBody::Html,
            "store" => ArtifactBody::Store,
            _ => ArtifactBody::Blocks,
        };
        let said = row.message_id.as_deref().and_then(|id| locations.get(id)).map(|(ch, number)| ArtifactSaid {
            channel: ch.clone(),
            number: *number,
        });
        Ok(Wire {
            id: row.id,
            title: row.title,
            body,
            artifact_type: row.artifact_type.as_deref().and_then(artifact_type_of),
            is_default: row.is_default,
            display: row.display.as_deref().and_then(display_of),
            channel: row.channel_id,
            said,
            issue: row.issue,
            by: row.by_id,
            by_name: row.by_name,
            version: row.version,
            seq: row.seq,
            versions: versions
                .into_iter()
                .map(|v| {
                    let loc = v.message_id.as_deref().and_then(|id| locations.get(id));
                    ArtifactVersion {
                        version: v.version,
                        size: v.size,
                        note: v.note.unwrap_or_default(),
                        by: v.by_id,
                        by_name: v.by_name,
                        at: v.created_at,
                        channel: loc.map(|(ch, _)| ch.clone()).unwrap_or_else(|| channel.clone()),
                        number: loc.map(|(_, number)| *number),
                    }
                })
                .collect(),
            at: row.created_at,
            updated: row.updated_at,
        })
    }

    async fn get_now_async(&self, id: &str) -> Result<Wire, ApiError> {
        let conn = self.db.read_conn();
        let row = self.found(conn, id).await?;
        self.assemble(conn, row).await
    }

    pub async fn list_async(&self, req: &ArtifactListRequest) -> Result<Vec<Wire>, ApiError> {
        let conn = self.db.read_conn();
        let channel = req.channel.as_deref().filter(|c| !c.is_empty());
        let rows = match (req.issue.as_deref().filter(|i| !i.is_empty()), channel) {
            (Some(issue), _) => db::artifacts_for_issue(conn, issue).await,
            (None, Some(channel)) => db::artifacts_in_channel(conn, channel).await,
            (None, None) => db::artifacts(conn, LISTED_MAX).await,
        }
        .map_err(q)?;
        // Both given: the issue's, in that channel; filtered by artifact_type when set.
        let mut out = Vec::new();
        for r in rows
            .into_iter()
            .filter(|r| channel.is_none_or(|c| r.channel_id.as_deref() == Some(c)))
            .filter(|r| req.artifact_type.is_none_or(|ty| r.artifact_type.as_deref() == Some(ty.as_str())))
        {
            out.push(self.assemble(conn, r).await?);
        }
        Ok(out)
    }

    /// Temporary compatibility wrapper for unowned sync callers until `spine-cutover-all`.
    #[doc(hidden)]
    pub fn list(&self, req: &ArtifactListRequest) -> Result<Vec<Wire>, ApiError> {
        vibevalley_runtime::rt::block_on(self.list_async(req))
    }

    pub async fn get_async(&self, id: &str) -> Result<Wire, ApiError> {
        self.get_now_async(id).await
    }

    async fn version_of<C: ConnectionTrait>(&self, db: &C, id: &str, version: Option<i64>) -> Result<(ArtifactRow, db::VersionRow), ApiError> {
        let row = self.found(db, id).await?;
        let n = version.unwrap_or(row.version);
        let Some(v) = db::version(db, id, n).await.map_err(q)? else {
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
    async fn page_of_async(&self, row: &ArtifactRow, v: &db::VersionRow) -> Result<String, ApiError> {
        tokio::fs::read(self.files.path_of(&v.attachment_id))
            .await
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
    pub async fn content_async(&self, id: &str, version: Option<i64>) -> Result<(ArtifactContent, ArtifactBody), ApiError> {
        let row = self.found(self.db.read_conn(), id).await?;
        if row.body == "blocks" {
            return Ok((
                ArtifactContent {
                    version: row.seq,
                    content: self.markdown_async(id).await?,
                },
                ArtifactBody::Blocks,
            ));
        }
        if row.body == "store" {
            let summary = self.store_summary_async(&row).await?;
            return Ok((
                ArtifactContent {
                    version: row.seq,
                    content: summary,
                },
                ArtifactBody::Store,
            ));
        }
        let (row, v) = self.version_of(self.db.read_conn(), id, version).await?;
        let content = self.page_of_async(&row, &v).await?;
        Ok((ArtifactContent { version: v.version, content }, ArtifactBody::Html))
    }

    /// An html version's file on disk; none when there is none.
    pub async fn file_async(&self, id: &str, version: i64) -> Option<PathBuf> {
        let conn = self.db.read_conn();
        let row = db::artifact(conn, id).await.ok()??;
        if row.body != "html" {
            return None;
        }
        db::version(conn, id, version).await.ok()?.map(|v| self.files.path_of(&v.attachment_id))
    }

    /// `keep`: a version's bytes as an attachment.
    async fn keep_async(&self, bytes: Vec<u8>, title: &str) -> Result<String, ApiError> {
        Ok(self.files.keep_async(bytes, format!("{title}.html"), "text/html".into()).await?.id)
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
    pub async fn create_async(&self, maker: &Maker, req: &ArtifactRequest) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock().await;
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
            return self.create_store_async(maker, req, &effective_title, store_type).await;
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
                Some(c) => Some(self.channel.place_of_async(&maker.from, c).await?),
                None => None,
            };
            return self.start_blocks_async(maker, &effective_title, docs_type, channel, req.issue.clone()).await;
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
        let channel = self.channel.place_of_async(&maker.from, req.channel.as_deref().unwrap_or("")).await?;
        let file = if html {
            self.keep_async(bytes.to_vec(), &effective_title).await?
        } else {
            String::new()
        };
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
        let by_name = if maker.by == USER_ID {
            t("server.channel.name.user", &[])
        } else {
            maker.by.clone()
        };
        let initial = {
            let at = now();
            let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
            let outcome: Result<Option<BlockAck>, ApiError> = async {
                db::add_artifact(
                    &tx,
                    db::NewArtifact {
                        id: id.clone(),
                        title: effective_title.clone(),
                        body: if html { "html" } else { "blocks" }.into(),
                        artifact_type: final_type.map(|ty| ty.as_str().into()),
                        is_default: false,
                        display: display.map(|d| d.as_str().into()),
                        channel_id: Some(channel.clone()),
                        issue: req.issue.clone(),
                        by_id: maker.by.clone(),
                        by_name: by_name.clone(),
                        version,
                        created_at: at,
                    },
                )
                .await
                .map_err(q)?;
                if html {
                    db::add_version(
                        &tx,
                        db::NewVersion {
                            artifact_id: id.clone(),
                            version: 1,
                            attachment_id: file.clone(),
                            size: bytes.len() as i64,
                            note: note.map(str::to_owned),
                            by_id: maker.by.clone(),
                            by_name,
                            created_at: at,
                        },
                    )
                    .await
                    .map_err(q)?;
                    let meta = collab::commit_meta_for_maker(maker, note.map(str::to_owned), at);
                    self.sync_html_to_collab_async(&tx, &id, None, content, &meta).await?;
                }
                let fill_meta = collab::commit_meta_for_maker(maker, note.map(str::to_owned), at);
                if html {
                    Ok(None)
                } else {
                    self.fill_with_meta_async(&tx, &id, content, &maker.by, &fill_meta).await
                }
            }
            .await;
            match outcome {
                Ok(ack) => {
                    tx.commit().await.map_err(q)?;
                    ack
                }
                Err(err) => {
                    let _ = tx.rollback().await;
                    return Err(err);
                }
            }
        };
        let text = Self::words(t("server.artifact.made", &[("title", effective_title.as_str().into())]), note);
        let said = match self
            .channel
            .post_card_async(&maker.from, &channel, &text, card, maker.run.clone(), String::new())
            .await
        {
            Ok(msg) => msg,
            Err(err) => {
                let _ = db::delete_artifact(self.db.write_conn(), &id).await;
                return Err(err);
            }
        };
        db::artifact_said(self.db.write_conn(), &id, &said.id).await.map_err(q)?;
        if html {
            db::version_announced(self.db.write_conn(), &id, 1, &said.id).await.map_err(q)?;
        }
        if let Some(ack) = initial {
            self.publish_change(&id, &ack);
        }
        self.get_now_async(&id).await
    }

    async fn create_store_async(&self, maker: &Maker, req: &ArtifactRequest, title: &str, artifact_type: Option<ArtifactType>) -> Result<Wire, ApiError> {
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
            Some(self.channel.place_of_async(&maker.from, req.channel.as_deref().unwrap_or("")).await?)
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
            let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
            let outcome: Result<(), ApiError> = async {
                if is_default {
                    db::clear_default_design_system(&tx, at).await.map_err(q)?;
                }
                db::add_artifact(
                    &tx,
                    db::NewArtifact {
                        id: id.clone(),
                        title: title.into(),
                        body: "store".into(),
                        artifact_type: artifact_type.map(|ty| ty.as_str().into()),
                        is_default,
                        display: None,
                        channel_id: resolved_channel.clone(),
                        issue: req.issue.clone(),
                        by_id: maker.by.clone(),
                        by_name: initial_name,
                        version: 0,
                        created_at: at,
                    },
                )
                .await
                .map_err(q)?;
                Ok(())
            }
            .await;
            match outcome {
                Ok(()) => tx.commit().await.map_err(q)?,
                Err(err) => {
                    let _ = tx.rollback().await;
                    return Err(err);
                }
            }
        }

        let mut seq = 0;
        let initial_entries = match &req.entries {
            Some(entries) => entries.clone(),
            None => artifact_type.map(|ty| starter_entries_for_type(ty, title)).unwrap_or_default(),
        };
        if !initial_entries.is_empty() {
            let seeded = self
                .batch_entries_async(
                    maker,
                    &ArtifactEntryBatchRequest {
                        id: id.clone(),
                        writes: initial_entries,
                        note: None,
                        announce: Some(false),
                    },
                )
                .await?;
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
            let text = Self::words(t("server.artifact.made", &[("title", title.into())]), note);
            let said = self
                .channel
                .post_card_async(&maker.from, &channel, &text, card, maker.run.clone(), String::new())
                .await?;
            db::artifact_said(self.db.write_conn(), &id, &said.id).await.map_err(q)?;
        }

        self.get_now_async(&id).await
    }

    /// An empty blocks one the user starts on the page.
    async fn start_blocks_async(
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
        let conn = self.db.write_conn();
        db::add_artifact(
            conn,
            db::NewArtifact {
                id: id.clone(),
                title: title.into(),
                body: "blocks".into(),
                artifact_type: artifact_type.map(|ty| ty.as_str().into()),
                is_default: false,
                display: None,
                channel_id: channel,
                issue,
                by_id: maker.by.clone(),
                by_name: name,
                version: 0,
                created_at: now(),
            },
        )
        .await
        .map_err(q)?;
        let row = self.found(conn, &id).await?;
        self.assemble(conn, row).await
    }

    /// Imports a `.md` document (standard Markdown, YAML frontmatter, or Logseq outline)
    /// into a new `ArtifactType::Outline` blocks artifact.
    pub async fn import_outline_async(&self, maker: &Maker, req: &ArtifactOutlineImportRequest) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock().await;
        let imported = import_outline_markdown(&req.markdown, req.filename.as_deref(), req.title.as_deref());
        let explicit_title = req.title.as_deref().map(str::trim).filter(|s| !s.is_empty());
        let effective_title = if let Some(explicit) = explicit_title {
            explicit.to_string()
        } else if imported.title.trim().is_empty() {
            t("server.artifact.untitled", &[])
        } else {
            imported.title.trim().chars().take(80).collect()
        };
        let problem = artifact_problem(Some(&effective_title), Some(ArtifactKind::Markdown.as_str()), Some(req.markdown.trim().len()));
        if !problem.is_empty() {
            return Err(refused(problem));
        }

        let id = new_id();
        let note = req.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
        let should_announce = req.announce.unwrap_or_else(|| req.channel.is_some());
        let resolved_channel = if should_announce {
            Some(self.channel.place_of_async(&maker.from, req.channel.as_deref().unwrap_or("")).await?)
        } else {
            match req.channel.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
                Some(c) => Some(self.channel.place_of_async(&maker.from, c).await?),
                None => None,
            }
        };
        let at = now();
        let by_name = if maker.by == USER_ID {
            t("server.channel.name.user", &[])
        } else {
            maker.by.clone()
        };
        let initial = {
            let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
            let outcome: Result<Option<BlockAck>, ApiError> = async {
                db::add_artifact(
                    &tx,
                    db::NewArtifact {
                        id: id.clone(),
                        title: effective_title.clone(),
                        body: "blocks".into(),
                        artifact_type: Some(ArtifactType::Outline.as_str().into()),
                        is_default: false,
                        display: None,
                        channel_id: resolved_channel.clone(),
                        issue: req.issue.clone(),
                        by_id: maker.by.clone(),
                        by_name,
                        version: 0,
                        created_at: at,
                    },
                )
                .await
                .map_err(q)?;
                let fill_meta = collab::commit_meta_for_maker(maker, note.map(str::to_owned).or_else(|| Some("import outline".into())), at);
                self.fill_md_blocks_with_meta_async(&tx, &id, imported.blocks, &maker.by, &fill_meta).await
            }
            .await;
            match outcome {
                Ok(ack) => {
                    tx.commit().await.map_err(q)?;
                    ack
                }
                Err(err) => {
                    let _ = tx.rollback().await;
                    return Err(err);
                }
            }
        };
        if should_announce && let Some(channel) = resolved_channel {
            let card = ArtifactCard {
                id: id.clone(),
                title: effective_title.clone(),
                body: ArtifactBody::Blocks,
                version: 0,
                note: note.unwrap_or("").into(),
                display: None,
                artifact_type: Some(ArtifactType::Outline),
            };
            let text = Self::words(t("server.artifact.made", &[("title", effective_title.as_str().into())]), note);
            let said = match self
                .channel
                .post_card_async(&maker.from, &channel, &text, card, maker.run.clone(), String::new())
                .await
            {
                Ok(msg) => msg,
                Err(err) => {
                    let _ = db::delete_artifact(self.db.write_conn(), &id).await;
                    return Err(err);
                }
            };
            db::artifact_said(self.db.write_conn(), &id, &said.id).await.map_err(q)?;
        }

        if let Some(ack) = initial {
            self.publish_change(&id, &ack);
        }
        self.get_now_async(&id).await
    }

    /// An html one's next version; a blocks or store one is refused.
    pub async fn version_async(&self, maker: &Maker, req: &ArtifactVersionRequest) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock().await;
        self.version_locked_async(maker, req, None).await
    }

    pub async fn version_with_meta_async(&self, maker: &Maker, req: &ArtifactVersionRequest, meta: &CommitMeta) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock().await;
        self.version_locked_async(maker, req, Some(meta)).await
    }

    async fn version_locked_async(&self, maker: &Maker, req: &ArtifactVersionRequest, explicit_meta: Option<&CommitMeta>) -> Result<Wire, ApiError> {
        let (row, prior_version) = {
            let conn = self.db.read_conn();
            let row = self.found(conn, &req.id).await?;
            let prior = if row.body == "html" && row.version > 0 {
                db::version(conn, &row.id, row.version).await.map_err(q)?
            } else {
                None
            };
            (row, prior)
        };
        let prior_html = match prior_version {
            Some(v) => self.page_of_async(&row, &v).await.ok(),
            None => None,
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
        let file = self.keep_async(bytes.to_vec(), &row.title).await?;
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
        let by_name = if maker.by == USER_ID {
            t("server.channel.name.user", &[])
        } else {
            maker.by.clone()
        };
        {
            let at = now();
            let tx = begin_write_tx(self.db.write_conn()).await.map_err(q)?;
            let outcome: Result<(), ApiError> = async {
                db::add_version(
                    &tx,
                    db::NewVersion {
                        artifact_id: row.id.clone(),
                        version: next,
                        attachment_id: file,
                        size: bytes.len() as i64,
                        note: note.map(str::to_owned),
                        by_id: maker.by.clone(),
                        by_name,
                        created_at: at,
                    },
                )
                .await
                .map_err(q)?;
                db::artifact_versioned(&tx, &row.id, next, at).await.map_err(q)?;
                let meta = explicit_meta
                    .cloned()
                    .unwrap_or_else(|| collab::commit_meta_for_maker(maker, note.map(str::to_owned), at));
                self.sync_html_to_collab_async(&tx, &row.id, prior_html.as_deref(), &req.content, &meta).await
            }
            .await;
            match outcome {
                Ok(()) => tx.commit().await.map_err(q)?,
                Err(err) => {
                    let _ = tx.rollback().await;
                    return Err(err);
                }
            }
        }
        let text = Self::words(
            t("server.artifact.versioned", &[("title", row.title.as_str().into()), ("version", next.into())]),
            note,
        );
        let said = self
            .channel
            .post_card_async(
                &maker.from,
                row.channel_id.as_deref().unwrap_or(""),
                &text,
                card,
                maker.run.clone(),
                String::new(),
            )
            .await?;
        db::version_announced(self.db.write_conn(), &row.id, next, &said.id).await.map_err(q)?;
        self.get_now_async(&row.id).await
    }

    /// The user's words in place of some in the latest version (or a store entry
    /// when `path` is given), kept as the next version or entry revision.
    pub async fn html_edit_async(&self, maker: &Maker, req: &ArtifactHtmlEdit) -> Result<Wire, ApiError> {
        if let Some(path) = req.path.as_deref() {
            let entry = self
                .get_entry_async(&ArtifactEntryGetRequest {
                    id: req.id.clone(),
                    path: path.into(),
                })
                .await?;
            let source = entry.value.as_deref().unwrap_or("");
            let edited = html_edit(source, &req.anchor, &req.text).map_err(refused)?;
            let res = self
                .batch_entries_async(
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
                )
                .await?;
            if !res.applied {
                return Err(refused(t(
                    "server.artifact.edit.stale",
                    &[("version", entry.rev.into()), ("latest", res.seq.into())],
                )));
            }
            return self.get_now_async(&req.id).await;
        }
        let _rows = self.rows.lock().await;
        let (row, v) = self.version_of(self.db.read_conn(), &req.id, Some(req.version)).await?;
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
        let source = self.page_of_async(&row, &v).await?;
        let edited = html_edit(&source, &req.anchor, &req.text).map_err(refused)?;
        let note = t(
            "server.artifact.edit.note",
            &[("old", head(req.anchor.exact.trim(), 40).into()), ("new", head(req.text.trim(), 40).into())],
        );
        self.version_locked_async(
            maker,
            &ArtifactVersionRequest {
                id: req.id.clone(),
                content: edited,
                note: Some(note),
            },
            None,
        )
        .await
    }

    /// Its title, how an html one is shown, or whether a design-system is the farm's default.
    pub async fn update_async(&self, req: &ArtifactUpdateRequest) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock().await;
        let conn = self.db.write_conn();
        let row = self.found(conn, &req.id).await?;
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
        let tx = begin_write_tx(conn).await.map_err(q)?;
        let outcome: Result<(), ApiError> = async {
            if let Some(title) = &req.title {
                db::artifact_renamed(&tx, &req.id, title.trim(), at).await.map_err(q)?;
            }
            if let Some(display) = req.display {
                db::artifact_shown(&tx, &req.id, display.as_str(), at).await.map_err(q)?;
            }
            if let Some(is_default) = req.is_default {
                if is_default {
                    db::clear_default_design_system(&tx, at).await.map_err(q)?;
                }
                db::set_artifact_default(&tx, &req.id, is_default, at).await.map_err(q)?;
            }
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) => tx.commit().await.map_err(q)?,
            Err(err) => {
                let _ = tx.rollback().await;
                return Err(err);
            }
        }
        let row = self.found(conn, &req.id).await?;
        self.assemble(conn, row).await
    }

    pub async fn preview_remove_async(&self, id: &str) -> Result<Preview, ApiError> {
        let row = self.found(self.db.read_conn(), id).await?;
        let what = if row.body == "html" {
            t(
                "server.artifact.preview.remove",
                &[("title", row.title.as_str().into()), ("n", row.version.into())],
            )
        } else if row.body == "store" {
            let n = self.entry_count_async(id).await?;
            t(
                "server.artifact.preview.removeEntries",
                &[("title", row.title.as_str().into()), ("n", n.into())],
            )
        } else {
            let n = self.live_blocks_async(id).await?.len();
            t("server.artifact.preview.removeBlocks", &[("title", row.title.as_str().into()), ("n", n.into())])
        };
        let mut does = vec![what];
        if row.channel_id.is_some() {
            does.push(t("server.artifact.preview.cards", &[]));
        }
        Ok(Preview { does })
    }

    /// It and its versions, blocks, or entries go; the versions' attachments stay.
    pub async fn remove_async(&self, id: &str) -> Result<(), ApiError> {
        let _rows = self.rows.lock().await;
        let conn = self.db.write_conn();
        self.found(conn, id).await?;
        db::delete_artifact(conn, id).await.map_err(q)?;
        self.drop_presence_state(id);
        Ok(())
    }

    pub async fn snapshot_async(&self, id: &str) -> Result<BlockSnapshot, ApiError> {
        let blocks = self.live_blocks_async(id).await?;
        Ok(BlockSnapshot {
            artifact: self.get_now_async(id).await?,
            blocks,
        })
    }

    /// VibeValley's `artifact.page`: what `GET /api/v1/artifact/:id/:version`
    /// answers. Plain, the version's bytes; with `shell`, the workbench's
    /// view of it in its theme (`artifactContent` in `gateway/http/api.ts`).
    pub async fn page_async(&self, req: &ArtifactPageInput) -> Result<ArtifactPage, ApiError> {
        let gone = || ApiError::new(BizCode::ArtifactNotFound, t("server.artifact.missing", &[("id", req.id.as_str().into())]));
        if req.version < 1 {
            return Err(gone());
        }
        let path = self.file_async(&req.id, req.version).await.ok_or_else(gone)?;
        let headers = artifact_headers(req.print == Some(true));
        if req.shell != Some(true) {
            let content = tokio::fs::read(&path).await.map_err(|_| gone())?;
            return Ok(ArtifactPage {
                content: String::from_utf8_lossy(&content).into_owned(),
                headers,
            });
        }
        let (page, _) = self.content_async(&req.id, Some(req.version)).await?;
        let shown = self.get_now_async(&req.id).await?;
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

/// `idOf`: an issue by number (refused when there is none), by session, or
/// the reference as given — read straight from `Hub`'s `SpaceState`.
fn issue_id(hub: &Hub, reference: &str) -> Result<String, ApiError> {
    let r = reference.trim();
    let number = r.strip_prefix('#').unwrap_or(r);
    if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
        return hub
            .read(|s| s.issues.iter().find(|i| i.number.to_string() == number).map(|i| i.id.clone()))
            .ok_or_else(|| missing(t("server.issue.issueNumbered", &[("n", number.into())]), LookIn::Issue));
    }
    if let Some(issue) = hub.read(|s| s.sessions.iter().find(|x| x.id == r).and_then(|x| x.issue_id().map(String::from))) {
        return Ok(issue);
    }
    Ok(r.to_string())
}

/// Every `artifact.*` endpoint and subscription, as the user calls them
/// (`gateway/http/handlers/artifact.ts`).
pub fn install(hub: &Hub, artifacts: Arc<ArtifactStore>) {
    artifacts.start_prune_ticker(hub);
    let a = artifacts;
    hub.on_async::<ops::ArtifactList, _, _>({
        let a = a.clone();
        move |ctx, r| {
            let a = a.clone();
            async move {
                let issue = r.issue.as_deref().filter(|i| !i.is_empty()).map(|i| issue_id(&ctx.hub, i)).transpose()?;
                a.list_async(&ArtifactListRequest {
                    channel: r.channel.filter(|c| !c.is_empty()),
                    issue,
                    artifact_type: r.artifact_type,
                })
                .await
            }
        }
    });
    hub.on_async::<ops::ArtifactGet, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.get_async(&r.id).await }
        }
    });
    hub.on_async::<ops::ArtifactContentGet, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.content_async(&r.id, r.version).await.map(|(c, _)| c) }
        }
    });
    hub.on_async::<ops::ArtifactCreate, _, _>({
        let a = a.clone();
        move |ctx, mut r| {
            let a = a.clone();
            async move {
                if let Some(i) = r.issue.as_deref().filter(|i| !i.is_empty()) {
                    r.issue = Some(issue_id(&ctx.hub, i)?);
                } else {
                    r.issue = None;
                }
                a.create_async(&Maker::user(), &r).await
            }
        }
    });
    hub.on_async::<ops::ArtifactOutlineImport, _, _>({
        let a = a.clone();
        move |ctx, mut r| {
            let a = a.clone();
            async move {
                if let Some(i) = r.issue.as_deref().filter(|i| !i.is_empty()) {
                    r.issue = Some(issue_id(&ctx.hub, i)?);
                } else {
                    r.issue = None;
                }
                a.import_outline_async(&Maker::user(), &r).await
            }
        }
    });
    hub.on_async::<ops::ArtifactVersionCreate, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.version_async(&Maker::user(), &r).await }
        }
    });
    hub.on_async::<ops::ArtifactHtmlEdit, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.html_edit_async(&Maker::user(), &r).await }
        }
    });
    hub.on_async::<ops::ArtifactUpdate, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.update_async(&r).await }
        }
    });
    hub.on_async::<ops::ArtifactDelete, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.remove_async(&r.id).await }
        }
    });
    hub.on_async::<ops::ArtifactPreviewDelete, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.preview_remove_async(&r.id).await }
        }
    });
    hub.on_async::<ops::ArtifactTypeList, _, _>({
        let a = a.clone();
        move |_, _| {
            let a = a.clone();
            async move { a.list_types_async().await }
        }
    });
    hub.on_async::<ops::ArtifactTypeRead, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.read_type_async(&r).await }
        }
    });
    hub.on_async::<ops::ArtifactEntryList, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.list_entries_async(&r).await }
        }
    });
    hub.on_async::<ops::ArtifactEntryGet, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.get_entry_async(&r).await }
        }
    });
    hub.on_async::<ops::ArtifactEntryBatch, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.batch_entries_async(&Maker::user(), &r).await }
        }
    });
    hub.on_async::<ops::ArtifactBlockList, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.snapshot_async(&r.id).await }
        }
    });
    hub.on_async::<ops::ArtifactSubmit, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.submit_async(&r.id, USER_ID, &r.batch_id, r.ops).await }
        }
    });
    hub.on_async::<ops::ArtifactBlockCreate, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move {
                let body = BlockCreate {
                    r#type: r.r#type,
                    level: r.level,
                    checked: r.checked,
                    language: r.language,
                    text: r.text,
                    after_block: r.after_block,
                    parent_id: r.parent_id,
                };
                a.insert_block_async(&r.id, USER_ID, &body).await
            }
        }
    });
    hub.on_async::<ops::ArtifactBlockUpdate, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move {
                let body = BlockUpdate {
                    block: r.block,
                    base_rev: r.base_rev,
                    text: r.text,
                    r#type: r.r#type,
                    level: r.level,
                    checked: r.checked,
                    language: r.language,
                };
                a.update_block_async(&r.id, USER_ID, &body).await
            }
        }
    });
    hub.on_async::<ops::ArtifactBlockDelete, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.delete_block_async(&r.id, USER_ID, &BlockDelete { block: r.block }).await }
        }
    });
    hub.on_async::<ops::ArtifactBlockPreviewDelete, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.preview_delete_block_async(&r.id, &BlockDelete { block: r.block }).await }
        }
    });
    hub.on_async::<ops::ArtifactSuggestionList, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.suggestions_async(&r.id).await }
        }
    });
    hub.on_async::<ops::ArtifactSuggestionCreate, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move {
                a.suggest_async(
                    &r.id,
                    USER_ID,
                    &vibevalley_protocol::SuggestionCreate {
                        block: r.block,
                        base_rev: r.base_rev,
                        change: r.change,
                    },
                )
                .await
            }
        }
    });
    hub.on_async::<ops::ArtifactSuggestionAccept, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.accept_suggestion_async(&r.id, &r.suggestion, USER_ID).await }
        }
    });
    hub.on_async::<ops::ArtifactSuggestionReject, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.reject_suggestion_async(&r.id, &r.suggestion, USER_ID).await }
        }
    });
    hub.on_async::<ops::ArtifactMarkdownGet, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.markdown_async(&r.id).await.map(|markdown| ArtifactMarkdown { markdown }) }
        }
    });
    hub.on_async::<ops::ArtifactPresenceUpdate, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.update_presence_async(USER_ID, &r).await }
        }
    });
    hub.on_async::<ops::ArtifactHistoryList, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.history_list_async(&r).await }
        }
    });
    hub.on_async::<ops::ArtifactHistoryPreview, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.history_preview_async(&r).await }
        }
    });
    hub.on_async::<ops::ArtifactHistoryRestore, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.history_restore_async(&r).await }
        }
    });
    hub.on_async::<ops::ArtifactHistoryFork, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.history_fork_async(&r).await }
        }
    });
    hub.on_async::<ops::ArtifactHistoryUndoOrigin, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.history_undo_origin_async(&r).await }
        }
    });
    hub.on_async::<ops::ArtifactHistoryCompact, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.history_compact_async(&r).await }
        }
    });
    hub.on_async::<native_ops::ArtifactPage, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.page_async(&r).await }
        }
    });
    hub.on_async::<native_ops::ArtifactView, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.view_async(&r).await }
        }
    });
    hub.on_async::<native_ops::ArtifactEntryWriteProps, _, _>({
        let a = a.clone();
        move |_, r| {
            let a = a.clone();
            async move { a.write_entry_props_async(&Maker::user(), &r).await }
        }
    });
    hub.on_async::<native_ops::ArtifactTokensInspect, _, _>(move |_, r| async move { Ok(ArtifactStore::inspect_tokens(&r)) });
    hub.on_subscription_async::<subscriptions::ArtifactFollow, _, _>({
        let a = a.clone();
        move |hub, p, sink| {
            let a = a.clone();
            async move { a.follow_async(&hub, &p.id, p.after, sink).await }
        }
    });
    hub.on_subscription_async::<subscriptions::ArtifactEntryFollow, _, _>({
        let a = a.clone();
        move |hub, p, sink| {
            let a = a.clone();
            async move { a.follow_entries_async(&hub, &p.id, p.after, sink).await }
        }
    });
    hub.on_subscription_async::<subscriptions::ArtifactSuggestionFollow, _, _>({
        let a = a.clone();
        move |hub, p, sink| {
            let a = a.clone();
            async move { a.follow_suggestions_async(&hub, &p.id, sink).await }
        }
    });
    hub.on_subscription_async::<subscriptions::ArtifactPresenceFollow, _, _>(move |hub, p, sink| {
        let a = a.clone();
        async move { a.follow_presence_async(&hub, &p.id, sink).await }
    });
}
