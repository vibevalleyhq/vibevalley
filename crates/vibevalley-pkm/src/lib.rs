//! The user's notes as VibeValley keeps them: Logseq-style Markdown outline
//! files in PARA folders, the file the only truth. Port of VibeValley
//! `apps/mac/ui/features/pkm/`: `parse` then
//! `print` gives the same bytes; ids not written in the file are made from
//! where the block is; links, tags and block references form the graph.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const MARKERS: [&str; 7] = ["TODO", "DOING", "DONE", "NOW", "LATER", "WAITING", "CANCELED"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Inbox,
    Project,
    Area,
    Resource,
    Archive,
    Journal,
}

/// A block: the page's outline is a tree of these.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub depth: usize,
    pub marker: Option<String>,
    pub priority: Option<String>,
    pub body: String,
    pub props: BTreeMap<String, String>,
    /// Its id is written in the file (`id::`), so it stays when re-read.
    pub explicit: bool,
    pub children: Vec<Node>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Page {
    pub slug: String,
    pub title: String,
    pub tier: Tier,
    /// Relative to the vault, with forward slashes.
    pub file: String,
    pub props: BTreeMap<String, String>,
    pub blocks: Vec<Node>,
    /// sha256 of the text with `\r\n` as `\n`.
    pub sha: String,
    pub mtime: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    Wikilink,
    Tag,
    BlockRef,
    PropLink,
}

/// A link out of a block: to a page (by slug) or to a block (by id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Edge {
    pub block: String,
    pub page: Option<String>,
    pub target: Option<String>,
    pub kind: RefKind,
}

/// An inline remark: `==the words==^[the remark]`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub text: String,
    pub remark: String,
}

pub fn tier_folder(tier: Tier) -> &'static str {
    match tier {
        Tier::Inbox => "00_Inbox",
        Tier::Project => "01_Projects",
        Tier::Area => "02_Areas",
        Tier::Resource => "03_Resources",
        Tier::Archive => "04_Archives",
        Tier::Journal => "journals",
    }
}

/// How much a search hit in each tier counts.
pub fn tier_weight(tier: Tier) -> f64 {
    match tier {
        Tier::Project => 2.0,
        Tier::Area => 1.5,
        Tier::Journal => 1.4,
        Tier::Resource => 1.2,
        Tier::Inbox => 1.0,
        Tier::Archive => 0.5,
    }
}

/// The server's own files in the vault; never read as pages.
pub const OWN_FOLDER: &str = ".pkm";

pub fn tier_of_file(file: &str) -> Tier {
    let first = file.split('/').next().unwrap_or("");
    [Tier::Inbox, Tier::Project, Tier::Area, Tier::Resource, Tier::Archive, Tier::Journal]
        .into_iter()
        .find(|t| tier_folder(*t) == first)
        .unwrap_or(Tier::Inbox)
}

pub fn title_of_file(file: &str) -> String {
    let name = file.rsplit('/').next().unwrap_or(file);
    name.strip_suffix(".md").unwrap_or(name).replace("__", "/")
}

pub fn file_name_of(title: &str) -> String {
    static WS: OnceLock<Regex> = OnceLock::new();
    let name: String = title
        .trim()
        .replace('\\', "/")
        .replace('/', "__")
        .chars()
        .filter(|c| !"<>:\"|?*".contains(*c))
        .collect();
    let name = WS.get_or_init(|| Regex::new(r"\s+").expect("regex")).replace_all(&name, "-").into_owned();
    if name.ends_with(".md") { name } else { format!("{name}.md") }
}

pub fn file_of(tier: Tier, title: &str) -> String {
    format!("{}/{}", tier_folder(tier), file_name_of(title))
}

/// `journals/2026_11_03.md` → `2026-11-03`.
pub fn journal_day(file: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let c = RE
        .get_or_init(|| Regex::new(r"^journals/(\d{4})_(\d{2})_(\d{2})\.md$").expect("regex"))
        .captures(file)?;
    Some(format!("{}-{}-{}", &c[1], &c[2], &c[3]))
}

