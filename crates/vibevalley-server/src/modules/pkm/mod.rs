//! The user's notes (VibeValley `modules/pkm/pkm.ts`): Markdown outline
//! files in PARA folders under the vault's root, held in memory as
//! `vibevalley_pkm` pages, read again when a file changed on disk; remarks,
//! the full-text index and the undo log in `server.db`; the `pkm.*`
//! endpoints.
//!
//! VibeValley adds a file watcher: a change under the vault rescans it, so the
//! index follows an outside editor before anyone asks. Nothing is
//! published for it (the protocol has no live pkm event).

mod db;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use regex::Regex;
use serde::Serialize;
use serde::de::DeserializeOwned;
use sqlx::SqliteConnection;
use vibevalley_i18n::{list, t};
use vibevalley_pkm::{self as p, Node, Page, Tier};
use vibevalley_protocol::{
    ApiError, BizCode, PkmBlockOp, PkmClip, PkmClipRequest, PkmCluster, PkmClusterRequest, PkmComment, PkmCommentStatus, PkmMoveRequest, PkmPage,
    PkmPageRequest, PkmPageView, PkmProposal, PkmProposalRequest, PkmRadar, PkmRename, PkmRenameRequest, PkmResolveRequest, PkmScan, PkmSearchHit,
    PkmSearchRequest, PkmSource, PkmSourceUpdate, PkmUndo, PkmVault, USER_ID, ops,
};

use crate::base::{LookIn, missing};
use crate::{Hub, now};

/// Only the newest this many changes can be undone.
const CHANGE_KEEP: i64 = 200;

fn refused(text: impl Into<String>) -> ApiError {
    ApiError::new(BizCode::PkmRefused, text.into())
}

fn db_failed(e: sqlx::Error) -> ApiError {
    ApiError::new(BizCode::InternalError, format!("pkm: {e}"))
}

/// The same wire shape on both sides (`vibevalley_pkm`'s own copies of the
/// protocol types).
fn wire<A: Serialize, B: DeserializeOwned>(a: A) -> B {
    serde_json::from_value(serde_json::to_value(a).expect("JSON")).expect("the same wire shape")
}

fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

fn tier_of(t: vibevalley_protocol::PkmTier) -> Tier {
    wire(t)
}

fn tier_name(t: Tier) -> String {
    serde_json::to_value(t).ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
}

fn tokenize(text: &str) -> Vec<String> {
    vibevalley_memory::terms_list(text)
}

fn query_words(text: &str) -> Vec<String> {
    p::query_words(text, &tokenize)
}

fn search(vault: &[Page], req: &p::SearchRequest, ranked: Option<&HashMap<String, f64>>) -> Vec<p::SearchHit> {
    p::search(vault, req, ranked, &tokenize)
}

/// No page by that name: the closest few by title and words are named.
fn no_page(name: &str, vault: &[Page]) -> ApiError {
    let req = p::SearchRequest {
        text: Some(name.to_string()),
        limit: Some(10),
        ..Default::default()
    };
    let mut like: Vec<String> = vec![];
    for h in search(vault, &req, None) {
        if !like.contains(&h.page_title) {
            like.push(h.page_title);
        }
    }
    like.truncate(3);
    let text = if like.is_empty() {
        t("server.pkm.noPage", &[("page", name.into())])
    } else {
        t("server.pkm.noPageLike", &[("page", name.into()), ("like", list(&like).into())])
    };
    missing(text, LookIn::Pkm)
}

/// The props a new page writes: its title too when the file's name would
/// not say it.
fn titled(title: &str, mut props: BTreeMap<String, String>) -> BTreeMap<String, String> {
    if p::title_of_file(&p::file_name_of(title)) == title || props.get("title").is_some_and(|v| !v.is_empty()) {
        return props;
    }
    props.insert("title".into(), title.into());
    props
}

/// The blocks with the ids in `referenced` marked as written: the file says
/// their id from now on.
fn pin(nodes: &[Node], referenced: &HashSet<String>) -> Vec<Node> {
    nodes
        .iter()
        .map(|n| Node {
            explicit: n.explicit || referenced.contains(&n.id) || n.props.get("comment").is_some_and(|c| !c.is_empty()) || !p::spans_of(&n.body).is_empty(),
            children: pin(&n.children, referenced),
            ..n.clone()
        })
        .collect()
}

/// The blocks with one block's body and props replaced.
fn replaced(nodes: &[Node], id: &str, body: &str, props: &BTreeMap<String, String>) -> Vec<Node> {
    nodes
        .iter()
        .map(|n| {
            if n.id == id {
                Node {
                    body: body.into(),
                    props: props.clone(),
                    ..n.clone()
                }
            } else {
                Node {
                    children: replaced(&n.children, id, body, props),
                    ..n.clone()
                }
            }
        })
        .collect()
}

/// `map.set(page.slug, page)`: in its place when the slug is held, else at
/// the end.
fn set(pages: &mut Vec<Page>, page: Page) {
    match pages.iter_mut().find(|p| p.slug == page.slug) {
        Some(at) => *at = page,
        None => pages.push(page),
    }
}

fn mtime_at(path: &Path) -> Option<i64> {
    let m = std::fs::metadata(path).ok()?.modified().ok()?;
    let d = m.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(d.as_millis() as i64)
}

fn utf16_sorted(mut files: Vec<String>) -> Vec<String> {
    files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    files
}

