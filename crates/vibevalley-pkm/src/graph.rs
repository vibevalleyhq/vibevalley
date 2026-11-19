//! The vault as a whole: lookups, links between pages, search, the radar,
//! export and renames. Ported from VibeValley `packages/pkm/src/graph.ts`
//! (with `flatBlocks` from outline.ts, `dayOf` from para.ts and
//! `plainText` from the protocol's rules); the wire shapes are VibeValley's.
//!
//! A vault is a slice of pages in the order VibeValley's map holds them:
//! first matches and ties follow it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde::{Deserialize, Serialize};

use crate::{Edge, Node, Page, Tier, block_ref, edges_of, find, journal_day, re, slug_of, tier_weight, walk, wiki_link, without_spans};

/// `PkmBlock`: one block of the flat outline the wire carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub depth: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<String>,
    pub body: String,
    pub props: BTreeMap<String, String>,
    /// The first lines of the blocks above it, joined by ` > `.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSummary {
    pub slug: String,
    pub title: String,
    pub tier: Tier,
    pub file: String,
    pub tldr: String,
    pub updated: i64,
    /// Blocks still to do.
    pub open: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
}

/// `PkmPage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WirePage {
    pub slug: String,
    pub title: String,
    pub tier: Tier,
    pub file: String,
    pub props: BTreeMap<String, String>,
    pub tldr: String,
    pub blocks: Vec<Block>,
    pub updated: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transclusion {
    pub block: String,
    pub found: bool,
    pub circular: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_title: Option<String>,
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Backlink {
    pub block: String,
    pub page: String,
    pub page_title: String,
    pub tier: Tier,
    pub path: String,
    pub body: String,
}

/// Backlinks by where the linking page sits in PARA.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Backlinks {
    pub projects: Vec<Backlink>,
    pub journals: Vec<Backlink>,
    /// Inbox, areas and resources.
    pub areas: Vec<Backlink>,
    pub archives: Vec<Backlink>,
}

/// `PkmSearchRequest`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub tier: Option<Tier>,
    #[serde(default)]
    pub marker: Option<String>,
    #[serde(default)]
    pub linked_to: Option<String>,
    #[serde(default)]
    pub limit: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub block: String,
    pub page: String,
    pub page_title: String,
    pub tier: Tier,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker: Option<String>,
    pub path: String,
    pub body: String,
    pub plain: String,
    pub score: f64,
    pub children: Vec<Block>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StaleProject {
    pub slug: String,
    pub title: String,
    pub days: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline: Option<String>,
    pub todo: usize,
    pub doing: usize,
    pub done: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Overdue {
    pub block: String,
    pub page: String,
    pub body: String,
    pub plain: String,
    pub deadline: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Radar {
    pub inbox: usize,
    pub stale: Vec<StaleProject>,
    pub overdue: Vec<Overdue>,
}

/// A block and where it is.
#[derive(Debug, Clone, PartialEq)]
pub struct Located<'a> {
    pub page: &'a Page,
    pub node: &'a Node,
    pub block: Block,
}

/// What an unreadable `((ref))` reads as.
pub struct RefWords<'a> {
    pub circular: &'a dyn Fn(&str) -> String,
    pub broken: &'a dyn Fn(&str) -> String,
}

// ---- outline.ts, para.ts, rules/plain.ts -------------------------------------

fn head_of(body: &str) -> String {
    static R: OnceLock<Regex> = OnceLock::new();
    let first = body.split('\n').next().unwrap_or("");
    re(&R, r"^#+\s*").replace(first, "").trim().to_string()
}

/// The outline as the wire has it: in order, each with its parent and the
/// path of first lines above it.
pub fn flat_blocks(nodes: &[Node]) -> Vec<Block> {
    fn go(list: &[Node], parent: Option<&str>, path: &[String], out: &mut Vec<Block>) {
        for node in list {
            out.push(Block {
                id: node.id.clone(),
                parent: parent.filter(|p| !p.is_empty()).map(str::to_string),
                depth: node.depth,
                marker: node.marker.clone(),
                priority: node.priority.clone(),
                body: node.body.clone(),
                props: node.props.clone(),
                path: path.join(" > "),
            });
            let mut deeper = path.to_vec();
            deeper.push(head_of(&node.body));
            go(&node.children, Some(&node.id), &deeper, out);
        }
    }
    let mut out = vec![];
    go(nodes, None, &[], &mut out);
    out
}

