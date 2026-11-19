//! Native `VvMarkdown` component wrapping `nsh_base::text_view()`.
//!
//! Strictly avoids `MarkdownPlugin` and `MarkdownExtension::container` so `nsh-base`'s
//! incremental streaming parser (`incremental.rs`) remains active for every streamed token.
//! Handles inline `#12` issue references, `@mention`, PKM `![[embed]]`, `[[wikilink]]`,
//! `((block-ref))`, `==remark==^[note]`, and `#tag` via `MarkdownExtension::pattern`, and
//! fenced `mermaid`, `canvas`, `chart`, and `genui` blocks via `MarkdownExtension::language`.

use nsh_base::text_view::{
    CodeBlock, CustomNode, Document, MarkdownExtension, MarkdownOptions, Parser, TextViewClasses, TextViewLinkPressEvent, TextViewLinks, TextViewPart,
    TextViewParts, TextViewStyles, TextViewTaskPressEvent, text_view,
};
use nsh_core::keymap::Modifiers;
use nsh_core::prelude::*;
use vibevalley_i18n::t;
use vibevalley_pkm::slug_of;

use crate::canvas::vv_canvas;
use crate::chart::vv_chart;
use crate::code_block::{VvCodeCopyEvent, vv_code_block};
use crate::diagram::vv_diagram;
use crate::genui::{VvGenUiActionEvent, vv_gen_ui};
use crate::theme::{AdaptiveUi, CODE_FONT_MONO, UiPalette};

/// Pattern for `#12` issue references outside code and links.
///
/// Rust's `regex` has no lookbehind, so group `"1"` captures the optional leading boundary
/// (rendered as plain text) and group `"2"` captures the issue number.
pub const PATTERN_ISSUE: &str = r"(^|[\s(（，。,])#(\d+)\b";
/// Pattern for `@mention` tokens outside code and links (enabled when `mentions = true`).
pub const PATTERN_MENTION: &str = r"(^|[\s(（，。,])@([\p{L}\p{N}_-]+)";
/// Pattern for PKM `![[embed]]` transclusions (must precede `PATTERN_WIKILINK`).
pub const PATTERN_EMBED: &str = r"!\[\[([^\[\]]+?)\]\]";
/// Pattern for PKM `[[page]]` and `[[page|alias]]` wikilinks.
pub const PATTERN_WIKILINK: &str = r"\[\[([^\[\]]+?)\]\]";
/// Pattern for PKM `((block-id))` block references.
pub const PATTERN_BLOCK_REF: &str = r"\(\(([0-9a-fA-F-]{8,36})\)\)";
/// Pattern for PKM `==highlighted words==^[remark note]` inline remarks.
pub const PATTERN_REMARK: &str = r"==([^=]+)==\^\[([^\]]+)\]";
/// Pattern for PKM `#tag` tokens (starts with a Unicode letter so `#12` issues never collide).
pub const PATTERN_TAG: &str = r"(^|[\s(（，。,])#([\p{L}][\p{L}\p{N}_/-]*)";

/// Closed set of custom Markdown nodes emitted by [`vv_markdown_extensions`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CustomNodeKind {
    Issue,
    Mention,
    Embed,
    Wikilink,
    BlockRef,
    Remark,
    Tag,
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
            Self::Embed => "vv_embed",
            Self::Wikilink => "vv_wikilink",
            Self::BlockRef => "vv_block_ref",
            Self::Remark => "vv_remark",
            Self::Tag => "vv_tag",
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
            "vv_embed" => Some(Self::Embed),
            "vv_wikilink" => Some(Self::Wikilink),
            "vv_block_ref" => Some(Self::BlockRef),
            "vv_remark" => Some(Self::Remark),
            "vv_tag" => Some(Self::Tag),
            "vv_mermaid" => Some(Self::Mermaid),
            "vv_canvas" => Some(Self::Canvas),
            "vv_chart" => Some(Self::Chart),
            "vv_genui" => Some(Self::GenUi),
            _ => None,
        }
    }
}

