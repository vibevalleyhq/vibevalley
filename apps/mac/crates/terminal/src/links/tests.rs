use std::fs;
use std::sync::Arc;

use unicode_segmentation::UnicodeSegmentation;

use super::file::MAX_QUOTED_PATH_BYTES;
use super::line::grapheme_cols;
use super::*;
use crate::{CellStyle, Point, Rgb, Row, Run};

fn default_style() -> CellStyle {
    CellStyle {
        fg: Rgb(220, 220, 220),
        bg: None,
        bold: false,
        italic: false,
        dim: false,
        underline: false,
        strikethrough: false,
    }
}

fn row(text: &str) -> Arc<Row> {
    row_wrapped(text, false)
}

fn row_wrapped(text: &str, wrapped: bool) -> Arc<Row> {
    let cols: u16 = text.graphemes(true).map(grapheme_cols).sum();
    Arc::new(Row {
        runs: vec![Run {
            start_col: 0,
            cols,
            text: text.to_string(),
            style: default_style(),
            hyperlink: None,
        }],
        wrapped,
    })
}

fn pt(row: u16, col: u16) -> Point {
    Point { row, col }
}

fn col_of(line: &str, needle: &str) -> u16 {
    let idx = line.find(needle).expect("needle in line");
    line[..idx].graphemes(true).map(grapheme_cols).sum()
}

#[test]
fn url_matching_handles_ports_queries_balanced_parens_and_trailing_punctuation() {
    let ctx = LinkResolveContext::default();
    let line = concat!(
        "see (https://en.wikipedia.org/wiki/Rust_(programming_language)), ",
        "http://127.0.0.1:8787/api/v1/slice/board?foo=1&bar=2#top; ",
        "[http://[::1]:8080/a[0]]. ",
        "\"https://example.com/path!\""
    );
    let rows = vec![row(line)];

    let wiki_col = col_of(line, "https://en.wikipedia");
    let wiki = link_at_rows(&rows, 240, pt(0, wiki_col + 10), &ctx).expect("wiki url");
    assert_eq!(wiki.target, LinkTarget::Url("https://en.wikipedia.org/wiki/Rust_(programming_language)".into()));
    assert_eq!(
        wiki.spans,
        vec![LinkSpan {
            row: 0,
            start_col: wiki_col,
            end_col: wiki_col + "https://en.wikipedia.org/wiki/Rust_(programming_language)".len() as u16,
        }]
    );
    assert_eq!(link_at_rows(&rows, 240, pt(0, wiki.spans[0].end_col), &ctx), None);

    let local_col = col_of(line, "http://127.0.0.1");
    let local = link_at_rows(&rows, 240, pt(0, local_col + 5), &ctx).expect("local url");
    assert_eq!(local.target, LinkTarget::Url("http://127.0.0.1:8787/api/v1/slice/board?foo=1&bar=2#top".into()));

    let ipv6_col = col_of(line, "http://[::1]");
    let ipv6 = link_at_rows(&rows, 240, pt(0, ipv6_col + 4), &ctx).expect("ipv6 url");
    assert_eq!(ipv6.target, LinkTarget::Url("http://[::1]:8080/a[0]".into()));

    let quoted_col = col_of(line, "https://example.com");
    let quoted = link_at_rows(&rows, 240, pt(0, quoted_col + 2), &ctx).expect("quoted url");
    assert_eq!(quoted.target, LinkTarget::Url("https://example.com/path".into()));
}

#[test]
fn url_matching_handles_cjk_surrounding_punctuation_and_rejects_empty_hosts() {
    let ctx = LinkResolveContext::default();
    let line = "请打开（https://example.com/docs），或者 http:// 与 https://. 结束";
    let rows = vec![row(line)];

    let url_col = col_of(line, "https://example.com");
    let hit = link_at_rows(&rows, 120, pt(0, url_col + 3), &ctx).expect("cjk-wrapped url");
    assert_eq!(hit.target, LinkTarget::Url("https://example.com/docs".into()));
    assert_eq!(
        hit.spans,
        vec![LinkSpan {
            row: 0,
            start_col: url_col,
            end_col: url_col + "https://example.com/docs".len() as u16,
        }]
    );

    assert_eq!(link_at_rows(&rows, 120, pt(0, col_of(line, "http://") + 2), &ctx), None);
    assert_eq!(link_at_rows(&rows, 120, pt(0, col_of(line, "https://.") + 2), &ctx), None);
}

