//! Native `VvMarkdown` component wrapping `nsh_base::text_view()`.
//!
//! Strictly avoids `MarkdownPlugin` and `MarkdownExtension::container` so `nsh-base`'s
//! incremental streaming parser (`incremental.rs`) remains active for every streamed token.
//! Handles inline `#12` issue references and `@mention` via `MarkdownExtension::pattern`, and
//! fenced `mermaid`, `canvas`, `chart`, and `genui` blocks via `MarkdownExtension::language`.

use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use nsh_base::text_view::{
    CodeBlock, CustomNode, Document, Image as TextViewImage, ImageLength, MarkdownExtension, MarkdownOptions, Parser, TextViewClasses, TextViewLinkPressEvent,
    TextViewLinks, TextViewMath, TextViewPart, TextViewParts, TextViewStyles, TextViewTaskPressEvent, text_view,
};
use nsh_core::element::{AnyValue, Children, Component, ImageSrc, NoEvent, PropError, PropSpec, Props, Root, Slot, TsTypes, image_size};
use nsh_core::keymap::Modifiers;
use nsh_core::prelude::*;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::cache::{LruCache, hash_str};
use crate::canvas::vv_canvas;
use crate::chart::vv_chart;
use crate::code_block::{VvCodeCopyEvent, vv_code_block};
use crate::diagram::vv_diagram;
use crate::genui::{VvGenUiActionEvent, vv_gen_ui};
use crate::math::render_math_element;
use crate::theme::{AdaptiveUi, CODE_FONT_MONO, UiPalette};

/// Pattern for `#12` issue references outside code and links.
///
/// Rust's `regex` has no lookbehind, so group `"1"` captures the optional leading boundary
/// (rendered as plain text) and group `"2"` captures the issue number.
pub const PATTERN_ISSUE: &str = r"(^|[\s(（，。,])#(\d+)\b";
/// Pattern for `@mention` tokens outside code and links (enabled when `mentions = true`).
pub const PATTERN_MENTION: &str = r"(^|[\s(（，。,])@([\p{L}\p{N}_-]+)";

/// Closed set of custom Markdown nodes emitted by [`vv_markdown_extensions`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CustomNodeKind {
    Issue,
    Mention,
    Mermaid,
    Canvas,
    Chart,
    GenUi,
}

impl CustomNodeKind {
    /// Extension identifier registered on `MarkdownExtension::name`.
    pub const fn as_name(self) -> &'static str {
        match self {
            Self::Issue => "vv_issue",
            Self::Mention => "vv_mention",
            Self::Mermaid => "vv_mermaid",
            Self::Canvas => "vv_canvas",
            Self::Chart => "vv_chart",
            Self::GenUi => "vv_genui",
        }
    }

    /// Decodes a `CustomNode.name` string into the closed [`CustomNodeKind`] enum.
    pub fn parse(name: &str) -> Option<Self> {
        match name {
            "vv_issue" => Some(Self::Issue),
            "vv_mention" => Some(Self::Mention),
            "vv_mermaid" => Some(Self::Mermaid),
            "vv_canvas" => Some(Self::Canvas),
            "vv_chart" => Some(Self::Chart),
            "vv_genui" => Some(Self::GenUi),
            _ => None,
        }
    }
}

/// Text scale preset for [`VvMarkdown`], matching VibeValley's `Markdown.tsx` and `MarkdownPane.tsx`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum VvMarkdownSize {
    /// Standard chat / report typography (14pt body).
    #[default]
    Base,
    /// Compact panel / sidebar / outline typography (13pt body).
    Sm,
    /// Editorial standalone document typography (14.5pt body, clear heading hierarchy, generous spacing).
    Doc,
}

impl VvMarkdownSize {
    pub const fn is_doc(self) -> bool {
        matches!(self, Self::Doc)
    }

    pub const fn body_pt(self) -> f32 {
        match self {
            Self::Base => 14.0,
            Self::Sm => 13.0,
            Self::Doc => 14.5,
        }
    }

    pub const fn line_height_pt(self) -> f32 {
        match self {
            Self::Base => 22.0,
            Self::Sm => 20.0,
            Self::Doc => 24.0,
        }
    }

    pub const fn h1_pt(self) -> f32 {
        match self {
            Self::Base => 18.0,
            Self::Sm => 16.0,
            Self::Doc => 26.0,
        }
    }

    pub const fn h1_line_height_pt(self) -> f32 {
        match self {
            Self::Base => 24.0,
            Self::Sm => 22.0,
            Self::Doc => 34.0,
        }
    }

    pub const fn h2_pt(self) -> f32 {
        match self {
            Self::Base => 14.0,
            Self::Sm => 13.0,
            Self::Doc => 19.0,
        }
    }

    pub const fn h2_line_height_pt(self) -> f32 {
        match self {
            Self::Base => 22.0,
            Self::Sm => 20.0,
            Self::Doc => 26.0,
        }
    }

    pub const fn h3_pt(self) -> f32 {
        match self {
            Self::Base => 14.0,
            Self::Sm => 13.0,
            Self::Doc => 15.5,
        }
    }

    pub const fn h3_line_height_pt(self) -> f32 {
        match self {
            Self::Base => 22.0,
            Self::Sm => 20.0,
            Self::Doc => 22.5,
        }
    }

    pub const fn h4_pt(self) -> f32 {
        match self {
            Self::Base => 14.0,
            Self::Sm => 13.0,
            Self::Doc => 14.5,
        }
    }

    pub const fn h5_pt(self) -> f32 {
        match self {
            Self::Base => 14.0,
            Self::Sm => 13.0,
            Self::Doc => 13.5,
        }
    }