/// The day of `at` (ms) in the machine's time zone, as `deadline::` values
/// are written: 2026-11-03.
pub fn day_of(at: i64) -> String {
    let zone = jiff::tz::TimeZone::system();
    match jiff::Timestamp::from_millisecond(at) {
        Ok(t) => t.to_zoned_datetime(zone).strftime("%Y-%m-%d").to_string(),
        Err(_) => String::new(),
    }
}

/// A journal page's title for a day, in the machine's time zone:
/// `2026_11_03`, as Logseq names them.
pub fn journal_title(at: i64) -> String {
    day_of(at).replace('-', "_")
}

/// `2026-11-03` → `2026_11_03`, as [`journal_title`] names today's.
pub fn journal_title_of(day: &str) -> String {
    day.replace('-', "_")
}

/// `**b**`, `__b__`, `*i*`, `_i_`, `~~s~~` → their words, leftmost first, as
/// `/(\*\*|__|\*|_|~~)(.+?)\1/g` does (the regex crate has no backreference).
fn without_emphasis(text: &str) -> String {
    const MARKS: [&str; 5] = ["**", "__", "*", "_", "~~"];
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    'scan: while i < text.len() {
        let rest = &text[i..];
        for mark in MARKS {
            if !rest.starts_with(mark) {
                continue;
            }
            let after = &rest[mark.len()..];
            // `.+?`: at least one character, never a line break.
            let Some(first) = after.chars().next() else { continue };
            if first == '\n' || first == '\r' {
                continue;
            }
            // The nearest closing mark; a line break before it fails the
            // match, as `.` stops at one.
            let from = first.len_utf8();
            if let Some(at) = after[from..].find(mark) {
                let inner = &after[..from + at];
                if !inner.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
                    out.push_str(inner);
                    i += mark.len() + inner.len() + mark.len();
                    continue 'scan;
                }
            }
        }
        let c = rest.chars().next().expect("non-empty");
        out.push(c);
        i += c.len_utf8();
    }
    out
}

/// Markdown as one line of plain words (VibeValley's `plainText`).
pub fn plain_text(markdown: &str) -> String {
    static FENCE: OnceLock<Regex> = OnceLock::new();
    static CODE: OnceLock<Regex> = OnceLock::new();
    static LINK: OnceLock<Regex> = OnceLock::new();
    static LEAD: OnceLock<Regex> = OnceLock::new();
    static SPACE: OnceLock<Regex> = OnceLock::new();
    let text = re(&FENCE, r"(?s)```.*?```").replace_all(markdown, " ");
    let text = re(&CODE, r"`([^`]*)`").replace_all(&text, "$1");
    let text = re(&LINK, r"!?\[([^\]]*)\]\([^)]*\)").replace_all(&text, "$1");
    let text = re(&LEAD, r"(?m)^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+").replace_all(&text, "");
    let text = without_emphasis(&text).replace('|', " ");
    re(&SPACE, r"\s+").replace_all(&text, " ").trim().to_string()
}

// ---- graph.ts ------------------------------------------------------------------

/// The page a name means: its slug, its title in any case, or one of its
/// `alias::` names.
pub fn page_of<'a>(vault: &'a [Page], name: &str) -> Option<&'a Page> {
    let slug = slug_of(name);
    if let Some(page) = vault.iter().find(|p| p.slug == slug) {
        return Some(page);
    }
    let lower = name.trim().to_lowercase();
    vault.iter().find(|page| {
        if page.title.to_lowercase() == lower {
            return true;
        }
        let aliases: HashSet<String> = page
            .props
            .get("alias")
            .map(String::as_str)
            .unwrap_or("")
            .split(',')
            .map(|a| a.trim().to_lowercase())
            .collect();
        aliases.contains(&lower) || aliases.contains(&slug)
    })
}

pub fn block_of<'a>(vault: &'a [Page], id: &str) -> Option<Located<'a>> {
    vault.iter().find_map(|page| {
        let node = find(&page.blocks, id)?;
        let block = flat_blocks(&page.blocks).into_iter().find(|b| b.id == id)?;
        Some(Located { page, node, block })
    })
}

