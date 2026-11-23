use std::cell::RefCell;
use std::path::Path;
use std::time::Duration;

use nsh_base::text_view::{Alert, Block, CustomNode, Inline};
use nsh_core::ViewKind;
use nsh_core::element::Root;
use nsh_core::prelude::*;
use vibevalley_rich::markdown::{ResolvedMarkdownImage, read_local_image_dimensions, resolve_markdown_image_src};
use vibevalley_rich::{
    CustomNodeKind, NativeMarkdownDoc, VvCodeCopyEvent, VvGenUiActionEvent, VvIssuePressEvent, VvLinkPressEvent, VvMarkdownSize, VvMentionPressEvent,
    VvTaskPressEvent, is_incremental_streaming_safe, native_markdown_root, parse_vv_markdown, vv_markdown, vv_markdown_extensions, vv_markdown_options,
};

use crate::support::TestHarness;

#[derive(Default)]
struct RecordedMarkdownEvents {
    links: Vec<String>,
    issues: Vec<u32>,
    mentions: Vec<String>,
    tasks: Vec<(u32, bool)>,
    copies: Vec<String>,
    genui_actions: Vec<(String, String)>,
}

thread_local! {
    static RECORDED_EVENTS: RefCell<RecordedMarkdownEvents> = RefCell::new(RecordedMarkdownEvents::default());
}

fn collect_inline_customs<'a>(inlines: &'a [Inline], out: &mut Vec<&'a CustomNode>) {
    for inline in inlines {
        match inline {
            Inline::Custom(node) => out.push(node),
            Inline::Strong { content }
            | Inline::Emphasis { content }
            | Inline::Strikethrough { content }
            | Inline::Underline { content }
            | Inline::Highlight { content, .. }
            | Inline::Superscript { content }
            | Inline::Subscript { content }
            | Inline::Small { content }
            | Inline::Link { content, .. } => collect_inline_customs(content, out),
            _ => {}
        }
    }
}

fn collect_all_inline_customs(blocks: &[Block]) -> Vec<&CustomNode> {
    let mut out = Vec::new();
    for block in blocks {
        match block {
            Block::Paragraph { content } | Block::Heading { content, .. } => collect_inline_customs(content, &mut out),
            Block::Blockquote { children, .. } => out.extend(collect_all_inline_customs(children)),
            Block::List { items, .. } => {
                for item in items {
                    out.extend(collect_all_inline_customs(&item.children));
                }
            }
            _ => {}
        }
    }
    out
}

#[test]
fn markdown_options_and_extensions_preserve_incremental_streaming() {
    for streaming in [false, true] {
        let opts = vv_markdown_options(streaming);
        assert!(opts.math);
        assert!(opts.alerts);
        assert!(opts.html);
        assert!(!opts.mdx);
        assert_eq!(opts.streaming, streaming);

        for mentions in [false, true] {
            let exts = vv_markdown_extensions(mentions);
            assert!(
                is_incremental_streaming_safe(&opts, &exts),
                "extensions must never install container/mdx so incremental.rs stays active"
            );
            assert!(exts.iter().all(|e| e.container.is_none()));
        }
    }
}

#[test]
fn inline_patterns_match_issues_and_mentions_while_skipping_code_and_links() {
    let md = "Fix #12, (#34) and #56 #78 with @alice and (@bob_2).\n\n\
              Ignore foo#99, #12abc, email@example.com, `#404 @ghost`, and [link #500](https://example.com/#600).\n\n\
              ```rust\nlet x = \"#700 @nobody\";\n```";

    let doc = parse_vv_markdown(md, true, false);
    let customs = collect_all_inline_customs(&doc.blocks);

    let issues: Vec<&str> = customs
        .iter()
        .filter(|n| CustomNodeKind::parse(&n.name) == Some(CustomNodeKind::Issue))
        .filter_map(|n| n.attributes.get("2").map(String::as_str))
        .collect();
    assert_eq!(issues, vec!["12", "34", "56", "78"]);

    let mentions: Vec<&str> = customs
        .iter()
        .filter(|n| CustomNodeKind::parse(&n.name) == Some(CustomNodeKind::Mention))
        .filter_map(|n| n.attributes.get("2").map(String::as_str))
        .collect();
    assert_eq!(mentions, vec!["alice", "bob_2"]);

    // Mentions disabled -> zero mention custom nodes.
    let doc_no_mentions = parse_vv_markdown(md, false, false);
    let no_mention_customs = collect_all_inline_customs(&doc_no_mentions.blocks);
    assert!(
        !no_mention_customs
            .iter()
            .any(|n| CustomNodeKind::parse(&n.name) == Some(CustomNodeKind::Mention))
    );
}