    pub const fn h6_pt(self) -> f32 {
        match self {
            Self::Base => 14.0,
            Self::Sm => 13.0,
            Self::Doc => 13.0,
        }
    }
}

/// Resolved destination of a Markdown image reference (`![alt](src)` or `<img src="...">`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolvedMarkdownImage {
    /// Remote HTTP(S) URL, inline `data:` URI, or bundled `asset:/` URI.
    Remote { uri: String },
    /// Verified readable local file (canonicalized absolute path accepted by `nsh-core`).
    LocalFile { path: PathBuf, uri: String },
    /// Unresolved or unreadable image reference (rendered as an explicit fallback badge).
    Missing { raw: String },
}

const IMAGE_HEADER_PROBE_BYTES: usize = 65_536;
const IMAGE_META_CACHE_CAPACITY: usize = 128;
const SMALL_INLINE_MAX_WIDTH: f32 = 160.0;
const SMALL_INLINE_MAX_HEIGHT: f32 = 36.0;

fn strip_query_and_fragment(raw: &str) -> &str {
    raw.split(['?', '#']).next().unwrap_or(raw)
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn percent_decode(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex_nibble(bytes[i + 1]), hex_nibble(bytes[i + 2]))
        {
            out.push((hi << 4) | lo);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn has_prefix_ignore_ascii_case(value: &str, prefix: &str) -> bool {
    value.len() >= prefix.len() && value.is_char_boundary(prefix.len()) && value[..prefix.len()].eq_ignore_ascii_case(prefix)
}

fn verify_readable_local_file(candidate: &Path) -> Option<PathBuf> {
    let canonical = std::fs::canonicalize(candidate).ok()?;
    let meta = std::fs::metadata(&canonical).ok()?;
    if !meta.is_file() {
        return None;
    }
    File::open(&canonical).ok()?;
    Some(canonical)
}

fn resolve_local_candidate(raw: &str, base: Option<&Path>) -> Option<PathBuf> {
    let join = |segment: &str| -> PathBuf {
        match base {
            Some(dir) => dir.join(segment),
            None => PathBuf::from(segment),
        }
    };

    if let Some(found) = verify_readable_local_file(&join(raw)) {
        return Some(found);
    }

    let stripped = strip_query_and_fragment(raw);
    if stripped != raw
        && let Some(found) = verify_readable_local_file(&join(stripped))
    {
        return Some(found);
    }

    let decoded = percent_decode(stripped);
    if decoded != stripped
        && let Some(found) = verify_readable_local_file(&join(&decoded))
    {
        return Some(found);
    }

    None
}

/// Resolves a Markdown image `src` against an optional document `base_dir`.
///
/// `nsh-core`'s image loader rejects relative paths (`docs/images/farm.png`, `./a.png`, `../b.png`),
/// accepting only `http(s)://`, `data:`, `asset:/`, `file://`, and absolute filesystem paths.
/// Resolving relative paths to canonical absolute paths lets local images load cleanly and fail
/// explicitly when missing.
pub fn resolve_markdown_image_src(raw_src: &str, base_dir: Option<&str>) -> ResolvedMarkdownImage {
    let trimmed = raw_src.trim();
    if trimmed.is_empty() {
        return ResolvedMarkdownImage::Missing { raw: String::new() };
    }

    if has_prefix_ignore_ascii_case(trimmed, "https://")
        || has_prefix_ignore_ascii_case(trimmed, "http://")
        || has_prefix_ignore_ascii_case(trimmed, "data:")
        || has_prefix_ignore_ascii_case(trimmed, "asset:/")
    {
        return ResolvedMarkdownImage::Remote { uri: trimmed.to_owned() };
    }

    if has_prefix_ignore_ascii_case(trimmed, "file://") {
        let rest = &trimmed["file://".len()..];
        let local = if has_prefix_ignore_ascii_case(rest, "localhost/") {
            &rest["localhost".len()..]
        } else {
            rest
        };
        if Path::new(local).is_absolute()
            && let Some(path) = resolve_local_candidate(local, None)
        {
            let uri = path.to_string_lossy().into_owned();
            return ResolvedMarkdownImage::LocalFile { path, uri };
        }
        return ResolvedMarkdownImage::Missing { raw: trimmed.to_owned() };
    }

    if Path::new(trimmed).is_absolute() {
        if let Some(path) = resolve_local_candidate(trimmed, None) {
            let uri = path.to_string_lossy().into_owned();
            return ResolvedMarkdownImage::LocalFile { path, uri };
        }
        return ResolvedMarkdownImage::Missing { raw: trimmed.to_owned() };
    }

    if let Some(dir) = base_dir.map(str::trim).filter(|d| !d.is_empty())
        && let Some(path) = resolve_local_candidate(trimmed, Some(Path::new(dir)))
    {
        let uri = path.to_string_lossy().into_owned();
        return ResolvedMarkdownImage::LocalFile { path, uri };
    }

    ResolvedMarkdownImage::Missing { raw: trimmed.to_owned() }
}

/// Probes natural pixel dimensions from a local raster image header without decoding full pixels.
pub fn read_local_image_dimensions(path: &Path) -> Option<(f32, f32)> {
    let file = File::open(path).ok()?;
    let mut header = Vec::new();
    file.take(IMAGE_HEADER_PROBE_BYTES as u64).read_to_end(&mut header).ok()?;
    let size = nsh_core::picker::image_size(&header)?;
    (size.width.0 > 0 && size.height.0 > 0).then_some((size.width.0 as f32, size.height.0 as f32))
}

/// Props of [`VvMarkdown`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvMarkdownProps {
    /// Markdown source text to render.
    pub text: Prop<SharedString>,
    /// Typography scale (`"base"`, `"sm"`, or `"doc"`).
    #[prop(default)]
    pub size: Prop<VvMarkdownSize>,
    /// Optional base directory used to resolve relative image paths (e.g. parent dir of a `.md` file).
    #[prop(default)]
    pub base_dir: Prop<Option<SharedString>>,
    /// Enable `@mention` inline parsing (default false).
    #[prop(default)]
    pub mentions: Prop<bool>,
    /// Stream-repair mode for AI replies still arriving token by token (preserves incremental parsing).
    #[prop(default)]
    pub streaming: Prop<bool>,
    /// Allow text selection across rendered blocks (default true).
    #[prop(default = true)]
    pub selectable: Prop<bool>,
    /// How link presses behave (`"report"` default, or `"open"`).
    #[prop(default)]
    pub links: Prop<TextViewLinks>,
    /// Optional Tailwind class overrides per `TextView` part.
    #[prop(default)]
    pub classes: Prop<TextViewClasses>,
    /// Optional inline style overrides per `TextView` part.
    #[prop(default)]
    pub styles: Prop<TextViewStyles>,
}

/// Payload for [`VvMarkdownEvent::LinkPress`].
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct VvLinkPressEvent {
    /// Target URL or document anchor (`#...`).
    pub url: SharedString,
    /// Modifier keys held during the press.
    pub modifiers: Modifiers,
}

/// Payload for [`VvMarkdownEvent::IssuePress`].
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvIssuePressEvent {
    /// Issue number parsed from `#12`.
    pub number: u32,
}

/// Payload for [`VvMarkdownEvent::MentionPress`].
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvMentionPressEvent {
    /// Mentioned handle parsed from `@name`.
    pub name: SharedString,
}

/// Payload for [`VvMarkdownEvent::TaskPress`].
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvTaskPressEvent {
    /// Zero-based task checkbox index in reading order.
    pub index: u32,
    /// Requested checked state after toggling.
    pub checked: bool,
}

/// Typed events emitted by [`VvMarkdown`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum VvMarkdownEvent {
    /// Fired when a standard Markdown link is pressed.
    #[args(event)]
    LinkPress(VvLinkPressEvent),
    /// Fired when an inline `#12` issue reference is pressed.
    #[args(event)]
    IssuePress(VvIssuePressEvent),
    /// Fired when an inline `@mention` is pressed.
    #[args(event)]
    MentionPress(VvMentionPressEvent),
    /// Fired when a GFM task list checkbox is toggled.
    #[args(event)]
    TaskPress(VvTaskPressEvent),
    /// Fired when a fenced code block inside the Markdown is copied.
    #[args(event)]
    CodeCopy(VvCodeCopyEvent),
    /// Fired when an embedded ` ```genui ` block emits an action.
    #[args(event)]
    GenUiAction(VvGenUiActionEvent),
}

