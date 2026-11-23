use nsh_base::diff_view;
use nsh_base::editor::{EditorHighlighter, EditorTextEdit, EditorToken, editor};
use nsh_core::element::{Registry, Root};
use nsh_core::prelude::*;
use vibevalley_rich::{
    BUNDLED_GRAMMARS, ICON_NAMES, SHIKI_DARK_THEME, SHIKI_LIGHT_THEME, SPECIFIER, ShikiEditorHighlighter, highlight_code, icon_shapes, loaded_languages,
    register_grammar_json, registry, tokenize_scopes, vv_icon,
};

use crate::support::TestHarness;

#[test]
fn registry_exports_all_components_and_documents_every_export() {
    let set = registry();
    assert_eq!(set.specifier(), Some(SPECIFIER));
    assert_eq!(SPECIFIER, "vibevalley/rich");

    let names: Vec<String> = set.specs().into_iter().map(|s| s.export.clone()).collect();
    assert_eq!(
        names,
        vec![
            "VvCanvas",
            "VvChart",
            "VvCodeBlock",
            "VvDiagram",
            "VvGenUi",
            "VvIcon",
            "VvMarkdown",
            "VvWhiteboard"
        ]
    );

    let undocumented = set.undocumented();
    assert!(
        undocumented.is_empty(),
        "every exported component/prop/event must be documented, missing: {undocumented:?}"
    );

    let dts = nsh_core::element::declarations(&set, &[]);
    for expected in [
        "export declare const VvMarkdown:",
        "export declare const VvCodeBlock:",
        "export declare const VvDiagram:",
        "export declare const VvCanvas:",
        "export declare const VvChart:",
        "export declare const VvGenUi:",
        "export declare const VvIcon:",
        "export declare const VvWhiteboard:",
        "onIssuePress?: (event: VvIssuePressEvent) => void;",
        "onWikilinkPress?: (event: VvWikilinkPressEvent) => void;",
        "onBlockRefPress?: (event: VvBlockRefPressEvent) => void;",
        "onGenUiAction?: (event: VvGenUiActionEvent) => void;",
        "onCursorMove?: (event: VvWhiteboardCursorEvent) => void;",
        "onViewportChange?: (event: VvWhiteboardViewportEvent) => void;",
    ] {
        assert!(dts.contains(expected), "generated declarations missing `{expected}`");
    }

    // Merging alongside `nsh_base::registry()` must never panic on name collisions.
    let merged = Registry::merged(&[nsh_base::registry(), set]);
    assert!(merged.specs().len() > 6);
}

#[test]
fn bundled_grammars_compile_and_tokenize_across_languages() {
    let loaded = loaded_languages();
    for grammar in BUNDLED_GRAMMARS {
        assert!(
            loaded.iter().any(|l| l == grammar.canonical),
            "bundled grammar {} should load into shared Shiki engine",
            grammar.canonical
        );
    }

    // Rust tokenization in both light and dark modes produces distinct themed colors.
    let rust_src = "// doc comment\npub fn answer() -> u32 {\n    let msg = \"hello\";\n    42\n}";
    let light = highlight_code(rust_src, Some("rs"), false);
    let dark = highlight_code(rust_src, Some("rust"), true);
    assert!(light.highlighted);
    assert!(dark.highlighted);
    assert_eq!(light.theme_name, SHIKI_LIGHT_THEME);
    assert_eq!(dark.theme_name, SHIKI_DARK_THEME);
    assert_ne!(light.fg, dark.fg);
    assert_ne!(light.bg, dark.bg);
    assert_eq!(light.lines.len(), 5);
    assert!(light.lines[0].spans.iter().any(|s| s.font_style.is_italic()));
    assert!(light.lines[1].spans.len() >= 2);

    // Unicode / CJK / emoji content must keep every span on valid UTF-8 char boundaries.
    let unicode_ts = "const 农场: string = \"🌾 VibeValley\"; // 注释";
    let res = highlight_code(unicode_ts, Some("tsx"), false);
    assert!(res.highlighted);
    for line in &res.lines {
        for span in &line.spans {
            assert!(line.text.is_char_boundary(span.range.start));
            assert!(line.text.is_char_boundary(span.range.end));
            assert!(span.range.start < span.range.end);
        }
    }

    // Zig grammar and theme-independent `tokenize_scopes` work on multi-line code.
    let zig_src = "const std = @import(\"std\");\npub fn main() void {}\n";
    let zig_spans = tokenize_scopes(zig_src, "zig");
    assert!(!zig_spans.is_empty());
    assert!(
        zig_spans[0]
            .iter()
            .any(|s| s.scopes.iter().any(|sc| sc.starts_with("support.function.builtin")))
    );
    assert!(zig_spans[1].iter().any(|s| s.scopes.iter().any(|sc| sc.starts_with("storage.type"))));
}