/// A page's name from its title: trimmed, lower case, spaces as dashes, `/`
/// (or `\`) as `__`.
pub fn slug_of(title: &str) -> String {
    static WS: OnceLock<Regex> = OnceLock::new();
    let s = title.trim().replace('\\', "/").replace('/', "__");
    WS.get_or_init(|| Regex::new(r"\s+").expect("regex")).replace_all(&s, "-").to_lowercase()
}

/// Every `#tag` name in a text. A tag may not follow a Latin letter, a digit
/// or one of `_ / & #` (so C#, issue#12, a link's #part, an entity and a ##
/// heading are not tags).
pub fn tags_in(text: &str) -> Vec<String> {
    static LATIN: OnceLock<Regex> = OnceLock::new();
    let latin = LATIN.get_or_init(|| Regex::new(r"^[\p{Latin}\p{N}_/&#]$").expect("regex"));
    let chars: Vec<char> = text.chars().collect();
    let mut out = vec![];
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '#' && (i == 0 || !latin.is_match(&chars[i - 1].to_string())) {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '/' || chars[j] == '-') {
                j += 1;
            }
            if j > i + 1 {
                out.push(chars[i + 1..j].iter().collect());
                i = j;
                continue;
            }
        }
        i += 1;
    }
    out
}

const PAGE_ORDER: [&str; 14] = [
    "title",
    "para",
    "status",
    "area",
    "deadline",
    "tags",
    "alias",
    "material-type",
    "source-url",
    "author",
    "read-status",
    "clipped-at",
    "snapshot",
    "tldr",
];
const BLOCK_ORDER: [&str; 9] = [
    "collapsed",
    "id",
    "completed",
    "deadline",
    "scheduled",
    "render",
    "caption",
    "source-anchor",
    "comment",
];

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("regex"))
}

fn prop_line() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^([a-zA-Z0-9_-]+)::\s*(.*)$")
}

fn bullet_line() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^(\s*)-(?:\s(.*))?$")
}

fn marker_lead() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?s)^(TODO|DOING|DONE|NOW|LATER|WAITING|CANCELED)(?:\s+\[#([ABC])\])?\s+(.*)$")
}

fn priority_lead() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?s)^\[#([ABC])\]\s+(.*)$")
}