/// Constructs [`MarkdownOptions`] for [`VvMarkdown`] with math, GitHub alerts, and HTML enabled,
/// keeping `mdx = false` so `nsh-base`'s incremental streaming parser stays active.
pub fn vv_markdown_options(streaming: bool) -> MarkdownOptions {
    MarkdownOptions {
        math: true,
        alerts: true,
        html: true,
        frontmatter: false,
        mdx: false,
        streaming,
    }
}

/// Constructs the declared [`MarkdownExtension`] list for [`VvMarkdown`].
///
/// Uses only `MarkdownExtension::pattern` and `MarkdownExtension::language` (never `container`)
/// so `nsh-base`'s `incremental()` parser predicate remains `true` during streaming.
pub fn vv_markdown_extensions(mentions: bool) -> Vec<MarkdownExtension> {
    let mut exts = Vec::with_capacity(6);
    exts.push(MarkdownExtension::pattern(CustomNodeKind::Issue.as_name(), PATTERN_ISSUE));
    if mentions {
        exts.push(MarkdownExtension::pattern(CustomNodeKind::Mention.as_name(), PATTERN_MENTION));
    }
    exts.push(MarkdownExtension::language(CustomNodeKind::Mermaid.as_name(), "mermaid"));
    exts.push(MarkdownExtension::language(CustomNodeKind::Canvas.as_name(), "canvas"));
    exts.push(MarkdownExtension::language(CustomNodeKind::Chart.as_name(), "chart"));
    exts.push(MarkdownExtension::language(CustomNodeKind::GenUi.as_name(), "genui"));
    exts
}

/// Verifies that the parser configuration satisfies `nsh-base`'s incremental streaming invariants
/// (`!mdx`, zero `container` extensions, and no `MarkdownPlugin`s installed).
pub fn is_incremental_streaming_safe(options: &MarkdownOptions, extensions: &[MarkdownExtension]) -> bool {
    !options.mdx && extensions.iter().all(|ext| ext.container.is_none())
}

/// Parses Markdown using VibeValley's exact [`vv_markdown_options`] and [`vv_markdown_extensions`].
///
/// Useful for deterministic inspection and unit/integration testing without requiring a UI window.
pub fn parse_vv_markdown(source: &str, mentions: bool, streaming: bool) -> Document {
    Parser::new()
        .options(vv_markdown_options(streaming))
        .extensions(vv_markdown_extensions(mentions))
        .markdown(source)
}

