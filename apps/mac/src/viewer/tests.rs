use std::path::Path;

use vibevalley_files::{HighlightKind, HighlightSpan, Language};

use super::HtmlViewMode;
use super::highlight::{clip_spans, prepare};
use super::toolbar::{
    HTML_PREVIEW_CAPABILITIES, build_html_preview_bundle, build_html_preview_document, format_bytes, html_mode_labels, is_html_path, split_display_path,
};

#[test]
fn spans_are_clipped_to_line_and_char_boundaries() {
    let spans = vec![
        HighlightSpan {
            range: 0..2,
            kind: HighlightKind::Keyword,
        },
        HighlightSpan {
            range: 3..4,
            kind: HighlightKind::String,
        },
        HighlightSpan {
            range: 5..99,
            kind: HighlightKind::Comment,
        },
    ];
    // "é" is two bytes (3..5), so 3..4 is not a boundary.
    let clipped = clip_spans("fn é xy", &spans);
    assert_eq!(clipped, vec![(0..2, HighlightKind::Keyword), (5..8, HighlightKind::Comment)]);
}

#[test]
fn prepare_pairs_lines_with_spans() {
    let lines = prepare("a\nb\n", None);
    assert_eq!(lines.len(), 2);
    assert!(lines.iter().all(|l| l.spans.is_empty()));
    let lang = Language("rust".into());
    let lines = prepare("fn main() {}\n// hi", Some(&lang));
    assert_eq!(lines.len(), 2);
    assert!(!lines[0].spans.is_empty(), "rust is highlighted");
}

#[test]
fn formats_byte_sizes_human_readably() {
    assert_eq!(format_bytes(512), "512 B");
    assert_eq!(format_bytes(1536), "1.5 KB");
    assert_eq!(format_bytes(8 * 1024 * 1024), "8.0 MB");
}

#[test]
fn splits_file_name_from_parent_directory() {
    let (name, dir) = split_display_path(Path::new("/tmp/project/src/viewer.rs"));
    assert_eq!(name, "viewer.rs");
    assert_eq!(dir.as_deref(), Some("/tmp/project/src"));
}

#[test]
fn prepare_highlights_every_supported_language() {
    for &name in vibevalley_files::SUPPORTED {
        let sample = match name {
            "rust" => "pub fn greet() -> i32 { 42 }",
            "typescript" | "javascript" => "export const count: number = 1;",
            "tsx" => "export const App = () => <View>hi</View>;",
            "json" => "{\"key\": \"value\", \"ok\": true}",
            "toml" => "[package]\nname = \"vibevalley\"",
            "yaml" => "name: vibevalley\nenabled: true",
            "markdown" => "# Title\n**bold** [site](https://example.com)",
            "python" => "def greet(name):\n    return f\"hi {name}\"",
            "go" => "package main\nfunc main() { return }",
            "bash" => "# comment\nif [ -f Cargo.toml ]; then echo \"ok\"; fi",
            "html" => "<div class=\"card\">hello</div>",
            "css" => ".card { color: #ff00aa; padding: 8px; }",
            "c" | "cpp" => "#include <stdio.h>\nint main() { return 0; }",
            "zig" => "const std = @import(\"std\");\npub fn main() void {}",
            "swift" => "struct Farm { let acres: Int = 4 }",
            other => panic!("unhandled supported language in test: {other}"),
        };
        let lang = Language(name.to_string());
        let lines = prepare(sample, Some(&lang));
        assert!(
            lines.iter().any(|l| !l.spans.is_empty()),
            "supported language `{name}` produced no highlight spans for sample"
        );
    }
}

#[test]
fn prepare_propagates_multiline_state_and_markdown_kinds() {
    let rust = Language("rust".into());
    let lines = prepare("/* line 1\nline 2 */\nfn main() {}", Some(&rust));
    assert_eq!(lines.len(), 3);
    assert!(lines[1].spans.iter().any(|s| s.kind == HighlightKind::Comment));
    assert!(lines[2].spans.iter().any(|s| s.kind == HighlightKind::Keyword && s.range == (0..2)));

    let md = Language("markdown".into());
    let md_lines = prepare("# Title\n**bold** [site](https://example.com)", Some(&md));
    assert!(md_lines[0].spans.iter().any(|s| s.kind == HighlightKind::Heading));
    assert!(md_lines[1].spans.iter().any(|s| s.kind == HighlightKind::Emphasis));
    assert!(md_lines[1].spans.iter().any(|s| s.kind == HighlightKind::Link));
}

#[test]
fn html_paths_default_to_preview_mode_case_insensitively() {
    for path in ["index.html", "DIR/PAGE.HTML", "widget.htm", "LEGACY.HTM"] {
        assert!(is_html_path(Path::new(path)), "{path} should be detected as HTML");
        assert_eq!(HtmlViewMode::default_for_path(Path::new(path)), HtmlViewMode::Preview);
    }
    for path in ["notes.md", "app.tsx", "styles.css", "html", "index.html.bak"] {
        assert!(!is_html_path(Path::new(path)), "{path} should not be detected as HTML");
        assert_eq!(HtmlViewMode::default_for_path(Path::new(path)), HtmlViewMode::Source);
    }
}

#[test]
fn build_html_preview_document_enforces_strict_sandbox_csp() {
    let full = "<!doctype html><html><head><title>Demo</title></head><body><h1>Hi</h1></body></html>";
    let full_out = build_html_preview_document(full);
    assert!(full_out.contains("default-src 'none'"));
    assert!(full_out.contains("connect-src 'none'"));
    assert!(full_out.contains("form-action 'none'"));
    assert!(full_out.contains("base-uri 'none'"));
    assert!(full_out.contains("<h1>Hi</h1>"));

    let fragment = "<p>fragment</p>";
    let frag_out = build_html_preview_document(fragment);
    assert!(frag_out.contains("connect-src 'none'"));
    assert!(frag_out.contains("<p>fragment</p>"));
}

#[test]
fn html_preview_bundle_denies_external_hosts_and_renders_localized_labels() {
    let caps: serde_json::Value = serde_json::from_str(HTML_PREVIEW_CAPABILITIES).expect("valid capabilities json");
    assert_eq!(caps["webview"]["hosts"], serde_json::json!([]));
    assert!(build_html_preview_bundle().is_ok());

    let prev = vibevalley_i18n::locale();
    vibevalley_i18n::set_locale("zh");
    assert_eq!(html_mode_labels(), ("预览".to_string(), "源码".to_string()));
    vibevalley_i18n::set_locale("en");
    assert_eq!(html_mode_labels(), ("Preview".to_string(), "Source".to_string()));
    vibevalley_i18n::set_locale(&prev);
}
