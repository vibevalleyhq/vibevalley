//! An HTML artifact (`html.ts`): what a page may load (`htmlCheck`), why a
//! title, kind or size is refused, the words the user changes on a page
//! (`htmlEdit`), and the headers it is served with.
//!
//! VibeValley parses with parse5; here lol_html's tokenizer gives the same
//! elements, attributes and text nodes with their byte offsets. Offsets and
//! lengths are in bytes and characters where VibeValley counts UTF-16 units.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::LazyLock;

use lol_html::html_content::TextType;
use lol_html::{RewriteStrSettings, doc_text, element, rewrite_str};
use regex::Regex;
use serde::Serialize;
use vibevalley_i18n::{list, t};

use crate::spans::{js_space, js_trim};

/// The largest artifact body, bytes.
pub const ARTIFACT_MAX: usize = 5 * 1024 * 1024;
const ARTIFACT_TITLE_MAX: usize = 80;

/// `htmlSandbox` (protocol rules/display.ts).
pub const HTML_SANDBOX: &str = "allow-scripts allow-popups allow-popups-to-escape-sandbox";

pub const DEMO_PIECES: usize = 6;
pub const DEMO_JITTER: f64 = 0.3;

/// Why a title, a kind or a hand-in's size is refused; "" when right.
pub fn artifact_problem(title: Option<&str>, kind: Option<&str>, size: Option<usize>) -> String {
    if let Some(title) = title {
        let n = js_trim(title).chars().count();
        if n == 0 {
            return t("server.artifact.noTitle", &[]);
        }
        if n > ARTIFACT_TITLE_MAX {
            return t("server.artifact.longTitle", &[("max", ARTIFACT_TITLE_MAX.into())]);
        }
    }
    if let Some(kind) = kind
        && kind != "html"
        && kind != "markdown"
    {
        return t("server.artifact.badKind", &[("kind", kind.into()), ("kinds", "html, markdown".into())]);
    }
    match size {
        None => String::new(),
        Some(0) => t("server.artifact.empty", &[]),
        Some(n) if n > ARTIFACT_MAX => t("server.artifact.tooBig", &[("mb", (ARTIFACT_MAX / 1024 / 1024).into())]),
        Some(_) => String::new(),
    }
}

const LIBRARIES: [&str; 2] = ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"];

fn sources(need: Need) -> Vec<&'static str> {
    match need {
        Need::Script => LIBRARIES.to_vec(),
        Need::Style => [&LIBRARIES[..], &["https://fonts.googleapis.com"]].concat(),
        Need::Font => [&LIBRARIES[..], &["https://fonts.gstatic.com"]].concat(),
        Need::Inline => vec![],
        Need::Link => {
            let mut all: Vec<&str> = vec![];
            for n in [Need::Script, Need::Style, Need::Font] {
                for h in sources(n) {
                    if !all.contains(&h) {
                        all.push(h);
                    }
                }
            }
            all
        }
    }
}

fn limits() -> String {
    [
        "default-src 'none'".to_string(),
        ["script-src 'unsafe-inline'"]
            .into_iter()
            .chain(sources(Need::Script))
            .collect::<Vec<_>>()
            .join(" "),
        ["style-src 'unsafe-inline'"]
            .into_iter()
            .chain(sources(Need::Style))
            .collect::<Vec<_>>()
            .join(" "),
        "img-src data: blob:".into(),
        ["font-src data:"].into_iter().chain(sources(Need::Font)).collect::<Vec<_>>().join(" "),
        "media-src data: blob:".into(),
        "connect-src 'none'".into(),
        "form-action 'none'".into(),
        "base-uri 'none'".into(),
    ]
    .join("; ")
}

/// The CSP an HTML artifact is served under: someone else's page, never
/// one of the farm's.
pub fn html_policy() -> String {
    format!("sandbox {HTML_SANDBOX}; {}", limits())
}

/// The headers an html version is served with; `print` lets it open the
/// print dialog, nothing more.
pub fn artifact_headers(print: bool) -> BTreeMap<String, String> {
    let policy = if print {
        format!("sandbox {HTML_SANDBOX} allow-modals; {}", limits())
    } else {
        html_policy()
    };
    [
        ("cache-control", "private, max-age=31536000, immutable".to_string()),
        ("x-content-type-options", "nosniff".into()),
        ("referrer-policy", "no-referrer".into()),
        ("content-type", "text/html; charset=utf-8".into()),
        ("content-security-policy", policy),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_string(), v))
    .collect()
}