/// Text scale preset for [`VvMarkdown`], matching VibeValley's `Markdown.tsx`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum VvMarkdownSize {
    /// Standard chat / report typography (14pt body).
    #[default]
    Base,
    /// Compact panel / sidebar / outline typography (13pt body).
    Sm,
}

impl VvMarkdownSize {
    const fn body_pt(self) -> f32 {
        match self {
            Self::Base => 14.0,
            Self::Sm => 13.0,
        }
    }

    const fn h1_pt(self) -> f32 {
        match self {
            Self::Base => 18.0,
            Self::Sm => 16.0,
        }
    }

    const fn line_height_pt(self) -> f32 {
        match self {
            Self::Base => 22.0,
            Self::Sm => 20.0,
        }
    }
}

/// Resolved PKM block transclusion passed to [`VvMarkdown`] for `((block-ref))` and `![[embed]]`.
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct BlockRefPayload {
    /// Referenced block id (or embed target key).
    pub block: SharedString,
    /// Resolved body text of the referenced block, if found.
    pub body: Option<SharedString>,
    /// Slug of the page owning the block, if known.
    pub page: Option<SharedString>,
    /// Human-readable title of the owning page (for tooltip/accessibility hints).
    pub page_title: Option<SharedString>,
    /// Whether the referenced block exists in the vault (default true).
    #[prop(default = true)]
    pub found: bool,
}

/// Props of [`VvMarkdown`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct VvMarkdownProps {
    /// Markdown source text to render.
    pub text: Prop<SharedString>,
    /// Typography scale (`"base"` or `"sm"`).
    #[prop(default)]
    pub size: Prop<VvMarkdownSize>,
    /// Enable `@mention` inline parsing (default false).
    #[prop(default)]
    pub mentions: Prop<bool>,
    /// Enable PKM inline syntax (`![[embed]]`, `[[wikilink]]`, `((block-ref))`, `==remark==^[note]`, `#tag`).
    #[prop(default)]
    pub pkm: Prop<bool>,
    /// Resolved block transclusions used when rendering `((block-ref))` and `![[embed]]` nodes.
    #[prop(default)]
    pub refs: Prop<Vec<BlockRefPayload>>,
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

/// Payload for [`VvMarkdownEvent::WikilinkPress`].
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvWikilinkPressEvent {
    /// Normalized page slug (`vibevalley_pkm::slug_of`).
    pub page: SharedString,
    /// Display text shown for the wikilink or tag.
    pub label: SharedString,
}

/// Payload for [`VvMarkdownEvent::BlockRefPress`].
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvBlockRefPressEvent {
    /// Block identifier parsed from `((id))`.
    pub id: SharedString,
    /// Owning page slug, if supplied in `refs`.
    pub page: Option<SharedString>,
}