const LINE_STRONG_LIGHT: Hsla = rgba(0x1c19_1724).to_hsla();
const LINE_STRONG_DARK: Hsla = rgba(0xeceb_e829).to_hsla();
const WARN_SOFT: AdaptiveColor = AdaptiveUi::pair(rgb(0xfbf0d9).to_hsla(), rgb(0x332917).to_hsla());
const NOTE_SOFT: AdaptiveColor = AdaptiveUi::pair(rgba(0x2c6a_a312).to_hsla(), rgba(0x6aa6_dc1c).to_hsla());
const IMPORTANT_SOFT: AdaptiveColor = AdaptiveUi::pair(rgba(0x7c5c_bd12).to_hsla(), rgba(0xb48e_f51c).to_hsla());
const IMPORTANT_BORDER_LIGHT: Hsla = rgb(0x6e4eb2).to_hsla();
const IMPORTANT_BORDER_DARK: Hsla = rgb(0xb48ef5).to_hsla();
const TRANSPARENT: Hsla = rgba(0x0000_0000).to_hsla();

/// Builds VibeValley's default `TextViewParts` typography matching `Markdown.tsx` and `MarkdownPane.tsx`.
fn vv_text_view_parts(size: Prop<VvMarkdownSize>) -> TextViewParts {
    TextViewParts::new()
        .part(TextViewPart::Root, move |s| {
            s.min_w(px(0.0))
                .gap(move || px(if size.get().is_doc() { 10.0 } else { 4.0 }))
                .text_size(move || Length::from(px(size.get().body_pt())))
                .line_height(move || px(size.get().line_height_pt()))
                .text_color(AdaptiveUi::INK)
        })
        .part(TextViewPart::Paragraph, move |s| s.my(move || px(if size.get().is_doc() { 4.0 } else { 2.0 })))
        .part(TextViewPart::Heading, |s| {
            s.mt(px(0.0)).mb(px(0.0)).font_weight(FontWeight::SEMIBOLD).text_color(AdaptiveUi::INK)
        })
        .part(TextViewPart::Heading1, move |s| {
            s.text_size(move || Length::from(px(size.get().h1_pt())))
                .line_height(move || px(size.get().h1_line_height_pt()))
                .mt(move || px(if size.get().is_doc() { 4.0 } else { 0.0 }))
                .mb(move || px(if size.get().is_doc() { 6.0 } else { 0.0 }))
                .pb(move || px(if size.get().is_doc() { 10.0 } else { 0.0 }))
                .border_b(move || AbsoluteLength::from(px(if size.get().is_doc() { 1.0 } else { 0.0 })))
                .border_color(AdaptiveUi::LINE)
        })
        .part(TextViewPart::Heading2, move |s| {
            s.text_size(move || Length::from(px(size.get().h2_pt())))
                .line_height(move || px(size.get().h2_line_height_pt()))
                .mt(move || px(if size.get().is_doc() { 22.0 } else { 0.0 }))
                .mb(move || px(if size.get().is_doc() { 4.0 } else { 0.0 }))
                .pb(move || px(if size.get().is_doc() { 7.0 } else { 0.0 }))
                .border_b(move || AbsoluteLength::from(px(if size.get().is_doc() { 1.0 } else { 0.0 })))
                .border_color(AdaptiveUi::LINE)
        })
        .part(TextViewPart::Heading3, move |s| {
            s.text_size(move || Length::from(px(size.get().h3_pt())))
                .line_height(move || px(size.get().h3_line_height_pt()))
                .mt(move || px(if size.get().is_doc() { 16.0 } else { 0.0 }))
                .mb(move || px(if size.get().is_doc() { 2.0 } else { 0.0 }))
        })
        .part(TextViewPart::Heading4, move |s| {
            s.text_size(move || Length::from(px(size.get().h4_pt())))
                .mt(move || px(if size.get().is_doc() { 12.0 } else { 0.0 }))
        })
        .part(TextViewPart::Heading5, move |s| {
            s.text_size(move || Length::from(px(size.get().h5_pt())))
                .mt(move || px(if size.get().is_doc() { 8.0 } else { 0.0 }))
        })
        .part(TextViewPart::Heading6, move |s| {
            s.text_size(move || Length::from(px(size.get().h6_pt()))).text_color(move || {
                let palette = UiPalette::for_mode(dark());
                if size.get().is_doc() { palette.muted } else { palette.ink }
            })
        })
        .part(TextViewPart::Link, |s| {
            s.text_color(AdaptiveUi::WATER)
                .underline()
                .text_decoration_color(move || UiPalette::for_mode(dark()).water.opacity(0.42))
        })
        .part(TextViewPart::Blockquote, move |s| {
            s.my(move || px(if size.get().is_doc() { 6.0 } else { 2.0 }))
                .border_l(move || AbsoluteLength::from(px(if size.get().is_doc() { 3.0 } else { 2.0 })))
                .border_color(move || {
                    let is_dark = dark();
                    if size.get().is_doc() {
                        if is_dark { LINE_STRONG_DARK } else { LINE_STRONG_LIGHT }
                    } else {
                        UiPalette::for_mode(is_dark).line
                    }
                })
                .pl(move || px(if size.get().is_doc() { 14.0 } else { 12.0 }))
                .pr(move || px(if size.get().is_doc() { 12.0 } else { 0.0 }))
                .py(move || px(if size.get().is_doc() { 6.0 } else { 0.0 }))
                .rounded_r(move || Length::from(px(if size.get().is_doc() { 6.0 } else { 0.0 })))
                .bg(move || if size.get().is_doc() { UiPalette::for_mode(dark()).side } else { TRANSPARENT })
                .text_color(AdaptiveUi::MUTED)
        })
        .part(TextViewPart::Alert, move |s| {
            s.my(move || px(if size.get().is_doc() { 8.0 } else { 4.0 }))
                .py(move || px(if size.get().is_doc() { 12.0 } else { 8.0 }))
                .px(move || px(if size.get().is_doc() { 14.0 } else { 12.0 }))
                .rounded(px(8.0))
                .border_1()
                .border_l(px(3.0))
                .text_color(AdaptiveUi::INK)
        })
        .part(TextViewPart::AlertNote, |s| {
            s.bg(NOTE_SOFT).border_color(move || UiPalette::for_mode(dark()).water.opacity(0.45))
        })
        .part(TextViewPart::AlertTip, |s| {
            s.bg(AdaptiveUi::OK_SOFT).border_color(move || UiPalette::for_mode(dark()).leaf.opacity(0.45))
        })
        .part(TextViewPart::AlertImportant, |s| {
            s.bg(IMPORTANT_SOFT).border_color(move || {
                let base = if dark() { IMPORTANT_BORDER_DARK } else { IMPORTANT_BORDER_LIGHT };
                base.opacity(0.45)
            })
        })
        .part(TextViewPart::AlertWarning, |s| {
            s.bg(WARN_SOFT).border_color(move || UiPalette::for_mode(dark()).wheat.opacity(0.55))
        })
        .part(TextViewPart::AlertCaution, |s| {
            s.bg(AdaptiveUi::BAD_SOFT).border_color(move || UiPalette::for_mode(dark()).berry.opacity(0.45))
        })
        .part(TextViewPart::Code, move |s| {
            s.rounded_sm()
                .bg(AdaptiveUi::INLINE_CODE_BG)
                .px(move || px(if size.get().is_doc() { 5.0 } else { 4.0 }))
                .py(move || px(if size.get().is_doc() { 1.0 } else { 0.0 }))
                .font_family(CODE_FONT_MONO)
                .text_size(move || Length::from(px(if size.get().is_doc() { 12.5 } else { 12.0 })))
                .text_color(AdaptiveUi::INK)
        })
        .part(TextViewPart::List, move |s| {
            s.my(move || px(if size.get().is_doc() { 4.0 } else { 2.0 }))
                .pl(move || px(if size.get().is_doc() { 4.0 } else { 16.0 }))
        })
        .part(TextViewPart::ListItem, move |s| s.my(move || px(if size.get().is_doc() { 2.5 } else { 1.0 })))
        .part(TextViewPart::ListMarker, |s| s.text_color(AdaptiveUi::MUTED))
        .part(TextViewPart::Table, move |s| {
            s.my(move || px(if size.get().is_doc() { 10.0 } else { 6.0 }))
                .text_size(move || Length::from(px(if size.get().is_doc() { 13.5 } else { 13.0 })))
                .line_height(move || px(if size.get().is_doc() { 21.0 } else { 19.0 }))
        })
        .part(TextViewPart::TableScroll, move |s| {
            s.rounded(move || Length::from(px(if size.get().is_doc() { 8.0 } else { 6.0 })))
                .overflow_hidden()
                .border_1()
                .border_color(AdaptiveUi::LINE)
        })
        .part(TextViewPart::TableHead, |s| s.bg(AdaptiveUi::SIDE))
        .part(TextViewPart::TableCell, move |s| {
            s.border_r_1()
                .border_b_1()
                .border_color(AdaptiveUi::LINE)
                .px(move || px(if size.get().is_doc() { 14.0 } else { 8.0 }))
                .py(move || px(if size.get().is_doc() { 9.0 } else { 4.0 }))
        })
        .part(TextViewPart::TableHeaderCell, move |s| {
            s.bg(AdaptiveUi::SIDE)
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(AdaptiveUi::INK)
                .text_size(move || Length::from(px(if size.get().is_doc() { 13.0 } else { 12.5 })))
        })
        .part(TextViewPart::Rule, move |s| {
            s.my(move || px(if size.get().is_doc() { 16.0 } else { 6.0 })).border_color(AdaptiveUi::LINE)
        })
}