#[test]
fn block_language_extensions_dispatch_mermaid_canvas_chart_genui_and_preserve_code_blocks() {
    let md = "```mermaid\nflowchart LR\n  A --> B\n```\n\n\
              ```canvas\n{\"nodes\":[],\"edges\":[]}\n```\n\n\
              ```chart\n{\"kind\":\"bar\"}\n```\n\n\
              ```genui\n{\"widget\":\"card\"}\n```\n\n\
              ```rust\nfn ok() {}\n```";

    let doc = parse_vv_markdown(md, false, false);
    assert_eq!(doc.blocks.len(), 5);

    let block_kinds: Vec<&str> = doc
        .blocks
        .iter()
        .map(|b| match b {
            Block::Custom(node) => node.name.as_str(),
            Block::CodeBlock(cb) => cb.language.as_deref().unwrap_or("plain"),
            _ => "other",
        })
        .collect();

    assert_eq!(block_kinds, vec!["vv_mermaid", "vv_canvas", "vv_chart", "vv_genui", "rust"]);
}

#[test]
fn streaming_mode_repairs_partial_markdown_cleanly() {
    let partial = "Working on **important** fix for #99 with `unclosed";
    let doc = parse_vv_markdown(partial, true, true);
    assert!(!doc.blocks.is_empty());
    let customs = collect_all_inline_customs(&doc.blocks);
    assert!(
        customs
            .iter()
            .any(|n| { CustomNodeKind::parse(&n.name) == Some(CustomNodeKind::Issue) && n.attributes.get("2").map(String::as_str) == Some("99") })
    );
}

#[component]
fn MarkdownTestRoot() -> impl IntoElement {
    let source = concat!(
        "Visit [Docs](https://vibevalley.dev), check #42 with @helper.\n\n",
        "- [ ] Ship rich UI\n\n",
        "```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\n\n",
        "```genui\n",
        "{\"op\":\"state_init\",\"state\":{\"enabled\":false}}\n",
        "{\"op\":\"set_node\",\"root\":true,\"node\":{\"id\":\"root\",\"kind\":\"switch\",\"bind\":\"enabled\",\"label\":\"Enable\"}}\n",
        "{\"op\":\"done\"}\n",
        "```\n\n",
        "```rust\nlet v = 7;\n```",
    );

    vv_markdown()
        .text(source)
        .mentions(true)
        .on_link_press(|ev: &VvLinkPressEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().links.push(ev.url.to_string()));
        })
        .on_issue_press(|ev: &VvIssuePressEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().issues.push(ev.number));
        })
        .on_mention_press(|ev: &VvMentionPressEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().mentions.push(ev.name.to_string()));
        })
        .on_task_press(|ev: &VvTaskPressEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().tasks.push((ev.index, ev.checked)));
        })
        .on_code_copy(|ev: &VvCodeCopyEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().copies.push(ev.code.to_string()));
        })
        .on_gen_ui_action(|ev: &VvGenUiActionEvent| {
            RECORDED_EVENTS.with(|e| {
                e.borrow_mut().genui_actions.push((ev.action.to_string(), ev.payload.to_string()));
            });
        })
}