fn fence_lead() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^(`{3,}|~{3,})")
}

fn wiki_link() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"\[\[([^\[\]]+?)\]\]")
}

fn block_ref() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"\(\(([0-9a-fA-F-]{8,36})\)\)")
}

fn span_remark() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"==([^=]+)==\^\[([^\]]+)\]")
}

fn sha_of(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// A uuid-shaped id from a seed: the same seed, the same id.
pub fn seeded_id(seed: &str) -> String {
    let h = sha_of(seed);
    format!("{}-{}-4{}-a{}-{}", &h[0..8], &h[8..12], &h[13..16], &h[17..20], &h[20..32])
}

/// A continuation line without its block's indent (or any, when indented less).
fn unindent(line: &str, depth: usize) -> String {
    let indent = "  ".repeat(depth + 1);
    match line.strip_prefix(&indent) {
        Some(rest) => rest.to_string(),
        None => line.trim_start().to_string(),
    }
}

/// The file's text as a page.
pub fn parse(text: &str, file: &str, mtime: i64) -> Page {
    let normal = text.replace("\r\n", "\n");
    let lines: Vec<&str> = normal.split('\n').collect();
    let mut props = BTreeMap::new();
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            i += 1;
            continue;
        }
        if bullet_line().is_match(line) {
            break;
        }
        let Some(p) = prop_line().captures(line) else { break };
        props.insert(p[1].to_string(), p[2].trim().to_string());
        i += 1;
    }
    let title = props.get("title").filter(|t| !t.is_empty()).cloned().unwrap_or_else(|| title_of_file(file));
    let slug = slug_of(&title);

    let mut roots: Vec<Node> = vec![];
    // Path of child indexes from the roots to the current block.
    let mut stack: Vec<usize> = vec![];
    let mut fence = String::new();
    let mut reading_props = false;
    let mut count = 0;
    let mut has_current = false;

    fn node_at<'a>(roots: &'a mut [Node], path: &[usize]) -> &'a mut Node {
        let (first, rest) = path.split_first().expect("a path");
        let mut node = &mut roots[*first];
        for i in rest {
            node = &mut node.children[*i];
        }
        node
    }

    while i < lines.len() {
        let line = lines[i];
        let last = i == lines.len() - 1;
        i += 1;
        if !fence.is_empty() && has_current {
            let current = node_at(&mut roots, &stack);
            let body = unindent(line, current.depth);
            current.body.push('\n');
            current.body.push_str(&body);
            if body.trim_start().starts_with(fence.as_str()) {
                fence.clear();
            }
            continue;
        }
        if let Some(b) = bullet_line().captures(line) {
            let width = b.get(1).map_or("", |m| m.as_str()).replace('\t', "  ").chars().count();
            let depth = (width / 2).min(stack.len());
            stack.truncate(depth);
            let mut content = b.get(2).map_or("", |m| m.as_str()).to_string();
            let (mut marker, mut priority) = (None, None);
            if let Some(lead) = marker_lead().captures(&content) {
                marker = Some(lead[1].to_string());
                priority = lead.get(2).map(|m| m.as_str().to_string());
                content = lead[3].to_string();
            } else if let Some(only) = priority_lead().captures(&content) {
                priority = Some(only[1].to_string());
                content = only[2].to_string();
            }
            count += 1;
            let opens = fence_lead().captures(content.trim_start()).map(|c| c[1].to_string());
            let node = Node {
                id: seeded_id(&format!("{slug}::{count}")),
                depth,
                marker,
                priority,
                body: content,
                props: BTreeMap::new(),
                explicit: false,
                children: vec![],
            };
            let siblings = if stack.is_empty() {
                &mut roots
            } else {
                &mut node_at(&mut roots, &stack).children
            };
            siblings.push(node);
            stack.push(siblings.len() - 1);
            has_current = true;
            reading_props = true;
            if let Some(f) = opens {
                fence = f;
                reading_props = false;
            }
            continue;
        }
        if !has_current {
            continue;
        }
        if line.trim().is_empty() && last {
            continue;
        }
        let current = node_at(&mut roots, &stack);
        let body = unindent(line, current.depth);
        if let Some(c) = fence_lead().captures(body.trim_start()) {
            fence = c[1].to_string();
            reading_props = false;
            current.body.push('\n');
            current.body.push_str(&body);
            continue;
        }
        if reading_props && let Some(p) = prop_line().captures(&body) {
            if &p[1] == "id" {
                current.id = p[2].trim().to_string();
                current.explicit = true;
            } else {
                current.props.insert(p[1].to_string(), p[2].trim().to_string());
            }
            continue;
        }
        if !line.trim().is_empty() {
            reading_props = false;
            current.body.push('\n');
            current.body.push_str(&body);
        }
    }
    Page {
        slug,
        title,
        tier: tier_of_file(file),
        file: file.to_string(),
        props,
        blocks: roots,
        sha: sha_of(&normal),
        mtime,
    }
}

/// Keys in the given order first, the rest as `localeCompare` sorts them.
fn sorted_keys<'a>(keys: impl Iterator<Item = &'a String>, order: &[&str]) -> Vec<&'a String> {
    let mut keys: Vec<&String> = keys.collect();
    keys.sort_by(|a, b| {
        match (order.iter().position(|k| k == a), order.iter().position(|k| k == b)) {
            (Some(x), Some(y)) => x.cmp(&y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            // localeCompare: letters before case, lower case first on a tie.
            (None, None) => a.to_lowercase().cmp(&b.to_lowercase()).then_with(|| b.cmp(a)),
        }
    });
    keys
}

fn writes_id(node: &Node, referenced: &HashSet<String>) -> bool {
    node.explicit || referenced.contains(&node.id) || node.props.get("comment").is_some_and(|c| !c.is_empty()) || !spans_of(&node.body).is_empty()
}

fn trim_end(s: &str) -> String {
    s.trim_end_matches([' ', '\t']).to_string()
}

/// The page as its file. `referenced`: the ids something in the vault refers
/// to or has a remark on.
pub fn print(props: &BTreeMap<String, String>, blocks: &[Node], referenced: &HashSet<String>) -> String {
    let mut out: Vec<String> = vec![];
    for key in sorted_keys(props.keys(), &PAGE_ORDER) {
        let value = &props[key];
        if !value.is_empty() {
            out.push(format!("{key}:: {value}"));
        }
    }
    if !out.is_empty() && !blocks.is_empty() {
        out.push(String::new());
    }
    fn write(node: &Node, referenced: &HashSet<String>, out: &mut Vec<String>) {
        let indent = "  ".repeat(node.depth);
        let more = "  ".repeat(node.depth + 1);
        let lead = format!(
            "{indent}- {}{}",
            node.marker.as_ref().map(|m| format!("{m} ")).unwrap_or_default(),
            node.priority.as_ref().map(|p| format!("[#{p}] ")).unwrap_or_default()
        );
        let mut lines = node.body.split('\n');
        out.push(trim_end(&(lead + lines.next().unwrap_or(""))));
        let mut props = node.props.clone();
        if writes_id(node, referenced) {
            props.insert("id".into(), node.id.clone());
        }
        for key in sorted_keys(props.keys(), &BLOCK_ORDER) {
            let value = &props[key];
            if !value.is_empty() {
                out.push(trim_end(&format!("{more}{key}:: {value}")));
            }
        }
        for line in lines {
            out.push(trim_end(&format!("{more}{line}")));
        }
        for child in &node.children {
            write(child, referenced, out);
        }
    }
    for node in blocks {
        write(node, referenced, &mut out);
    }
    format!("{}\n", out.join("\n"))
}

/// The text with fenced code taken out.
fn without_fences(text: &str) -> String {
    // A backreference in the original (`(`{3,}|~{3,})[\s\S]*?\1`): matched
    // by hand, opening fence to the next identical one.
    let mut out = String::new();
    let mut rest = text;
    loop {
        let next = ["```", "~~~"].iter().filter_map(|f| rest.find(f).map(|at| (at, *f))).min();
        let Some((at, f)) = next else {
            out.push_str(rest);
            return out;
        };
        let ch = f.chars().next().unwrap_or('`');
        let run = rest[at..].chars().take_while(|c| *c == ch).count();
        let open: String = std::iter::repeat_n(ch, run).collect();
        match rest[at + run..].find(&open) {
            Some(close) => {
                out.push_str(&rest[..at]);
                rest = &rest[at + run + close + open.len()..];
            }
            None => {
                out.push_str(rest);
                return out;
            }
        }
    }
}