/// Every `.md` file under `dir`, relative to `base`, without dot parts.
fn md_files_under(base: &Path, dir: &Path, out: &mut Vec<String>) -> std::io::Result<()> {
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        if kind.is_dir() {
            md_files_under(base, &path, out)?;
        } else if let Ok(rel) = path.strip_prefix(base) {
            let file = rel.to_string_lossy().replace('\\', "/");
            if file.ends_with(".md") && !file.split('/').any(|part| part.starts_with('.')) {
                out.push(file);
            }
        }
    }
    Ok(())
}

const TIERS: [Tier; 6] = [Tier::Inbox, Tier::Project, Tier::Area, Tier::Resource, Tier::Archive, Tier::Journal];

struct Inner {
    root: PathBuf,
    db: SqliteConnection,
    /// VibeValley's map in its order (slug-keyed, insertion order).
    pages: Vec<Page>,
    loaded: bool,
}

impl Inner {
    fn abs(&self, file: &str) -> PathBuf {
        self.root.join(file)
    }

    fn mtime_of(&self, file: &str) -> Option<i64> {
        mtime_at(&self.abs(file))
    }

    /// The remarks the user wrote in a page's file, kept so their status
    /// outlives a reading.
    fn keep_remarks(&mut self, page: &Page) -> Result<(), ApiError> {
        let at = now();
        for node in p::walk(&page.blocks) {
            for (i, span) in p::spans_of(&node.body).into_iter().enumerate() {
                db::keep_remark(
                    &mut self.db,
                    db::Remark {
                        id: format!("span:{}:{}", node.id, i + 1),
                        page: page.slug.clone(),
                        block: node.id.clone(),
                        span: Some(span.text),
                        author: USER_ID.into(),
                        body: span.remark,
                        created_at: at,
                    },
                )
                .map_err(db_failed)?;
            }
            if let Some(comment) = node.props.get("comment").filter(|c| !c.is_empty()) {
                db::keep_remark(
                    &mut self.db,
                    db::Remark {
                        id: format!("prop:{}", node.id),
                        page: page.slug.clone(),
                        block: node.id.clone(),
                        span: None,
                        author: USER_ID.into(),
                        body: comment.clone(),
                        created_at: at,
                    },
                )
                .map_err(db_failed)?;
            }
        }
        Ok(())
    }

    fn remarked(&mut self) -> Result<HashSet<String>, ApiError> {
        Ok(db::remarked_blocks(&mut self.db).map_err(db_failed)?.into_iter().collect())
    }

    /// A page's blocks in the full-text index, as they read now.
    fn indexed(&mut self, page: &Page) -> Result<(), ApiError> {
        let mut order: Vec<String> = Vec::new();
        let mut by_block: HashMap<String, Vec<String>> = HashMap::new();
        for b in p::flat_blocks(&page.blocks) {
            let next = tokenize(&format!("{}\n{}\n{}", page.title, b.path, b.body));
            let entry = by_block.entry(b.id.clone()).or_insert_with(|| {
                order.push(b.id.clone());
                Vec::new()
            });
            for term in next {
                if !entry.contains(&term) {
                    entry.push(term);
                }
            }
        }
        let rows: Vec<(String, String)> = order
            .into_iter()
            .filter_map(|id| by_block.remove(&id).map(|terms| (id, terms.join(" "))))
            .collect();
        db::set_page_terms(&mut self.db, &page.slug, &rows).map_err(db_failed)
    }

    fn unindexed(&mut self, slug: &str) -> Result<(), ApiError> {
        db::clear_page_terms(&mut self.db, slug).map_err(db_failed)
    }

    /// A file read as the page it is now; `was`: the page as held, whose ids
    /// carry over to the blocks that did not change.
    fn read_page(&mut self, file: &str, mtime: i64, was: Option<&Page>) -> Result<Page, ApiError> {
        let text = std::fs::read_to_string(self.abs(file)).map_err(|e| refused(e.to_string()))?;
        let read = p::parse(&text, file, mtime);
        if let Some(was) = was
            && read.sha == was.sha
        {
            return Ok(Page {
                file: file.into(),
                mtime,
                ..was.clone()
            });
        }
        let page = match was {
            Some(was) => p::carry_ids(was, &read),
            None => read,
        };
        self.keep_remarks(&page)?;
        self.indexed(&page)?;
        Ok(page)
    }

    fn markdown_files(&self) -> Vec<String> {
        let mut found = vec![];
        for tier in TIERS {
            let folder = p::tier_folder(tier);
            let dir = self.abs(folder);
            let read = std::fs::create_dir_all(&dir).and_then(|_| md_files_under(&self.root, &dir, &mut found));
            if let Err(e) = read {
                eprintln!("vibevalley-server: pkm: the {folder} folder could not be read; its pages are left out: {e}");
            }
        }
        utf16_sorted(found)
    }

    /// Every file read again that changed since it was read; pages whose
    /// file is gone are dropped.
    fn rescan(&mut self) -> Result<vibevalley_protocol::PkmScan, ApiError> {
        let files = self.markdown_files();
        let held = std::mem::take(&mut self.pages);
        let by_file: HashMap<&str, &Page> = held.iter().map(|p| (p.file.as_str(), p)).collect();
        let mut next: Vec<Page> = vec![];
        let mut updated = 0;
        for file in &files {
            let mtime = self.mtime_of(file).unwrap_or(0);
            let was = by_file.get(file.as_str()).copied();
            let page = match was {
                Some(w) if w.mtime == mtime => Some(w.clone()),
                _ => match self.read_page(file, mtime, was) {
                    Ok(page) => {
                        updated += 1;
                        Some(page)
                    }
                    Err(e) => {
                        eprintln!("vibevalley-server: pkm: {file} could not be read: {}", e.message);
                        was.cloned()
                    }
                },
            };
            if let Some(page) = page {
                set(&mut next, page);
            }
        }
        let on_disk: HashSet<&str> = files.iter().map(String::as_str).collect();
        for p in &held {
            let gone = !on_disk.contains(p.file.as_str()) || next.iter().find(|n| n.slug == p.slug).is_none_or(|n| n.file != p.file);
            if gone && !next.iter().any(|n| n.slug == p.slug) {
                self.unindexed(&p.slug)?;
            }
        }
        let removed = held.iter().filter(|p| !on_disk.contains(p.file.as_str())).count();
        self.pages = next;
        self.loaded = true;
        Ok(PkmScan {
            scanned: files.len() as i64,
            updated,
            removed: removed as i64,
        })
    }