#[test]
fn soft_wrapped_url_and_file_path_match_across_rows() {
    let dir = tempfile::tempdir().unwrap();
    let nested = dir.path().join("crates/demo/src");
    fs::create_dir_all(&nested).unwrap();
    let file = nested.join("very_long_module.rs");
    fs::write(&file, "fn main() {}\n").unwrap();
    let canonical = fs::canonicalize(&file).unwrap();

    let ctx = LinkResolveContext {
        cwd: Some(dir.path().to_path_buf()),
        project_root: None,
        home: None,
    };

    let r0 = row_wrapped("open https://example.com", true);
    let r1 = row_wrapped("/deep/path/page.html ok", false);
    let rows = vec![r0, r1];
    let hit_top = link_at_rows(&rows, 24, pt(0, 10), &ctx).expect("url top half");
    let hit_bot = link_at_rows(&rows, 24, pt(1, 5), &ctx).expect("url bottom half");
    assert_eq!(hit_top, hit_bot);
    assert_eq!(hit_top.target, LinkTarget::Url("https://example.com/deep/path/page.html".into()));
    assert_eq!(
        hit_top.spans,
        vec![
            LinkSpan {
                row: 0,
                start_col: 5,
                end_col: 24,
            },
            LinkSpan {
                row: 1,
                start_col: 0,
                end_col: 20,
            },
        ]
    );

    let f0 = row_wrapped("--> crates/demo/src/very", true);
    let f1 = row_wrapped("_long_module.rs:42:7 err", false);
    let frows = vec![f0, f1];
    let fhit = link_at_rows(&frows, 24, pt(1, 16), &ctx).expect("wrapped file hit on :line:col");
    assert_eq!(
        fhit.target,
        LinkTarget::File {
            path: canonical,
            line: Some(42),
            col: Some(7),
        }
    );
    assert_eq!(
        fhit.spans,
        vec![
            LinkSpan {
                row: 0,
                start_col: 4,
                end_col: 24,
            },
            LinkSpan {
                row: 1,
                start_col: 0,
                end_col: 20,
            },
        ]
    );
}

#[test]
fn trimmed_trailing_space_on_wrapped_row_does_not_fuse_adjacent_tokens() {
    let ctx = LinkResolveContext::default();
    let r0 = row_wrapped("see", true);
    let r1 = row_wrapped("https://example.com", false);
    let rows = vec![r0, r1];
    let hit = link_at_rows(&rows, 10, pt(1, 2), &ctx).expect("url on second row");
    assert_eq!(hit.target, LinkTarget::Url("https://example.com".into()));
    assert_eq!(
        hit.spans,
        vec![LinkSpan {
            row: 1,
            start_col: 0,
            end_col: 19,
        }]
    );
    assert_eq!(link_at_rows(&rows, 10, pt(0, 1), &ctx), None);
}