pub fn spans_of(body: &str) -> Vec<Span> {
    span_remark()
        .captures_iter(&without_fences(body))
        .map(|m| Span {
            text: m[1].trim().to_string(),
            remark: m[2].trim_start_matches('💬').trim().to_string(),
        })
        .collect()
}

/// The body with its `==span==^[remark]` marks taken off, the words left.
pub fn without_spans(body: &str) -> String {
    span_remark().replace_all(body, "$1").into_owned()
}

/// Every block, depth first, in the page's order.
pub fn walk(nodes: &[Node]) -> Vec<&Node> {
    let mut out = vec![];
    for n in nodes {
        out.push(n);
        out.extend(walk(&n.children));
    }
    out
}

pub fn find<'a>(nodes: &'a [Node], id: &str) -> Option<&'a Node> {
    walk(nodes).into_iter().find(|n| n.id == id)
}

/// The links out of each block: `[[pages]]`, `#tags`, `((blocks))` and
/// `[[pages]]` in its props; none inside code.
pub fn edges_of(blocks: &[Node]) -> Vec<Edge> {
    let mut edges = vec![];
    let link_target = |m: &str| m.split('|').next().unwrap_or("").trim().to_string();
    for node in walk(blocks) {
        let text = without_fences(&node.body);
        for m in wiki_link().captures_iter(&text) {
            let target = link_target(&m[1]);
            if !target.is_empty() && !target.starts_with('.') {
                edges.push(Edge {
                    block: node.id.clone(),
                    page: Some(slug_of(&target)),
                    target: None,
                    kind: RefKind::Wikilink,
                });
            }
        }
        for m in block_ref().captures_iter(&text) {
            edges.push(Edge {
                block: node.id.clone(),
                page: None,
                target: Some(m[1].to_string()),
                kind: RefKind::BlockRef,
            });
        }
        for tag in tags_in(&text) {
            edges.push(Edge {
                block: node.id.clone(),
                page: Some(slug_of(&tag)),
                target: None,
                kind: RefKind::Tag,
            });
        }
        for value in node.props.values() {
            for m in wiki_link().captures_iter(value) {
                let target = link_target(&m[1]);
                if !target.is_empty() {
                    edges.push(Edge {
                        block: node.id.clone(),
                        page: Some(slug_of(&target)),
                        target: None,
                        kind: RefKind::PropLink,
                    });
                }
            }
        }
    }
    edges
}

