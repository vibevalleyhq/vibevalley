//! Artifacts (VibeValley `modules/artifact/artifact.ts`): an html page kept
//! version by version (each version's bytes an attachment), or a page of
//! blocks written together (`blocks.rs`). Made with content, it is
//! announced in a channel with its card; the `artifact.*` endpoints, the
//! `artifact.follow` and `artifact.suggestion.follow` subscriptions, the
//! quotes of blocks a chat message carries, and VibeValley's `artifact.page`
//! (what `GET /api/v1/artifact/:id/:version` serves).

mod blocks;
mod db;

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use rusqlite::Connection;
use vibevalley_artifact::{artifact_headers, artifact_problem, html_check, html_edit, html_problem, shell_theme_of, with_shell};
use vibevalley_i18n::t;
use vibevalley_protocol::{
    ApiError, Artifact as Wire, ArtifactBody, ArtifactCard, ArtifactContent, ArtifactDisplay, ArtifactHtmlEdit, ArtifactListRequest, ArtifactMarkdown,
    ArtifactPage, ArtifactPageInput, ArtifactRequest, ArtifactSaid, ArtifactUpdateRequest, ArtifactVersion, ArtifactVersionRequest, BizCode, BlockAck,
    BlockCreate, BlockDelete, BlockRef, BlockSnapshot, BlockUpdate, Preview, QuotedBlock, USER_ID, native_ops, ops, subscriptions,
};

pub use blocks::spans_of;
use db::ArtifactRow;

use crate::base::{LookIn, missing, open_db};
use crate::modules::agent::Agents;
use crate::modules::attachment::Attachments;
use crate::modules::channel::{Chat, Made, Posting};
use crate::{Hub, lock, now};

/// How many the farm-wide list shows.
const LISTED_MAX: i64 = 200;

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::ArtifactRefused, text.into())
}