fn all_edges(vault: &[Page]) -> Vec<(&Page, Vec<Edge>)> {
    vault.iter().map(|page| (page, edges_of(&page.blocks))).collect()
}

/// The ids some block refers to with `((id))`: their files keep an `id::`
/// line so the ref survives a reading.
pub fn refs_into(vault: &[Page]) -> HashSet<String> {
    all_edges(vault)
        .into_iter()
        .flat_map(|(_, edges)| edges.into_iter().filter_map(|e| e.target))
        .collect()
}

/// Each `((id))` on the page as it reads now, and in the blocks shown with
/// it (its backlinks).
pub fn transclusions(vault: &[Page], page: &Page, words: &RefWords, shown_with: &[(String, String)]) -> Vec<Transclusion> {
    fn read_out(vault: &[Page], words: &RefWords, id: &str, seen: &HashSet<String>, depth: usize) -> Transclusion {
        if seen.contains(id) || depth >= 2 {
            return Transclusion {
                block: id.into(),
                found: true,
                circular: true,
                page: None,
                page_title: None,
                body: (words.circular)(id),
            };
        }
        let Some(at) = block_of(vault, id) else {
            return Transclusion {
                block: id.into(),
                found: false,
                circular: false,
                page: None,
                page_title: None,
                body: (words.broken)(id),
            };
        };
        let mut next = seen.clone();
        next.insert(id.to_string());
        let body = block_ref()
            .replace_all(&at.node.body, |c: &Captures| read_out(vault, words, &c[1], &next, depth + 1).body)
            .into_owned();
        Transclusion {
            block: id.into(),
            found: true,
            circular: false,
            page: Some(at.page.slug.clone()),
            page_title: Some(at.page.title.clone()),
            body,
        }
    }
    let mut order: Vec<String> = vec![];
    let mut out: HashMap<String, Transclusion> = HashMap::new();
    let mut sources: Vec<(String, String)> = walk(&page.blocks).into_iter().map(|n| (n.id.clone(), n.body.clone())).collect();
    sources.extend(shown_with.iter().cloned());
    for (block, body) in sources {
        for m in block_ref().captures_iter(&body) {
            let id = m[1].to_string();
            if !out.contains_key(&id) {
                let seen = HashSet::from([block.clone()]);
                out.insert(id.clone(), read_out(vault, words, &id, &seen, 0));
                order.push(id);
            }
        }
    }
    order.into_iter().filter_map(|id| out.remove(&id)).collect()
}

/// Pages newest first; ties keep the vault's order.
fn newest_first(vault: &[Page]) -> Vec<&Page> {
    let mut pages: Vec<&Page> = vault.iter().collect();
    pages.sort_by_key(|p| std::cmp::Reverse(p.mtime));
    pages
}

/// The blocks of other pages that link to `slug`, newest page first, by
/// where their page is in PARA.
pub fn backlinks(vault: &[Page], slug: &str) -> Backlinks {
    let mut groups = Backlinks::default();
    for page in newest_first(vault) {
        if page.slug == slug {
            continue;
        }
        let ids: HashSet<String> = edges_of(&page.blocks)
            .into_iter()
            .filter(|e| e.page.as_deref() == Some(slug))
            .map(|e| e.block)
            .collect();
        if ids.is_empty() {
            continue;
        }
        for block in flat_blocks(&page.blocks) {
            if !ids.contains(&block.id) {
                continue;
            }
            let link = Backlink {
                block: block.id.clone(),
                page: page.slug.clone(),
                page_title: page.title.clone(),
                tier: page.tier,
                path: plain_path(vault, &block.path),
                body: block.body.clone(),
            };
            match page.tier {
                Tier::Project => groups.projects.push(link),
                Tier::Journal => groups.journals.push(link),
                Tier::Archive => groups.archives.push(link),
                Tier::Inbox | Tier::Area | Tier::Resource => groups.areas.push(link),
            }
        }
    }
    groups
}

fn is_open(marker: Option<&str>) -> bool {
    matches!(marker, Some("TODO" | "DOING" | "NOW" | "LATER" | "WAITING"))
}