#[test]
fn file_paths_resolve_relative_project_root_home_absolute_and_reject_missing() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    let sub = root.join("crates/sub");
    let home = dir.path().join("home");
    fs::create_dir_all(&sub).unwrap();
    fs::create_dir_all(root.join("src")).unwrap();
    fs::create_dir_all(&home).unwrap();

    let root_lib = root.join("src/lib.rs");
    let sub_main = sub.join("main.rs");
    let sub_sibling = root.join("crates/other.md");
    let home_note = home.join("todo.md");
    let abs_file = dir.path().join("abs_file.ts");
    fs::write(&root_lib, "pub fn a() {}\n").unwrap();
    fs::write(&sub_main, "fn main() {}\n").unwrap();
    fs::write(&sub_sibling, "# sibling\n").unwrap();
    fs::write(&home_note, "# todo\n").unwrap();
    fs::write(&abs_file, "export {};\n").unwrap();

    let ctx = LinkResolveContext {
        cwd: Some(sub.clone()),
        project_root: Some(root.clone()),
        home: Some(home.clone()),
    };

    let line = "./main.rs:12";
    let hit = link_at_rows(&[row(line)], 80, pt(0, 2), &ctx).expect("cwd relative");
    assert_eq!(
        hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&sub_main).unwrap(),
            line: Some(12),
            col: None,
        }
    );

    let line = "see ../other.md:3:8;";
    let hit = link_at_rows(&[row(line)], 80, pt(0, 6), &ctx).expect("parent relative");
    assert_eq!(
        hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&sub_sibling).unwrap(),
            line: Some(3),
            col: Some(8),
        }
    );

    for sample in ["src/lib.rs(42,10): err", "src/lib.rs(42, 10): err"] {
        let hit = link_at_rows(&[row(sample)], 80, pt(0, 4), &ctx).expect(sample);
        assert_eq!(
            hit.target,
            LinkTarget::File {
                path: fs::canonicalize(&root_lib).unwrap(),
                line: Some(42),
                col: Some(10),
            }
        );
        let col_idx = col_of(sample, "10");
        assert_eq!(link_at_rows(&[row(sample)], 80, pt(0, col_idx), &ctx), Some(hit));
    }

    let line = "open ~/todo.md#L9 now";
    let hit = link_at_rows(&[row(line)], 80, pt(0, 7), &ctx).expect("home file");
    assert_eq!(
        hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&home_note).unwrap(),
            line: Some(9),
            col: None,
        }
    );

    let line = format!("at run ({}:7:3)", abs_file.display());
    let start = col_of(&line, &abs_file.display().to_string());
    let hit = link_at_rows(&[row(&line)], 200, pt(0, start + 1), &ctx).expect("abs file");
    assert_eq!(
        hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&abs_file).unwrap(),
            line: Some(7),
            col: Some(3),
        }
    );

    let line = "+++ b/src/lib.rs";
    let hit = link_at_rows(&[row(line)], 80, pt(0, 8), &ctx).expect("git diff path");
    assert_eq!(
        hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&root_lib).unwrap(),
            line: None,
            col: None,
        }
    );
    assert_eq!(
        hit.spans,
        vec![LinkSpan {
            row: 0,
            start_col: 6,
            end_col: 16,
        }]
    );

    let missing = "src/does_not_exist.rs:10 /no/such/file.rs ~/missing.md";
    let rows = vec![row(missing)];
    assert_eq!(link_at_rows(&rows, 100, pt(0, 4), &ctx), None);
    assert_eq!(link_at_rows(&rows, 100, pt(0, col_of(missing, "/no/such") + 2), &ctx), None);
    assert_eq!(link_at_rows(&rows, 100, pt(0, col_of(missing, "~/missing") + 2), &ctx), None);
    let dir_line = format!("{}", sub.display());
    assert_eq!(link_at_rows(&[row(&dir_line)], 120, pt(0, 2), &ctx), None);
}

#[test]
fn cwd_takes_precedence_over_project_root_for_same_relative_name() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("repo");
    let sub = root.join("pkg");
    fs::create_dir_all(&sub).unwrap();
    let root_toml = root.join("Cargo.toml");
    let sub_toml = sub.join("Cargo.toml");
    fs::write(&root_toml, "[workspace]\n").unwrap();
    fs::write(&sub_toml, "[package]\n").unwrap();

    let ctx = LinkResolveContext {
        cwd: Some(sub),
        project_root: Some(root),
        home: None,
    };
    let hit = link_at_rows(&[row("Cargo.toml")], 80, pt(0, 3), &ctx).expect("Cargo.toml");
    assert_eq!(
        hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&sub_toml).unwrap(),
            line: None,
            col: None,
        }
    );
}

#[test]
fn file_url_decodes_percent_escapes_and_checks_existence() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("my file.txt");
    fs::write(&file, "hi\n").unwrap();
    let canonical = fs::canonicalize(&file).unwrap();

    let encoded = format!("file://localhost{}/my%20file.txt:5:2", dir.path().display());
    let rows = vec![row(&encoded)];
    let ctx = LinkResolveContext::default();
    let hit = link_at_rows(&rows, 200, pt(0, 12), &ctx).expect("file url");
    assert_eq!(
        hit.target,
        LinkTarget::File {
            path: canonical,
            line: Some(5),
            col: Some(2),
        }
    );

    let missing = format!("file://{}/nope.txt", dir.path().display());
    assert_eq!(link_at_rows(&[row(&missing)], 200, pt(0, 5), &ctx), None);
}