/// Ids of `page`'s blocks not written in its file are taken from `was`
/// where a block reads the same at the same depth.
pub fn carry_ids(was: &Page, page: &Page) -> Page {
    let key = |n: &Node| format!("{}\u{0}{}\u{0}{}", n.depth, n.marker.as_deref().unwrap_or(""), n.body);
    let explicit: HashSet<&str> = walk(&page.blocks).into_iter().filter(|n| n.explicit).map(|n| n.id.as_str()).collect();
    let mut held = HashSet::new();
    let mut free: HashMap<String, std::collections::VecDeque<String>> = HashMap::new();
    for n in walk(&was.blocks) {
        held.insert(n.id.clone());
        if explicit.contains(n.id.as_str()) {
            continue;
        }
        free.entry(key(n)).or_default().push_back(n.id.clone());
    }
    fn relabel(
        nodes: &[Node],
        free: &mut HashMap<String, std::collections::VecDeque<String>>,
        held: &HashSet<String>,
        sha: &str,
        key: &dyn Fn(&Node) -> String,
    ) -> Vec<Node> {
        nodes
            .iter()
            .map(|n| {
                let reuse = if n.explicit {
                    None
                } else {
                    free.get_mut(&key(n)).and_then(|q| q.pop_front())
                };
                let id = reuse.unwrap_or_else(|| {
                    if !n.explicit && held.contains(&n.id) {
                        seeded_id(&format!("{sha}::{}", n.id))
                    } else {
                        n.id.clone()
                    }
                });
                Node {
                    id,
                    children: relabel(&n.children, free, held, sha, key),
                    ..n.clone()
                }
            })
            .collect()
    }
    Page {
        blocks: relabel(&page.blocks, &mut free, &held, &page.sha, &key),
        ..page.clone()
    }
}