pub fn summary_of(page: &Page) -> PageSummary {
    PageSummary {
        slug: page.slug.clone(),
        title: page.title.clone(),
        tier: page.tier,
        file: page.file.clone(),
        tldr: page.props.get("tldr").cloned().unwrap_or_default(),
        updated: page.mtime,
        open: walk(&page.blocks).into_iter().filter(|n| is_open(n.marker.as_deref())).count(),
        day: if page.tier == Tier::Journal { journal_day(&page.file) } else { None },
    }
}

fn plain_path(vault: &[Page], path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    path.split(" > ").map(|step| plain_of(vault, step)).collect::<Vec<_>>().join(" > ")
}

/// A block's text as one line: a `((ref))` read out one level only (a
/// nested one as …), a `[[link]]` as its words.
pub fn plain_of(vault: &[Page], body: &str) -> String {
    let refs_out = block_ref().replace_all(body, |c: &Captures| match block_of(vault, &c[1]) {
        Some(at) => block_ref().replace_all(&at.node.body, "…").into_owned(),
        None => "…".to_string(),
    });
    let links_out = wiki_link()
        .replace_all(&without_spans(&refs_out), |c: &Captures| {
            c[1].split('|').next_back().unwrap_or(&c[1]).trim().to_string()
        })
        .into_owned();
    plain_text(&links_out)
}

pub fn wire_of(page: &Page) -> WirePage {
    WirePage {
        slug: page.slug.clone(),
        title: page.title.clone(),
        tier: page.tier,
        file: page.file.clone(),
        props: page.props.clone(),
        tldr: page.props.get("tldr").cloned().unwrap_or_default(),
        blocks: flat_blocks(&page.blocks),
        updated: page.mtime,
    }
}

/// The default tokenizer: runs of two or more Han characters, and Latin
/// words (with `_ . - /` inside), lowercased.
pub fn default_tokenize(text: &str) -> Vec<String> {
    static R: OnceLock<Regex> = OnceLock::new();
    let lower = text.to_lowercase();
    re(&R, r"\p{Han}{2,}|[a-z0-9_][a-z0-9_.\-/]*[a-z0-9_]")
        .find_iter(&lower)
        .map(|m| m.as_str().to_string())
        .collect()
}

/// The words a search matches on: the whole query's space-separated words
/// and the words the tokenizer cuts it into.
pub fn query_words(text: &str, tokenize: &dyn Fn(&str) -> Vec<String>) -> Vec<String> {
    let lower = text.trim().to_lowercase();
    let mut seen = HashSet::new();
    lower
        .split(char::is_whitespace)
        .map(str::to_string)
        .chain(tokenize(text))
        .filter(|w| !w.is_empty() && seen.insert(w.clone()))
        .collect()
}