    /// The index is made again from the files the first time: what it held
    /// may be of files changed since.
    fn ready(&mut self) -> Result<(), ApiError> {
        if self.loaded {
            return Ok(());
        }
        db::clear_all_terms(&mut self.db).map_err(db_failed)?;
        self.rescan().map(|_| ())
    }

    /// The page a name means, read again first when its file changed.
    fn fresh(&mut self, name: &str) -> Result<Page, ApiError> {
        self.ready()?;
        let Some(held) = p::page_of(&self.pages, name).cloned() else {
            return Err(no_page(name, &self.pages));
        };
        let Some(mtime) = self.mtime_of(&held.file) else {
            self.pages.retain(|p| p.slug != held.slug);
            self.unindexed(&held.slug)?;
            return Err(no_page(name, &self.pages));
        };
        if mtime == held.mtime {
            return Ok(held);
        }
        let page = self.read_page(&held.file, mtime, Some(&held))?;
        set(&mut self.pages, page.clone());
        Ok(page)
    }

    fn text_at(&self, file: &str) -> Option<String> {
        std::fs::read_to_string(self.abs(file)).ok()
    }

    /// Writes `page` as its file, says the change for undo and holds the
    /// page as written: the blocks whose id the file now says are written.
    fn write(&mut self, page: Page, what: &str, from: Option<&str>) -> Result<Page, ApiError> {
        let from = from.map(String::from).unwrap_or_else(|| page.file.clone());
        let mut others = self.pages.clone();
        set(&mut others, page.clone());
        let mut referenced = p::refs_into(&others);
        referenced.extend(self.remarked()?);
        let pinned = pin(&page.blocks, &referenced);
        let text = p::print(&page.props, &pinned, &referenced);
        let before = self.text_at(&from);
        let target = self.abs(&page.file);
        let tmp = self.abs(&format!("{}.tmp-{}", page.file, new_id()));
        let wrote = (|| {
            if let Some(dir) = target.parent() {
                std::fs::create_dir_all(dir)?;
            }
            std::fs::write(&tmp, &text)?;
            std::fs::rename(&tmp, &target)
        })();
        wrote.map_err(|e| refused(e.to_string()))?;
        if from != page.file
            && let Err(e) = std::fs::remove_file(self.abs(&from))
        {
            eprintln!("vibevalley-server: pkm: {from} could not be removed after the move: {e}");
        }
        let mtime = self.mtime_of(&page.file).unwrap_or(0);
        let written = Page {
            blocks: pinned,
            ..p::parse(&text, &page.file, mtime)
        };
        // Writing a block's id is not a change to undo.
        if what != "pin" {
            db::add_change(
                &mut self.db,
                db::NewChange {
                    at: now(),
                    what: what.to_owned(),
                    page: written.slug.clone(),
                    before_file: before.as_ref().map(|_| from.clone()),
                    after_file: written.file.clone(),
                    before_text: before,
                    after_text: text,
                },
            )
            .map_err(db_failed)?;
            db::trim_changes(&mut self.db, CHANGE_KEEP).map_err(db_failed)?;
        }
        self.keep_remarks(&written)?;
        let stale: Vec<String> = self
            .pages
            .iter()
            .filter(|p| (p.file == from || p.file == written.file) && p.slug != written.slug)
            .map(|p| p.slug.clone())
            .collect();
        for slug in &stale {
            self.unindexed(slug)?;
        }
        self.indexed(&written)?;
        self.pages.retain(|p| p.file != from && p.file != written.file);
        set(&mut self.pages, written.clone());
        // Refs into blocks whose ids their own files do not say yet.
        let targets: HashSet<String> = p::edges_of(&written.blocks).into_iter().filter_map(|e| e.target).collect();
        let unpinned: Vec<Page> = self
            .pages
            .iter()
            .filter(|p| p.slug != written.slug && p::walk(&p.blocks).iter().any(|n| targets.contains(&n.id) && !n.explicit))
            .cloned()
            .collect();
        for p in unpinned {
            self.write(p, "pin", None)?;
        }
        Ok(written)
    }

    fn view_of(&mut self, page: &Page) -> Result<PkmPageView, ApiError> {
        let ids: HashSet<&str> = p::walk(&page.blocks).into_iter().map(|n| n.id.as_str()).collect();
        let rows = db::open_comments(&mut self.db, Some(&page.slug)).map_err(db_failed)?;
        let linking = p::backlinks(&self.pages, &page.slug);
        let shown: Vec<(String, String)> = [&linking.projects, &linking.journals, &linking.areas, &linking.archives]
            .into_iter()
            .flatten()
            .map(|l| (l.block.clone(), l.body.clone()))
            .collect();
        let circular = |id: &str| t("server.pkm.circular", &[("id", id.into())]);
        let broken = |id: &str| t("server.pkm.brokenRef", &[("id", id.into())]);
        let words = p::RefWords {
            circular: &circular,
            broken: &broken,
        };
        Ok(PkmPageView {
            page: wire(p::wire_of(page)),
            transclusions: wire(p::transclusions(&self.pages, page, &words, &shown)),
            backlinks: wire(linking),
            comments: rows.into_iter().filter(|r| ids.contains(r.block.as_str())).collect(),
        })
    }