fn render_missing_image(alt: &str, raw: &str) -> AnyElement {
    let label = alt.trim();
    let title = if label.is_empty() { "Image unavailable" } else { label };
    let path_hint = raw.trim();

    view()
        .test_id("vv-image-missing")
        .flex_row()
        .items_center()
        .gap(px(8.0))
        .px(px(12.0))
        .py(px(8.0))
        .my(px(4.0))
        .rounded(px(8.0))
        .border_1()
        .border_color(AdaptiveUi::LINE)
        .bg(AdaptiveUi::SIDE)
        .max_w(relative(1.0))
        .child(
            text(title.to_owned())
                .text_size(px(12.5))
                .font_weight(FontWeight::MEDIUM)
                .text_color(AdaptiveUi::MUTED),
        )
        .when(!path_hint.is_empty(), |el| {
            el.child(
                text(path_hint.to_owned())
                    .font_family(CODE_FONT_MONO)
                    .text_size(px(11.5))
                    .text_color(AdaptiveUi::FAINT),
            )
        })
        .into_element()
}

fn render_resolved_image(img: &TextViewImage, uri: String, initial_natural: Option<Size<Points>>, size: VvMarkdownSize) -> AnyElement {
    let width = img.width;
    let height = img.height;
    let natural = signal(initial_natural);
    let load_failed = signal(false);

    let has_explicit_box = matches!((width, height), (Some(ImageLength::Points(_)), Some(ImageLength::Points(_))));
    if !has_explicit_box && initial_natural.is_none() {
        let probe_uri = uri.clone();
        spawn(async move {
            match image_size(probe_uri).await {
                Ok(measured) if measured.width.0 > 0 && measured.height.0 > 0 => {
                    natural.set(Some(Size::new(px(measured.width.0 as f32), px(measured.height.0 as f32))));
                }
                Ok(_) | Err(_) => {
                    load_failed.set(true);
                }
            }
        });
    }

    let explicit_ratio = match (width, height) {
        (Some(ImageLength::Points(w)), Some(ImageLength::Points(h))) if h > px(0.0) => Some(w / h),
        _ => None,
    };
    let aspect = move || natural.get().filter(|s| s.width > px(0.0) && s.height > px(0.0)).map(|s| s.width / s.height);
    let box_width = move || -> Length {
        match (width, height) {
            (Some(w), _) => DefiniteLength::from(w).into(),
            (None, Some(ImageLength::Points(h))) => (h * aspect().unwrap_or(1.0)).into(),
            (None, _) => natural.get().map_or(px(0.0), |s| s.width).into(),
        }
    };

    let is_small_inline = initial_natural.is_some_and(|s| s.width < px(SMALL_INLINE_MAX_WIDTH) || s.height <= px(SMALL_INLINE_MAX_HEIGHT))
        || matches!(width, Some(ImageLength::Points(w)) if w < px(SMALL_INLINE_MAX_WIDTH))
        || matches!(height, Some(ImageLength::Points(h)) if h <= px(SMALL_INLINE_MAX_HEIGHT));

    let alt = img.alt.clone();
    let title = img.title.clone();
    let raw_src = img.src.clone();

    view()
        .when(!is_small_inline, |v| v.w_full())
        .child(dynamic(move || {
            if load_failed.get() {
                return render_missing_image(&alt, &raw_src);
            }

            let mut src = ImageSrc::from(uri.clone());
            if let Some(nat) = initial_natural {
                src = src.size(nat);
            }

            let img_el = image(src)
                .test_id("vv-markdown-image")
                .object_fit(ResizeMode::Contain)
                .label(SharedString::from(alt.clone()))
                .when_some(title.clone(), |el, t| el.hint(t))
                .w_full()
                .aspect_ratio(move || explicit_ratio.or_else(aspect).unwrap_or(16.0 / 10.0));

            if is_small_inline {
                return view().w(box_width).max_w(relative(1.0)).child(img_el.rounded(px(4.0))).into_element();
            }

            let frame = view()
                .w(box_width)
                .max_w(relative(1.0))
                .rounded(px(if size.is_doc() { 10.0 } else { 8.0 }))
                .overflow_hidden()
                .border_1()
                .border_color(AdaptiveUi::LINE)
                .bg(AdaptiveUi::SIDE)
                .child(img_el);

            let caption = alt.trim();
            view()
                .w_full()
                .flex_col()
                .items_center()
                .my(px(if size.is_doc() { 12.0 } else { 6.0 }))
                .gap(px(8.0))
                .child(frame)
                .when(size.is_doc() && !caption.is_empty(), |el| {
                    el.child(
                        text(caption.to_owned())
                            .test_id("vv-image-caption")
                            .text_size(px(12.0))
                            .line_height(px(18.0))
                            .text_color(AdaptiveUi::MUTED)
                            .text_center(),
                    )
                })
                .into_element()
        }))
        .into_element()
}