/// The blocks that match, best first, times the tier's weight. `ranked`
/// (block id → score from a full-text index) replaces word counting.
pub fn search(vault: &[Page], req: &SearchRequest, ranked: Option<&HashMap<String, f64>>, tokenize: &dyn Fn(&str) -> Vec<String>) -> Vec<SearchHit> {
    let limit = req.limit.filter(|l| *l > 0).unwrap_or(10) as usize;
    let text = req.text.as_deref().unwrap_or("").trim();
    let words = if text.is_empty() { vec![] } else { query_words(text, tokenize) };
    let whole = text.to_lowercase();
    let linked = req.linked_to.as_deref().map(slug_of);
    let mut hits = vec![];
    for page in newest_first(vault) {
        if req.tier.is_some_and(|t| t != page.tier) {
            continue;
        }
        let linking: Option<HashSet<String>> = linked.as_ref().map(|slug| {
            edges_of(&page.blocks)
                .into_iter()
                .filter(|e| e.page.as_deref() == Some(slug.as_str()))
                .map(|e| e.block)
                .collect()
        });
        let blocks = flat_blocks(&page.blocks);
        for (i, block) in blocks.iter().enumerate() {
            if req.marker.as_deref().is_some_and(|m| block.marker.as_deref() != Some(m)) {
                continue;
            }
            if linking.as_ref().is_some_and(|l| !l.contains(&block.id)) {
                continue;
            }
            let mut score = 1.0;
            if !text.is_empty() {
                let props: Vec<String> = block.props.iter().map(|(k, v)| format!("{k}:{v}")).collect();
                let hay = format!("{}\n{}\n{}\n{}", page.title, block.path, block.body, props.join(" ")).to_lowercase();
                let found = match ranked {
                    Some(r) => match r.get(&block.id) {
                        Some(s) => *s,
                        None => continue,
                    },
                    None => {
                        let n = words.iter().filter(|w| hay.contains(w.as_str())).count();
                        if n == 0 {
                            continue;
                        }
                        n as f64
                    }
                };
                score = found + if hay.contains(&whole) { 2.0 } else { 0.0 };
            }
            let children = blocks[i + 1..].iter().take_while(|next| next.depth > block.depth).cloned().collect();
            hits.push(SearchHit {
                block: block.id.clone(),
                page: page.slug.clone(),
                page_title: page.title.clone(),
                tier: page.tier,
                marker: block.marker.clone(),
                path: plain_path(vault, &block.path),
                body: block.body.clone(),
                plain: plain_of(vault, &block.body),
                score: score * tier_weight(page.tier),
                children,
            });
        }
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    hits
}

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// What needs a look: inbox pages, projects untouched for `stale_days`,
/// blocks past their `deadline::`. `now` in ms.
pub fn radar(vault: &[Page], now: i64, stale_days: i64) -> Radar {
    let today = day_of(now);
    let mut out = Radar::default();
    let mut pages: Vec<&Page> = vault.iter().collect();
    pages.sort_by(|a, b| js_locale_compare(&a.slug, &b.slug));
    for page in pages {
        if page.tier == Tier::Inbox {
            out.inbox += 1;
        }
        let status = page.props.get("status").map(String::as_str);
        if page.tier == Tier::Project && status != Some("completed") && status != Some("archived") && now - page.mtime >= stale_days * DAY_MS {
            let (mut todo, mut doing, mut done) = (0, 0, 0);
            for node in walk(&page.blocks) {
                match node.marker.as_deref() {
                    Some("TODO" | "LATER") => todo += 1,
                    Some("DOING" | "NOW") => doing += 1,
                    Some("DONE") => done += 1,
                    _ => {}
                }
            }
            out.stale.push(StaleProject {
                slug: page.slug.clone(),
                title: page.title.clone(),
                days: ((now - page.mtime) / DAY_MS).max(stale_days),
                deadline: page.props.get("deadline").cloned(),
                todo,
                doing,
                done,
            });
        }
        for node in walk(&page.blocks) {
            if let Some(deadline) = node.props.get("deadline")
                && !deadline.is_empty()
                && deadline.as_str() < today.as_str()
                && !matches!(node.marker.as_deref(), Some("DONE" | "CANCELED"))
            {
                out.overdue.push(Overdue {
                    block: node.id.clone(),
                    page: page.slug.clone(),
                    body: node.body.clone(),
                    plain: plain_of(vault, &node.body),
                    deadline: deadline.clone(),
                });
            }
        }
    }
    out
}

/// Close to `String.prototype.localeCompare` for slugs: case-insensitive
/// first, then by code point.
fn js_locale_compare(a: &str, b: &str) -> std::cmp::Ordering {
    a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| a.cmp(b))
}