/// Typed or piped text as blocks of their own (`pkm capture`).
pub fn outline_of(text: &str, new_id: &mut dyn FnMut() -> String) -> Vec<Node> {
    let normal = text.replace("\r\n", "\n");
    let lines: Vec<&str> = normal.split('\n').filter(|l| !l.trim().is_empty()).collect();
    if lines.is_empty() {
        return vec![];
    }
    let width = |l: &str| l.encode_utf16().count() - l.trim_start().encode_utf16().count();
    let least = lines.iter().map(|l| width(l)).min().unwrap_or(0);
    let mut open: Vec<usize> = vec![];
    static DASH: OnceLock<Regex> = OnceLock::new();
    let dash = DASH.get_or_init(|| Regex::new(r"^[-*]\s+").expect("regex"));
    let markdown: Vec<String> = lines
        .iter()
        .map(|l| {
            let w = width(l) - least;
            while open.last().is_some_and(|x| *x >= w) {
                open.pop();
            }
            let depth = open.len();
            open.push(w);
            format!("{}- {}", "  ".repeat(depth), dash.replace(l.trim(), ""))
        })
        .collect();
    fn fresh(nodes: Vec<Node>, new_id: &mut dyn FnMut() -> String) -> Vec<Node> {
        nodes
            .into_iter()
            .map(|n| {
                let id = new_id();
                let children = fresh(n.children.clone(), new_id);
                Node {
                    id,
                    explicit: false,
                    children,
                    ..n
                }
            })
            .collect()
    }
    fresh(parse(&(markdown.join("\n") + "\n"), "captured.md", 0).blocks, new_id)
}

/// VibeValley's `PkmBlockOp`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum BlockOp {
    Append(NewBlock),
    InsertBefore {
        block: String,
        #[serde(flatten)]
        new: NewBlock,
    },
    InsertAfter {
        block: String,
        #[serde(flatten)]
        new: NewBlock,
    },
    InsertChild {
        block: String,
        #[serde(flatten)]
        new: NewBlock,
    },
    Update {
        block: String,
        body: Option<String>,
        priority: Option<String>,
        props: Option<BTreeMap<String, String>>,
    },
    SetMarker {
        block: String,
        marker: Option<String>,
    },
    ToggleMarker {
        block: String,
    },
    Delete {
        block: String,
    },
    Indent {
        block: String,
    },
    Outdent {
        block: String,
    },
    Move {
        block: String,
        direction: String,
    },
    MoveTo {
        block: String,
        target: String,
        at: String,
    },
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct NewBlock {
    pub id: Option<String>,
    pub body: String,
    pub marker: Option<String>,
    pub priority: Option<String>,
    pub props: Option<BTreeMap<String, String>>,
}

/// Where a block is: the path of indexes to its sibling list, and its index.
fn locate(nodes: &[Node], id: &str, prefix: &mut Vec<usize>) -> Option<(Vec<usize>, usize)> {
    for (i, n) in nodes.iter().enumerate() {
        if n.id == id {
            return Some((prefix.clone(), i));
        }
        prefix.push(i);
        if let Some(found) = locate(&n.children, id, prefix) {
            return Some(found);
        }
        prefix.pop();
    }
    None
}

fn siblings_at<'a>(roots: &'a mut Vec<Node>, path: &[usize]) -> &'a mut Vec<Node> {
    let mut list = roots;
    for i in path {
        list = &mut list[*i].children;
    }
    list
}

fn fresh_node(new: &NewBlock, new_id: &mut dyn FnMut() -> String) -> Node {
    Node {
        id: new.id.clone().unwrap_or_else(&mut *new_id),
        depth: 0,
        marker: new.marker.clone(),
        priority: new.priority.clone(),
        body: new.body.clone(),
        props: new.props.clone().unwrap_or_default(),
        explicit: false,
        children: vec![],
    }
}

fn cycle(marker: &str) -> &'static str {
    match marker {
        "TODO" => "DOING",
        "DOING" => "DONE",
        "DONE" => "TODO",
        "LATER" => "NOW",
        "NOW" => "DONE",
        _ => "DONE",
    }
}

/// The blocks after the ops in order. An op on a block not on the page
/// changes nothing; moving a block into itself is refused.
pub fn apply_ops(blocks: &[Node], ops: &[BlockOp], new_id: &mut dyn FnMut() -> String) -> Vec<Node> {
    let mut roots = blocks.to_vec();
    for op in ops {
        apply_one(&mut roots, op, new_id);
    }
    renumber(&mut roots, 0);
    roots
}