#[test]
fn vv_markdown_mounts_in_core_and_emits_typed_events_without_canvas_svg_view_kind() {
    RECORDED_EVENTS.with(|e| *e.borrow_mut() = RecordedMarkdownEvents::default());
    let mut harness = TestHarness::mount(Root::of::<MarkdownTestRoot>());

    // Mermaid diagram inside Markdown MUST mount as ViewKind::Image (never element::svg ViewKind::Canvas).
    assert!(!harness.has_view_kind(ViewKind::Canvas));
    assert!(harness.has_view_kind(ViewKind::Image));

    // Press standard Markdown link ("Docs") via its inline TextLink node.
    let docs_link_id = harness.find_inline_link_with_text("Docs").expect("Markdown Docs link mounted");
    assert!(harness.press(docs_link_id));

    // Press GFM task list checkbox via its accessibility label.
    let task_id = harness.find_label("Ship rich UI").expect("GFM task checkbox mounted");
    assert!(harness.press(task_id));

    let issue_id = harness.find_test_id("vv-issue").expect("issue node mounted");
    assert!(harness.press(issue_id));

    let mention_id = harness.find_test_id("vv-mention").expect("mention node mounted");
    assert!(harness.press(mention_id));

    let genui_switch_id = harness.find_test_id("genui-switch-root").expect("genui switch mounted");
    assert!(harness.press(genui_switch_id));

    let copy_id = harness.find_test_id("code-copy").expect("code-copy button mounted");
    assert!(harness.press(copy_id));

    RECORDED_EVENTS.with(|e| {
        let recorded = e.borrow();
        assert_eq!(recorded.links, vec!["https://vibevalley.dev"]);
        assert_eq!(recorded.tasks, vec![(0, true)]);
        assert_eq!(recorded.issues, vec![42]);
        assert_eq!(recorded.mentions, vec!["helper"]);
        assert_eq!(recorded.genui_actions, vec![("state_change".to_owned(), "enabled=true".to_owned())]);
        assert_eq!(recorded.copies, vec!["let v = 7;"]);
    });
    assert_eq!(harness.clipboard_writes, vec!["let v = 7;"]);
}

#[component]
fn MathAndGenUiRoot() -> impl IntoElement {
    let md = concat!(
        "Inline formula $E = mc^2$ in prose.\n\n",
        "$$\n\\sum_{i=1}^n i = \\frac{n(n+1)}{2}\n$$\n\n",
        "```genui\n",
        "{\"op\":\"state_init\",\"state\":{\"active\":false}}\n",
        "{\"op\":\"set_node\",\"root\":true,\"node\":{\"id\":\"root\",\"kind\":\"stack\",\"direction\":\"vertical\",\"gap\":8,\"children\":[\"sw\",\"label\"]}}\n",
        "{\"op\":\"set_node\",\"node\":{\"id\":\"sw\",\"kind\":\"switch\",\"bind\":\"active\",\"label\":\"Toggle\"}}\n",
        "{\"op\":\"set_node\",\"node\":{\"id\":\"label\",\"kind\":\"text\",\"value\":\"State: ${active}\"}}\n",
        "{\"op\":\"done\"}\n",
        "```\n",
    );
    vv_markdown().text(md)
}