#[test]
fn osc8_hyperlinks_span_styled_runs_and_wrapped_rows() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("readme.md");
    fs::write(&file, "hi\n").unwrap();
    let canonical = fs::canonicalize(&file).unwrap();
    let ctx = LinkResolveContext::default();

    let url: Arc<str> = Arc::from("https://vibevalley.dev/docs");
    let bold = CellStyle { bold: true, ..default_style() };
    let r0 = Arc::new(Row {
        runs: vec![
            Run {
                start_col: 0,
                cols: 4,
                text: "see ".into(),
                style: default_style(),
                hyperlink: None,
            },
            Run {
                start_col: 4,
                cols: 5,
                text: "click".into(),
                style: default_style(),
                hyperlink: Some(url.clone()),
            },
            Run {
                start_col: 9,
                cols: 5,
                text: " here".into(),
                style: bold,
                hyperlink: Some(url.clone()),
            },
        ],
        wrapped: true,
    });
    let r1 = Arc::new(Row {
        runs: vec![
            Run {
                start_col: 0,
                cols: 3,
                text: "now".into(),
                style: default_style(),
                hyperlink: Some(url.clone()),
            },
            Run {
                start_col: 3,
                cols: 4,
                text: " end".into(),
                style: default_style(),
                hyperlink: None,
            },
        ],
        wrapped: false,
    });
    let rows = vec![r0, r1];
    let hit = link_at_rows(&rows, 14, pt(0, 10), &ctx).expect("osc8 wrapped");
    assert_eq!(hit.target, LinkTarget::Url("https://vibevalley.dev/docs".into()));
    assert_eq!(
        hit.spans,
        vec![
            LinkSpan {
                row: 0,
                start_col: 4,
                end_col: 14,
            },
            LinkSpan {
                row: 1,
                start_col: 0,
                end_col: 3,
            },
        ]
    );
    assert_eq!(link_at_rows(&rows, 14, pt(1, 5), &ctx), None);

    let file_uri: Arc<str> = Arc::from(format!("file://{}", file.display()));
    let file_row = Arc::new(Row {
        runs: vec![Run {
            start_col: 0,
            cols: 6,
            text: "readme".into(),
            style: default_style(),
            hyperlink: Some(file_uri),
        }],
        wrapped: false,
    });
    let fhit = link_at_rows(&[file_row], 80, pt(0, 2), &ctx).expect("osc8 file");
    assert_eq!(
        fhit.target,
        LinkTarget::File {
            path: canonical,
            line: None,
            col: None,
        }
    );

    let js_row = Arc::new(Row {
        runs: vec![Run {
            start_col: 0,
            cols: 3,
            text: "bad".into(),
            style: default_style(),
            hyperlink: Some(Arc::from("javascript:alert(1)")),
        }],
        wrapped: false,
    });
    assert_eq!(link_at_rows(&[js_row], 80, pt(0, 1), &ctx), None);
}

#[test]
fn lazy_resolver_skips_cwd_lookup_for_urls_and_plain_words() {
    let mut called = 0usize;
    let rows = vec![row("hello https://example.com world")];
    let hit = link_at_rows_with(&rows, 80, pt(0, 10), || {
        called += 1;
        LinkResolveContext::default()
    });
    assert_eq!(hit.map(|h| h.target), Some(LinkTarget::Url("https://example.com".into())));
    assert_eq!(called, 0);

    let plain = link_at_rows_with(&rows, 80, pt(0, 1), || {
        called += 1;
        LinkResolveContext::default()
    });
    assert_eq!(plain, None);
    assert_eq!(called, 0);
}