struct ImageMetaCacheKey {
    raw_src: String,
    base_dir: Option<String>,
}

type ImageMetaEntry = (ResolvedMarkdownImage, Option<(f32, f32)>);

fn image_meta_cache() -> &'static Mutex<LruCache<ImageMetaCacheKey, ImageMetaEntry>> {
    static CACHE: OnceLock<Mutex<LruCache<ImageMetaCacheKey, ImageMetaEntry>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(LruCache::new(IMAGE_META_CACHE_CAPACITY)))
}

fn resolve_markdown_image_cached(raw_src: &str, base_dir: Option<&str>) -> (ResolvedMarkdownImage, Option<(f32, f32)>) {
    let hash = hash_str(raw_src) ^ base_dir.map_or(0, |d| hash_str(d).rotate_left(13));
    if let Some(hit) = image_meta_cache()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get_by(hash, |k| k.raw_src == raw_src && k.base_dir.as_deref() == base_dir)
    {
        return hit;
    }

    let resolved = resolve_markdown_image_src(raw_src, base_dir);
    let dims = match &resolved {
        ResolvedMarkdownImage::LocalFile { path, .. } => read_local_image_dimensions(path),
        ResolvedMarkdownImage::Remote { .. } | ResolvedMarkdownImage::Missing { .. } => None,
    };
    let entry = (resolved, dims);
    if !matches!(entry.0, ResolvedMarkdownImage::Missing { .. }) {
        let key = ImageMetaCacheKey {
            raw_src: raw_src.to_owned(),
            base_dir: base_dir.map(str::to_owned),
        };
        image_meta_cache()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert_by(hash, key, entry.clone(), |k| k.raw_src == raw_src && k.base_dir.as_deref() == base_dir);
    }
    entry
}

fn render_markdown_image(img: &TextViewImage, base_dir: Option<&str>, size: VvMarkdownSize) -> AnyElement {
    let (resolved, dims) = resolve_markdown_image_cached(&img.src, base_dir);
    match resolved {
        ResolvedMarkdownImage::Missing { raw } => render_missing_image(&img.alt, &raw),
        ResolvedMarkdownImage::LocalFile { uri, .. } => {
            let initial_natural = dims.map(|(w, h)| Size::new(px(w), px(h)));
            render_resolved_image(img, uri, initial_natural, size)
        }
        ResolvedMarkdownImage::Remote { uri } => render_resolved_image(img, uri, None, size),
    }
}