/// Payload for [`VvMarkdownEvent::EmbedPress`].
#[derive(Debug, Clone, Default, PartialEq, Eq, JsObject)]
pub struct VvEmbedPressEvent {
    /// Raw embed target parsed from `![[target]]`.
    pub target: SharedString,
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
    /// Fired when a PKM `[[wikilink]]` or `#tag` is pressed.
    #[args(event)]
    WikilinkPress(VvWikilinkPressEvent),
    /// Fired when a PKM `((block-ref))` is pressed.
    #[args(event)]
    BlockRefPress(VvBlockRefPressEvent),
    /// Fired when a PKM `![[embed]]` is pressed.
    #[args(event)]
    EmbedPress(VvEmbedPressEvent),
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
pub fn vv_markdown_extensions(mentions: bool, pkm: bool) -> Vec<MarkdownExtension> {
    let mut exts = Vec::with_capacity(11);
    if pkm {
        // `![[embed]]` MUST precede `[[wikilink]]` so embeds capture the leading `!`.
        exts.push(MarkdownExtension::pattern(CustomNodeKind::Embed.as_name(), PATTERN_EMBED));
        exts.push(MarkdownExtension::pattern(CustomNodeKind::Wikilink.as_name(), PATTERN_WIKILINK));
        exts.push(MarkdownExtension::pattern(CustomNodeKind::BlockRef.as_name(), PATTERN_BLOCK_REF));
        exts.push(MarkdownExtension::pattern(CustomNodeKind::Remark.as_name(), PATTERN_REMARK));
    }
    exts.push(MarkdownExtension::pattern(CustomNodeKind::Issue.as_name(), PATTERN_ISSUE));
    if pkm {
        exts.push(MarkdownExtension::pattern(CustomNodeKind::Tag.as_name(), PATTERN_TAG));
    }
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
pub fn parse_vv_markdown(source: &str, mentions: bool, pkm: bool, streaming: bool) -> Document {
    Parser::new()
        .options(vv_markdown_options(streaming))
        .extensions(vv_markdown_extensions(mentions, pkm))
        .markdown(source)
}

/// Splits a wikilink payload (`"Page"` or `"Page|Display Label"`) into `(page_slug, display_label)`.
pub fn parse_wikilink_target(raw: &str) -> (String, String) {
    match raw.split_once('|') {
        Some((page, label)) => {
            let trimmed_label = label.trim();
            let display = if trimmed_label.is_empty() { page.trim() } else { trimmed_label };
            (slug_of(page), display.to_owned())
        }
        None => (slug_of(raw), raw.trim().to_owned()),
    }
}

/// Strips the leading `💬` prefix from PKM inline remarks, matching `packages/pkm/src/view.ts`.
pub fn clean_remark_note(raw: &str) -> String {
    raw.trim_start().strip_prefix('💬').unwrap_or(raw).trim().to_owned()
}

/// Builds VibeValley's default `TextViewParts` typography matching `Markdown.tsx`.
fn vv_text_view_parts(size: Prop<VvMarkdownSize>) -> TextViewParts {
    TextViewParts::new()
        .part(TextViewPart::Root, move |s| {
            s.min_w(px(0.0))
                .gap(px(4.0))
                .text_size(move || Length::from(px(size.get().body_pt())))
                .line_height(move || px(size.get().line_height_pt()))
                .text_color(AdaptiveUi::INK)
        })
        .part(TextViewPart::Paragraph, |s| s.my(px(2.0)))
        .part(TextViewPart::Heading, |s| s.mt(px(0.0)).mb(px(0.0)).font_weight(FontWeight::SEMIBOLD))
        .part(TextViewPart::Heading1, move |s| s.text_size(move || Length::from(px(size.get().h1_pt()))))
        .part(TextViewPart::Heading2, move |s| s.text_size(move || Length::from(px(size.get().body_pt()))))
        .part(TextViewPart::Heading3, move |s| s.text_size(move || Length::from(px(size.get().body_pt()))))
        .part(TextViewPart::Heading4, move |s| s.text_size(move || Length::from(px(size.get().body_pt()))))
        .part(TextViewPart::Heading5, move |s| s.text_size(move || Length::from(px(size.get().body_pt()))))
        .part(TextViewPart::Heading6, move |s| s.text_size(move || Length::from(px(size.get().body_pt()))))
        .part(TextViewPart::Link, |s| s.text_color(AdaptiveUi::WATER).underline())
        .part(TextViewPart::Blockquote, |s| {
            s.my(px(2.0))
                .border_l(px(2.0))
                .border_color(AdaptiveUi::LINE)
                .pl(px(12.0))
                .text_color(AdaptiveUi::MUTED)
        })
        .part(TextViewPart::Code, |s| {
            s.rounded_sm()
                .bg(AdaptiveUi::INLINE_CODE_BG)
                .px(px(4.0))
                .font_family(CODE_FONT_MONO)
                .text_size(px(12.0))
        })
        .part(TextViewPart::List, |s| s.my(px(2.0)).pl(px(16.0)))
        .part(TextViewPart::ListItem, |s| s.my(px(1.0)))
        .part(TextViewPart::Table, |s| s.my(px(6.0)))
        .part(TextViewPart::TableCell, |s| s.border_1().border_color(AdaptiveUi::LINE).px(px(8.0)).py(px(2.0)))
        .part(TextViewPart::TableHeaderCell, |s| {
            s.font_weight(FontWeight::SEMIBOLD).text_color(AdaptiveUi::INK)
        })
        .part(TextViewPart::Rule, |s| s.my(px(6.0)).border_color(AdaptiveUi::LINE))
}

fn with_optional_prefix(prefix: &str, token: Text) -> AnyElement {
    if prefix.is_empty() {
        token.into_element()
    } else {
        text("").child(text(prefix.to_owned())).child(token).into_element()
    }
}

fn render_custom_node(node: &CustomNode, refs: &[BlockRefPayload], streaming: bool, cx: Scope<VvMarkdownEvent>) -> AnyElement {
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
        CustomNodeKind::Embed => {
            let target = node.attributes.get("1").cloned().unwrap_or_default();
            if target.is_empty() {
                return text(node.text.clone()).into_element();
            }
            let matched = refs.iter().find(|r| r.block.as_str() == target.as_str());
            let target_shared = SharedString::from(target.clone());
            let display = matched.and_then(|r| r.body.clone()).unwrap_or_else(|| SharedString::from(target));
            let missing = matched.is_some_and(|r| !r.found);
            let hint = matched
                .and_then(|r| r.page_title.as_ref())
                .map(|page| SharedString::from(t("web.pkm.page.refFrom", &[("page", page.as_str().into())])));

            text(display)
                .test_id("vv-embed")
                .role(AccessibilityRole::Link)
                .rounded_sm()
                .px(px(4.0))
                .bg(AdaptiveUi::SIDE)
                .text_color(if missing { AdaptiveUi::BERRY } else { AdaptiveUi::WATER })
                .underline()
                .cursor_pointer()
                .when_some(hint, |el, h| el.hint(h))
                .on_press(move |_: &PressEvent| {
                    cx.emit(VvMarkdownEvent::EmbedPress(VvEmbedPressEvent { target: target_shared.clone() }));
                })
                .into_element()
        }
        CustomNodeKind::Wikilink => {
            let raw = node.attributes.get("1").map(String::as_str).unwrap_or("");
            if raw.is_empty() {
                return text(node.text.clone()).into_element();
            }
            let (page, label) = parse_wikilink_target(raw);
            let page_shared = SharedString::from(page);
            let label_shared = SharedString::from(label.clone());
            text(label)
                .test_id("pkm-link")
                .role(AccessibilityRole::Link)
                .text_color(AdaptiveUi::WATER)
                .underline()
                .text_decoration_color(move || UiPalette::for_mode(dark()).water.opacity(0.35))
                .cursor_pointer()
                .on_press(move |_: &PressEvent| {
                    cx.emit(VvMarkdownEvent::WikilinkPress(VvWikilinkPressEvent {
                        page: page_shared.clone(),
                        label: label_shared.clone(),
                    }));
                })
                .into_element()
        }
        CustomNodeKind::BlockRef => {
            let id = node.attributes.get("1").cloned().unwrap_or_default();
            if id.is_empty() {
                return text(node.text.clone()).into_element();
            }
            let matched = refs.iter().find(|r| r.block.as_str() == id.as_str());
            let found = matched.is_some_and(|r| r.found);
            let display = matched
                .and_then(|r| r.body.clone())
                .unwrap_or_else(|| SharedString::from(t("web.pkm.page.missingRef", &[])));
            let hint = matched
                .and_then(|r| r.page_title.as_ref())
                .map(|page| SharedString::from(t("web.pkm.page.refFrom", &[("page", page.as_str().into())])));
            let page = matched.and_then(|r| r.page.clone());
            let id_shared = SharedString::from(id);

            text(display)
                .test_id("pkm-ref")
                .role(AccessibilityRole::Link)
                .underline()
                .text_decoration_dotted()
                .text_decoration_color(move || UiPalette::for_mode(dark()).faint.opacity(0.55))
                .text_color(if found { AdaptiveUi::INK } else { AdaptiveUi::BERRY })
                .cursor_pointer()
                .when_some(hint, |el, h| el.hint(h))
                .on_press(move |_: &PressEvent| {
                    cx.emit(VvMarkdownEvent::BlockRefPress(VvBlockRefPressEvent {
                        id: id_shared.clone(),
                        page: page.clone(),
                    }));
                })
                .into_element()
        }
        CustomNodeKind::Remark => {
            let words = node.attributes.get("1").cloned().unwrap_or_default();
            let raw_note = node.attributes.get("2").map(String::as_str).unwrap_or("");
            let note = clean_remark_note(raw_note);
            let note_shared = SharedString::from(note);
            text(words)
                .test_id("pkm-remark")
                .text_color(AdaptiveUi::INK)
                .underline()
                .text_decoration_color(move || UiPalette::for_mode(dark()).wheat.opacity(0.75))
                .when(!note_shared.is_empty(), |el| {
                    let h = note_shared.clone();
                    el.hint(h.clone()).tooltip(text(h))
                })
                .into_element()
        }
        CustomNodeKind::Tag => {
            let prefix = node.attributes.get("1").map(String::as_str).unwrap_or("");
            let tag = node.attributes.get("2").map(String::as_str).unwrap_or("");
            if tag.is_empty() {
                return text(node.text.clone()).into_element();
            }
            let page = SharedString::from(slug_of(tag));
            let label = SharedString::from(format!("#{tag}"));
            let span = text(label.clone())
                .test_id("pkm-tag")
                .role(AccessibilityRole::Link)
                .text_color(AdaptiveUi::WATER)
                .underline()
                .text_decoration_color(move || UiPalette::for_mode(dark()).water.opacity(0.35))
                .cursor_pointer()
                .on_press(move |_: &PressEvent| {
                    cx.emit(VvMarkdownEvent::WikilinkPress(VvWikilinkPressEvent {
                        page: page.clone(),
                        label: label.clone(),
                    }));
                });
            with_optional_prefix(prefix, span)
        }
        CustomNodeKind::Mermaid => vv_diagram().source(node.text.clone()).into_element(),
        CustomNodeKind::Canvas => vv_canvas().data(node.text.clone()).into_element(),
        CustomNodeKind::Chart => vv_chart().spec(node.text.clone()).into_element(),
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
/// `#12` issue references, `@mentions`, PKM syntax (`![[embed]]`, `[[wikilink]]`, `((block-ref))`,
/// `==remark==^[note]`, `#tag`), pure-Rust Shiki code blocks, Mermaid diagrams, JSON Canvas,
/// native SVG Charts, and reactive GenUI surfaces with zero JS string-splicing.
#[component]
pub fn VvMarkdown(props: VvMarkdownProps, cx: Scope<VvMarkdownEvent>) -> impl IntoElement {
    provide_context(vv_text_view_parts(props.size));

    let options = computed(move || vv_markdown_options(props.streaming.get()));
    let extensions = computed(move || vv_markdown_extensions(props.mentions.get(), props.pkm.get()));
    let refs_prop = props.refs;
    let streaming_prop = props.streaming;
    let selectable_prop = props.selectable;

    text_view()
        .markdown(move || Some(props.text.get()))
        .options(options)
        .extensions(extensions)
        .selectable(props.selectable)
        .links(props.links)
        .classes(props.classes)
        .styles(props.styles)
        .render_custom(move |node: &CustomNode| {
            let refs = refs_prop.get();
            render_custom_node(node, &refs, streaming_prop.get(), cx)
        })
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
