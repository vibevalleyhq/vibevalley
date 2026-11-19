#![allow(dead_code)]

use std::path::PathBuf;
use std::sync::OnceLock;

use regex::Regex;
use vibevalley_pele::{METRICS_MEASURER, RenderOptions, ThemeMode};

pub fn css_options<'a>() -> RenderOptions<'a> {
    RenderOptions {
        measurer: Some(&METRICS_MEASURER),
        theme_mode: ThemeMode::CssVariables,
        ..RenderOptions::default()
    }
}

pub fn resolved_options<'a>() -> RenderOptions<'a> {
    RenderOptions {
        measurer: Some(&METRICS_MEASURER),
        theme_mode: ThemeMode::light(),
        ..RenderOptions::default()
    }
}

pub fn dark_options<'a>() -> RenderOptions<'a> {
    RenderOptions {
        measurer: Some(&METRICS_MEASURER),
        theme_mode: ThemeMode::dark(),
        ..RenderOptions::default()
    }
}

pub fn load_fixture(filename: &str) -> Vec<String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(filename);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read fixture {}: {e}", path.display()));
    serde_json::from_str::<Vec<String>>(&raw).unwrap_or_else(|e| panic!("failed to parse fixture {}: {e}", path.display()))
}

const ELEMENTS: &[&str] = &[
    "svg", "g", "rect", "circle", "ellipse", "polygon", "path", "text", "tspan", "a", "title", "desc", "image",
];

const ATTRIBUTES: &[&str] = &[
    "xmlns",
    "class",
    "viewBox",
    "width",
    "height",
    "style",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "text-decoration",
    "baseline-shift",
    "fill",
    "fill-opacity",
    "opacity",
    "stroke",
    "stroke-width",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-linejoin",
    "role",
    "aria-roledescription",
    "aria-labelledby",
    "aria-describedby",
    "id",
    "data-id",
    "data-icon",
    "data-href",
    "transform",
    "x",
    "y",
    "rx",
    "ry",
    "r",
    "cx",
    "cy",
    "d",
    "points",
    "text-anchor",
    "xml:space",
    "href",
    "target",
    "rel",
    "preserveAspectRatio",
    "pointer-events",
];

const STYLE_PROPERTIES: &[&str] = &[
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-dasharray",
    "stroke-dashoffset",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-opacity",
    "opacity",
    "rx",
    "ry",
    "font-size",
    "font-family",
    "font-weight",
    "font-style",
    "text-decoration",
    "letter-spacing",
    "word-spacing",
    "max-width",
];

const ROOT_STYLES: &[&str] = &["height:auto", "color:var(--_fg)", "text-transform:none", "direction:ltr"];

const NUMERIC: &[&str] = &["x", "y", "width", "height", "r", "cx", "cy", "rx", "ry"];

struct InertRegexes {
    root_series: Regex,
    root_font: Regex,
    number: Regex,
    script_url: Regex,
    target: Regex,
    unsafe_style: Regex,
    unsafe_paint: Regex,
    scheme_prefix: Regex,
}

fn regexes() -> &'static InertRegexes {
    static RE: OnceLock<InertRegexes> = OnceLock::new();
    RE.get_or_init(|| InertRegexes {
        root_series: Regex::new(r"^--pele-series-[1-8]$").unwrap(),
        root_font: Regex::new(r"^font:\d+(?:\.\d+)?(?:e[-+]?\d+)?px sans-serif$").unwrap(),
        number: Regex::new(r"^(?:-?\d+(?:\.\d+)?(?:e[-+]?\d+)?|100%)$").unwrap(),
        script_url: Regex::new(r"(?i)^[\s\x00-\x1f]*(?:javascript|vbscript|data)\s*:").unwrap(),
        target: Regex::new(r"^_(?:self|blank|parent|top)$").unwrap(),
        unsafe_style: Regex::new(r"(?i)url\s*\(|expression|@import|javascript:|[<>{}\\]").unwrap(),
        unsafe_paint: Regex::new(r"(?i)url\s*\(|javascript:").unwrap(),
        scheme_prefix: Regex::new(r"(?i)^[a-z][a-z0-9+.-]*:").unwrap(),
    })
}

fn is_allowed_url(seen: &str) -> bool {
    let lower = seen.to_ascii_lowercase();
    if lower.starts_with("http:") || lower.starts_with("https:") || lower.starts_with("mailto:") || lower.starts_with("tel:") {
        return true;
    }
    if seen.starts_with("//") || seen.starts_with("\\\\") || seen.starts_with("/\\") || seen.starts_with("\\/") {
        return false;
    }
    !regexes().scheme_prefix.is_match(seen)
}

