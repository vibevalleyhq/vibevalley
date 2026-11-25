use std::cell::RefCell;
use std::collections::HashSet;
use std::sync::Mutex;

use nsh_core::element::Root;
use nsh_core::prelude::*;
use vibevalley_rich::{
    DEFAULT_FOLD_LINES, VvCodeCopyEvent, clear_code_highlight_cache, code_highlight_cache_stats, count_code_lines, highlight_code, should_offload_highlight,
    vv_code_block,
};

use crate::support::TestHarness;

static CACHE_LOCK: Mutex<()> = Mutex::new(());

thread_local! {
    static RECORDED_COPIES: RefCell<Vec<VvCodeCopyEvent>> = const { RefCell::new(Vec::new()) };
}

#[test]
fn highlight_code_uses_lru_cache_and_falls_back_cleanly_for_unknown_or_plain_languages() {
    let _guard = CACHE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    clear_code_highlight_cache();
    let snippet = "const x: number = 42;\nexport default x;";

    let first = highlight_code(snippet, Some("ts"), false);
    assert!(first.highlighted);
    let after_first = code_highlight_cache_stats();
    assert_eq!(after_first.misses, 1);
    assert_eq!(after_first.hits, 0);

    let second = highlight_code(snippet, Some("ts"), false);
    assert_eq!(first, second);
    assert_eq!(code_highlight_cache_stats().hits, 1);

    let dark = highlight_code(snippet, Some("ts"), true);
    assert!(dark.highlighted);
    assert_ne!(first.fg, dark.fg);

    // Plain or unknown languages stay unhighlighted without failing.
    let plain = highlight_code("just plain text", Some("plaintext"), false);
    assert!(!plain.highlighted);
    assert_eq!(plain.lines.len(), 1);

    let unknown = highlight_code("alpha beta", Some("nonexistent-lang-xyz"), false);
    assert!(!unknown.highlighted);
    assert_eq!(unknown.lines[0].text, "alpha beta");
}

#[test]
fn line_counting_and_async_offload_thresholds_work_as_expected() {
    assert_eq!(DEFAULT_FOLD_LINES, 16);
    assert_eq!(count_code_lines("one"), 1);
    assert_eq!(count_code_lines("a\nb\nc"), 3);
    assert!(!should_offload_highlight("let x = 1;"));

    let large_lines = (0..140).map(|i| format!("let v_{i} = {i};")).collect::<Vec<_>>().join("\n");
    assert!(should_offload_highlight(&large_lines));
}

#[derive(Clone, PartialEq, Props)]
struct CodeBlockHarnessProps {
    code: String,
    language: Option<String>,
}

#[component]
fn CodeBlockHarness(props: CodeBlockHarnessProps) -> impl IntoElement {
    vv_code_block()
        .code(props.code.clone())
        .language(props.language.clone().map(SharedString::from))
        .on_copy(|ev: &VvCodeCopyEvent| {
            RECORDED_COPIES.with(|c| c.borrow_mut().push(ev.clone()));
        })
}

#[test]
fn vv_code_block_renders_themed_spans_reacts_to_dark_and_handles_copy_and_fold() {
    let _guard = CACHE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    RECORDED_COPIES.with(|c| c.borrow_mut().clear());
    let short_code = "pub fn greet(name: &str) -> String {\n    format!(\"hi {name}\")\n}";

    let mut harness = TestHarness::mount(Root::new::<CodeBlockHarness>(move || CodeBlockHarnessProps {
        code: short_code.to_owned(),
        language: Some("rust".to_owned()),
    }));

    assert!(harness.find_test_id("code-block").is_some());
    assert!(harness.find_test_id("code-more").is_none(), "short block must not fold");
    assert!(harness.contains_text("rust"));

    // Collect distinct span colors in light mode.
    let span_colors = |h: &TestHarness| -> HashSet<u32> {
        h.texts
            .values()
            .filter(|t| t.text.contains("pub fn greet"))
            .flat_map(|t| t.spans.iter().map(|s| s.style.color.0))
            .collect()
    };
    let colors_light = span_colors(&harness);
    assert!(
        colors_light.len() >= 2,
        "Shiki-highlighted code block must emit multiple distinct span colors in light mode, got {colors_light:?}"
    );

    // Flip to dark mode and confirm reactive re-highlighting updates span colors.
    harness.set_dark(true);
    let colors_dark = span_colors(&harness);
    assert!(colors_dark.len() >= 2);
    assert_ne!(colors_light, colors_dark, "switching light->dark must update code colors");

    // Copy action writes clipboard and emits typed VvCodeCopyEvent, showing localized copy text (never raw i18n keys).
    assert!(
        !harness.contains_text("web.base.rich."),
        "code block must render localized labels, got {:?}",
        harness.all_text_strings()
    );
    let copy_id = harness.find_test_id("code-copy").expect("copy button");
    assert!(harness.press(copy_id));
    assert!(
        !harness.contains_text("web.base.rich."),
        "copied label must be localized, got {:?}",
        harness.all_text_strings()
    );
    assert_eq!(harness.clipboard_writes, vec![short_code]);
    RECORDED_COPIES.with(|c| {
        let recorded = c.borrow();
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].code.as_str(), short_code);
        assert_eq!(recorded[0].language.as_deref(), Some("rust"));
    });
}