#[test]
fn shiki_editor_highlighter_maps_textmate_scopes_and_tracks_multiline_state() {
    let rust = ShikiEditorHighlighter::for_language("rs");
    assert!(rust.has_grammar());

    let doc = "/* start block comment\nstill inside comment */\npub fn run() {\n    let s = \"ok\";\n    let n = 123;\n}";
    let lines = rust.tokenize_document(doc);
    assert_eq!(lines.len(), 6);

    // Line 0 and line 1 carry multi-line block comment state.
    assert!(lines[0].iter().any(|(_, kind)| *kind == EditorToken::Comment));
    assert!(lines[1].iter().any(|(_, kind)| *kind == EditorToken::Comment));
    // Line 2 has keywords (`pub`, `fn`) and function title (`run`).
    assert!(lines[2].iter().any(|(_, kind)| *kind == EditorToken::Keyword));
    assert!(lines[2].iter().any(|(_, kind)| *kind == EditorToken::Title));
    // Line 3 has string literal.
    assert!(lines[3].iter().any(|(_, kind)| *kind == EditorToken::String));
    // Line 4 has numeric literal.
    assert!(lines[4].iter().any(|(_, kind)| *kind == EditorToken::Number));

    // Diff grammar emits `EditorToken::String` (inserted) and `EditorToken::Deletion` (removed).
    let diff = ShikiEditorHighlighter::for_language("diff");
    assert!(diff.has_grammar());
    let diff_lines = diff.tokenize_document("@@ -1,2 +1,2 @@\n-old line\n+new line");
    assert!(diff_lines[1].iter().any(|(_, kind)| *kind == EditorToken::Deletion));
    assert!(diff_lines[2].iter().any(|(_, kind)| *kind == EditorToken::String));

    // Mermaid custom language highlights comments and keywords.
    let mermaid = ShikiEditorHighlighter::for_language("mmd");
    assert!(mermaid.has_grammar());
    let mmd_lines = mermaid.tokenize_document("%% note\nflowchart LR\n  A --> B");
    assert!(mmd_lines[0].iter().any(|(_, kind)| *kind == EditorToken::Comment));
    assert!(mmd_lines[1].iter().any(|(_, kind)| *kind == EditorToken::Keyword));
}

#[test]
fn shiki_editor_highlighter_edited_rewinds_frontier_cleanly() {
    let mut hl = ShikiEditorHighlighter::for_language("rust");
    assert_eq!(hl.frontier(), 0);
    hl.edited(&EditorTextEdit::lines(0, 0, 5));
    assert_eq!(hl.frontier(), 0);
    // Out-of-bounds edit line must never panic.
    hl.edited(&EditorTextEdit::lines(99, 2, 1));
    assert_eq!(hl.frontier(), 0);
}

#[test]
fn runtime_grammar_loader_registers_custom_textmate_language() {
    let custom_json = r#"{
        "name": "vvtestlang",
        "scopeName": "source.vvtestlang",
        "patterns": [
            { "name": "keyword.control.vvtestlang", "match": "\\b(?:harvest|sow)\\b" },
            { "name": "string.quoted.double.vvtestlang", "begin": "\"", "end": "\"" }
        ]
    }"#;
    let canonical = register_grammar_json(custom_json, &["vvt"]).expect("valid custom grammar");
    assert_eq!(canonical, "vvtestlang");

    let res = highlight_code("sow \"wheat\"", Some("vvt"), false);
    assert!(res.highlighted);
    assert!(res.lines[0].spans.len() >= 2);
}