#[test]
fn regression_ratex_math_updates_canvas_color_on_theme_toggle_without_resetting_genui() {
    use nsh_core::canvas::{CanvasOp, Paint};

    let mut harness = TestHarness::mount(Root::of::<MathAndGenUiRoot>());
    let inline_id = harness.find_test_id("math-inline").expect("inline math wrapper mounted");
    let block_id = harness.find_test_id("math-block").expect("block math wrapper mounted");
    assert!(harness.contains_text("State: false"));

    // Verify inline and block math formulas lay out with realistic non-zero dimensions
    // (inline must shrink-wrap to formula width rather than collapsing or stretching full-width).
    let inline_frame = harness.frames.get(&inline_id).copied().expect("inline math frame");
    assert!(
        inline_frame.size.width.0 > 20.0 && inline_frame.size.width.0 < 160.0,
        "inline math width should match formula size, got {:?}",
        inline_frame.size
    );
    assert!(
        inline_frame.size.height.0 > 10.0 && inline_frame.size.height.0 < 36.0,
        "inline math height should match line box, got {:?}",
        inline_frame.size
    );
    let block_frame = harness.frames.get(&block_id).copied().expect("block math frame");
    assert!(block_frame.size.height.0 > 20.0, "block math must have non-zero height: {:?}", block_frame.size);

    let canvas_fill_colors = |h: &TestHarness| -> Vec<u32> {
        h.canvases
            .values()
            .flat_map(|drawing| {
                drawing.ops.iter().filter_map(|op| match op {
                    CanvasOp::FillStyle(Paint::Color(c)) => Some(c.0),
                    _ => None,
                })
            })
            .collect()
    };

    // Light ink (#1c1917 -> 0x1c1917ff) vs Dark ink (#ecebe8 -> 0xecebe8ff).
    let light_ink_rgba: u32 = 0x1c19_17ff;
    let dark_ink_rgba: u32 = 0xeceb_e8ff;

    // 1. Light mode: both inline and block ratex canvases paint with light ink.
    assert_eq!(harness.canvases.len(), 2, "expected inline + block ratex math canvases");
    let light_fills = canvas_fill_colors(&harness);
    assert!(!light_fills.is_empty(), "ratex math canvases must emit fill colors");
    assert!(
        light_fills.iter().all(|&c| c == light_ink_rgba),
        "expected all math fills to match light ink 0x{light_ink_rgba:08x}, got {light_fills:08x?}"
    );

    // Mutate interactive GenUI switch state before toggling theme.
    let switch_id = harness.find_test_id("genui-switch-sw").expect("genui switch mounted");
    assert!(harness.press(switch_id));
    assert!(harness.contains_text("State: true"));

    // 2. Toggle Light -> Dark: both math canvases must repaint in dark ink, while GenUI keeps State: true.
    harness.set_dark(true);
    assert_eq!(harness.canvases.len(), 2, "expected 2 live math canvases after toggling to dark");
    let dark_fills = canvas_fill_colors(&harness);
    assert!(!dark_fills.is_empty());
    assert!(
        dark_fills.iter().all(|&c| c == dark_ink_rgba),
        "expected all math fills to switch to dark ink 0x{dark_ink_rgba:08x}, got {dark_fills:08x?}"
    );
    assert!(harness.contains_text("State: true"), "GenUI state must survive Light->Dark toggle");

    // 3. Toggle Dark -> Light: both math canvases must return to light ink, and GenUI still keeps State: true.
    harness.set_dark(false);
    assert_eq!(harness.canvases.len(), 2, "expected 2 live math canvases after toggling back to light");
    let restored_fills = canvas_fill_colors(&harness);
    assert!(!restored_fills.is_empty());
    assert!(
        restored_fills.iter().all(|&c| c == light_ink_rgba),
        "expected all math fills to return to light ink 0x{light_ink_rgba:08x}, got {restored_fills:08x?}"
    );
    assert!(harness.contains_text("State: true"), "GenUI state must survive Dark->Light toggle");
}

#[test]
fn doc_size_preset_establishes_editorial_heading_hierarchy_and_preserves_chat_presets() {
    assert_eq!(VvMarkdownSize::Base.body_pt(), 14.0);
    assert_eq!(VvMarkdownSize::Base.line_height_pt(), 22.0);
    assert_eq!(VvMarkdownSize::Base.h1_pt(), 18.0);
    assert_eq!(VvMarkdownSize::Base.h2_pt(), 14.0);

    assert_eq!(VvMarkdownSize::Sm.body_pt(), 13.0);
    assert_eq!(VvMarkdownSize::Sm.line_height_pt(), 20.0);
    assert_eq!(VvMarkdownSize::Sm.h1_pt(), 16.0);

    assert!(VvMarkdownSize::Doc.is_doc());
    assert!(!VvMarkdownSize::Base.is_doc());
    assert!(!VvMarkdownSize::Sm.is_doc());
    assert!(VvMarkdownSize::Doc.body_pt() > VvMarkdownSize::Base.body_pt());
    assert!(VvMarkdownSize::Doc.line_height_pt() > VvMarkdownSize::Base.line_height_pt());
    assert!(VvMarkdownSize::Doc.h1_pt() > VvMarkdownSize::Doc.h2_pt());
    assert!(VvMarkdownSize::Doc.h2_pt() > VvMarkdownSize::Doc.h3_pt());
    assert!(VvMarkdownSize::Doc.h3_pt() > VvMarkdownSize::Doc.h4_pt());
    assert!(VvMarkdownSize::Doc.h4_pt() >= VvMarkdownSize::Doc.body_pt());
}

