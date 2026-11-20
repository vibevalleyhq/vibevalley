mod support;

use std::cell::RefCell;

use nsh_base::text_view::{Block, CustomNode, Inline};
use nsh_core::ViewKind;
use nsh_core::element::Root;
use nsh_core::prelude::*;
use vibevalley_rich_ui::{
    BlockRefPayload, CustomNodeKind, VvBlockRefPressEvent, VvCodeCopyEvent, VvEmbedPressEvent, VvIssuePressEvent, VvLinkPressEvent, VvMentionPressEvent,
    VvTaskPressEvent, VvWikilinkPressEvent, clean_remark_note, is_incremental_streaming_safe, parse_vv_markdown, parse_wikilink_target, vv_markdown,
    vv_markdown_extensions, vv_markdown_options,
};

use support::TestHarness;

#[derive(Default)]
struct RecordedMarkdownEvents {
    links: Vec<String>,
    issues: Vec<u32>,
    mentions: Vec<String>,
    wikilinks: Vec<(String, String)>,
    block_refs: Vec<(String, Option<String>)>,
    embeds: Vec<String>,
    tasks: Vec<(u32, bool)>,
    copies: Vec<String>,
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

        for (mentions, pkm) in [(false, false), (true, false), (false, true), (true, true)] {
            let exts = vv_markdown_extensions(mentions, pkm);
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

    let doc = parse_vv_markdown(md, true, false, false);
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
    let doc_no_mentions = parse_vv_markdown(md, false, false, false);
    let no_mention_customs = collect_all_inline_customs(&doc_no_mentions.blocks);
    assert!(
        !no_mention_customs
            .iter()
            .any(|n| CustomNodeKind::parse(&n.name) == Some(CustomNodeKind::Mention))
    );
}

#[test]
fn pkm_patterns_parse_embeds_wikilinks_block_refs_remarks_tags_and_issues_cleanly() {
    let md = "Transclude ![[System Architecture]] and link [[Project Plan|The Plan]] and [[Page #12]].\n\n\
              Ref ((a1b2c3d4-e5f6-4789-a012-3456789abcde)), mark ==key point==^[💬 double check], \
              tag #area/rust and issue #42. Skip `[[NotLink]] ((deadbeef)) #not_tag`.";

    let doc = parse_vv_markdown(md, false, true, false);
    let customs = collect_all_inline_customs(&doc.blocks);

    let kinds_and_values: Vec<(CustomNodeKind, String)> = customs
        .iter()
        .map(|n| {
            let kind = CustomNodeKind::parse(&n.name).expect("known custom node");
            let val = match kind {
                CustomNodeKind::Embed | CustomNodeKind::Wikilink | CustomNodeKind::BlockRef | CustomNodeKind::Remark => {
                    n.attributes.get("1").cloned().unwrap_or_default()
                }
                CustomNodeKind::Issue | CustomNodeKind::Mention | CustomNodeKind::Tag => n.attributes.get("2").cloned().unwrap_or_default(),
                CustomNodeKind::Mermaid | CustomNodeKind::Canvas | CustomNodeKind::Chart | CustomNodeKind::GenUi => n.text.clone(),
            };
            (kind, val)
        })
        .collect();

    assert_eq!(
        kinds_and_values,
        vec![
            (CustomNodeKind::Embed, "System Architecture".to_owned()),
            (CustomNodeKind::Wikilink, "Project Plan|The Plan".to_owned()),
            (CustomNodeKind::Wikilink, "Page #12".to_owned()),
            (CustomNodeKind::BlockRef, "a1b2c3d4-e5f6-4789-a012-3456789abcde".to_owned()),
            (CustomNodeKind::Remark, "key point".to_owned()),
            (CustomNodeKind::Tag, "area/rust".to_owned()),
            (CustomNodeKind::Issue, "42".to_owned()),
        ]
    );

    assert_eq!(
        parse_wikilink_target("Project Plan|The Plan"),
        ("project-plan".to_owned(), "The Plan".to_owned())
    );
    assert_eq!(
        parse_wikilink_target("Area/Rust Notes"),
        ("area__rust-notes".to_owned(), "Area/Rust Notes".to_owned())
    );
    assert_eq!(clean_remark_note("💬 double check "), "double check");
}

#[test]
fn block_language_extensions_dispatch_mermaid_canvas_chart_genui_and_preserve_code_blocks() {
    let md = "```mermaid\nflowchart LR\n  A --> B\n```\n\n\
              ```canvas\n{\"nodes\":[],\"edges\":[]}\n```\n\n\
              ```chart\n{\"kind\":\"bar\"}\n```\n\n\
              ```genui\n{\"widget\":\"card\"}\n```\n\n\
              ```rust\nfn ok() {}\n```";

    let doc = parse_vv_markdown(md, false, false, false);
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
    let doc = parse_vv_markdown(partial, true, false, true);
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
    let refs = vec![BlockRefPayload {
        block: SharedString::from("11111111-2222-3333-4444-555555555555"),
        body: Some(SharedString::from("Resolved block content")),
        page: Some(SharedString::from("notes")),
        page_title: Some(SharedString::from("Notes")),
        found: true,
    }];

    let source = "Visit [Docs](https://vibevalley.dev), check #42 with @helper, ![[Roadmap]], [[Design|Spec]], \
                  ((11111111-2222-3333-4444-555555555555)), ((aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)), \
                  ==important==^[check this], #rust.\n\n\
                  - [ ] Ship rich UI\n\n\
                  ```mermaid\nflowchart LR\n  A[Start] --> B[Done]\n```\n\n\
                  ```rust\nlet v = 7;\n```";

    vv_markdown()
        .text(source)
        .mentions(true)
        .pkm(true)
        .refs(refs)
        .on_link_press(|ev: &VvLinkPressEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().links.push(ev.url.to_string()));
        })
        .on_issue_press(|ev: &VvIssuePressEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().issues.push(ev.number));
        })
        .on_mention_press(|ev: &VvMentionPressEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().mentions.push(ev.name.to_string()));
        })
        .on_wikilink_press(|ev: &VvWikilinkPressEvent| {
            RECORDED_EVENTS.with(|e| {
                e.borrow_mut().wikilinks.push((ev.page.to_string(), ev.label.to_string()));
            });
        })
        .on_block_ref_press(|ev: &VvBlockRefPressEvent| {
            RECORDED_EVENTS.with(|e| {
                e.borrow_mut().block_refs.push((ev.id.to_string(), ev.page.as_ref().map(ToString::to_string)));
            });
        })
        .on_embed_press(|ev: &VvEmbedPressEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().embeds.push(ev.target.to_string()));
        })
        .on_task_press(|ev: &VvTaskPressEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().tasks.push((ev.index, ev.checked)));
        })
        .on_code_copy(|ev: &VvCodeCopyEvent| {
            RECORDED_EVENTS.with(|e| e.borrow_mut().copies.push(ev.code.to_string()));
        })
}