fn with_optional_prefix(prefix: &str, token: Text) -> AnyElement {
    if prefix.is_empty() {
        token.into_element()
    } else {
        text("").child(text(prefix.to_owned())).child(token).into_element()
    }
}

fn render_custom_node(node: &CustomNode, streaming: bool, cx: Scope<VvMarkdownEvent>) -> AnyElement {
    let Some(kind) = CustomNodeKind::parse(&node.name) else {
        return text(node.text.clone()).into_element();
    };

    match kind {
        CustomNodeKind::Issue => {
            let prefix = node.attributes.get("1").map(String::as_str).unwrap_or("");
            let raw_num = node.attributes.get("2").map(String::as_str).unwrap_or("");
            let Ok(number) = raw_num.parse::<u32>() else {
                return text(node.text.clone()).into_element();
            };
            let span = text(format!("#{number}"))
                .test_id("vv-issue")
                .role(AccessibilityRole::Link)
                .text_color(AdaptiveUi::WATER)
                .underline()
                .cursor_pointer()
                .on_press(move |_: &PressEvent| {
                    cx.emit(VvMarkdownEvent::IssuePress(VvIssuePressEvent { number }));
                });
            with_optional_prefix(prefix, span)
        }
        CustomNodeKind::Mention => {
            let prefix = node.attributes.get("1").map(String::as_str).unwrap_or("");
            let name = node.attributes.get("2").cloned().unwrap_or_default();
            if name.is_empty() {
                return text(node.text.clone()).into_element();
            }
            let display = format!("@{name}");
            let name_shared = SharedString::from(name);
            let span = text(display)
                .test_id("vv-mention")
                .role(AccessibilityRole::Button)
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(AdaptiveUi::ACCENT)
                .cursor_pointer()
                .on_press(move |_: &PressEvent| {
                    cx.emit(VvMarkdownEvent::MentionPress(VvMentionPressEvent { name: name_shared.clone() }));
                });
            with_optional_prefix(prefix, span)
        }
        CustomNodeKind::Mermaid => vv_diagram().source(node.text.clone()).into_element(),
        CustomNodeKind::Canvas => vv_canvas().data(node.text.clone()).streaming(streaming).into_element(),
        CustomNodeKind::Chart => vv_chart().spec(node.text.clone()).streaming(streaming).into_element(),
        CustomNodeKind::GenUi => vv_gen_ui()
            .spec(node.text.clone())
            .streaming(streaming)
            .on_action(move |ev: &VvGenUiActionEvent| {
                cx.emit(VvMarkdownEvent::GenUiAction(ev.clone()));
            })
            .into_element(),
    }
}

/// VibeValley's native Markdown renderer wrapping `nsh_base::text_view()`.
///
/// Supports GitHub Flavored Markdown, `ratex` math, GitHub alerts, incremental streaming,
/// `#12` issue references, `@mentions`, pure-Rust Shiki code blocks, Mermaid diagrams,
/// JSON Canvas, native SVG Charts, and reactive GenUI surfaces with zero JS string-splicing.
#[component]
pub fn VvMarkdown(props: VvMarkdownProps, cx: Scope<VvMarkdownEvent>) -> impl IntoElement {
    provide_context(vv_text_view_parts(props.size));

    let options = computed(move || vv_markdown_options(props.streaming.get()));
    let extensions = computed(move || vv_markdown_extensions(props.mentions.get()));
    let streaming_prop = props.streaming;
    let selectable_prop = props.selectable;
    let size_prop = props.size;
    let base_dir_prop = props.base_dir;

    text_view()
        .markdown(move || Some(props.text.get()))
        .options(options)
        .extensions(extensions)
        .selectable(props.selectable)
        .links(props.links)
        .classes(props.classes)
        .styles(props.styles)
        .render_image(move |img: &TextViewImage| {
            let owned = img.clone();
            dynamic(move || {
                let base_dir = base_dir_prop.get();
                render_markdown_image(&owned, base_dir.as_deref(), size_prop.get())
            })
        })
        .render_math(move |math: &TextViewMath| render_math_element(&math.tex, math.display, size_prop.get().body_pt(), selectable_prop.get()))
        .render_custom(move |node: &CustomNode| render_custom_node(node, streaming_prop.get(), cx))
        .render_code_block(move |block: &CodeBlock| {
            vv_code_block()
                .code(block.code.clone())
                .language(block.language.clone().map(SharedString::from))
                .selectable(selectable_prop.get())
                .wrap(block.wrap)
                .on_copy(move |ev: &VvCodeCopyEvent| {
                    cx.emit(VvMarkdownEvent::CodeCopy(ev.clone()));
                })
        })
        .on_link_press(move |ev: &TextViewLinkPressEvent| {
            cx.emit(VvMarkdownEvent::LinkPress(VvLinkPressEvent {
                url: ev.url.clone(),
                modifiers: ev.modifiers,
            }));
        })
        .on_task_press(move |ev: &TextViewTaskPressEvent| {
            cx.emit(VvMarkdownEvent::TaskPress(VvTaskPressEvent {
                index: ev.index,
                checked: ev.checked,
            }));
        })
}

/// Document payload pushed into a pure-Rust [`NativeMarkdownRoot`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeMarkdownDoc {
    pub text: String,
    pub base_dir: Option<String>,
}

/// User interactions emitted by a pure-Rust [`NativeMarkdownRoot`] back to its GPUI host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeMarkdownEvent {
    LinkPress(String),
    IssuePress(u32),
    GenUiAction { action: String, payload: String },
    CodeCopy(String),
}