    /// The page with that title made (in its tier, with props and the
    /// outline), or the one there with props set and moved to the tier.
    fn upsert(&mut self, req: &PkmPageRequest, what: &str) -> Result<Page, ApiError> {
        let title = req.title.trim();
        if title.is_empty() {
            return Err(refused(t("server.pkm.noTitle", &[])));
        }
        self.ready()?;
        let more = req.props.clone().unwrap_or_default();
        if let Some(slug) = p::page_of(&self.pages, title).map(|p| p.slug.clone()) {
            let page = self.fresh(&slug)?;
            let tier = req.tier.map(tier_of).unwrap_or(page.tier);
            let file = if tier == page.tier {
                page.file.clone()
            } else {
                p::file_of(tier, &page.title)
            };
            let mut props = page.props.clone();
            props.extend(more);
            if page.props.contains_key("para") {
                props.insert("para".into(), tier_name(tier));
            }
            let from = page.file.clone();
            return self.write(Page { tier, file, props, ..page }, what, Some(&from));
        }
        let tier = req.tier.map(tier_of).unwrap_or(Tier::Inbox);
        let file = p::file_of(tier, title);
        let outline = p::parse(req.markdown.as_deref().unwrap_or(""), &file, 0);
        let mut props = outline.props.clone();
        props.extend(more);
        let page = Page {
            slug: p::slug_of(title),
            title: title.into(),
            tier,
            props: titled(title, props),
            ..outline
        };
        self.write(page, what, None)
    }

    fn mutate(&mut self, name: &str, ops: &[PkmBlockOp], what: &str) -> Result<Page, ApiError> {
        let page = self.fresh(name)?;
        let ops: Vec<p::BlockOp> = wire(ops);
        let blocks = p::apply_ops(&page.blocks, &ops, &mut new_id);
        self.write(Page { blocks, ..page }, what, None)
    }

    fn remove_file(&self, file: &str, why: &str) {
        if let Err(e) = std::fs::remove_file(self.abs(file)) {
            eprintln!("vibevalley-server: pkm: {file} could not be removed {why}: {e}");
        }
    }
}

/// The vault. Every read that may read a file again and every write go one
/// at a time: a page is read, changed and written whole.
pub struct Pkm {
    root: PathBuf,
    inner: Mutex<Inner>,
    watcher: Mutex<Option<vibevalley_files::Watcher>>,
}

fn inbox_tag() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"(?:^|\s)#inbox(?-u:\b)").expect("regex"))
}

impl Pkm {
    /// The vault at `root` (VibeValley `pkmDir`), its tables in
    /// `<home>/server.db`.
    pub fn open(home: &Path, root: &Path) -> Result<Arc<Pkm>, ApiError> {
        let mut conn = pollster::block_on(crate::base::open_sqlx_db(home)).map_err(db_failed)?;
        pollster::block_on(sqlx::raw_sql(db::SCHEMA).execute(&mut conn)).map_err(db_failed)?;
        Ok(Arc::new(Pkm {
            root: root.to_path_buf(),
            inner: Mutex::new(Inner {
                root: root.to_path_buf(),
                db: conn,
                pages: vec![],
                loaded: false,
            }),
            watcher: Mutex::new(None),
        }))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Rescans when a Markdown file under the vault changes (VibeValley's own;
    /// VibeValley reads again only when asked).
    pub fn watch(self: &Arc<Self>) {
        let _ = std::fs::create_dir_all(&self.root);
        let me = Arc::downgrade(self);
        let own = self.root.join(p::OWN_FOLDER);
        let watcher = vibevalley_files::Watcher::new(&self.root, move |changes| {
            let notes = changes
                .iter()
                .any(|c| c.path.extension().is_some_and(|x| x == "md") && !c.path.starts_with(&own) && !c.path.to_string_lossy().contains(".tmp-"));
            if !notes {
                return;
            }
            if let Some(me) = me.upgrade()
                && let Err(e) = me.scan()
            {
                eprintln!("vibevalley-server: pkm: the rescan after a change: {}", e.message);
            }
        });
        match watcher {
            Ok(w) => *self.watcher.lock().unwrap_or_else(|e| e.into_inner()) = Some(w),
            Err(e) => eprintln!("vibevalley-server: pkm: the vault is not watched: {e}"),
        }
    }

    /// Stops watching the vault.
    pub fn close(&self) {
        self.watcher.lock().unwrap_or_else(|e| e.into_inner()).take();
    }

    pub fn list(&self) -> Result<PkmVault, ApiError> {
        let mut g = self.lock();
        g.rescan()?;
        let mut all: Vec<p::PageSummary> = g.pages.iter().map(p::summary_of).collect();
        all.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.slug.cmp(&b.slug)));
        Ok(PkmVault {
            root: self.root.to_string_lossy().into_owned(),
            pages: wire(all),
        })
    }

    pub fn page(&self, name: &str) -> Result<PkmPageView, ApiError> {
        let mut g = self.lock();
        let page = g.fresh(name)?;
        g.view_of(&page)
    }

    pub fn save(&self, req: &PkmPageRequest) -> Result<PkmPage, ApiError> {
        Ok(wire(p::wire_of(&self.lock().upsert(req, "save")?)))
    }