fn apply_one(roots: &mut Vec<Node>, op: &BlockOp, new_id: &mut dyn FnMut() -> String) {
    let block = match op {
        BlockOp::Append(new) => {
            roots.push(fresh_node(new, new_id));
            return;
        }
        BlockOp::InsertBefore { block, .. }
        | BlockOp::InsertAfter { block, .. }
        | BlockOp::InsertChild { block, .. }
        | BlockOp::Update { block, .. }
        | BlockOp::SetMarker { block, .. }
        | BlockOp::ToggleMarker { block }
        | BlockOp::Delete { block }
        | BlockOp::Indent { block }
        | BlockOp::Outdent { block }
        | BlockOp::Move { block, .. }
        | BlockOp::MoveTo { block, .. } => block.clone(),
    };
    let Some((path, index)) = locate(roots, &block, &mut vec![]) else { return };
    match op {
        BlockOp::InsertBefore { new, .. } => {
            let n = fresh_node(new, new_id);
            siblings_at(roots, &path).insert(index, n);
        }
        BlockOp::InsertAfter { new, .. } => {
            let n = fresh_node(new, new_id);
            siblings_at(roots, &path).insert(index + 1, n);
        }
        BlockOp::InsertChild { new, .. } => {
            let n = fresh_node(new, new_id);
            siblings_at(roots, &path)[index].children.push(n);
        }
        BlockOp::Update { body, priority, props, .. } => {
            let node = &mut siblings_at(roots, &path)[index];
            if let Some(b) = body {
                node.body = b.clone();
            }
            if let Some(p) = priority {
                node.priority = Some(p.clone());
            }
            if let Some(p) = props {
                node.props.extend(p.clone());
            }
        }
        BlockOp::SetMarker { marker, .. } => siblings_at(roots, &path)[index].marker = marker.clone(),
        BlockOp::ToggleMarker { .. } => {
            let node = &mut siblings_at(roots, &path)[index];
            node.marker = Some(node.marker.as_deref().map(cycle).unwrap_or("TODO").to_string());
        }
        BlockOp::Delete { .. } => {
            siblings_at(roots, &path).remove(index);
        }
        BlockOp::Indent { .. } => {
            if index == 0 {
                return;
            }
            let list = siblings_at(roots, &path);
            let node = list.remove(index);
            list[index - 1].children.push(node);
        }
        BlockOp::Outdent { .. } => {
            let Some((&parent_index, parent_path)) = path.split_last() else { return };
            let node = siblings_at(roots, &path).remove(index);
            siblings_at(roots, parent_path).insert(parent_index + 1, node);
        }
        BlockOp::MoveTo { target, at, .. } => {
            let node = siblings_at(roots, &path)[index].clone();
            if *target == node.id || find(&node.children, target).is_some() {
                return;
            }
            siblings_at(roots, &path).remove(index);
            match locate(roots, target, &mut vec![]) {
                None => siblings_at(roots, &path).insert(index, node),
                Some((tpath, tindex)) => {
                    let list = siblings_at(roots, &tpath);
                    match at.as_str() {
                        "inside" => list[tindex].children.insert(0, node),
                        "after" => list.insert(tindex + 1, node),
                        _ => list.insert(tindex, node),
                    }
                }
            }
        }
        BlockOp::Move { direction, .. } => {
            let list = siblings_at(roots, &path);
            let to = if direction == "up" { index.checked_sub(1) } else { Some(index + 1) };
            if let Some(to) = to.filter(|t| *t < list.len()) {
                list.swap(index, to);
            }
        }
        BlockOp::Append(_) => {}
    }
}

fn renumber(nodes: &mut [Node], depth: usize) {
    for n in nodes {
        n.depth = depth;
        renumber(&mut n.children, depth + 1);
    }
}

pub mod graph;
pub use graph::*;

#[cfg(test)]
mod tests;