#[test]
fn vv_markdown_mounts_in_core_and_emits_typed_events_without_canvas_svg_view_kind() {
    RECORDED_EVENTS.with(|e| *e.borrow_mut() = RecordedMarkdownEvents::default());
    let mut harness = TestHarness::mount(Root::of::<MarkdownTestRoot>());

    // Mermaid diagram inside Markdown MUST mount as ViewKind::Image (never element::svg ViewKind::Canvas).
    assert!(!harness.has_view_kind(ViewKind::Canvas));
    assert!(harness.has_view_kind(ViewKind::Image));
    assert!(harness.contains_text("Resolved block content"));

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

    let embed_id = harness.find_test_id("vv-embed").expect("embed node mounted");
    assert!(harness.press(embed_id));

    let link_id = harness.find_test_id("pkm-link").expect("wikilink node mounted");
    assert!(harness.press(link_id));

    let tag_id = harness.find_test_id("pkm-tag").expect("tag node mounted");
    assert!(harness.press(tag_id));

    let ref_ids = harness.find_all_test_ids("pkm-ref");
    assert_eq!(ref_ids.len(), 2);
    for id in ref_ids {
        assert!(harness.press(id));
    }

    let copy_id = harness.find_test_id("code-copy").expect("code-copy button mounted");
    assert!(harness.press(copy_id));

    RECORDED_EVENTS.with(|e| {
        let recorded = e.borrow();
        assert_eq!(recorded.links, vec!["https://vibevalley.dev"]);
        assert_eq!(recorded.tasks, vec![(0, true)]);
        assert_eq!(recorded.issues, vec![42]);
        assert_eq!(recorded.mentions, vec!["helper"]);
        assert_eq!(recorded.embeds, vec!["Roadmap"]);
        assert_eq!(
            recorded.wikilinks,
            vec![("design".to_owned(), "Spec".to_owned()), ("rust".to_owned(), "#rust".to_owned()),]
        );
        assert_eq!(
            recorded.block_refs,
            vec![
                ("11111111-2222-3333-4444-555555555555".to_owned(), Some("notes".to_owned())),
                ("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_owned(), None),
            ]
        );
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