    pub fn move_page(&self, req: &PkmMoveRequest) -> Result<PkmPage, ApiError> {
        let mut g = self.lock();
        let page = g.fresh(&req.page)?;
        let moved = g.upsert(
            &PkmPageRequest {
                title: page.title,
                tier: Some(req.tier),
                ..Default::default()
            },
            "move",
        )?;
        Ok(wire(p::wire_of(&moved)))
    }

    pub fn apply(&self, page: &str, ops: &[PkmBlockOp]) -> Result<PkmPage, ApiError> {
        Ok(wire(p::wire_of(&self.lock().mutate(page, ops, "apply")?)))
    }

    pub fn search(&self, req: &PkmSearchRequest) -> Result<Vec<PkmSearchHit>, ApiError> {
        let mut g = self.lock();
        g.ready()?;
        let req_p: p::SearchRequest = wire(req);
        let text = req.text.as_deref().unwrap_or("").trim();
        if text.is_empty() {
            return Ok(wire(search(&g.pages, &req_p, None)));
        }
        let ranked = db::match_terms(&mut g.db, &query_words(text)).map_err(db_failed)?;
        Ok(wire(search(&g.pages, &req_p, Some(&ranked))))
    }

    /// `text` read as an outline. `page`: at that page's end as it is; none:
    /// into today's journal as things to come back to, `by` named on the
    /// first.
    pub fn capture(&self, text: &str, by: Option<&str>, page: Option<&str>) -> Result<PkmPage, ApiError> {
        let blocks = p::outline_of(text, &mut new_id);
        if blocks.is_empty() {
            return Err(refused(t("server.pkm.noText", &[])));
        }
        let mut g = self.lock();
        if let Some(name) = page {
            let there = g.fresh(name)?;
            let mut all = there.blocks.clone();
            all.extend(blocks);
            return Ok(wire(p::wire_of(&g.write(Page { blocks: all, ..there }, "capture", None)?)));
        }
        let marked: Vec<Node> = blocks
            .into_iter()
            .enumerate()
            .map(|(i, b)| {
                let said = match by.filter(|b| i == 0 && !b.is_empty()) {
                    Some(name) => t("server.pkm.notedBy", &[("text", b.body.clone().into()), ("name", name.into())]),
                    None => b.body.clone(),
                };
                let body = if inbox_tag().is_match(&said) { said } else { format!("{said} #inbox") };
                Node {
                    marker: Some(b.marker.clone().unwrap_or_else(|| "LATER".into())),
                    body,
                    ..b
                }
            })
            .collect();
        let title = p::journal_title(now());
        g.ready()?;
        if let Some(slug) = p::page_of(&g.pages, &title).map(|p| p.slug.clone()) {
            let journal = g.fresh(&slug)?;
            let mut all = journal.blocks.clone();
            all.extend(marked);
            return Ok(wire(p::wire_of(&g.write(Page { blocks: all, ..journal }, "capture", None)?)));
        }
        let file = p::file_of(Tier::Journal, &title);
        let empty = p::parse("", &file, 0);
        let props = titled(&title, empty.props.clone());
        let page = Page {
            slug: p::slug_of(&title),
            title: title.clone(),
            tier: Tier::Journal,
            props,
            blocks: marked,
            ..empty
        };
        Ok(wire(p::wire_of(&g.write(page, "capture", None)?)))
    }

    pub fn source(&self, name: &str) -> Result<PkmSource, ApiError> {
        let mut g = self.lock();
        let page = g.fresh(name)?;
        let markdown = g.text_at(&page.file).unwrap_or_else(|| p::print(&page.props, &page.blocks, &HashSet::new()));
        Ok(PkmSource {
            page: page.slug,
            title: page.title,
            markdown,
            updated: page.mtime,
        })
    }

    pub fn source_update(&self, req: &PkmSourceUpdate) -> Result<PkmPage, ApiError> {
        let mut g = self.lock();
        let page = g.fresh(&req.page)?;
        // Written since it was read (the app, another editor): not overwritten.
        if page.mtime != req.updated {
            return Err(refused(t("server.pkm.changedSince", &[("page", page.title.clone().into())])));
        }
        let read = p::parse(&req.markdown, &page.file, 0);
        let props = titled(&page.title, read.props);
        Ok(wire(p::wire_of(&g.write(
            Page {
                props,
                blocks: read.blocks,
                ..page
            },
            "edit",
            None,
        )?)))
    }

    /// A day, `YYYY-MM-DD`.
    pub fn journal(&self, day: &str) -> Result<PkmPage, ApiError> {
        let title = p::journal_title_of(day);
        let mut g = self.lock();
        g.ready()?;
        if let Some(slug) = p::page_of(&g.pages, &title).map(|p| p.slug.clone()) {
            return Ok(wire(p::wire_of(&g.fresh(&slug)?)));
        }
        let req = PkmPageRequest {
            title,
            tier: Some(vibevalley_protocol::PkmTier::Journal),
            markdown: Some("- \n".into()),
            ..Default::default()
        };
        Ok(wire(p::wire_of(&g.upsert(&req, "journal")?)))
    }

    pub fn radar(&self, stale_days: Option<i64>) -> Result<PkmRadar, ApiError> {
        let mut g = self.lock();
        g.rescan()?;
        Ok(wire(p::radar(&g.pages, now(), stale_days.unwrap_or(14))))
    }