#[test]
fn resolve_markdown_image_src_handles_relative_file_absolute_remote_and_missing_paths() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root canonical");
    let expected_farm = repo_root.join("docs/images/farm.png").canonicalize().expect("farm.png exists");
    let repo_root_str = repo_root.to_string_lossy();
    let docs_dir = repo_root.join("docs");
    let docs_dir_str = docs_dir.to_string_lossy();
    let subsystems_dir = repo_root.join("docs/subsystems");
    let subsystems_dir_str = subsystems_dir.to_string_lossy();

    // Repo-relative path (`docs/images/farm.png`) and query-stripped variant.
    assert_eq!(
        resolve_markdown_image_src("docs/images/farm.png", Some(&repo_root_str)),
        ResolvedMarkdownImage::LocalFile {
            path: expected_farm.clone(),
            uri: expected_farm.to_string_lossy().into_owned(),
        }
    );
    assert_eq!(
        resolve_markdown_image_src("./images/farm.png?raw=1", Some(&docs_dir_str)),
        ResolvedMarkdownImage::LocalFile {
            path: expected_farm.clone(),
            uri: expected_farm.to_string_lossy().into_owned(),
        }
    );
    assert_eq!(
        resolve_markdown_image_src("../images/farm.png", Some(&subsystems_dir_str)),
        ResolvedMarkdownImage::LocalFile {
            path: expected_farm.clone(),
            uri: expected_farm.to_string_lossy().into_owned(),
        }
    );

    // Absolute filesystem path and `file://` URI.
    let abs_str = expected_farm.to_string_lossy().into_owned();
    assert_eq!(
        resolve_markdown_image_src(&abs_str, None),
        ResolvedMarkdownImage::LocalFile {
            path: expected_farm.clone(),
            uri: abs_str.clone(),
        }
    );
    assert_eq!(
        resolve_markdown_image_src(&format!("file://{abs_str}"), None),
        ResolvedMarkdownImage::LocalFile {
            path: expected_farm.clone(),
            uri: abs_str,
        }
    );

    // Remote HTTP(S) & data URIs stay untouched as remote sources.
    assert_eq!(
        resolve_markdown_image_src("https://vibevalley.dev/banner.png", Some(&repo_root_str)),
        ResolvedMarkdownImage::Remote {
            uri: "https://vibevalley.dev/banner.png".to_owned(),
        }
    );
    assert_eq!(
        resolve_markdown_image_src("http://127.0.0.1:8790/img.png", None),
        ResolvedMarkdownImage::Remote {
            uri: "http://127.0.0.1:8790/img.png".to_owned(),
        }
    );
    assert_eq!(
        resolve_markdown_image_src("data:image/png;base64,AAAA", None),
        ResolvedMarkdownImage::Remote {
            uri: "data:image/png;base64,AAAA".to_owned(),
        }
    );

    // Missing file and relative path without base_dir both yield Missing explicitly.
    assert_eq!(
        resolve_markdown_image_src("docs/images/nonexistent.png", Some(&repo_root_str)),
        ResolvedMarkdownImage::Missing {
            raw: "docs/images/nonexistent.png".to_owned(),
        }
    );
    assert_eq!(
        resolve_markdown_image_src("docs/images/farm.png", None),
        ResolvedMarkdownImage::Missing {
            raw: "docs/images/farm.png".to_owned(),
        }
    );

    // Local PNG header probe reads natural dimensions synchronously.
    let dims = read_local_image_dimensions(&expected_farm).expect("PNG dimensions readable");
    assert_eq!(dims, (1440.0, 900.0));
}

