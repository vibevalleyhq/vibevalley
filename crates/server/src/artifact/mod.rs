//! Artifact domain (`Manager`), consolidating versioned HTML/block/store
//! artifacts, the media [`Library`], and the [`Media`] job engine behind
//! [`crate::context::Context`] and [`crate::service::ArtifactService`].

mod block;
mod collab;
mod entry;
pub mod library;
pub mod media;
mod types;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use tokio::sync::{Mutex as AsyncMutex, broadcast};
use tokio_util::sync::CancellationToken;
use vibevalley_core::artifact::{
    artifact_headers, artifact_problem, html_check, html_edit, html_problem, import_outline_markdown, infer_artifact_from_name, shell_theme_of,
    starter_entries_for_type, with_shell,
};
use vibevalley_core::collab::{CommitMeta, PresenceHub};
use vibevalley_i18n::t;
use vibevalley_protocol::native::{NativeEndpointId, native_ops};
use vibevalley_protocol::{
    ApiError, Artifact as Wire, ArtifactBody, ArtifactCard, ArtifactContent, ArtifactDisplay, ArtifactEntryBatchRequest, ArtifactEntryGetRequest,
    ArtifactEntryKind, ArtifactEntryOp, ArtifactEntryWriteInput, ArtifactHtmlEdit, ArtifactKind, ArtifactListRequest, ArtifactMarkdown,
    ArtifactOutlineImportRequest, ArtifactPage, ArtifactPageInput, ArtifactPresenceEvent, ArtifactRequest, ArtifactSaid, ArtifactType, ArtifactUpdateRequest,
    ArtifactVersion, ArtifactVersionRequest, BizCode, BlockAck, BlockCreate, BlockDelete, BlockRef, BlockSnapshot, BlockUpdate, Caller, ChatMessage,
    EndpointId, Op, Preview, QuotedBlock, Subscription, USER_ID, ops, subscriptions,
};

pub use block::spans_of;
use entry::EntryChange;
pub use library::{AddedBy, Library};
pub use media::Media;

use crate::context::{Context, LookIn, Sink, Ticker, internal, missing};
use crate::db::{DbError, Tx};
use crate::gateway::api::CallerContext;
use crate::service::artifact::{ArtifactRow, ArtifactService, NewArtifact, NewVersion, VersionRow};
use crate::setting::Setting;
use crate::storage::Storage;

const LISTED_MAX: i64 = 200;
const STREAM_CAPACITY: usize = 256;

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::ArtifactRefused, text.into())
}

fn q(e: DbError) -> ApiError {
    internal(e)
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

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

/// Narrow channel announcement interface used by artifact creation and media jobs.
pub trait ChannelAnnounce: Send + Sync {
    fn place_exists(&self, id: &str) -> bool;
    fn orchestrator_in(&self, channel: &str) -> String;
    fn place_of_async<'a>(&'a self, who: &'a str, target: &'a str) -> crate::BoxFuture<'a, Result<String, ApiError>>;
    fn post_card_async<'a>(
        &'a self,
        from: &'a str,
        channel: &'a str,
        text: &'a str,
        card: ArtifactCard,
        run: Option<String>,
        send_key: String,
    ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>>;
    fn post_attachments_async<'a>(
        &'a self,
        from: &'a str,
        channel: &'a str,
        text: &'a str,
        attachments: Vec<String>,
        send_key: String,
    ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>>;
}