/// The page as plain Markdown to hand to someone: `((refs))` read out,
/// `[[links]]` as their words, remarks taken off. `summary` words the tldr.
pub fn export_markdown(vault: &[Page], page: &Page, summary: &dyn Fn(&str) -> String) -> String {
    static NAMED: OnceLock<Regex> = OnceLock::new();
    static BARE: OnceLock<Regex> = OnceLock::new();
    let mut lines: Vec<String> = vec![format!("# {}", page.title), String::new()];
    if let Some(tldr) = page.props.get("tldr").filter(|t| !t.is_empty()) {
        lines.push(summary(tldr));
        lines.push(String::new());
    }
    let plain = |text: &str| -> String {
        let refs = block_ref().replace_all(text, |c: &Captures| block_of(vault, &c[1]).map(|at| at.node.body.clone()).unwrap_or_default());
        let text = without_spans(&refs);
        let text = re(&NAMED, r"\[\[([^\[\]|]+)\|([^\[\]]+)\]\]").replace_all(&text, "$2");
        re(&BARE, r"\[\[([^\[\]]+)\]\]").replace_all(&text, "$1").into_owned()
    };
    fn go(nodes: &[Node], level: usize, lines: &mut Vec<String>, plain: &dyn Fn(&str) -> String) {
        for node in nodes {
            let body = plain(&node.body);
            if body.starts_with("## ") || body.starts_with("### ") {
                lines.push(body);
                lines.push(String::new());
            } else if level == 0 && !node.children.is_empty() && !body.starts_with("![") {
                lines.push(format!("### {body}"));
                lines.push(String::new());
            } else {
                let indent = if level <= 1 { String::new() } else { "  ".repeat(level - 1) };
                lines.push(format!("{indent}- {body}"));
            }
            if !node.children.is_empty() {
                go(&node.children, level + 1, lines, plain);
                if level == 0 {
                    lines.push(String::new());
                }
            }
        }
    }
    go(&page.blocks, 0, &mut lines, &plain);
    format!("{}\n", lines.join("\n").trim())
}

/// The page with every `[[from]]` (or `[[from|words]]`) in its blocks and
/// props said as `[[to]]`; `None` when it has none.
pub fn rename_links(page: &Page, from: &str, to: &str) -> Option<Page> {
    let link = Regex::new(&format!(r"(?i)\[\[{}(\|[^\[\]]+)?\]\]", regex::escape(from))).ok()?;
    let changed = std::cell::Cell::new(false);
    let said = |text: &str| -> String {
        let next = link
            .replace_all(text, |c: &Captures| format!("[[{to}{}]]", c.get(1).map(|m| m.as_str()).unwrap_or("")))
            .into_owned();
        if next != text {
            changed.set(true);
        }
        next
    };
    let props = page.props.iter().map(|(k, v)| (k.clone(), said(v))).collect();
    fn relink(nodes: &[Node], said: &dyn Fn(&str) -> String) -> Vec<Node> {
        nodes
            .iter()
            .map(|n| Node {
                body: said(&n.body),
                props: n.props.iter().map(|(k, v)| (k.clone(), said(v))).collect(),
                children: relink(&n.children, said),
                ..n.clone()
            })
            .collect()
    }
    let blocks = relink(&page.blocks, &said);
    changed.get().then(|| Page { props, blocks, ..page.clone() })
}

fn links_in(text: &str) -> Vec<String> {
    let mut out: Vec<String> = wiki_link().captures_iter(text).map(|m| format!("[[{}]]", m[1].trim())).collect();
    out.extend(block_ref().captures_iter(text).map(|m| format!("(({}))", &m[1])));
    out
}

/// What [`keep_links`] made of a proposed text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeptLinks {
    pub text: String,
    pub kept: Vec<String>,
    pub restored: Vec<String>,
}

/// A proposed text that keeps every link the old one had: the dropped ones
/// are put back at its end.
pub fn keep_links(old: &str, proposed: &str) -> KeptLinks {
    let kept = links_in(old);
    let mut text = proposed.to_string();
    let mut restored = vec![];
    for link in &kept {
        if !text.contains(link.as_str()) {
            text = format!("{text} {link}");
            restored.push(link.clone());
        }
    }
    KeptLinks { text, kept, restored }
}

/// The inbox, journal and resource blocks about a topic (in their text or
/// their page's title), newest page first.
pub fn clustered<'a>(vault: &'a [Page], topic: &str) -> Vec<(&'a Page, &'a Node)> {
    let lower = topic.trim().to_lowercase();
    let mut out = vec![];
    for page in newest_first(vault) {
        if !matches!(page.tier, Tier::Inbox | Tier::Journal | Tier::Resource) {
            continue;
        }
        let titled = page.title.to_lowercase().contains(&lower);
        for node in walk(&page.blocks) {
            if titled || node.body.to_lowercase().contains(&lower) {
                out.push((page, node));
            }
        }
    }
    out
}

/// The page whose `source-url::` is `url`: a clip of it already.
pub fn clip_of<'a>(vault: &'a [Page], url: &str) -> Option<&'a Page> {
    vault.iter().find(|p| p.props.get("source-url").map(String::as_str) == Some(url))
}