    pub fn comments(&self, page: Option<&str>) -> Result<Vec<PkmComment>, ApiError> {
        let mut g = self.lock();
        match page.filter(|p| !p.is_empty()) {
            None => db::open_comments(&mut g.db, None).map_err(db_failed),
            Some(name) => {
                let page = g.fresh(name)?;
                db::open_comments(&mut g.db, Some(&page.slug)).map_err(db_failed)
            }
        }
    }

    /// `by`: who proposes it, the user or an agent's id.
    pub fn suggest(&self, req: &PkmProposalRequest, by: &str) -> Result<PkmProposal, ApiError> {
        let mut g = self.lock();
        g.ready()?;
        let Some(at) = p::block_of(&g.pages, &req.block) else {
            return Err(missing(t("server.pkm.noBlock", &[("id", req.block.clone().into())]), LookIn::Pkm));
        };
        let (slug, held_node) = (at.page.slug.clone(), at.node.clone());
        let page = g.fresh(&slug)?;
        let node = p::find(&page.blocks, &req.block).cloned().unwrap_or(held_node);
        let kept = p::keep_links(&node.body, &req.suggested);
        let rationale = req.rationale.clone().unwrap_or_else(|| t("server.pkm.kept", &[]));
        let answering = match req.comment.as_deref() {
            Some(id) => db::comment(&mut g.db, id),
            None => db::newest_on(&mut g.db, &req.block),
        }
        .map_err(db_failed)?;
        if let Some(id) = &req.comment
            && answering.is_none()
        {
            return Err(missing(t("server.pkm.noComment", &[("id", id.clone().into())]), LookIn::Pkm));
        }
        let answers = answering
            .as_ref()
            .filter(|a| matches!(a.status, PkmCommentStatus::Open | PkmCommentStatus::Suggested))
            .map(|a| a.id.clone());
        let id = match answers {
            Some(id) => {
                db::suggest(&mut g.db, &id, &kept.text, &rationale).map_err(db_failed)?;
                id
            }
            None => {
                let id = new_id();
                db::add_suggestion(
                    &mut g.db,
                    db::Suggestion {
                        id: id.clone(),
                        page: page.slug.clone(),
                        block: req.block.clone(),
                        author: by.into(),
                        body: rationale.clone(),
                        suggested: Some(kept.text.clone()),
                        rationale: Some(rationale.clone()),
                        created_at: now(),
                    },
                )
                .map_err(db_failed)?;
                id
            }
        };
        // The block's id goes into its file, so the suggestion still finds it
        // once the file is read again.
        if !node.explicit {
            g.write(page, "pin", None)?;
        }
        let comment = db::comment(&mut g.db, &id)
            .map_err(db_failed)?
            .ok_or_else(|| ApiError::new(BizCode::InternalError, "a suggestion just written must read back"))?;
        Ok(PkmProposal {
            comment,
            kept: kept.kept,
            restored: kept.restored,
        })
    }

    pub fn resolve(&self, req: &PkmResolveRequest) -> Result<PkmPage, ApiError> {
        let mut g = self.lock();
        let no_comment = || missing(t("server.pkm.noComment", &[("id", req.id.clone().into())]), LookIn::Pkm);
        let row = db::comment(&mut g.db, &req.id).map_err(db_failed)?.ok_or_else(no_comment)?;
        g.ready()?;
        let slug = p::block_of(&g.pages, &row.block)
            .map(|at| at.page.slug.clone())
            .unwrap_or_else(|| row.page.clone());
        let page = g.fresh(&slug)?;
        let when = now();
        if !req.accept {
            db::resolve(&mut g.db, &row.id, "rejected", when).map_err(db_failed)?;
            return Ok(wire(p::wire_of(&page)));
        }
        let Some(node) = p::find(&page.blocks, &row.block) else {
            return Err(missing(t("server.pkm.noBlock", &[("id", row.block.clone().into())]), LookIn::Pkm));
        };
        let mut props = node.props.clone();
        props.remove("comment");
        let body = p::without_spans(row.suggested.as_deref().unwrap_or(&node.body));
        let blocks = replaced(&page.blocks, &row.block, &body, &props);
        let written = g.write(Page { blocks, ..page }, "resolve", None)?;
        db::resolve_on(&mut g.db, &row.block, when).map_err(db_failed)?;
        Ok(wire(p::wire_of(&written)))
    }