/// Pure-Rust `nsh_core` root surface hosting [`VvMarkdown`] without spawning a QuickJS VM.
pub struct NativeMarkdownRoot {
    pub root: Root,
    pub doc_tx: UnboundedSender<NativeMarkdownDoc>,
    pub event_rx: UnboundedReceiver<NativeMarkdownEvent>,
}

struct NativeMarkdownBridge {
    initial: NativeMarkdownDoc,
    doc_rx: Mutex<Option<UnboundedReceiver<NativeMarkdownDoc>>>,
    event_tx: UnboundedSender<NativeMarkdownEvent>,
}

struct BridgeHandle(Arc<NativeMarkdownBridge>);

impl Clone for BridgeHandle {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl PartialEq for BridgeHandle {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

#[derive(Clone, PartialEq)]
struct NativeMarkdownSurfaceProps {
    bridge: Option<BridgeHandle>,
}

impl Props for NativeMarkdownSurfaceProps {
    fn spec(_: &mut TsTypes) -> Vec<PropSpec> {
        Vec::new()
    }

    fn initial() -> Self {
        Self { bridge: None }
    }

    fn set(&mut self, name: &str, _: Option<AnyValue>) -> Result<bool, PropError> {
        Err(PropError(format!("unknown prop `{name}`")))
    }

    fn set_slot(&mut self, _: &str, _: Option<Slot>) -> bool {
        false
    }

    fn set_children(&mut self, _: Children) -> bool {
        false
    }
}

struct NativeMarkdownSurface;

impl Component for NativeMarkdownSurface {
    type Props = NativeMarkdownSurfaceProps;
    type Event = NoEvent;

    fn view(props: Self::Props, _cx: Scope<Self::Event>) -> impl IntoElement {
        let bridge = props.bridge.as_ref().map(|handle| Arc::clone(&handle.0));
        let initial = bridge.as_ref().map(|b| b.initial.clone()).unwrap_or_default();
        let text_sig = signal(SharedString::from(initial.text));
        let base_dir_sig = signal(initial.base_dir.map(SharedString::from));

        if let Some(ref bridge) = bridge
            && let Some(mut rx) = bridge.doc_rx.lock().ok().and_then(|mut guard| guard.take())
        {
            spawn(async move {
                while let Some(doc) = rx.recv().await {
                    if text_sig.with_untracked(|cur| cur.as_str() != doc.text) {
                        text_sig.set(SharedString::from(doc.text));
                    }
                    if base_dir_sig.with_untracked(|cur| cur.as_deref() != doc.base_dir.as_deref()) {
                        base_dir_sig.set(doc.base_dir.map(SharedString::from));
                    }
                }
            });
        }

        let link_tx = bridge.as_ref().map(|b| b.event_tx.clone());
        let issue_tx = bridge.as_ref().map(|b| b.event_tx.clone());
        let genui_tx = bridge.as_ref().map(|b| b.event_tx.clone());
        let copy_tx = bridge.as_ref().map(|b| b.event_tx.clone());

        scroll().flex_1().min_h(px(0.0)).bg(AdaptiveUi::PAGE).child(
            view().w_full().items_center().child(
                view().w_full().max_w(px(820.0)).px(px(40.0)).py(px(32.0)).child(
                    vv_markdown()
                        .text(move || text_sig.get())
                        .size(VvMarkdownSize::Doc)
                        .base_dir(move || base_dir_sig.get())
                        .selectable(true)
                        .on_link_press(move |ev: &VvLinkPressEvent| {
                            if let Some(ref tx) = link_tx {
                                let _ = tx.send(NativeMarkdownEvent::LinkPress(ev.url.to_string()));
                            }
                        })
                        .on_issue_press(move |ev: &VvIssuePressEvent| {
                            if let Some(ref tx) = issue_tx {
                                let _ = tx.send(NativeMarkdownEvent::IssuePress(ev.number));
                            }
                        })
                        .on_gen_ui_action(move |ev: &VvGenUiActionEvent| {
                            if let Some(ref tx) = genui_tx {
                                let _ = tx.send(NativeMarkdownEvent::GenUiAction {
                                    action: ev.action.to_string(),
                                    payload: ev.payload.to_string(),
                                });
                            }
                        })
                        .on_code_copy(move |ev: &VvCodeCopyEvent| {
                            if let Some(ref tx) = copy_tx {
                                let _ = tx.send(NativeMarkdownEvent::CodeCopy(ev.code.to_string()));
                            }
                        }),
                ),
            ),
        )
    }
}

/// Builds a pure-Rust [`Root`] rendering a scrollable, centered editorial [`VvMarkdown`]
/// document so GPUI panes can preview Markdown files with zero QuickJS VMs.
pub fn native_markdown_root(initial: NativeMarkdownDoc, capabilities_json: Option<&str>) -> NativeMarkdownRoot {
    let (doc_tx, doc_rx) = unbounded_channel();
    let (event_tx, event_rx) = unbounded_channel();
    let bridge = Arc::new(NativeMarkdownBridge {
        initial,
        doc_rx: Mutex::new(Some(doc_rx)),
        event_tx,
    });
    let mut root = Root::new::<NativeMarkdownSurface>(move || NativeMarkdownSurfaceProps {
        bridge: Some(BridgeHandle(Arc::clone(&bridge))),
    })
    .app_id("dev.vibevalley.markdown");
    if let Some(caps) = capabilities_json {
        root = root.capabilities_json(caps);
    }
    NativeMarkdownRoot { root, doc_tx, event_rx }
}