// ----- the page as elements and text nodes -----

struct El {
    tag: String,
    line: usize,
    /// Lowercase name, value with its references read, the line it is on.
    attrs: Vec<(String, String, usize)>,
    /// A script's or style's own text, and the line it starts on.
    text: String,
    text_line: Option<usize>,
}

impl El {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.iter().find(|a| a.0 == name).map(|a| a.1.as_str())
    }
    fn attr_line(&self, name: &str) -> usize {
        self.attrs.iter().find(|a| a.0 == name).map_or(self.line, |a| a.2)
    }
}

struct Text {
    start: usize,
    end: usize,
    hidden: bool,
}

#[derive(Default)]
struct Scan {
    els: Vec<El>,
    texts: Vec<Text>,
    in_head: bool,
    templates: usize,
    /// The text node being read: where it starts and ends, and whether it is hidden.
    open: Option<(usize, usize, bool)>,
}

struct Lines(Vec<usize>);

impl Lines {
    fn of(s: &str) -> Lines {
        Lines(s.match_indices('\n').map(|(i, _)| i).collect())
    }
    /// 1-based, as parse5 counts.
    fn at(&self, offset: usize) -> usize {
        self.0.partition_point(|&i| i < offset) + 1
    }
}

const IN_HEAD: [&str; 11] = [
    "base", "basefont", "bgsound", "link", "meta", "title", "noscript", "noframes", "style", "script", "template",
];

fn scan(source: &str) -> Scan {
    let lines = Rc::new(Lines::of(source));
    let state = Rc::new(RefCell::new(Scan::default()));
    let (s1, s2, l1, l2) = (state.clone(), state.clone(), lines.clone(), lines.clone());
    let settings = RewriteStrSettings::new()
        .append_element_content_handler(element!("*", move |el| {
            let start = el.source_location().bytes().start;
            let tag = el.tag_name().to_ascii_lowercase();
            let attrs = el
                .attributes()
                .iter()
                .map(|a| {
                    let line = a.name_source_location().map_or(l1.at(start), |l| l1.at(l.bytes().start));
                    (a.name(), htmlize::unescape_attribute(a.value()).into_owned(), line)
                })
                .collect();
            let mut s = s1.borrow_mut();
            if tag == "head" {
                s.in_head = true;
                let s = s1.clone();
                let h: lol_html::EndTagHandler<'static> = Box::new(move |_| {
                    s.borrow_mut().in_head = false;
                    Ok(())
                });
                let _ = el.on_end_tag(h);
            } else if tag == "body" || !IN_HEAD.contains(&tag.as_str()) {
                s.in_head = false;
            }
            if tag == "template" {
                s.templates += 1;
                let s = s1.clone();
                let h: lol_html::EndTagHandler<'static> = Box::new(move |_| {
                    let mut s = s.borrow_mut();
                    s.templates = s.templates.saturating_sub(1);
                    Ok(())
                });
                let _ = el.on_end_tag(h);
            }
            s.els.push(El {
                tag,
                line: l1.at(start),
                attrs,
                text: String::new(),
                text_line: None,
            });
            Ok(())
        }))
        .append_document_content_handler(doc_text!(move |chunk| {
            let loc = chunk.source_location().bytes();
            let mut s = s2.borrow_mut();
            let kind = chunk.text_type();
            let raw_tag = s.els.last().map(|e| e.tag.clone()).unwrap_or_default();
            if matches!(kind, TextType::ScriptData | TextType::RawText)
                && let Some(el) = s.els.last_mut()
                && (el.tag == "script" || el.tag == "style")
                && (kind == TextType::ScriptData) == (el.tag == "script")
            {
                if el.text_line.is_none() && loc.start < loc.end {
                    el.text_line = Some(l2.at(loc.start));
                }
                el.text.push_str(chunk.as_str());
            }
            if loc.start < loc.end {
                match &mut s.open {
                    Some(open) => open.1 = open.1.max(loc.end),
                    None => {
                        let raw_hidden = match kind {
                            TextType::ScriptData | TextType::RCData => true,
                            TextType::RawText => raw_tag == "style" || raw_tag == "noscript",
                            _ => false,
                        };
                        if s.in_head && kind == TextType::Data && !chunk.as_str().chars().all(js_space) {
                            s.in_head = false;
                        }
                        let hidden = raw_hidden || s.in_head || s.templates > 0;
                        s.open = Some((loc.start, loc.end, hidden));
                    }
                }
            }
            if chunk.last_in_text_node()
                && let Some((start, end, hidden)) = s.open.take()
            {
                s.texts.push(Text { start, end, hidden });
            }
            Ok(())
        }));
    let _ = rewrite_str(source, settings);
    drop(lines);
    Rc::try_unwrap(state).map(RefCell::into_inner).unwrap_or_default()
}