pub fn assert_well_formed(xml: &str) -> Result<(), String> {
    if xml.chars().any(|c| {
        let code = c as u32;
        (code < 0x20 && !matches!(c, '\t' | '\n' | '\r')) || matches!(code, 0xfffe | 0xffff)
    }) {
        return Err("disallowed XML control character".to_string());
    }
    roxmltree::Document::parse(xml).map(|_| ()).map_err(|e| format!("XML parse error: {e}"))
}

pub fn inert_problem(svg: &str, resolved_mode: bool) -> Option<String> {
    if let Err(err) = assert_well_formed(svg) {
        return Some(err);
    }
    let doc = roxmltree::Document::parse(svg).ok()?;
    let re = regexes();
    for node in doc.descendants().filter(|n| n.is_element()) {
        let el_name = node.tag_name().name();
        if !ELEMENTS.contains(&el_name) {
            return Some(format!("element <{el_name}>"));
        }
        for attr in node.attributes() {
            let full_name = match attr.namespace() {
                Some("http://www.w3.org/XML/1998/namespace") => format!("xml:{}", attr.name()),
                Some(ns) => format!("{ns}:{}", attr.name()),
                None => attr.name().to_string(),
            };
            let name = full_name.as_str();
            let value = attr.value();
            if !ATTRIBUTES.contains(&name) {
                return Some(format!("attribute {name} on <{el_name}>"));
            }
            if resolved_mode && (value.contains("var(--") || value.contains("color-mix(")) {
                return Some(format!("unresolved CSS token in {name}=\"{value}\" on <{el_name}>"));
            }
            if NUMERIC.contains(&name) && !re.number.is_match(value) {
                return Some(format!("{name}=\"{value}\" is not a number"));
            }
            match name {
                "href" => {
                    if el_name != "a" && el_name != "image" {
                        return Some(format!("href on <{el_name}>"));
                    }
                    if re.script_url.is_match(value) {
                        return Some(format!("href=\"{value}\" can run script"));
                    }
                    let stripped: String = value.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
                    let seen = stripped.trim_start_matches(|c: char| (c as u32) <= 0x20);
                    if !is_allowed_url(seen) {
                        return Some(format!("href=\"{value}\" has a scheme that is not allowed"));
                    }
                }
                "target" => {
                    if !re.target.is_match(value) {
                        return Some(format!("target=\"{value}\""));
                    }
                }
                "style" => {
                    if re.unsafe_style.is_match(value) {
                        return Some(format!("style=\"{value}\""));
                    }
                    for decl in value.split(';') {
                        let trimmed = decl.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let prop = match decl.find(':') {
                            Some(colon) => decl[..colon].trim(),
                            None => trimmed,
                        };
                        let root_color = el_name == "svg" && resolved_mode && prop == "color" && !re.unsafe_paint.is_match(trimmed);
                        let root = el_name == "svg"
                            && (ROOT_STYLES.contains(&trimmed) || root_color || re.root_font.is_match(trimmed) || re.root_series.is_match(prop));
                        if !root && !STYLE_PROPERTIES.contains(&prop) && !prop.starts_with("--_") {
                            return Some(format!("style property {prop}"));
                        }
                    }
                }
                "fill" | "stroke" | "font-family" | "rx" if re.unsafe_paint.is_match(value) => {
                    return Some(format!("{name}=\"{value}\""));
                }
                _ => {}
            }
        }
    }
    None
}

pub fn assert_inert(svg: &str, where_ctx: &str) {
    if let Some(problem) = inert_problem(svg, false) {
        panic!("{where_ctx}: {problem}");
    }
}

pub fn assert_inert_resolved(svg: &str, where_ctx: &str) {
    if let Some(problem) = inert_problem(svg, true) {
        panic!("{where_ctx}: {problem}");
    }
    assert!(!svg.contains("<foreignObject"), "{where_ctx}: output must not contain <foreignObject>");
}

pub fn assert_resvg_parses(svg: &str, where_ctx: &str) {
    let opts = usvg::Options::default();
    let tree = usvg::Tree::from_str(svg, &opts).unwrap_or_else(|e| panic!("{where_ctx}: usvg failed to parse SVG: {e}\n{svg}"));
    let size = tree.size();
    assert!(
        size.width() > 0.0 && size.height() > 0.0,
        "{where_ctx}: usvg parsed non-positive size {:?} for SVG",
        size
    );
}