    pub fn clip(&self, req: &PkmClipRequest) -> Result<PkmClip, ApiError> {
        let url = req.url.trim().trim_end_matches('/').to_string();
        let mut g = self.lock();
        g.ready()?;
        let highlights = req.highlights.clone().unwrap_or_default();
        if let Some(there) = p::clip_of(&g.pages, &url).cloned() {
            let quotes: Vec<PkmBlockOp> = highlights
                .iter()
                .map(|h| PkmBlockOp::Append {
                    id: None,
                    body: format!("> {}", h.text),
                    marker: None,
                    priority: None,
                    props: Some(BTreeMap::from([("source-anchor".into(), format!("{}#{}", there.slug, h.anchor))])),
                })
                .collect();
            if !quotes.is_empty() {
                g.mutate(&there.slug, &quotes, "clip")?;
            }
            return Ok(PkmClip {
                duplicate: true,
                page: there.slug.clone(),
                snapshot: there.props.get("snapshot").cloned().unwrap_or_default(),
            });
        }
        let title = req.title.trim();
        if title.is_empty() {
            return Err(refused(t("server.pkm.noTitle", &[])));
        }
        let slug = p::slug_of(title);
        let name = p::file_name_of(title);
        let snapshot = format!("{}/snapshots/{}.raw.md", p::OWN_FOLDER, name.strip_suffix(".md").unwrap_or(&name));
        let wrote = std::fs::create_dir_all(g.abs(&format!("{}/snapshots", p::OWN_FOLDER))).and_then(|_| std::fs::write(g.abs(&snapshot), &req.content));
        wrote.map_err(|e| refused(e.to_string()))?;
        let gist = req.tldr.clone().unwrap_or_else(|| {
            static NL: OnceLock<Regex> = OnceLock::new();
            let head = vibevalley_core::rules::slice(&req.content, 0, Some(120));
            NL.get_or_init(|| Regex::new(r"\n+").expect("regex")).replace_all(&head, " ").into_owned()
        });
        let lines: Vec<String> = if highlights.is_empty() {
            vec![format!("  - {gist}\n    source-anchor:: {slug}#L1")]
        } else {
            highlights
                .iter()
                .map(|h| format!("  - > {}\n    source-anchor:: {slug}#{}", h.text, h.anchor))
                .collect()
        };
        let tags = req
            .tags
            .clone()
            .unwrap_or_else(|| vec!["clipped".into()])
            .into_iter()
            .map(|tag| if tag.starts_with("[[") { tag } else { format!("[[{tag}]]") })
            .collect::<Vec<_>>()
            .join(", ");
        let mut props = BTreeMap::from([
            ("material-type".to_string(), "article".to_string()),
            ("source-url".into(), url.clone()),
            ("read-status".into(), "unread".into()),
            ("clipped-at".into(), p::day_of(now())),
            ("snapshot".into(), snapshot.clone()),
            ("tags".into(), tags),
            ("tldr".into(), gist),
        ]);
        if let Some(author) = req.author.clone().filter(|a| !a.is_empty()) {
            props.insert("author".into(), author);
        }
        let page = g.upsert(
            &PkmPageRequest {
                title: title.into(),
                tier: Some(req.tier.unwrap_or(vibevalley_protocol::PkmTier::Inbox)),
                props: Some(props),
                markdown: Some(format!("- {}\n{}\n", t("server.pkm.clipHeading", &[]), lines.join("\n"))),
            },
            "clip",
        )?;
        Ok(PkmClip {
            duplicate: false,
            page: page.slug,
            snapshot,
        })
    }

    pub fn cluster(&self, req: &PkmClusterRequest) -> Result<PkmCluster, ApiError> {
        let mut g = self.lock();
        g.ready()?;
        let found: Vec<(String, String)> = p::clustered(&g.pages, &req.topic)
            .into_iter()
            .map(|(page, node)| (page.title.clone(), node.id.clone()))
            .collect();
        let lines: Vec<String> = found
            .iter()
            .map(|(title, id)| {
                format!(
                    "  - {}",
                    t("server.pkm.clusterLine", &[("title", title.clone().into()), ("id", id.clone().into())])
                )
            })
            .collect();
        let props = BTreeMap::from([
            ("tags".to_string(), format!("[[{}]]", req.topic)),
            (
                "tldr".to_string(),
                t("server.pkm.clusterTldr", &[("topic", req.topic.clone().into()), ("count", found.len().into())]),
            ),
        ]);
        let page = g.upsert(
            &PkmPageRequest {
                title: req.title.clone(),
                tier: Some(vibevalley_protocol::PkmTier::Resource),
                props: Some(props),
                markdown: Some(format!(
                    "- {}\n{}\n",
                    t("server.pkm.clusterHeading", &[("topic", req.topic.clone().into())]),
                    lines.join("\n")
                )),
            },
            "cluster",
        )?;
        Ok(PkmCluster {
            page: page.slug,
            blocks: found.into_iter().map(|(_, id)| id).collect(),
        })
    }

    pub fn rename(&self, req: &PkmRenameRequest) -> Result<PkmRename, ApiError> {
        let from = req.from.trim();
        let to = req.to.trim();
        if from.is_empty() || to.is_empty() {
            return Err(refused(t("server.pkm.noTitle", &[])));
        }
        if p::slug_of(from) == p::slug_of(to) {
            return Err(refused(t("server.pkm.sameName", &[])));
        }
        let mut g = self.lock();
        g.ready()?;
        let old = p::page_of(&g.pages, from).map(|p| p.slug.clone());
        let target = p::page_of(&g.pages, to).map(|p| p.slug.clone());
        let aliased = |mut props: BTreeMap<String, String>| {
            let mut names: Vec<String> = props
                .get("alias")
                .map(String::as_str)
                .unwrap_or("")
                .split(',')
                .map(|a| a.trim().to_string())
                .filter(|a| !a.is_empty())
                .collect();
            if !names.iter().any(|n| n == from) {
                names.push(from.to_string());
            }
            let mut seen = HashSet::new();
            names.retain(|n| seen.insert(n.clone()));
            props.insert("alias".into(), names.join(", "));
            props
        };
        match (old, target) {
            (None, None) => return Err(refused(t("server.pkm.noRename", &[("from", from.into()), ("to", to.into())]))),
            (Some(old), None) => {
                let page = g.fresh(&old)?;
                let file = p::file_of(page.tier, to);
                let mut props = page.props.clone();
                if props.get("title").is_some_and(|v| !v.is_empty()) {
                    props.insert("title".into(), to.into());
                }
                let props = aliased(titled(to, props));
                let was = page.slug.clone();
                let from_file = page.file.clone();
                g.write(
                    Page {
                        slug: p::slug_of(to),
                        title: to.into(),
                        file,
                        props,
                        ..page
                    },
                    "rename",
                    Some(&from_file),
                )?;
                db::move_page(&mut g.db, &was, &p::slug_of(to)).map_err(db_failed)?;
            }
            (old, Some(target)) => {
                let into = g.fresh(&target)?;
                let merged = match old.filter(|o| *o != into.slug) {
                    Some(o) => Some(g.fresh(&o)?),
                    None => None,
                };
                let mut blocks = into.blocks.clone();
                if let Some(m) = &merged {
                    blocks.extend(m.blocks.clone());
                }
                let props = aliased(into.props.clone());
                let into_slug = into.slug.clone();
                g.write(Page { props, blocks, ..into }, "rename", None)?;
                if let Some(m) = merged {
                    g.remove_file(&m.file, "after its page was merged");
                    g.pages.retain(|p| p.slug != m.slug);
                    g.unindexed(&m.slug)?;
                    db::move_page(&mut g.db, &m.slug, &into_slug).map_err(db_failed)?;
                }
            }
        }
        let relinked: Vec<Page> = g.pages.iter().filter_map(|page| p::rename_links(page, from, to)).collect();
        let slugs = relinked.iter().map(|p| p.slug.clone()).collect();
        for page in relinked {
            g.write(page, "rename", None)?;
        }
        Ok(PkmRename { pages: slugs, into: to.into() })
    }