/// Resolves quoted artifact blocks asynchronously via [`ArtifactService`] without blocking.
pub async fn quote_blocks_async(service: &ArtifactService, refs: &[BlockRef]) -> Vec<QuotedBlock> {
    let mut out = Vec::new();
    for r in refs {
        let row = match service.get(&r.artifact_id).await {
            Ok(Some(row)) => row,
            Ok(None) => continue,
            Err(e) => {
                eprintln!("vibevalley-server: quoting a block failed: {e}");
                continue;
            }
        };
        let blocks = match service.blocks(&r.artifact_id).await {
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
}

/// Who makes an artifact: `from` posts in the channel, `by` is the profile or user,
/// and `run` records the originating session run when applicable.
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

/// Unified artifact domain manager owning artifact documents/blocks/stores,
/// the media [`Library`], and the [`Media`] job engine.
pub struct Manager {
    pub library: Arc<Library>,
    pub media: Arc<Media>,
    pub(super) ctx: Arc<Context>,
    rows: AsyncMutex<()>,
    batches: AsyncMutex<()>,
    entry_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    storage: Arc<Storage>,
    channel: Arc<dyn ChannelAnnounce>,
    changes: broadcast::Sender<Change>,
    entry_changes: broadcast::Sender<EntryChange>,
    suggestion_changes: broadcast::Sender<SuggestionsNow>,
    presences: Mutex<HashMap<String, PresenceHub>>,
    presence_extra: Mutex<PresenceExtra>,
    presence_changes: broadcast::Sender<(String, ArtifactPresenceEvent)>,
    cancel: CancellationToken,
    prune_ticker: Mutex<Option<Ticker>>,
}

impl Manager {
    /// Opens the artifact manager together with [`Media`] and [`Library`], wiring
    /// media job updates to the library and starting the daily history prune ticker.
    pub async fn open_async(
        ctx: Arc<Context>,
        setting: Arc<Setting>,
        storage: Arc<Storage>,
        channel: Arc<dyn ChannelAnnounce>,
        channel_messages: Option<broadcast::Receiver<ChatMessage>>,
    ) -> Result<Arc<Self>, ApiError> {
        let media = Media::open_async(ctx.clone(), setting, storage.clone(), channel.clone()).await?;
        let library = Library::open(ctx.clone(), storage.clone(), channel_messages, Some(media.subscribe_job_updates()));
        let (changes, _) = broadcast::channel(STREAM_CAPACITY);
        let (entry_changes, _) = broadcast::channel(STREAM_CAPACITY);
        let (suggestion_changes, _) = broadcast::channel(STREAM_CAPACITY);
        let (presence_changes, _) = broadcast::channel(STREAM_CAPACITY);
        let cancel = ctx.task.child_token();
        let manager = Arc::new(Self {
            library,
            media,
            ctx,
            rows: AsyncMutex::new(()),
            batches: AsyncMutex::new(()),
            entry_locks: Mutex::default(),
            storage,
            channel,
            changes,
            entry_changes,
            suggestion_changes,
            presences: Mutex::default(),
            presence_extra: Mutex::default(),
            presence_changes,
            cancel,
            prune_ticker: Mutex::new(None),
        });
        manager.start_prune_ticker();
        Ok(manager)
    }

    fn start_prune_ticker(self: &Arc<Self>) {
        let mut slot = self.prune_ticker.lock();
        if slot.is_some() || self.cancel.is_cancelled() {
            return;
        }
        let weak = Arc::downgrade(self);
        let ticker = self.ctx.every("artifact.history.prune", Duration::from_millis(block::DAY_MS as u64), move || {
            let weak = weak.clone();
            async move {
                let Some(a) = weak.upgrade() else { return false };
                if a.cancel.is_cancelled() {
                    return false;
                }
                let before = a.ctx.now() - block::KEPT_DAYS * block::DAY_MS;
                if let Err(e) = a.ctx.service.artifact.prune_history(before).await {
                    eprintln!("vibevalley-server: artifact.prune failed: {e}");
                }
                true
            }
        });
        *slot = Some(ticker);
    }

    /// Stops background prune tasks, library listeners, and active media runs.
    pub fn close(&self) {
        self.cancel.cancel();
        if let Some(ticker) = self.prune_ticker.lock().take() {
            ticker.cancel();
        }
        self.library.close();
        self.media.close();
    }

    /// Returns the [`crate::gateway::api::media::SpeechStreams`] handle for `GatewayPorts`.
    pub fn speech_streams(&self) -> Arc<dyn crate::gateway::api::media::SpeechStreams> {
        self.media.clone()
    }

    /// Quotes referenced artifact blocks asynchronously.
    pub async fn quote_blocks_async(&self, refs: &[BlockRef]) -> Vec<QuotedBlock> {
        quote_blocks_async(&self.ctx.service.artifact, refs).await
    }

    pub(super) async fn found(&self, id: &str) -> Result<ArtifactRow, ApiError> {
        self.ctx
            .service
            .artifact
            .get(id)
            .await
            .map_err(q)?
            .ok_or_else(|| missing(t("server.artifact.missing", &[("id", id.into())]), LookIn::Artifact))
    }

    pub(super) async fn found_in_tx(&self, tx: &Tx, id: &str) -> Result<ArtifactRow, ApiError> {
        self.ctx
            .service
            .artifact
            .get_in_tx(tx, id)
            .await
            .map_err(q)?
            .ok_or_else(|| missing(t("server.artifact.missing", &[("id", id.into())]), LookIn::Artifact))
    }

    pub(super) async fn assemble(&self, row: ArtifactRow) -> Result<Wire, ApiError> {
        let versions = if row.body == "html" {
            self.ctx.service.artifact.versions(&row.id).await.map_err(q)?
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
            self.ctx.service.channel.message_locations(&message_ids).await.unwrap_or_default()
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

    pub(super) async fn get_now_async(&self, id: &str) -> Result<Wire, ApiError> {
        let row = self.found(id).await?;
        self.assemble(row).await
    }

    pub async fn list_async(&self, req: &ArtifactListRequest) -> Result<Vec<Wire>, ApiError> {
        let channel = req.channel.as_deref().filter(|c| !c.is_empty());
        let rows = match (req.issue.as_deref().filter(|i| !i.is_empty()), channel) {
            (Some(issue), _) => self.ctx.service.artifact.list_for_issue(issue).await,
            (None, Some(channel)) => self.ctx.service.artifact.list_in_channel(channel).await,
            (None, None) => self.ctx.service.artifact.list(LISTED_MAX).await,
        }
        .map_err(q)?;
        let mut out = Vec::new();
        for r in rows
            .into_iter()
            .filter(|r| channel.is_none_or(|c| r.channel_id.as_deref() == Some(c)))
            .filter(|r| req.artifact_type.is_none_or(|ty| r.artifact_type.as_deref() == Some(ty.as_str())))
        {
            out.push(self.assemble(r).await?);
        }
        Ok(out)
    }

    pub async fn get_async(&self, id: &str) -> Result<Wire, ApiError> {
        self.get_now_async(id).await
    }

    async fn version_of(&self, id: &str, version: Option<i64>) -> Result<(ArtifactRow, VersionRow), ApiError> {
        let row = self.found(id).await?;
        let n = version.unwrap_or(row.version);
        let Some(v) = self.ctx.service.artifact.version(id, n).await.map_err(q)? else {
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

    pub(super) async fn page_of_async(&self, row: &ArtifactRow, v: &VersionRow) -> Result<String, ApiError> {
        tokio::fs::read(self.storage.path_of(&v.attachment_id))
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

    pub async fn content_async(&self, id: &str, version: Option<i64>) -> Result<(ArtifactContent, ArtifactBody), ApiError> {
        let row = self.found(id).await?;
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
        let (row, v) = self.version_of(id, version).await?;
        let content = self.page_of_async(&row, &v).await?;
        Ok((ArtifactContent { version: v.version, content }, ArtifactBody::Html))
    }

    pub async fn file_async(&self, id: &str, version: i64) -> Option<PathBuf> {
        let row = self.ctx.service.artifact.get(id).await.ok()??;
        if row.body != "html" {
            return None;
        }
        self.ctx
            .service
            .artifact
            .version(id, version)
            .await
            .ok()?
            .map(|v| self.storage.path_of(&v.attachment_id))
    }

    pub(super) async fn keep_async(&self, bytes: Vec<u8>, title: &str) -> Result<String, ApiError> {
        Ok(self.storage.keep_async(bytes, format!("{title}.html"), "text/html".into()).await?.id)
    }

    pub(super) fn words(base: String, note: Option<&str>) -> String {
        match note {
            Some(note) => t("server.artifact.withNote", &[("said", base.into()), ("note", note.into())]),
            None => base,
        }
    }

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
            let at = self.ctx.now();
            let tx = self.ctx.service.begin_tx().await.map_err(q)?;
            let outcome: Result<Option<BlockAck>, ApiError> = async {
                self.ctx
                    .service
                    .artifact
                    .add_in_tx(
                        &tx,
                        NewArtifact {
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
                    self.ctx
                        .service
                        .artifact
                        .add_version_in_tx(
                            &tx,
                            NewVersion {
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
                    self.sync_html_to_collab_in_tx_async(&tx, &id, None, content, &meta).await?;
                }
                let fill_meta = collab::commit_meta_for_maker(maker, note.map(str::to_owned), at);
                if html {
                    Ok(None)
                } else {
                    self.fill_with_meta_in_tx_async(&tx, &id, content, &maker.by, &fill_meta).await
                }
            }
            .await;
            match outcome {
                Ok(ack) => {
                    self.ctx.service.commit_tx(tx).await.map_err(q)?;
                    ack
                }
                Err(err) => {
                    let _ = self.ctx.service.rollback_tx(tx).await;
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
                let _ = self.ctx.service.artifact.delete(&id).await;
                return Err(err);
            }
        };
        self.ctx.service.artifact.set_message_id(&id, &said.id).await.map_err(q)?;
        if html {
            self.ctx.service.artifact.set_version_message_id(&id, 1, &said.id).await.map_err(q)?;
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
        let at = self.ctx.now();
        let initial_name = if maker.by == USER_ID {
            t("server.channel.name.user", &[])
        } else {
            maker.by.clone()
        };

        {
            let tx = self.ctx.service.begin_tx().await.map_err(q)?;
            let outcome: Result<(), ApiError> = async {
                if is_default {
                    self.ctx.service.artifact.clear_default_design_system_in_tx(&tx, at).await.map_err(q)?;
                }
                self.ctx
                    .service
                    .artifact
                    .add_in_tx(
                        &tx,
                        NewArtifact {
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
                Ok(()) => self.ctx.service.commit_tx(tx).await.map_err(q)?,
                Err(err) => {
                    let _ = self.ctx.service.rollback_tx(tx).await;
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
            self.ctx.service.artifact.set_message_id(&id, &said.id).await.map_err(q)?;
        }

        self.get_now_async(&id).await
    }

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
        self.ctx
            .service
            .artifact
            .add(NewArtifact {
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
                created_at: self.ctx.now(),
            })
            .await
            .map_err(q)?;
        self.get_now_async(&id).await
    }

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
        let at = self.ctx.now();
        let by_name = if maker.by == USER_ID {
            t("server.channel.name.user", &[])
        } else {
            maker.by.clone()
        };
        let initial = {
            let tx = self.ctx.service.begin_tx().await.map_err(q)?;
            let outcome: Result<Option<BlockAck>, ApiError> = async {
                self.ctx
                    .service
                    .artifact
                    .add_in_tx(
                        &tx,
                        NewArtifact {
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
                self.fill_md_blocks_with_meta_in_tx_async(&tx, &id, imported.blocks, &maker.by, &fill_meta)
                    .await
            }
            .await;
            match outcome {
                Ok(ack) => {
                    self.ctx.service.commit_tx(tx).await.map_err(q)?;
                    ack
                }
                Err(err) => {
                    let _ = self.ctx.service.rollback_tx(tx).await;
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
                    let _ = self.ctx.service.artifact.delete(&id).await;
                    return Err(err);
                }
            };
            self.ctx.service.artifact.set_message_id(&id, &said.id).await.map_err(q)?;
        }

        if let Some(ack) = initial {
            self.publish_change(&id, &ack);
        }
        self.get_now_async(&id).await
    }

    pub async fn version_async(&self, maker: &Maker, req: &ArtifactVersionRequest) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock().await;
        self.version_locked_async(maker, req, None).await
    }

    pub async fn version_with_meta_async(&self, maker: &Maker, req: &ArtifactVersionRequest, meta: &CommitMeta) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock().await;
        self.version_locked_async(maker, req, Some(meta)).await
    }

    async fn version_locked_async(&self, maker: &Maker, req: &ArtifactVersionRequest, explicit_meta: Option<&CommitMeta>) -> Result<Wire, ApiError> {
        let row = self.found(&req.id).await?;
        let prior_version = if row.body == "html" && row.version > 0 {
            self.ctx.service.artifact.version(&row.id, row.version).await.map_err(q)?
        } else {
            None
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
            let at = self.ctx.now();
            let tx = self.ctx.service.begin_tx().await.map_err(q)?;
            let outcome: Result<(), ApiError> = async {
                self.ctx
                    .service
                    .artifact
                    .add_version_in_tx(
                        &tx,
                        NewVersion {
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
                self.ctx.service.artifact.set_version_in_tx(&tx, &row.id, next, at).await.map_err(q)?;
                let meta = explicit_meta
                    .cloned()
                    .unwrap_or_else(|| collab::commit_meta_for_maker(maker, note.map(str::to_owned), at));
                self.sync_html_to_collab_in_tx_async(&tx, &row.id, prior_html.as_deref(), &req.content, &meta)
                    .await
            }
            .await;
            match outcome {
                Ok(()) => self.ctx.service.commit_tx(tx).await.map_err(q)?,
                Err(err) => {
                    let _ = self.ctx.service.rollback_tx(tx).await;
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
        self.ctx.service.artifact.set_version_message_id(&row.id, next, &said.id).await.map_err(q)?;
        self.get_now_async(&row.id).await
    }

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
        let (row, v) = self.version_of(&req.id, Some(req.version)).await?;
        if row.body != "html" {
            return Err(refused(t("server.artifact.notHtml", &[("title", row.title.as_str().into())])));
        }
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

    pub async fn update_async(&self, req: &ArtifactUpdateRequest) -> Result<Wire, ApiError> {
        let _rows = self.rows.lock().await;
        let row = self.found(&req.id).await?;
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
        let at = self.ctx.now();
        let tx = self.ctx.service.begin_tx().await.map_err(q)?;
        let outcome: Result<(), ApiError> = async {
            if let Some(title) = &req.title {
                self.ctx.service.artifact.rename_in_tx(&tx, &req.id, title.trim(), at).await.map_err(q)?;
            }
            if let Some(display) = req.display {
                self.ctx
                    .service
                    .artifact
                    .set_display_in_tx(&tx, &req.id, display.as_str(), at)
                    .await
                    .map_err(q)?;
            }
            if let Some(is_default) = req.is_default {
                if is_default {
                    self.ctx.service.artifact.clear_default_design_system_in_tx(&tx, at).await.map_err(q)?;
                }
                self.ctx.service.artifact.set_default_in_tx(&tx, &req.id, is_default, at).await.map_err(q)?;
            }
            Ok(())
        }
        .await;
        match outcome {
            Ok(()) => self.ctx.service.commit_tx(tx).await.map_err(q)?,
            Err(err) => {
                let _ = self.ctx.service.rollback_tx(tx).await;
                return Err(err);
            }
        }
        self.get_now_async(&req.id).await
    }

    pub async fn preview_remove_async(&self, id: &str) -> Result<Preview, ApiError> {
        let row = self.found(id).await?;
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

    pub async fn remove_async(&self, id: &str) -> Result<(), ApiError> {
        let _rows = self.rows.lock().await;
        self.found(id).await?;
        self.ctx.service.artifact.delete(id).await.map_err(q)?;
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

    async fn resolve_issue_ref_async(&self, reference: &str) -> Result<String, ApiError> {
        let r = reference.trim();
        let number = r.strip_prefix('#').unwrap_or(r);
        if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
            let issues = self.ctx.service.issue.all().await.map_err(q)?;
            return issues
                .into_iter()
                .find(|i| i.number.to_string() == number)
                .map(|i| i.id)
                .ok_or_else(|| missing(t("server.issue.issueNumbered", &[("n", number.into())]), LookIn::Issue));
        }
        if let Some(session) = self.ctx.service.session.get(r).await.map_err(q)?
            && let Some(issue) = session.issue_id()
        {
            return Ok(issue.to_string());
        }
        Ok(r.to_string())
    }

    /// Dispatches all `Artifact*`, `Library*`, and `Media*` protocol endpoints for `router.rs`.
    #[allow(clippy::too_many_lines, reason = "domain router dispatch covering all artifact, library, and media endpoints")]
    pub(crate) async fn dispatch_endpoint_async(&self, caller: &CallerContext, id: EndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            // media
            EndpointId::MediaDialogueCreate => {
                let req: <ops::MediaDialogueCreate as Op>::Input = decode(payload)?;
                ok_json(self.media.create_speakers_for_caller_async(caller.caller, req).await?)
            }
            EndpointId::MediaVoiceDesignCreate => {
                let req: <ops::MediaVoiceDesignCreate as Op>::Input = decode(payload)?;
                ok_json(self.media.create_voice_design_for_caller_async(caller.caller, req).await?)
            }
            EndpointId::MediaCloneCreate => {
                let req: <ops::MediaCloneCreate as Op>::Input = decode(payload)?;
                ok_json(self.media.clone_voice_async(req).await?)
            }
            EndpointId::MediaTranscriptionCreate => {
                let req: <ops::MediaTranscriptionCreate as Op>::Input = decode(payload)?;
                ok_json(self.media.transcription_async(req).await?)
            }
            EndpointId::MediaAudioResume => {
                let req: <ops::MediaAudioResume as Op>::Input = decode(payload)?;
                ok_json(self.media.audio_resume_async(&req.id).await?)
            }
            EndpointId::MediaAudioPreviewCleanup => {
                let req: <ops::MediaAudioPreviewCleanup as Op>::Input = decode(payload)?;
                ok_json(self.media.preview_audio_cleanup_async(&req.id).await?)
            }
            EndpointId::MediaAudioCleanup => {
                let req: <ops::MediaAudioCleanup as Op>::Input = decode(payload)?;
                self.media.audio_cleanup_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::MediaImageCreate => {
                let req: <ops::MediaImageCreate as Op>::Input = decode(payload)?;
                ok_json(self.media.create_image_for_caller_async(caller.caller, req).await?)
            }
            EndpointId::MediaUnderstandingCreate => {
                let req: <ops::MediaUnderstandingCreate as Op>::Input = decode(payload)?;
                ok_json(self.media.understanding_async(req).await?)
            }
            EndpointId::MediaUnderstandingAuthorize => {
                let req: <ops::MediaUnderstandingAuthorize as Op>::Input = decode(payload)?;
                ok_json(self.media.authorize_understanding_async(req).await?)
            }
            EndpointId::MediaUnderstandingStart => {
                let req: <ops::MediaUnderstandingStart as Op>::Input = decode(payload)?;
                ok_json(self.media.start_understanding_for_caller_async(caller.caller, &req.id).await?)
            }
            EndpointId::MediaSpeechCreate => {
                let req: <ops::MediaSpeechCreate as Op>::Input = decode(payload)?;
                ok_json(self.media.create_speech_for_caller_async(caller.caller, req).await?)
            }
            EndpointId::MediaSpeechResume => {
                let req: <ops::MediaSpeechResume as Op>::Input = decode(payload)?;
                ok_json(self.media.resume_async(&req.id).await?)
            }
            EndpointId::MediaUnderstandingPreviewCleanup => {
                let req: <ops::MediaUnderstandingPreviewCleanup as Op>::Input = decode(payload)?;
                ok_json(self.media.preview_understanding_cleanup_async(&req.id).await?)
            }
            EndpointId::MediaUnderstandingCleanup => {
                let req: <ops::MediaUnderstandingCleanup as Op>::Input = decode(payload)?;
                self.media.understanding_cleanup_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::MediaJobGet => {
                let req: <ops::MediaJobGet as Op>::Input = decode(payload)?;
                ok_json(self.media.get_async(&req.id).await?)
            }
            EndpointId::MediaJobCancel => {
                let req: <ops::MediaJobCancel as Op>::Input = decode(payload)?;
                ok_json(self.media.cancel_async(&req.id).await?)
            }
            EndpointId::MediaJobPreviewRelease => {
                let req: <ops::MediaJobPreviewRelease as Op>::Input = decode(payload)?;
                ok_json(self.media.preview_release_async(&req.id).await?)
            }
            EndpointId::MediaJobRelease => {
                let req: <ops::MediaJobRelease as Op>::Input = decode(payload)?;
                self.media.release_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::MediaJobDownload => {
                let req: <ops::MediaJobDownload as Op>::Input = decode(payload)?;
                ok_json(self.media.retry_download_async(&req.id).await?)
            }
            EndpointId::MediaJobList => ok_json(self.media.list_async().await?),

            // library
            EndpointId::LibraryItemList => {
                let req: <ops::LibraryItemList as Op>::Input = decode(payload)?;
                ok_json(self.library.list_async(&req).await?)
            }
            EndpointId::LibraryItemAdd => {
                let req: <ops::LibraryItemAdd as Op>::Input = decode(payload)?;
                let by = match caller.caller {
                    Caller::User | Caller::Remote => AddedBy::User,
                    Caller::Orchestrator => AddedBy::Agent {
                        agent: caller.client.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
                        session: None,
                        dir: None,
                    },
                    Caller::Session => {
                        let sid = caller.client.as_ref().map(|c| c.id.clone()).unwrap_or_default();
                        let (agent, dir) = self
                            .ctx
                            .service
                            .session
                            .get(&sid)
                            .await
                            .ok()
                            .flatten()
                            .map(|h| (h.profile.unwrap_or_default(), h.cwd.map(PathBuf::from)))
                            .unwrap_or_default();
                        AddedBy::Agent {
                            agent,
                            session: (!sid.is_empty()).then_some(sid),
                            dir,
                        }
                    }
                };
                ok_json(self.library.add_async(&req, &by).await?)
            }
            EndpointId::LibraryItemDelete => {
                let req: <ops::LibraryItemDelete as Op>::Input = decode(payload)?;
                self.library.remove_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::LibraryItemPreviewDelete => {
                let req: <ops::LibraryItemPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.library.preview_remove_async(&req.id).await?)
            }

            // artifact
            EndpointId::ArtifactList => {
                let req: <ops::ArtifactList as Op>::Input = decode(payload)?;
                let issue = match req.issue.as_deref().filter(|i| !i.is_empty()) {
                    Some(raw) => Some(self.resolve_issue_ref_async(raw).await?),
                    None => None,
                };
                ok_json(
                    self.list_async(&ArtifactListRequest {
                        channel: req.channel.filter(|c| !c.is_empty()),
                        issue,
                        artifact_type: req.artifact_type,
                    })
                    .await?,
                )
            }
            EndpointId::ArtifactGet => {
                let req: <ops::ArtifactGet as Op>::Input = decode(payload)?;
                ok_json(self.get_async(&req.id).await?)
            }
            EndpointId::ArtifactContentGet => {
                let req: <ops::ArtifactContentGet as Op>::Input = decode(payload)?;
                ok_json(self.content_async(&req.id, req.version).await?.0)
            }
            EndpointId::ArtifactCreate => {
                let mut req: <ops::ArtifactCreate as Op>::Input = decode(payload)?;
                if let Some(raw) = req.issue.as_deref().filter(|i| !i.is_empty()) {
                    req.issue = Some(self.resolve_issue_ref_async(raw).await?);
                } else {
                    req.issue = None;
                }
                ok_json(self.create_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactVersionCreate => {
                let req: <ops::ArtifactVersionCreate as Op>::Input = decode(payload)?;
                ok_json(self.version_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactHtmlEdit => {
                let req: <ops::ArtifactHtmlEdit as Op>::Input = decode(payload)?;
                ok_json(self.html_edit_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactUpdate => {
                let req: <ops::ArtifactUpdate as Op>::Input = decode(payload)?;
                ok_json(self.update_async(&req).await?)
            }
            EndpointId::ArtifactDelete => {
                let req: <ops::ArtifactDelete as Op>::Input = decode(payload)?;
                self.remove_async(&req.id).await?;
                Ok(Value::Null)
            }
            EndpointId::ArtifactPreviewDelete => {
                let req: <ops::ArtifactPreviewDelete as Op>::Input = decode(payload)?;
                ok_json(self.preview_remove_async(&req.id).await?)
            }
            EndpointId::ArtifactBlockList => {
                let req: <ops::ArtifactBlockList as Op>::Input = decode(payload)?;
                ok_json(self.snapshot_async(&req.id).await?)
            }
            EndpointId::ArtifactSubmit => {
                let req: <ops::ArtifactSubmit as Op>::Input = decode(payload)?;
                ok_json(self.submit_async(&req.id, USER_ID, &req.batch_id, req.ops).await?)
            }
            EndpointId::ArtifactBlockCreate => {
                let req: <ops::ArtifactBlockCreate as Op>::Input = decode(payload)?;
                let body = BlockCreate {
                    r#type: req.r#type,
                    level: req.level,
                    checked: req.checked,
                    language: req.language,
                    text: req.text,
                    after_block: req.after_block,
                    parent_id: req.parent_id,
                };
                ok_json(self.insert_block_async(&req.id, USER_ID, &body).await?)
            }
            EndpointId::ArtifactBlockUpdate => {
                let req: <ops::ArtifactBlockUpdate as Op>::Input = decode(payload)?;
                let body = BlockUpdate {
                    block: req.block,
                    base_rev: req.base_rev,
                    text: req.text,
                    r#type: req.r#type,
                    level: req.level,
                    checked: req.checked,
                    language: req.language,
                };
                ok_json(self.update_block_async(&req.id, USER_ID, &body).await?)
            }
            EndpointId::ArtifactBlockDelete => {
                let req: <ops::ArtifactBlockDelete as Op>::Input = decode(payload)?;
                let body = BlockDelete { block: req.block };
                ok_json(self.delete_block_async(&req.id, USER_ID, &body).await?)
            }
            EndpointId::ArtifactBlockPreviewDelete => {
                let req: <ops::ArtifactBlockPreviewDelete as Op>::Input = decode(payload)?;
                let body = BlockDelete { block: req.block };
                ok_json(self.preview_delete_block_async(&req.id, &body).await?)
            }
            EndpointId::ArtifactSuggestionList => {
                let req: <ops::ArtifactSuggestionList as Op>::Input = decode(payload)?;
                ok_json(self.suggestions_async(&req.id).await?)
            }
            EndpointId::ArtifactSuggestionCreate => {
                let req: <ops::ArtifactSuggestionCreate as Op>::Input = decode(payload)?;
                let body = vibevalley_protocol::SuggestionCreate {
                    block: req.block,
                    base_rev: req.base_rev,
                    change: req.change,
                };
                ok_json(self.suggest_async(&req.id, USER_ID, &body).await?)
            }
            EndpointId::ArtifactSuggestionAccept => {
                let req: <ops::ArtifactSuggestionAccept as Op>::Input = decode(payload)?;
                ok_json(self.accept_suggestion_async(&req.id, &req.suggestion, USER_ID).await?)
            }
            EndpointId::ArtifactSuggestionReject => {
                let req: <ops::ArtifactSuggestionReject as Op>::Input = decode(payload)?;
                ok_json(self.reject_suggestion_async(&req.id, &req.suggestion, USER_ID).await?)
            }
            EndpointId::ArtifactMarkdownGet => {
                let req: <ops::ArtifactMarkdownGet as Op>::Input = decode(payload)?;
                let markdown = self.markdown_async(&req.id).await?;
                ok_json(ArtifactMarkdown { markdown })
            }
            EndpointId::ArtifactTypeList => ok_json(self.list_types_async().await?),
            EndpointId::ArtifactTypeRead => {
                let req: <ops::ArtifactTypeRead as Op>::Input = decode(payload)?;
                ok_json(self.read_type_async(&req).await?)
            }
            EndpointId::ArtifactEntryList => {
                let req: <ops::ArtifactEntryList as Op>::Input = decode(payload)?;
                ok_json(self.list_entries_async(&req).await?)
            }
            EndpointId::ArtifactEntryGet => {
                let req: <ops::ArtifactEntryGet as Op>::Input = decode(payload)?;
                ok_json(self.get_entry_async(&req).await?)
            }
            EndpointId::ArtifactEntryBatch => {
                let req: <ops::ArtifactEntryBatch as Op>::Input = decode(payload)?;
                ok_json(self.batch_entries_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactOutlineImport => {
                let mut req: <ops::ArtifactOutlineImport as Op>::Input = decode(payload)?;
                if let Some(raw) = req.issue.as_deref().filter(|i| !i.is_empty()) {
                    req.issue = Some(self.resolve_issue_ref_async(raw).await?);
                } else {
                    req.issue = None;
                }
                ok_json(self.import_outline_async(&Maker::user(), &req).await?)
            }
            EndpointId::ArtifactPresenceUpdate => {
                let req: <ops::ArtifactPresenceUpdate as Op>::Input = decode(payload)?;
                ok_json(self.update_presence_async(USER_ID, &req).await?)
            }
            EndpointId::ArtifactHistoryList => {
                let req: <ops::ArtifactHistoryList as Op>::Input = decode(payload)?;
                ok_json(self.history_list_async(&req).await?)
            }
            EndpointId::ArtifactHistoryPreview => {
                let req: <ops::ArtifactHistoryPreview as Op>::Input = decode(payload)?;
                ok_json(self.history_preview_async(&req).await?)
            }
            EndpointId::ArtifactHistoryRestore => {
                let req: <ops::ArtifactHistoryRestore as Op>::Input = decode(payload)?;
                ok_json(self.history_restore_async(&req).await?)
            }
            EndpointId::ArtifactHistoryFork => {
                let req: <ops::ArtifactHistoryFork as Op>::Input = decode(payload)?;
                ok_json(self.history_fork_async(&req).await?)
            }
            EndpointId::ArtifactHistoryUndoOrigin => {
                let req: <ops::ArtifactHistoryUndoOrigin as Op>::Input = decode(payload)?;
                ok_json(self.history_undo_origin_async(&req).await?)
            }
            EndpointId::ArtifactHistoryCompact => {
                let req: <ops::ArtifactHistoryCompact as Op>::Input = decode(payload)?;
                ok_json(self.history_compact_async(&req).await?)
            }
            other => Err(ApiError::new(
                BizCode::RouteNotFound,
                format!("artifact does not handle endpoint {}", other.op()),
            )),
        }
    }

    /// Dispatches native artifact endpoints (`ArtifactPage`, `ArtifactView`, `ArtifactEntryWriteProps`, `ArtifactTokensInspect`) for `router.rs`.
    pub(crate) async fn dispatch_native_async(&self, id: NativeEndpointId, payload: Value) -> Result<Value, ApiError> {
        match id {
            NativeEndpointId::ArtifactPage => {
                let req: <native_ops::ArtifactPage as Op>::Input = decode(payload)?;
                ok_json(self.page_async(&req).await?)
            }
            NativeEndpointId::ArtifactView => {
                let req: <native_ops::ArtifactView as Op>::Input = decode(payload)?;
                ok_json(self.view_async(&req).await?)
            }
            NativeEndpointId::ArtifactEntryWriteProps => {
                let req: <native_ops::ArtifactEntryWriteProps as Op>::Input = decode(payload)?;
                ok_json(self.write_entry_props_async(&Maker::user(), &req).await?)
            }
            NativeEndpointId::ArtifactTokensInspect => {
                let req: <native_ops::ArtifactTokensInspect as Op>::Input = decode(payload)?;
                ok_json(Self::inspect_tokens(&req))
            }
            other => Err(ApiError::new(
                BizCode::RouteNotFound,
                format!("artifact does not handle native endpoint {}", other.op()),
            )),
        }
    }

    /// Dispatches `artifact.*` live subscriptions for `router.rs`.
    pub(crate) async fn dispatch_subscription_async(self: &Arc<Self>, name: &str, payload: Value, sink: Sink) -> Result<(), ApiError> {
        match name {
            "artifact.follow" => {
                let p: <subscriptions::ArtifactFollow as Subscription>::Payload = decode(payload)?;
                self.follow_async(&p.id, p.after, sink).await
            }
            "artifact.entry.follow" => {
                let p: <subscriptions::ArtifactEntryFollow as Subscription>::Payload = decode(payload)?;
                self.follow_entries_async(&p.id, p.after, sink).await
            }
            "artifact.suggestion.follow" => {
                let p: <subscriptions::ArtifactSuggestionFollow as Subscription>::Payload = decode(payload)?;
                self.follow_suggestions_async(&p.id, sink).await
            }
            "artifact.presence.follow" => {
                let p: <subscriptions::ArtifactPresenceFollow as Subscription>::Payload = decode(payload)?;
                self.follow_presence_async(&p.id, sink).await
            }
            other => Err(ApiError::new(BizCode::RouteNotFound, format!("artifact does not handle subscription {other}"))),
        }
    }
}

fn display_of(s: &str) -> Option<ArtifactDisplay> {
    ArtifactDisplay::ALL.into_iter().find(|d| d.as_str() == s)
}

pub(super) fn artifact_type_of(s: &str) -> Option<ArtifactType> {
    ArtifactType::ALL.into_iter().find(|ty| ty.as_str() == s)
}

fn ok_json<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|e| ApiError::new(BizCode::InternalError, e.to_string()))
}

fn decode<T: DeserializeOwned>(payload: Value) -> Result<T, ApiError> {
    serde_path_to_error::deserialize(payload).map_err(|e| {
        let path = e.path().to_string();
        let problem = e.into_inner().to_string();
        let message = if path == "." || path.is_empty() {
            problem
        } else {
            format!("{path}: {problem}")
        };
        ApiError::new(BizCode::InvalidInput, message)
    })
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::io::Cursor;
    use std::path::Path;
    use std::sync::atomic::{AtomicI64, Ordering};

    use serde_json::json;
    use vibevalley_core::ManualClock;
    use vibevalley_protocol::{
        Actor, ArtifactEntryListRequest, ArtifactEntryWritePropsInput, ArtifactHistoryCompactRequest, ArtifactHistoryForkRequest, ArtifactHistoryListRequest,
        ArtifactHistoryPreviewRequest, ArtifactHistoryRestoreRequest, BlockOp, BlockOpStatus, BlockOpUpdateText, DesignPropValue, HtmlAnchor, HtmlAnchorKind,
        LibraryAddRequest, LibraryFileKind, LibraryListRequest, LibraryOriginKind, LibrarySort, MediaImageFormat, MediaImageRequest, MediaInputKind,
        MediaInputPhase, MediaInputRequest, MediaJob, MediaSource, MessageKind, SuggestionChange, SuggestionCreate, SuggestionStatus,
    };

    use super::*;
    use crate::context::{LiveState, Outbox, StateFeed, TaskGroup};
    use crate::service::Service;
    use crate::service::channel::{NewMessage, ParticipantRow};
    use crate::setting::SettingConfig;

    struct TestAnnounce {
        service: Arc<Service>,
        seq: AtomicI64,
    }

    impl TestAnnounce {
        async fn new_async(service: Arc<Service>) -> Arc<Self> {
            service
                .channel
                .upsert_participant(&ParticipantRow {
                    id: USER_ID.into(),
                    kind: "user".into(),
                    name: "User".into(),
                    agent_id: None,
                    home_id: None,
                    joined_at: 100,
                    left_at: None,
                })
                .await
                .unwrap();
            service.channel.create_channel("general", true, "general", None, None, 100).await.unwrap();
            Arc::new(Self {
                service,
                seq: AtomicI64::new(1),
            })
        }
    }

    impl ChannelAnnounce for TestAnnounce {
        fn place_exists(&self, id: &str) -> bool {
            id == "general"
        }

        fn orchestrator_in(&self, _channel: &str) -> String {
            "orch".into()
        }

        fn place_of_async<'a>(&'a self, _who: &'a str, target: &'a str) -> crate::BoxFuture<'a, Result<String, ApiError>> {
            let trimmed = target.trim();
            let out = if trimmed.is_empty() { "general".to_owned() } else { trimmed.to_owned() };
            Box::pin(async move { Ok(out) })
        }

        fn post_card_async<'a>(
            &'a self,
            _from: &'a str,
            ch: &'a str,
            text: &'a str,
            card: ArtifactCard,
            _run: Option<String>,
            _send_key: String,
        ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
            Box::pin(async move {
                let seq = self.seq.fetch_add(1, Ordering::SeqCst);
                let msg_id = format!("msg-{seq}");
                let num = self
                    .service
                    .channel
                    .insert_message(&NewMessage {
                        id: &msg_id,
                        channel_id: ch,
                        sender: USER_ID,
                        kind: "chat",
                        body: text,
                        meta: None,
                        system_code: None,
                        send_key: None,
                        at: 1000 + seq,
                        revision: seq,
                        reply_number: None,
                    })
                    .await
                    .unwrap();
                Ok(ChatMessage {
                    id: msg_id,
                    number: num,
                    channel: ch.to_owned(),
                    from: USER_ID.into(),
                    actor: Actor::User {
                        id: USER_ID.into(),
                        name: Some("User".into()),
                    },
                    name: "User".into(),
                    agent: None,
                    kind: MessageKind::Chat,
                    text: text.to_owned(),
                    mentions: vec![],
                    session: None,
                    run: None,
                    outcome: None,
                    spent: None,
                    spoken: false,
                    send_key: None,
                    at: 1000 + seq,
                    revision: seq,
                    reply_to: None,
                    edited: None,
                    deleted: None,
                    pinned: None,
                    reactions: vec![],
                    attachments: vec![],
                    embeds: vec![],
                    artifact: Some(card),
                    blocks: None,
                    view_context: None,
                })
            })
        }

        fn post_attachments_async<'a>(
            &'a self,
            _from: &'a str,
            _ch: &'a str,
            _text: &'a str,
            _attachments: Vec<String>,
            _send_key: String,
        ) -> crate::BoxFuture<'a, Result<ChatMessage, ApiError>> {
            unimplemented!()
        }
    }

    async fn verify_storage_and_artifact_on(home: &Path, service: Arc<Service>) {
        vibevalley_i18n::set_locale("zh");
        let clock = Arc::new(ManualClock::new(1_700_000_000_000));
        let (vendor, download) = crate::fake::moss::network();
        let ctx = Arc::new(Context::new(
            service.clone(),
            TaskGroup::new(),
            Arc::new(LiveState::new()),
            Arc::new(Outbox::new(service.clone())),
            Arc::new(StateFeed::new()),
            clock.clone(),
            vendor,
            download,
        ));
        let setting = Setting::open(SettingConfig {
            home: home.to_path_buf(),
            work_root: home.to_path_buf(),
            version: "0.1.0-test".into(),
            deepseek_api_key: String::new(),
        });
        let storage = Storage::open_async(home, ctx.clone()).await.unwrap();
        let announce = TestAnnounce::new_async(service.clone()).await;
        let manager = Manager::open_async(ctx.clone(), setting, storage.clone(), announce, None).await.unwrap();

        // 1. Storage attachments & media inputs
        let att_png = storage
            .keep_async(b"\x89PNG\r\n\x1a\ncontent-bytes".to_vec(), "100%_chart.png".into(), "image/png".into())
            .await
            .unwrap();
        let att_dup = storage
            .keep_async(b"\x89PNG\r\n\x1a\ncontent-bytes".to_vec(), "dup.png".into(), "image/png".into())
            .await
            .unwrap();
        assert_eq!(att_png.id, att_dup.id);
        let att_txt = storage
            .keep_async(b"plain text note".to_vec(), "notes.txt".into(), "text/plain".into())
            .await
            .unwrap();
        assert_eq!(
            storage
                .of_async(&[att_png.id.clone(), att_txt.id.clone(), att_png.id.clone()])
                .await
                .unwrap()
                .len(),
            2
        );
        let f_info = storage.file_async(&att_png.id).await.unwrap();
        assert_eq!(f_info.name, "100%_chart.png");

        let req = MediaInputRequest {
            kind: MediaInputKind::Image,
            mime: "image/png".into(),
            name: "sample.png".into(),
            size: 24,
        };
        let reserved = storage.create_input_async(&req).await.unwrap();
        let mut png_bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        png_bytes.resize(24, 0);
        let ready = storage.upload_input_async(&reserved.id, Box::new(Cursor::new(png_bytes))).await.unwrap();
        assert_eq!(ready.phase, MediaInputPhase::Ready);
        storage.pin_inputs_async(std::slice::from_ref(&ready.id), "job-pin-1").await.unwrap();
        assert!(!storage.get_input_async(&ready.id).await.unwrap().can_delete);
        clock.advance(Duration::from_millis(86_400_000));
        storage.sweep_inputs_async().await.unwrap();
        assert!(storage.input_content_async(&ready.id).await.is_ok());
        storage.release_input_pins_async("job-pin-1").await.unwrap();
        storage.sweep_inputs_async().await.unwrap();
        assert!(storage.list_inputs_async().await.unwrap().is_empty());

        // 2. Library
        let lib_png = manager
            .library
            .add_async(
                &LibraryAddRequest {
                    attachment: Some(att_png.id.clone()),
                    url: None,
                    path: None,
                    name: None,
                },
                &AddedBy::User,
            )
            .await
            .unwrap();
        assert_eq!(lib_png.attachment.id, att_png.id);
        manager
            .library
            .add_async(
                &LibraryAddRequest {
                    attachment: Some(att_txt.id.clone()),
                    url: None,
                    path: None,
                    name: None,
                },
                &AddedBy::User,
            )
            .await
            .unwrap();
        let like_escaped = manager
            .library
            .list_async(&LibraryListRequest {
                origin: Some(LibraryOriginKind::Uploaded),
                r#type: Some(LibraryFileKind::Image),
                text: Some("100%_".into()),
                sort: Some(LibrarySort::Name),
            })
            .await
            .unwrap();
        assert_eq!(like_escaped.len(), 1);
        assert_eq!(like_escaped[0].attachment.id, att_png.id);
        let others = manager
            .library
            .list_async(&LibraryListRequest {
                origin: None,
                r#type: Some(LibraryFileKind::Other),
                text: None,
                sort: Some(LibrarySort::Size),
            })
            .await
            .unwrap();
        assert_eq!(others.len(), 1);
        assert_eq!(others[0].attachment.id, att_txt.id);

        let gen_att = storage
            .keep_async(b"generated-art".to_vec(), "gen.png".into(), "image/png".into())
            .await
            .unwrap();
        let job: MediaJob = serde_json::from_value(json!({
            "kind":"image","id":"job-lib-1","prompt":"p","model":"m","connection":"c","revision":1,
            "source":{"kind":"user"},"phase":"ready","phaseText":"","problem":"","canCancel":false,
            "canRetryDownload":false,"createdAt":10,"updatedAt":20,"attachment":gen_att
        }))
        .unwrap();
        manager.library.record_made_async(std::slice::from_ref(&job)).await.unwrap();
        manager.library.record_made_async(std::slice::from_ref(&job)).await.unwrap();
        assert_eq!(
            manager
                .library
                .list_async(&LibraryListRequest {
                    origin: Some(LibraryOriginKind::Generated),
                    ..Default::default()
                })
                .await
                .unwrap()
                .len(),
            1
        );
        manager.library.remove_async(&gen_att.id).await.unwrap();
        manager.library.record_made_async(&[job]).await.unwrap();
        assert!(
            manager
                .library
                .list_async(&LibraryListRequest {
                    origin: Some(LibraryOriginKind::Generated),
                    ..Default::default()
                })
                .await
                .unwrap()
                .is_empty()
        );
        manager.library.remove_async(&att_txt.id).await.unwrap();

        // 3. Media job admission check
        let bad_img = manager
            .media
            .image_async(
                MediaImageRequest {
                    id: "bad-id".into(),
                    prompt: "a tree".into(),
                    format: MediaImageFormat::Text,
                    width: 512,
                    height: 512,
                    seed: None,
                    steps: None,
                    guidance: None,
                    negative_prompt: None,
                    enhance: false,
                    watermark: false,
                },
                MediaSource::User {},
            )
            .await;
        assert_eq!(bad_img.unwrap_err().biz_code, BizCode::ProviderRefused);

        // 4. Artifacts (blocks + html + store + collab/history + starters + html_edit + write_props)
        let maker = Maker::user();
        let doc = manager
            .create_async(
                &maker,
                &ArtifactRequest {
                    title: "Spec".into(),
                    kind: Some(ArtifactKind::Markdown),
                    artifact_type: Some(ArtifactType::Docs),
                    display: None,
                    content: Some("# Heading\n\nInitial paragraph\n".into()),
                    entries: None,
                    is_default: None,
                    announce: None,
                    note: Some("v0".into()),
                    channel: Some("general".into()),
                    issue: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(doc.body, ArtifactBody::Blocks);
        assert!(doc.said.is_some());
        let blocks = manager.live_blocks_async(&doc.id).await.unwrap();
        assert_eq!(blocks.len(), 2);
        let para_id = blocks[1].id.clone();

        let quoted = manager
            .quote_blocks_async(&[BlockRef {
                artifact_id: doc.id.clone(),
                block_id: para_id.clone(),
                rev: 1,
            }])
            .await;
        assert_eq!(quoted.len(), 1);
        assert_eq!(quoted[0].text.as_deref(), Some("Initial paragraph"));

        let inserted = manager
            .insert_block_async(
                &doc.id,
                USER_ID,
                &BlockCreate {
                    r#type: Some("paragraph".into()),
                    level: None,
                    checked: None,
                    language: None,
                    text: "Added block".into(),
                    after_block: Some(para_id.clone()),
                    parent_id: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(inserted.status, BlockOpStatus::Applied);

        let ack1 = manager
            .submit_async(
                &doc.id,
                USER_ID,
                "batch-idem-1",
                vec![BlockOp::UpdateText(BlockOpUpdateText {
                    block_id: para_id.clone(),
                    base_rev: 1,
                    text: spans_of(blocks[1].r#type, "Updated paragraph"),
                })],
            )
            .await
            .unwrap();
        let ack2 = manager
            .submit_async(
                &doc.id,
                USER_ID,
                "batch-idem-1",
                vec![BlockOp::UpdateText(BlockOpUpdateText {
                    block_id: para_id.clone(),
                    base_rev: 1,
                    text: spans_of(blocks[1].r#type, "Updated paragraph"),
                })],
            )
            .await
            .unwrap();
        assert_eq!(ack1.seq, ack2.seq);

        let sug = manager
            .suggest_async(
                &doc.id,
                "reviewer",
                &SuggestionCreate {
                    block: para_id.clone(),
                    base_rev: 2,
                    change: SuggestionChange {
                        text: Some(spans_of(blocks[1].r#type, "Suggested paragraph")),
                        r#type: None,
                        attrs: None,
                        unset: None,
                        delete: None,
                    },
                },
            )
            .await
            .unwrap();
        assert_eq!(sug.status, SuggestionStatus::Open);
        let accepted = manager.accept_suggestion_async(&doc.id, &sug.id, USER_ID).await.unwrap();
        assert_eq!(accepted.status, SuggestionStatus::Accepted);

        let hist = manager
            .history_list_async(&ArtifactHistoryListRequest {
                id: doc.id.clone(),
                limit: Some(10),
            })
            .await
            .unwrap();
        assert!(hist.len() >= 2);
        let prev_frontiers = hist.last().unwrap().frontiers.clone();
        let preview = manager
            .history_preview_async(&ArtifactHistoryPreviewRequest {
                id: doc.id.clone(),
                frontiers: prev_frontiers.clone(),
            })
            .await
            .unwrap();
        assert!(preview.markdown.is_some());
        let forked = manager
            .history_fork_async(&ArtifactHistoryForkRequest {
                id: doc.id.clone(),
                frontiers: prev_frontiers.clone(),
                title: Some("Forked Spec".into()),
                channel: None,
            })
            .await
            .unwrap();
        assert_eq!(forked.title, "Forked Spec");
        manager
            .history_restore_async(&ArtifactHistoryRestoreRequest {
                id: doc.id.clone(),
                frontiers: prev_frontiers,
                note: Some("restore".into()),
            })
            .await
            .unwrap();
        manager
            .history_compact_async(&ArtifactHistoryCompactRequest { id: doc.id.clone() })
            .await
            .unwrap();

        let slides = manager
            .create_async(
                &maker,
                &ArtifactRequest {
                    title: "Q4 Deck".into(),
                    kind: Some(ArtifactKind::Store),
                    artifact_type: Some(ArtifactType::Slides),
                    display: None,
                    content: None,
                    entries: None,
                    is_default: None,
                    announce: None,
                    note: None,
                    channel: None,
                    issue: None,
                },
            )
            .await
            .unwrap();
        assert_eq!(slides.seq, 1);
        let snap = manager
            .list_entries_async(&ArtifactEntryListRequest {
                id: slides.id.clone(),
                prefix: None,
                include_values: Some(true),
            })
            .await
            .unwrap();
        let slide = snap
            .entries
            .iter()
            .find(|e| e.path.starts_with("project/slides/") && e.path.ends_with(".html"))
            .unwrap();
        assert!(slide.value.as_deref().unwrap().contains("Q4 Deck"));
        let edited_art = manager
            .html_edit_async(
                &maker,
                &ArtifactHtmlEdit {
                    id: slides.id.clone(),
                    version: slides.seq,
                    path: Some(slide.path.clone()),
                    anchor: HtmlAnchor {
                        kind: HtmlAnchorKind::Text,
                        exact: "Q4 Deck".into(),
                        prefix: String::new(),
                        suffix: String::new(),
                    },
                    text: "Q1 Roadmap".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(edited_art.seq, 2);

        let design = manager
            .create_async(
                &maker,
                &ArtifactRequest {
                    title: "Hero".into(),
                    kind: Some(ArtifactKind::Store),
                    artifact_type: Some(ArtifactType::Design),
                    display: None,
                    content: None,
                    entries: Some(vec![ArtifactEntryWriteInput {
                        op: ArtifactEntryOp::Set,
                        path: "project/main.dc.html".into(),
                        kind: Some(ArtifactEntryKind::Text),
                        value: Some(
                            r#"<x-dc data-props='[{"name":"density","type":"select","options":["comfortable","compact"],"value":"comfortable"}]'><div>Body</div></x-dc>"#
                                .into(),
                        ),
                        from: None,
                        mime: None,
                        if_rev: None,
                    }]),
                    is_default: None,
                    announce: None,
                    note: None,
                    channel: None,
                    issue: None,
                },
            )
            .await
            .unwrap();
        let res = manager
            .write_entry_props_async(
                &maker,
                &ArtifactEntryWritePropsInput {
                    id: design.id.clone(),
                    path: "project/main.dc.html".into(),
                    values: BTreeMap::from([("density".into(), DesignPropValue::String("compact".into()))]),
                },
            )
            .await
            .unwrap();
        assert!(res.applied);
        let dc = manager
            .get_entry_async(&ArtifactEntryGetRequest {
                id: design.id,
                path: "project/main.dc.html".into(),
            })
            .await
            .unwrap();
        assert!(dc.value.as_deref().unwrap().contains(r#""value":"compact""#));

        manager.close();
        storage.close_async().await;
        ctx.shutdown(Duration::from_secs(2)).await;
    }

    #[tokio::test]
    async fn sqlite_storage_and_artifact_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let service = Service::open(dir.path()).await.unwrap();
        verify_storage_and_artifact_on(dir.path(), service.clone()).await;
        service.close().await;
    }
}