/// Hostile payloads ported from upstream `tests/support/inert.ts`.
pub const PAYLOADS: &[&str] = &[
    "<script>alert(1)</script>",
    "\"><script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<svg onload=alert(1)>",
    "<a href=\"javascript:alert(1)\">x</a>",
    "<foreignObject><iframe src=javascript:alert(1)></iframe></foreignObject>",
    "</text></g></svg><script>alert(1)</script>",
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    " javascript:alert(1)",
    "jav&#x09;ascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "' onload='alert(1)",
    "\" onmouseover=\"alert(1)",
    "x\" onclick=\"alert(1)\" y=\"",
    "#60;script#62;alert(1)#60;/script#62;",
    "#106;avascript:alert(1)",
    "#34; onload=#34;alert(1)",
    "url#40;javascript:alert#40;1#41;#41;",
    "red#59;background:url#40;//evil.example/x#41;",
    "&lt;script&gt;alert(1)&lt;/script&gt;",
    "&#60;script&#62;",
    "url(javascript:alert(1))",
    "expression(alert(1))",
    "red;background:url(//evil.example/x)",
    "red\" onload=\"alert(1)",
    "]]><script>alert(1)</script>",
    "--><script>alert(1)</script>",
    "\u{0000}\u{0001}\u{0008}\u{000b}\u{001f}",
    "a\u{fffe}b\u{ffff}c\u{fffd}d\u{fffd}e#65534;f",
    "u\u{0001}rl(//evil.example/x)",
    "u\u{fffe}RL(//evil.example/x)",
    "u\u{fffd}rl(//evil.example/x)",
    "java\u{fffe}script:alert(1)",
    "java\u{fffd}script:alert(1)",
    "file\u{ffff}:///etc/passwd",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "{{7*7}}",
    "${alert(1)}",
    "%0ajavascript:alert(1)",
    "file:///etc/passwd",
    "//evil.example/share",
    "\\\\evil.example\\share",
    "#92;#92;nevil.example/share",
    "\t/#92;nevil.example/share",
    "smb://evil.example/share",
    "obsidian://open?vault=x",
    "\\\"><script>",
];

pub struct Lcg {
    state: u32,
}

impl Lcg {
    pub fn new(seed: u32) -> Self {
        Self { state: seed }
    }

    pub fn next_f64(&mut self) -> f64 {
        self.state = self.state.wrapping_mul(1664525).wrapping_add(1013904223);
        (self.state as f64) / 4_294_967_296.0
    }

    pub fn next_usize(&mut self, upper: usize) -> usize {
        if upper == 0 {
            return 0;
        }
        (self.next_f64() * (upper as f64)) as usize
    }
}

pub struct Mutator<'a> {
    corpus: &'a [String],
    fragments: Vec<&'a str>,
    rng: Lcg,
}

impl<'a> Mutator<'a> {
    pub fn new(corpus: &'a [String], fragments: Vec<&'a str>, seed: u32) -> Self {
        Self {
            corpus,
            fragments,
            rng: Lcg::new(seed),
        }
    }

    pub fn next_sample(&mut self) -> String {
        let idx = self.rng.next_usize(self.corpus.len());
        let mut chars: Vec<char> = self.corpus[idx].chars().collect();
        let edits = 1 + self.rng.next_usize(3);
        for _ in 0..edits {
            let pos = self.rng.next_usize(chars.len() + 1);
            let r = self.rng.next_f64();
            if r < 0.35 {
                let frag = self.fragments[self.rng.next_usize(self.fragments.len())];
                let insert: Vec<char> = frag.chars().collect();
                chars.splice(pos..pos, insert);
            } else if r < 0.6 {
                let del_end = (pos + 1 + self.rng.next_usize(3)).min(chars.len());
                if pos < del_end {
                    chars.drain(pos..del_end);
                }
            } else if r < 0.75 {
                let other_idx = self.rng.next_usize(self.corpus.len());
                let other: Vec<char> = self.corpus[other_idx].chars().collect();
                if !other.is_empty() {
                    let from = self.rng.next_usize(other.len());
                    let take = self.rng.next_usize(20).min(other.len() - from);
                    chars.splice(pos..pos, other[from..from + take].iter().copied());
                }
            } else if r < 0.9 {
                let dup_end = (pos + self.rng.next_usize(6)).min(chars.len());
                let dup: Vec<char> = chars[pos..dup_end].to_vec();
                chars.splice(pos..pos, dup);
            } else {
                let frag = self.fragments[self.rng.next_usize(self.fragments.len())];
                let insert: Vec<char> = frag.chars().collect();
                let end = (pos + 1).min(chars.len());
                chars.splice(pos..end, insert);
            }
        }
        chars.into_iter().collect()
    }
}