    pub fn markdown(&self, name: &str) -> Result<String, ApiError> {
        let mut g = self.lock();
        let page = g.fresh(name)?;
        Ok(p::export_markdown(&g.pages, &page, &|tldr| t("server.pkm.summary", &[("tldr", tldr.into())])))
    }

    pub fn undo(&self) -> Result<PkmUndo, ApiError> {
        let mut g = self.lock();
        let Some(last) = db::last_change(&mut g.db).map_err(db_failed)? else {
            return Ok(PkmUndo {
                undone: false,
                page: None,
                what: None,
            });
        };
        if last.before_text.is_none() || last.before_file.as_ref().is_some_and(|b| *b != last.after_file) {
            g.remove_file(&last.after_file, "by the undo");
        }
        if let (Some(file), Some(text)) = (&last.before_file, &last.before_text) {
            let at = g.abs(file);
            let wrote = at.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|_| std::fs::write(&at, text));
            wrote.map_err(|e| refused(e.to_string()))?;
        }
        db::drop_change(&mut g.db, last.seq).map_err(db_failed)?;
        g.pages
            .retain(|p| p.file != last.after_file && last.before_file.as_deref() != Some(p.file.as_str()));
        g.unindexed(&last.page)?;
        g.rescan()?;
        Ok(PkmUndo {
            undone: true,
            page: Some(last.page),
            what: Some(last.what),
        })
    }

    pub fn scan(&self) -> Result<PkmScan, ApiError> {
        self.lock().rescan()
    }

    /// The pages as held, after a rescan (for the orchestrator's notes).
    pub fn pages(&self) -> Result<Vec<Page>, ApiError> {
        let mut g = self.lock();
        g.ready()?;
        Ok(g.pages.clone())
    }
}

/// The `pkm.*` endpoints.
pub fn install(hub: &Hub, pkm: Arc<Pkm>) {
    let k = pkm.clone();
    hub.on::<ops::PkmPageList>(move |_, ()| k.list());
    let k = pkm.clone();
    hub.on::<ops::PkmPageGet>(move |_, r| k.page(&r.page));
    let k = pkm.clone();
    hub.on::<ops::PkmPageSave>(move |_, r| k.save(&r));
    let k = pkm.clone();
    hub.on::<ops::PkmPageMove>(move |_, r| k.move_page(&r));
    let k = pkm.clone();
    hub.on::<ops::PkmPageRename>(move |_, r| k.rename(&r));
    let k = pkm.clone();
    hub.on::<ops::PkmPageExport>(move |_, r| {
        Ok(vibevalley_protocol::PkmMarkdown {
            markdown: k.markdown(&r.page)?,
        })
    });
    let k = pkm.clone();
    hub.on::<ops::PkmBlockApply>(move |_, r| k.apply(&r.page, &r.ops));
    let k = pkm.clone();
    hub.on::<ops::PkmSearch>(move |_, r| k.search(&r));
    let k = pkm.clone();
    hub.on::<ops::PkmCapture>(move |_, r| k.capture(&r.text, None, r.page.as_deref()));
    let k = pkm.clone();
    hub.on::<ops::PkmSourceGet>(move |_, r| k.source(&r.page));
    let k = pkm.clone();
    hub.on::<ops::PkmSourceUpdate>(move |_, r| k.source_update(&r));
    let k = pkm.clone();
    hub.on::<ops::PkmJournalOpen>(move |_, r| k.journal(&r.day));
    let k = pkm.clone();
    hub.on::<ops::PkmRadarGet>(move |_, r| k.radar(r.stale_days));
    let k = pkm.clone();
    hub.on::<ops::PkmCommentList>(move |_, r| k.comments(r.page.as_deref()));
    let k = pkm.clone();
    hub.on::<ops::PkmCommentSuggest>(move |_, r| k.suggest(&r, USER_ID));
    let k = pkm.clone();
    hub.on::<ops::PkmCommentResolve>(move |_, r| k.resolve(&r));
    let k = pkm.clone();
    hub.on::<ops::PkmClipCreate>(move |_, r| k.clip(&r));
    let k = pkm.clone();
    hub.on::<ops::PkmClusterCreate>(move |_, r| k.cluster(&r));
    let k = pkm.clone();
    hub.on::<ops::PkmUndo>(move |_, ()| k.undo());
    let k = pkm;
    hub.on::<ops::PkmScan>(move |_, ()| k.scan());
}