fn q(e: rusqlite::Error) -> ApiError {
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

pub struct Artifacts {
    db: Mutex<Connection>,
    /// One change of an artifact's row at a time: a version's number is the
    /// latest's plus one.
    rows: Mutex<()>,
    /// One batch of block ops at a time.
    batches: Mutex<()>,
    files: Arc<Attachments>,
    chat: Arc<Chat>,
    changes: Mutex<Vec<flume::Sender<Change>>>,
    suggestion_changes: Mutex<Vec<flume::Sender<SuggestionsNow>>>,
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
        let conn = open_db(home).map_err(q)?;
        conn.execute_batch(db::SCHEMA).map_err(q)?;
        let (stop_tx, stop_rx) = flume::bounded::<()>(0);
        let me = Arc::new(Artifacts {
            db: Mutex::new(conn),
            rows: Mutex::default(),
            batches: Mutex::default(),
            files,
            chat,
            changes: Mutex::default(),
            suggestion_changes: Mutex::default(),
            demo_on: AtomicBool::new(false),
            closed: AtomicBool::new(false),
            stop: Mutex::new(Some(stop_tx)),
            prune_thread: Mutex::new(None),
            demo_tick_ms: std::sync::atomic::AtomicU64::new(blocks::DEMO_TICK_MS),
        });
        if let Some(handle) = prune_daily(Arc::downgrade(&me), stop_rx) {
            *lock(&me.prune_thread) = Some(handle);
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
        let _ = lock(&self.stop).take();
        if let Some(handle) = lock(&self.prune_thread).take()
            && handle.thread().id() != std::thread::current().id()
        {
            let _ = handle.join();
        }
    }

    fn db(&self) -> MutexGuard<'_, Connection> {
        lock(&self.db)
    }

    fn found(&self, db: &Connection, id: &str) -> Result<ArtifactRow, ApiError> {
        db::artifact(db, id)
            .map_err(q)?
            .ok_or_else(|| missing(t("server.artifact.missing", &[("id", id.into())]), LookIn::Artifact))
    }

    fn assemble(&self, db: &Connection, row: ArtifactRow) -> Result<Wire, ApiError> {
        let versions = if row.body == "html" { db::versions(db, &row.id).map_err(q)? } else { vec![] };
        let channel = row.channel_id.clone().unwrap_or_default();
        Ok(Wire {
            id: row.id,
            title: row.title,
            body: if row.body == "html" { ArtifactBody::Html } else { ArtifactBody::Blocks },
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
        let db = self.db();
        let row = self.found(&db, id)?;
        self.assemble(&db, row)
    }

    pub fn list(&self, req: &ArtifactListRequest) -> Result<Vec<Wire>, ApiError> {
        let db = self.db();
        let channel = req.channel.as_deref().filter(|c| !c.is_empty());
        let rows = match (req.issue.as_deref().filter(|i| !i.is_empty()), channel) {
            (Some(issue), _) => db::artifacts_for_issue(&db, issue),
            (None, Some(channel)) => db::artifacts_in_channel(&db, channel),
            (None, None) => db::artifacts(&db, LISTED_MAX),
        }
        .map_err(q)?;
        // Both given: the issue's, in that channel.
        rows.into_iter()
            .filter(|r| channel.is_none_or(|c| r.channel_id.as_deref() == Some(c)))
            .map(|r| self.assemble(&db, r))
            .collect()
    }

    pub fn get(&self, id: &str) -> Result<Wire, ApiError> {
        self.get_now(id)
    }

    fn version_of(&self, db: &Connection, id: &str, version: Option<i64>) -> Result<(ArtifactRow, db::VersionRow), ApiError> {
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

    /// An html one's version as made; a blocks one's Markdown now, its version its seq.
    pub fn content(&self, id: &str, version: Option<i64>) -> Result<(ArtifactContent, ArtifactBody), ApiError> {
        let row = self.found(&self.db(), id)?;
        if row.body == "blocks" {
            return Ok((
                ArtifactContent {
                    version: row.seq,
                    content: self.markdown(id)?,
                },
                ArtifactBody::Blocks,
            ));
        }
        let (row, v) = self.version_of(&self.db(), id, version)?;
        let content = self.page_of(&row, &v)?;
        Ok((ArtifactContent { version: v.version, content }, ArtifactBody::Html))
    }

    /// An html version's file on disk; none when there is none.
    pub fn file(&self, id: &str, version: i64) -> Option<PathBuf> {
        let db = self.db();
        let row = db::artifact(&db, id).ok()??;
        if row.body != "html" {
            return None;
        }
        db::version(&db, id, version).ok()?.map(|v| self.files.path_of(&v.attachment_id))
    }

    /// `keep`: a version's bytes as an attachment.
    fn keep(&self, bytes: &[u8], title: &str) -> Result<String, ApiError> {
        Ok(self.files.keep(bytes, &format!("{title}.html"), "text/html")?.id)
    }

    fn words(base: String, note: Option<&str>) -> String {
        match note {
            Some(note) => t("server.artifact.withNote", &[("said", base.into()), ("note", note.into())]),
            None => base,
        }
    }

    /// Without content, an empty blocks one, not announced. With content, a
    /// hand-in: html kept whole, Markdown read into blocks, announced with
    /// its card.
    pub fn create(&self, maker: &Maker, req: &ArtifactRequest) -> Result<Wire, ApiError> {
        let _rows = lock(&self.rows);
        let trimmed = req.title.trim();
        let title = if trimmed.is_empty() {
            t("server.artifact.untitled", &[])
        } else {
            trimmed.to_string()
        };
        let Some(content) = &req.content else {
            let problem = artifact_problem(Some(&title), None, None);
            if !problem.is_empty() {
                return Err(refused(problem));
            }
            return self.start(maker, &title);
        };
        let kind = req.kind.as_str();
        let bytes = content.as_bytes();
        let mut problem = artifact_problem(Some(&req.title), Some(kind), Some(bytes.len()));
        if problem.is_empty() && kind == "html" {
            problem = html_problem(&html_check(content));
        }
        if !problem.is_empty() {
            return Err(refused(problem));
        }
        let html = kind == "html";
        if !html && req.display.is_some() {
            return Err(refused(t("server.artifact.displayHtmlOnly", &[])));
        }
        let display = html.then(|| req.display.unwrap_or(ArtifactDisplay::Page));
        let channel = self.chat.place_of(&maker.from, req.channel.as_deref().unwrap_or(""))?;
        let file = if html { self.keep(bytes, &title)? } else { String::new() };
        let id = new_id();
        let note = req.note.as_deref().map(str::trim).filter(|n| !n.is_empty());
        let version = if html { 1 } else { 0 };
        let card = ArtifactCard {
            id: id.clone(),
            title: title.clone(),
            body: if html { ArtifactBody::Html } else { ArtifactBody::Blocks },
            version,
            note: note.unwrap_or("").into(),
            display,
        };
        // Said first: the name it goes by is the one the channel knows its maker by.
        let (said, _) = self.chat.post(Posting {
            from: maker.from.clone(),
            channel,
            text: Self::words(t("server.artifact.made", &[("title", title.as_str().into())]), note),
            made: Some(Made::Card(card)),
            run: maker.run.clone(),
            ..Posting::default()
        })?;
        let at = now();
        {
            let db = self.db();
            db::add_artifact(
                &db,
                &db::NewArtifact {
                    id: &id,
                    title: &title,
                    body: if html { "html" } else { "blocks" },
                    display: display.map(ArtifactDisplay::as_str),
                    channel_id: Some(&said.channel),
                    issue: req.issue.as_deref(),
                    by_id: &maker.by,
                    by_name: &said.name,
                    version,
                    created_at: at,
                },
            )
            .map_err(q)?;
            db::artifact_said(&db, &id, &said.id).map_err(q)?;
            if html {
                db::add_version(
                    &db,
                    &db::NewVersion {
                        artifact_id: &id,
                        version: 1,
                        attachment_id: &file,
                        size: bytes.len() as i64,
                        note,
                        by_id: &maker.by,
                        by_name: &said.name,
                        created_at: at,
                    },
                )
                .map_err(q)?;
                db::version_announced(&db, &id, 1, &said.id).map_err(q)?;
            }
        }
        if !html {
            self.fill(&id, content, &maker.by)?;
        }
        self.get_now(&id)
    }

    /// An empty blocks one the user starts on the page.
    fn start(&self, maker: &Maker, title: &str) -> Result<Wire, ApiError> {
        let id = new_id();
        let name = if maker.by == USER_ID {
            t("server.channel.name.user", &[])
        } else {
            maker.by.clone()
        };
        let db = self.db();
        db::add_artifact(
            &db,
            &db::NewArtifact {
                id: &id,
                title,
                body: "blocks",
                display: None,
                channel_id: None,
                issue: None,
                by_id: &maker.by,
                by_name: &name,
                version: 0,
                created_at: now(),
            },
        )
        .map_err(q)?;
        let row = self.found(&db, &id)?;
        self.assemble(&db, row)
    }

    /// An html one's next version; a blocks one is refused.
    pub fn version(&self, maker: &Maker, req: &ArtifactVersionRequest) -> Result<Wire, ApiError> {
        let _rows = lock(&self.rows);
        self.version_locked(maker, req)
    }

    fn version_locked(&self, maker: &Maker, req: &ArtifactVersionRequest) -> Result<Wire, ApiError> {
        let row = self.found(&self.db(), &req.id)?;
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
        };
        // Announced where the first one was: its comments stay in one place.
        let (said, _) = self.chat.post(Posting {
            from: maker.from.clone(),
            channel: row.channel_id.clone().unwrap_or_default(),
            text: Self::words(
                t("server.artifact.versioned", &[("title", row.title.as_str().into()), ("version", next.into())]),
                note,
            ),
            made: Some(Made::Card(card)),
            run: maker.run.clone(),
            ..Posting::default()
        })?;
        let at = now();
        let db = self.db();
        db::add_version(
            &db,
            &db::NewVersion {
                artifact_id: &row.id,
                version: next,
                attachment_id: &file,
                size: bytes.len() as i64,
                note,
                by_id: &maker.by,
                by_name: &said.name,
                created_at: at,
            },
        )
        .map_err(q)?;
        db::version_announced(&db, &row.id, next, &said.id).map_err(q)?;
        db::artifact_versioned(&db, &row.id, next, at).map_err(q)?;
        let row = self.found(&db, &row.id)?;
        self.assemble(&db, row)
    }

    /// The user's words in place of some in the latest version, kept as
    /// the next version.
    pub fn html_edit(&self, maker: &Maker, req: &ArtifactHtmlEdit) -> Result<Wire, ApiError> {
        let _rows = lock(&self.rows);
        let (row, v) = self.version_of(&self.db(), &req.id, Some(req.version))?;
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
        )
    }

    /// Its title, or how an html one is shown.
    pub fn update(&self, req: &ArtifactUpdateRequest) -> Result<Wire, ApiError> {
        let _rows = lock(&self.rows);
        let db = self.db();
        let row = self.found(&db, &req.id)?;
        if let Some(title) = &req.title {
            let problem = artifact_problem(Some(title), None, None);
            if !problem.is_empty() {
                return Err(refused(problem));
            }
        }
        if req.display.is_some() && row.body != "html" {
            return Err(refused(t("server.artifact.displayHtmlOnly", &[])));
        }
        let at = now();
        if let Some(title) = &req.title {
            db::artifact_renamed(&db, &req.id, title.trim(), at).map_err(q)?;
        }
        if let Some(display) = req.display {
            db::artifact_shown(&db, &req.id, display.as_str(), at).map_err(q)?;
        }
        let row = self.found(&db, &req.id)?;
        self.assemble(&db, row)
    }

    pub fn preview_remove(&self, id: &str) -> Result<Preview, ApiError> {
        let row = self.found(&self.db(), id)?;
        let what = if row.body == "html" {
            t(
                "server.artifact.preview.remove",
                &[("title", row.title.as_str().into()), ("n", row.version.into())],
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

    /// It and its versions or blocks go; the versions' attachments stay.
    pub fn remove(&self, id: &str) -> Result<(), ApiError> {
        let _rows = lock(&self.rows);
        let db = self.db();
        self.found(&db, id)?;
        db::delete_artifact(&db, id).map_err(q)
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
                        text: b.map(|b| vibevalley_artifact::plain(&b.text)),
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
        Ok(ArtifactPage {
            content: with_shell(&page.content, shown.display.unwrap_or(ArtifactDisplay::Page), theme),
            headers,
        })
    }
}

fn display_of(s: &str) -> Option<ArtifactDisplay> {
    ArtifactDisplay::ALL.into_iter().find(|d| d.as_str() == s)
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
                    if let Err(e) = db::prune(&a.db(), before) {
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
fn issue_id(board: &crate::modules::issue::Board, reference: &str) -> Result<String, ApiError> {
    let r = reference.trim();
    let number = r.strip_prefix('#').unwrap_or(r);
    if !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()) {
        return board
            .issue(number)
            .map(|i| i.id)
            .ok_or_else(|| missing(t("server.issue.issueNumbered", &[("n", number.into())]), LookIn::Issue));
    }
    if let Some(issue) = board.session(r).and_then(|s| s.issue) {
        return Ok(issue);
    }
    Ok(r.to_string())
}

/// Every `artifact.*` endpoint and subscription, as the user calls them
/// (`gateway/http/handlers/artifact.ts`).
pub fn install(hub: &Hub, artifacts: Arc<Artifacts>, agents: Arc<Agents>, board: crate::modules::issue::Board) {
    let a = artifacts;
    hub.on::<ops::ArtifactList>({
        let (a, board) = (a.clone(), board.clone());
        move |_, r| {
            let issue = r.issue.as_deref().filter(|i| !i.is_empty()).map(|i| issue_id(&board, i)).transpose()?;
            a.list(&ArtifactListRequest {
                channel: r.channel.filter(|c| !c.is_empty()),
                issue,
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
    hub.on::<native_ops::ArtifactPage>({
        let a = a.clone();
        move |_, r| a.page(&r)
    });
    hub.on_subscription::<subscriptions::ArtifactFollow>({
        let a = a.clone();
        move |_, p, sink| a.follow(&p.id, p.after, sink)
    });
    hub.on_subscription::<subscriptions::ArtifactSuggestionFollow>(move |_, p, sink| a.follow_suggestions(&p.id, sink));
}