#[test]
fn real_readme_parses_html_h1_images_alerts_table_and_mermaid_cleanly() {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root canonical");
    let readme = std::fs::read_to_string(repo_root.join("README.md")).expect("README.md readable");
    let doc = parse_vv_markdown(&readme, false, false);

    // `<h1 align="center">VibeValley · 码农场物语</h1>` must become a Level-1 Heading block.
    assert!(
        matches!(doc.blocks.first(), Some(Block::Heading { level: 1, .. })),
        "expected README HTML <h1> to parse as Block::Heading level 1, got {:?}",
        doc.blocks.first()
    );

    let mut image_srcs = Vec::new();
    let mut alerts = Vec::new();
    let mut has_table = false;
    let mut has_mermaid = false;
    for block in &doc.blocks {
        match block {
            Block::Paragraph { content } => {
                for inline in content {
                    if let Inline::Image(img) = inline {
                        image_srcs.push(img.src.clone());
                    }
                }
            }
            Block::Blockquote { alert: Some(kind), .. } => alerts.push(*kind),
            Block::Table(table) => {
                has_table = table.columns() == 2 && !table.rows.is_empty();
            }
            Block::Custom(node) if CustomNodeKind::parse(&node.name) == Some(CustomNodeKind::Mermaid) => {
                has_mermaid = true;
            }
            _ => {}
        }
    }

    assert!(image_srcs.contains(&"docs/images/farm.png".to_owned()));
    assert!(image_srcs.contains(&"docs/images/map.png".to_owned()));
    assert!(alerts.contains(&Alert::Warning));
    assert!(alerts.contains(&Alert::Note));
    assert!(has_table);
    assert!(has_mermaid);

    let root_str = repo_root.to_string_lossy();
    for src in &image_srcs {
        assert!(
            matches!(resolve_markdown_image_src(src, Some(&root_str)), ResolvedMarkdownImage::LocalFile { .. }),
            "expected README image {src} to resolve locally"
        );
    }
}

#[component]
fn DocPreviewWithImagesRoot() -> impl IntoElement {
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("repo root canonical");
    let base_dir = SharedString::from(repo_root.to_string_lossy().into_owned());
    let md = concat!(
        "<h1 align=\"center\">VibeValley</h1>\n\n",
        "![Farm screenshot](docs/images/farm.png)\n\n",
        "![Missing graphic](docs/images/missing-preview.png)\n",
    );

    vv_markdown().text(md).size(VvMarkdownSize::Doc).base_dir(Some(base_dir))
}

#[test]
fn doc_preview_mounts_relative_image_with_nonzero_aspect_ratio_and_missing_fallback() {
    let harness = TestHarness::mount(Root::of::<DocPreviewWithImagesRoot>());

    assert!(harness.contains_text("VibeValley"));
    assert!(harness.has_view_kind(ViewKind::Image));

    // Resolved local relative PNG mounts with non-zero proportional frame + caption.
    let img_id = harness.find_test_id("vv-markdown-image").expect("resolved local image mounted");
    let img_frame = harness.frames.get(&img_id).copied().expect("resolved image frame");
    assert!(
        img_frame.size.width.0 > 100.0 && img_frame.size.height.0 > 60.0,
        "resolved local image must lay out with non-zero dimensions, got {:?}",
        img_frame.size
    );
    let rendered_aspect = img_frame.size.width.0 / img_frame.size.height.0;
    assert!(
        (rendered_aspect - (1440.0 / 900.0)).abs() < 0.08,
        "expected 16:10 aspect ratio (~1.6), got {rendered_aspect} ({:?})",
        img_frame.size
    );
    assert!(harness.find_test_id("vv-image-caption").is_some());
    assert!(harness.contains_text("Farm screenshot"));

    // Unresolvable image mounts clean fallback badge showing alt + path.
    assert!(harness.find_test_id("vv-image-missing").is_some());
    assert!(harness.contains_text("Missing graphic"));
    assert!(harness.contains_text("docs/images/missing-preview.png"));
}

#[test]
fn native_markdown_root_mounts_and_updates_without_quickjs() {
    let native = native_markdown_root(
        NativeMarkdownDoc {
            text: "# Initial Title\n\nInitial body copy.".to_string(),
            base_dir: None,
        },
        None,
    );
    let mut harness = TestHarness::mount(native.root);
    assert!(harness.contains_text("Initial Title"));
    assert!(harness.contains_text("Initial body copy."));

    native
        .doc_tx
        .send(NativeMarkdownDoc {
            text: "# Reloaded Heading\n\nUpdated from watcher.".to_string(),
            base_dir: None,
        })
        .expect("send updated markdown doc");

    let updated = harness.wait_until(Duration::from_secs(2), |h| h.contains_text("Reloaded Heading"));
    assert!(updated, "native markdown root should reactively update on doc_tx");
    assert!(harness.contains_text("Updated from watcher."));
}