#[component]
fn EditorAndDiffHarness() -> impl IntoElement {
    view()
        .flex_col()
        .child(
            view()
                .w(px(600.0))
                .h(px(200.0))
                .child(editor().language("main.rs").default_value("pub fn main() { let x = 1; }\n").size_full()),
        )
        .child(
            view().w(px(600.0)).h(px(200.0)).child(
                diff_view()
                    .language("mermaid")
                    .old_value(SharedString::from("flowchart LR\n  A --> B\n"))
                    .new_value(SharedString::from("flowchart LR\n  A --> C\n"))
                    .size_full(),
            ),
        )
}

#[test]
fn registry_setup_mounts_editor_and_diff_view_without_nsh_base_highlight_feature() {
    use std::collections::HashSet;
    use std::time::Duration;

    let mut harness = TestHarness::mount(Root::of::<EditorAndDiffHarness>());
    // Wait for `Editor`'s background highlight pass (driven by our registered ShikiEditorHighlighter)
    // to paint multiple distinct syntax token colors on `pub fn main() { let x = 1; }`.
    let highlighted = harness.wait_until(Duration::from_secs(5), |h| {
        let colors: HashSet<u32> = h
            .texts
            .values()
            .filter(|t| t.text.contains("pub fn main"))
            .flat_map(|t| t.spans.iter().map(|s| s.style.color.0))
            .collect();
        colors.len() >= 2
    });
    assert!(
        highlighted,
        "Editor with `main.rs` should highlight natively via registered ShikiEditorHighlighter even without `nsh-base/highlight`"
    );

    // Wait for `DiffView` (`mermaid` custom language) to highlight too.
    let diff_highlighted = harness.wait_until(Duration::from_secs(5), |h| {
        let colors: HashSet<u32> = h
            .texts
            .values()
            .filter(|t| t.text.contains("flowchart LR"))
            .flat_map(|t| t.spans.iter().map(|s| s.style.color.0))
            .collect();
        colors.len() >= 2
    });
    assert!(
        diff_highlighted,
        "DiffView with custom `mermaid` language should highlight via registered ShikiEditorHighlighter"
    );
}

#[component]
fn IconGalleryHarness() -> impl IntoElement {
    let mut row = view().flex_row().flex_wrap().gap(px(4.0));
    // Mount every registered icon alongside labeled, theme-default, and unknown edge cases.
    for &name in ICON_NAMES {
        row = row.child(vv_icon().name(SharedString::from(name)).size(16.0).color(SharedString::from("#1c1917")));
    }
    row.child(
        vv_icon()
            .name(SharedString::from("close"))
            .size(20.0)
            .color(SharedString::from("#a83a2c"))
            .label(Some(SharedString::from("Close dialog"))),
    )
    .child(
        vv_icon()
            .name(SharedString::from("sidebar"))
            .size(24.0)
            .label(Some(SharedString::from("Theme sidebar"))),
    )
    .child(vv_icon().name(SharedString::from("unknown-icon")).size(16.0))
}

#[test]
fn vv_icon_mounts_all_97_icons_and_exposes_accessible_label() {
    assert_eq!(ICON_NAMES.len(), 97);
    assert!(icon_shapes("chat").is_some());
    assert!(icon_shapes("sidebar").is_some());

    let mut harness = TestHarness::mount(Root::of::<IconGalleryHarness>());
    // 97 catalog icons + 3 edge-case icons = 100 mounted canvas views; only the 99 valid icons emit non-empty drawings.
    let canvas_views = harness.kinds.values().filter(|&&k| k == nsh_core::ViewKind::Canvas).count();
    assert_eq!(canvas_views, 100);
    assert_eq!(harness.canvases.len(), 99);
    assert!(harness.canvases.values().all(|d| !d.ops.is_empty()));

    let labeled = harness.find_label("Close dialog").expect("labeled VvIcon should be discoverable");
    let frame = harness.frames.get(&labeled).expect("labeled VvIcon should have layout bounds");
    assert!((frame.size.width.0 - 20.0).abs() < 0.5);
    assert!((frame.size.height.0 - 20.0).abs() < 0.5);

    // Theme switch repaints the default-color icon with the dark ink color.
    let sidebar_id = harness.find_label("Theme sidebar").expect("theme sidebar VvIcon");
    let light_ops = harness.canvases.get(&sidebar_id).expect("light drawing").ops.clone();
    harness.set_dark(true);
    let dark_ops = harness.canvases.get(&sidebar_id).expect("dark drawing").ops.clone();
    assert_ne!(light_ops, dark_ops, "default-color VvIcon should repaint when light/dark mode flips");
}