// ----- words edited in place -----

#[derive(Clone, Copy)]
struct At {
    node: i64,
    from: usize,
    to: usize,
}

static REFERENCE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);?").expect("a fixed pattern"));

/// The page's words as a reader sees them, spaces squashed, and where each
/// character came from.
fn page_text(source: &str) -> (Vec<char>, Vec<At>) {
    let mut chars: Vec<(char, At)> = vec![];
    for (n, tx) in scan(source).texts.iter().filter(|t| !t.hidden).enumerate() {
        let node = n as i64 + 1;
        let raw = &source[tx.start..tx.end];
        let mut i = 0;
        while i < raw.len() {
            let reference = if raw.as_bytes()[i] == b'&' {
                REFERENCE.find(&raw[i..]).map(|m| m.as_str())
            } else {
                None
            };
            let written = reference.unwrap_or_else(|| {
                let c = raw[i..].chars().next().expect("inside the text");
                &raw[i..i + c.len_utf8()]
            });
            let at = At {
                node,
                from: tx.start + i,
                to: tx.start + i + written.len(),
            };
            let read = if reference.is_some() {
                htmlize::unescape(written).into_owned()
            } else {
                written.to_string()
            };
            for c in read.chars() {
                chars.push((c, at));
            }
            i += written.len();
        }
    }
    let mut text: Vec<char> = vec![];
    let mut at: Vec<At> = vec![];
    for (c, a) in chars {
        if js_space(c)
            && text.last() == Some(&' ')
            && let Some(last) = at.last_mut()
        {
            *last = At {
                node: if last.node == a.node { last.node } else { -1 },
                from: last.from,
                to: a.to,
            };
            continue;
        }
        text.push(if js_space(c) { ' ' } else { c });
        at.push(a);
    }
    (text, at)
}

fn squash(s: &str) -> String {
    let mut out = String::new();
    let mut in_space = false;
    for c in s.chars() {
        if js_space(c) {
            if !in_space {
                out.push(' ');
            }
            in_space = true;
        } else {
            out.push(c);
            in_space = false;
        }
    }
    out
}

fn bare(s: impl IntoIterator<Item = char>) -> String {
    s.into_iter().filter(|c| !js_space(*c)).collect()
}

fn escaped(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

fn find_all(hay: &[char], needle: &[char]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return vec![];
    }
    (0..=hay.len() - needle.len()).filter(|&k| hay[k..k + needle.len()] == *needle).collect()
}

/// The user's words in place of `anchor`'s on the page: every other byte
/// stays as written. `Err` says why not.
pub fn html_edit(source: &str, anchor: &vibevalley_protocol::HtmlAnchor, text: &str) -> Result<String, String> {
    let exact = js_trim(&squash(&anchor.exact)).to_string();
    if exact.is_empty() {
        return Err(t("server.artifact.edit.empty", &[]));
    }
    if js_trim(&squash(text)) == exact {
        return Err(t("server.artifact.edit.same", &[]));
    }
    let (page, at) = page_text(source);
    let want: Vec<char> = exact.chars().collect();
    let found = find_all(&page, &want);
    if found.is_empty() {
        return Err(t("server.artifact.edit.notFound", &[("words", exact.as_str().into())]));
    }
    let (prefix, suffix) = (bare(anchor.prefix.chars()), bare(anchor.suffix.chars()));
    let (pn, sn) = (prefix.chars().count(), suffix.chars().count());
    let fits = |k: usize| {
        let before = bare(page[k.saturating_sub(4 * pn + 64)..k].iter().copied());
        let from = k + want.len();
        let after = bare(page[from..(from + 4 * sn + 64).min(page.len())].iter().copied());
        before.ends_with(&prefix) && after.starts_with(&suffix)
    };
    let chosen: Vec<usize> = if found.len() == 1 {
        found.clone()
    } else {
        found.iter().copied().filter(|&k| fits(k)).collect()
    };
    let [k] = chosen[..] else {
        return Err(t("server.artifact.edit.many", &[("words", exact.as_str().into()), ("n", found.len().into())]));
    };
    let (first, last) = (at[k], at[k + want.len() - 1]);
    if first.node < 0 || first.node != last.node {
        return Err(t("server.artifact.edit.crosses", &[("words", exact.as_str().into())]));
    }
    Ok(format!("{}{}{}", &source[..first.from], escaped(text), &source[last.to..]))
}