#[test]
fn quoted_path_with_spaces_and_flag_equals_paths_match() {
    let dir = tempfile::tempdir().unwrap();
    let spaced = dir.path().join("My Notes/hello world.md");
    fs::create_dir_all(spaced.parent().unwrap()).unwrap();
    fs::write(&spaced, "hi\n").unwrap();
    let cfg = dir.path().join("config.toml");
    fs::write(&cfg, "x = 1\n").unwrap();

    let ctx = LinkResolveContext {
        cwd: Some(dir.path().to_path_buf()),
        project_root: None,
        home: None,
    };

    let quoted_line = format!("File \"{}\" line 1", spaced.display());
    let col = col_of(&quoted_line, "hello");
    let hit = link_at_rows(&[row(&quoted_line)], 200, pt(0, col), &ctx).expect("quoted path");
    assert_eq!(
        hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&spaced).unwrap(),
            line: None,
            col: None,
        }
    );

    let flag_line = "--config=config.toml";
    let hit = link_at_rows(&[row(flag_line)], 80, pt(0, 12), &ctx).expect("flag=path");
    assert_eq!(
        hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&cfg).unwrap(),
            line: None,
            col: None,
        }
    );
    assert_eq!(
        hit.spans,
        vec![LinkSpan {
            row: 0,
            start_col: 9,
            end_col: 20,
        }]
    );
}

#[test]
fn wide_cjk_prefixes_cjk_filenames_comma_lists_and_extensionless_files_match() {
    let dir = tempfile::tempdir().unwrap();
    let note_dir = dir.path().join("笔记");
    fs::create_dir_all(&note_dir).unwrap();
    let note = note_dir.join("说明.md");
    let makefile = dir.path().join("Makefile");
    fs::write(&note, "# 中文\n").unwrap();
    fs::write(&makefile, "all:\n").unwrap();

    let ctx = LinkResolveContext {
        cwd: Some(dir.path().to_path_buf()),
        project_root: None,
        home: None,
    };

    let line = "打开 笔记/说明.md:3 或 (foo,Makefile)";
    let rows = vec![row(line)];
    let note_col = col_of(line, "笔记");
    assert_eq!(note_col, 5);
    let note_hit = link_at_rows(&rows, 80, pt(0, note_col + 1), &ctx).expect("cjk file path");
    assert_eq!(
        note_hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&note).unwrap(),
            line: Some(3),
            col: None,
        }
    );
    assert_eq!(
        note_hit.spans,
        vec![LinkSpan {
            row: 0,
            start_col: 5,
            end_col: 19,
        }]
    );

    let mk_col = col_of(line, "Makefile");
    let mk_hit = link_at_rows(&rows, 80, pt(0, mk_col + 2), &ctx).expect("comma-delimited Makefile");
    assert_eq!(
        mk_hit.target,
        LinkTarget::File {
            path: fs::canonicalize(&makefile).unwrap(),
            line: None,
            col: None,
        }
    );
    assert_eq!(
        mk_hit.spans,
        vec![LinkSpan {
            row: 0,
            start_col: mk_col,
            end_col: mk_col + "Makefile".len() as u16,
        }]
    );

    assert_eq!(link_at_rows(&[row("file:///")], 40, pt(0, 2), &ctx), None);
}

#[test]
fn regression_quoted_path_scan_aligns_multibyte_utf8_boundary() {
    let ctx = LinkResolveContext::default();
    let mut line = String::from("\"a");
    for _ in 0..200 {
        line.push('中');
    }
    line.push('"');
    assert!(!line.is_char_boundary(1 + MAX_QUOTED_PATH_BYTES));

    let rows = vec![row(&line)];
    let cols: u16 = line.graphemes(true).map(grapheme_cols).sum();
    for col in [1u16, 2, 3, 4, 5, 10] {
        assert_eq!(link_at_rows(&rows, cols, pt(0, col), &ctx), None);
    }
}

#[test]
fn regression_colon_segment_trailing_punctuation_does_not_panic() {
    let ctx = LinkResolveContext::default();
    for sample in ["foo:bar:.", "a:b:)))", "x:y:::"] {
        let rows = vec![row(sample)];
        for col in 0..sample.len() as u16 {
            assert_eq!(link_at_rows(&rows, 40, pt(0, col), &ctx), None);
        }
    }
}