#[test]
fn regression_all_rich_ui_i18n_keys_resolve_in_zh_and_en() {
    for lang in ["zh", "en"] {
        for key in [
            "web.base.rich.copy",
            "web.base.rich.copied",
            "web.base.rich.more",
            "web.base.rich.less",
            "web.base.rich.diagram",
        ] {
            let value = vibevalley_i18n::t_in(lang, key, &[]);
            assert!(!value.starts_with("web."), "{lang} key {key} resolved to raw key {value:?}");
        }
        let lines = vibevalley_i18n::t_in(lang, "web.base.rich.lines", &[("n", 24i64.into())]);
        assert!(!lines.starts_with("web."), "{lang} lines resolved to {lines:?}");
        let failed = vibevalley_i18n::t_in(lang, "web.base.rich.diagramFailed", &[("why", "syntax".into())]);
        assert!(!failed.starts_with("web."), "{lang} diagramFailed resolved to {failed:?}");
    }
}

#[test]
fn rich_preview_modal_i18n_keys_resolve_in_zh_and_en() {
    for lang in ["zh", "en"] {
        for key in [
            "web.base.rich.expand",
            "web.base.rich.viewDiagram",
            "web.base.rich.viewSource",
            "web.base.rich.zoomIn",
            "web.base.rich.zoomOut",
            "web.base.rich.zoomReset",
        ] {
            let value = vibevalley_i18n::t_in(lang, key, &[]);
            assert!(!value.starts_with("web."), "{lang} key {key} resolved to raw key {value:?}");
        }
    }
}

#[test]
fn vv_code_block_folds_long_blocks_and_handles_large_async_offload_without_panicking() {
    let _guard = CACHE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 24 lines (> 16 fold threshold), no language -> header shows localized line count.
    let long_code = (1..=24).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");

    let mut harness = TestHarness::mount(Root::new::<CodeBlockHarness>(move || CodeBlockHarnessProps {
        code: long_code.clone(),
        language: None,
    }));

    let more_id = harness.find_test_id("code-more").expect("long block must render fold button");
    assert!(harness.press(more_id), "fold toggle button must handle press");

    // Large block (>120 lines) paints plain text immediately, then finishes async Shiki offload
    // via `nsh_core::prelude::blocking` + `Signal` and paints multiple distinct syntax colors.
    clear_code_highlight_cache();
    let huge_code = (1..=140).map(|i| format!("let x_{i} = {i};")).collect::<Vec<_>>().join("\n");
    let mut huge_harness = TestHarness::mount(Root::new::<CodeBlockHarness>(move || CodeBlockHarnessProps {
        code: huge_code.clone(),
        language: Some("rust".to_owned()),
    }));
    assert!(huge_harness.contains_text("let x_1 = 1;"));
    assert!(huge_harness.find_test_id("code-more").is_some());

    let async_done = huge_harness.wait_until(std::time::Duration::from_secs(5), |h| {
        let colors: HashSet<u32> = h
            .texts
            .values()
            .filter(|t| t.text.contains("let x_1 = 1;"))
            .flat_map(|t| t.spans.iter().map(|s| s.style.color.0))
            .collect();
        colors.len() >= 2
    });
    assert!(
        async_done,
        "large code block should complete background Shiki offload and update Signal with colored spans"
    );
}