// ----- what a page may load -----

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Need {
    Script,
    Style,
    Font,
    Inline,
    Link,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum HtmlRefusal {
    Load { need: Need, line: usize, url: String },
    Form { line: usize, url: String },
    Refresh { line: usize },
    Base { line: usize },
    Frame { line: usize, tag: String },
}

impl HtmlRefusal {
    pub fn line(&self) -> usize {
        match self {
            HtmlRefusal::Load { line, .. }
            | HtmlRefusal::Form { line, .. }
            | HtmlRefusal::Refresh { line }
            | HtmlRefusal::Base { line }
            | HtmlRefusal::Frame { line, .. } => *line,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HtmlWarning {
    pub line: usize,
    pub call: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct HtmlCheck {
    pub refused: Vec<HtmlRefusal>,
    pub warned: Vec<HtmlWarning>,
}

fn origin(u: &str) -> Option<String> {
    let url = url::Url::parse(u).ok()?;
    Some(url.origin().ascii_serialization())
}

fn allowed(url: &str, need: Need) -> bool {
    let u = js_trim(url);
    if u.is_empty() || u.starts_with('#') {
        return true;
    }
    let lower = u.to_ascii_lowercase();
    if lower.starts_with("data:") || lower.starts_with("blob:") {
        return need == Need::Inline || need == Need::Font;
    }
    origin(u).is_some_and(|o| sources(need).contains(&o.as_str()))
}

const FRAMES: [&str; 7] = ["iframe", "frame", "frameset", "object", "embed", "portal", "fencedframe"];

fn inline_sources(tag: &str) -> &'static [&'static str] {
    match tag {
        "img" | "source" => &["src", "srcset"],
        "video" => &["src", "poster"],
        "audio" | "track" => &["src"],
        "image" | "use" => &["href"],
        _ => &[],
    }
}

const SCRIPT_TYPES: [&str; 4] = ["", "module", "text/javascript", "application/javascript"];

static NETWORK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?-u:\b)(fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)(?-u:\b)").expect("a fixed pattern"));
static IMPORTS: LazyLock<[Regex; 2]> = LazyLock::new(|| {
    [
        Regex::new(r#"(?-u:\b)import\s*(?:[0-9A-Za-z_*{}\s,$]+?\s*from\s*)?["'](https?://[^"']+)["']"#).expect("a fixed pattern"),
        Regex::new(r#"(?-u:\b)import\s*\(\s*["'](https?://[^"']+)["']"#).expect("a fixed pattern"),
    ]
});

fn link_need(rel: &str, r#as: &str) -> Option<Need> {
    let lower = rel.to_lowercase();
    let rels: Vec<&str> = lower.split(js_space).collect();
    let has = |r: &str| rels.contains(&r);
    if has("stylesheet") {
        return Some(Need::Style);
    }
    if has("icon") || has("apple-touch-icon") {
        return Some(Need::Inline);
    }
    if has("preload") || has("modulepreload") || has("prefetch") {
        return Some(match r#as {
            "font" => Need::Font,
            "style" => Need::Style,
            "image" => Need::Inline,
            _ => Need::Script,
        });
    }
    if has("preconnect") || has("dns-prefetch") {
        return Some(Need::Link);
    }
    None
}

fn srcset_urls(v: &str) -> Vec<String> {
    let c: Vec<char> = v.chars().collect();
    let mut out = vec![];
    let mut i = 0;
    while i < c.len() {
        while i < c.len() && (js_space(c[i]) || c[i] == ',') {
            i += 1;
        }
        let mut j = i;
        while j < c.len() && !js_space(c[j]) {
            j += 1;
        }
        let url: String = c[i..j].iter().collect();
        if url.ends_with(',') {
            i = j;
        } else {
            i = c[j..].iter().position(|&x| x == ',').map_or(c.len(), |p| j + p + 1);
        }
        let url = url.trim_end_matches(',');
        if !url.is_empty() {
            out.push(url.to_string());
        }
    }
    out
}

fn line_at(text: &str, at: usize) -> usize {
    text[..at].matches('\n').count()
}

static CSS_COMMENT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/\*[\s\S]*?\*/").expect("a fixed pattern"));
static CSS_IMPORT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)@import\s+(?:url\(\s*)?(?:"([^"')\s;]+)"|'([^"')\s;]+)'|([^"')\s;]+))"#).expect("a fixed pattern"));
static CSS_IMPORT_ALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)@import[^;]*;?").expect("a fixed pattern"));
static CSS_FACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)@font-face\s*\{[^}]*\}").expect("a fixed pattern"));
static CSS_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?i)url\(\s*(?:"([^"')]*)"|'([^"')]*)'|([^"')]*))\s*\)"#).expect("a fixed pattern"));

fn blanked(re: &Regex, s: &str) -> String {
    re.replace_all(s, |c: &regex::Captures| {
        c[0].chars().map(|ch| if ch == '\n' { '\n' } else { ' ' }).collect::<String>()
    })
    .into_owned()
}

fn any_group(c: &regex::Captures, groups: &[usize]) -> String {
    groups.iter().find_map(|&i| c.get(i)).map_or(String::new(), |m| m.as_str().to_string())
}

fn css_loads(css: &str) -> Vec<(Need, usize, String)> {
    let mut out = vec![];
    let text = blanked(&CSS_COMMENT, css);
    for c in CSS_IMPORT.captures_iter(&text) {
        out.push((Need::Style, c.get(0).map_or(0, |m| m.start()), any_group(&c, &[1, 2, 3])));
    }
    let text = blanked(&CSS_IMPORT_ALL, &text);
    let faces: Vec<(usize, usize)> = CSS_FACE.find_iter(&text).map(|m| (m.start(), m.end())).collect();
    for c in CSS_URL.captures_iter(&text) {
        let at = c.get(0).map_or(0, |m| m.start());
        let need = if faces.iter().any(|&(a, b)| at >= a && at < b) {
            Need::Font
        } else {
            Need::Inline
        };
        out.push((need, at, any_group(&c, &[1, 2, 3])));
    }
    out
}

/// What a page loads from where it may not, and the network calls its
/// scripts make.
pub fn html_check(source: &str) -> HtmlCheck {
    let mut refused: Vec<HtmlRefusal> = vec![];
    let mut warned: Vec<HtmlWarning> = vec![];
    let load = |refused: &mut Vec<HtmlRefusal>, need: Need, line: usize, url: &str| {
        if !allowed(url, need) {
            refused.push(HtmlRefusal::Load {
                need,
                line,
                url: js_trim(url).to_string(),
            });
        }
    };
    for el in scan(source).els {
        let (tag, line) = (el.tag.as_str(), el.line);
        if FRAMES.contains(&tag) {
            refused.push(HtmlRefusal::Frame { line, tag: tag.to_string() });
        }
        for name in inline_sources(tag) {
            let Some(v) = el.attr(name) else { continue };
            let urls = if *name == "srcset" { srcset_urls(v) } else { vec![v.to_string()] };
            for u in urls {
                load(&mut refused, Need::Inline, el.attr_line(name), &u);
            }
        }
        if tag == "input"
            && el.attr("type").is_some_and(|t| t.to_lowercase() == "image")
            && let Some(v) = el.attr("src")
        {
            load(&mut refused, Need::Inline, el.attr_line("src"), v);
        }
        if tag == "link"
            && let Some(need) = link_need(el.attr("rel").unwrap_or(""), &el.attr("as").unwrap_or("").to_lowercase())
            && let Some(href) = el.attr("href")
        {
            load(&mut refused, need, el.attr_line("href"), href);
        }
        if tag == "script" {
            if let Some(src) = el.attr("src").or_else(|| el.attr("href")) {
                let name = if el.attr("src").is_none() { "href" } else { "src" };
                load(&mut refused, Need::Script, el.attr_line(name), src);
            } else if SCRIPT_TYPES.contains(&js_trim(el.attr("type").unwrap_or("")).to_lowercase().as_str()) {
                let code = &el.text;
                let first = el.text_line.unwrap_or(line);
                for re in IMPORTS.iter() {
                    for c in re.captures_iter(code) {
                        let at = c.get(0).map_or(0, |m| m.start());
                        load(&mut refused, Need::Script, first + line_at(code, at), &c[1]);
                    }
                }
                for c in NETWORK.captures_iter(code) {
                    let call = c[1].to_string();
                    if !warned.iter().any(|w| w.call == call) {
                        let at = c.get(0).map_or(0, |m| m.start());
                        warned.push(HtmlWarning {
                            line: first + line_at(code, at),
                            call,
                        });
                    }
                }
            }
        }
        if tag == "style" {
            let first = el.text_line.unwrap_or(line);
            for (need, at, url) in css_loads(&el.text) {
                load(&mut refused, need, first + line_at(&el.text, at), &url);
            }
        }
        if let Some(style) = el.attr("style") {
            for (need, _, url) in css_loads(style) {
                load(&mut refused, need, el.attr_line("style"), &url);
            }
        }
        let action = match tag {
            "form" => el.attr("action"),
            "button" | "input" => el.attr("formaction"),
            _ => None,
        };
        if let Some(action) = action.map(js_trim)
            && !action.is_empty()
            && !action.starts_with('#')
            && !action.to_ascii_lowercase().starts_with("javascript:")
        {
            refused.push(HtmlRefusal::Form { line, url: action.to_string() });
        }
        if tag == "meta" && el.attr("http-equiv").is_some_and(|v| js_trim(v).to_lowercase() == "refresh") {
            refused.push(HtmlRefusal::Refresh { line });
        }
        if tag == "base" && el.attr("href").is_some() {
            refused.push(HtmlRefusal::Base { line });
        }
    }
    refused.sort_by_key(HtmlRefusal::line);
    HtmlCheck { refused, warned }
}

fn host_list(need: Need) -> String {
    let hosts: Vec<String> = sources(need)
        .into_iter()
        .filter_map(|h| url::Url::parse(h).ok().and_then(|u| u.host_str().map(str::to_string)))
        .collect();
    list(&hosts)
}

fn refusal_text(f: &HtmlRefusal) -> String {
    match f {
        HtmlRefusal::Load { need, line, url } => {
            let key = match need {
                Need::Script => "script",
                Need::Style => "style",
                Need::Font => "font",
                Need::Inline => "inline",
                Need::Link => "link",
            };
            let mut params = vec![("line", (*line).into()), ("url", url.as_str().into())];
            if *need != Need::Inline {
                params.push(("hosts", host_list(*need).into()));
            }
            t(&format!("server.artifact.check.{key}"), &params)
        }
        HtmlRefusal::Form { line, url } => t("server.artifact.check.form", &[("line", (*line).into()), ("url", url.as_str().into())]),
        HtmlRefusal::Refresh { line } => t("server.artifact.check.refresh", &[("line", (*line).into())]),
        HtmlRefusal::Base { line } => t("server.artifact.check.base", &[("line", (*line).into())]),
        HtmlRefusal::Frame { line, tag } => t("server.artifact.check.frame", &[("line", (*line).into()), ("tag", tag.as_str().into())]),
    }
}

const SHOWN_MAX: usize = 8;

/// Why a page is refused, in the user's words; "" when it may be kept.
pub fn html_problem(check: &HtmlCheck) -> String {
    if check.refused.is_empty() {
        return String::new();
    }
    let shown: String = check.refused.iter().take(SHOWN_MAX).map(|f| format!("\n- {}", refusal_text(f))).collect();
    let more = if check.refused.len() > SHOWN_MAX {
        format!("\n{}", t("server.artifact.check.more", &[("n", (check.refused.len() - SHOWN_MAX).into())]))
    } else {
        String::new()
    };
    format!("{}{shown}{more}", t("server.artifact.check.refused", &[("n", check.refused.len().into())]))
}
