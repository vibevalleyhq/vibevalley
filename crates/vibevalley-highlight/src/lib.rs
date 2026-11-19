use std::sync::OnceLock;

use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

use vibevalley_files::{HighlightKind, HighlightSpan, Language, SUPPORTED};

/// Reached only through injection (the inline half of the markdown grammar).
const MARKDOWN_INLINE: &str = "markdown_inline";

/// Capture names the queries of the bundled grammars use, and what each is
/// shown as. A capture resolves to the entry sharing the most leading parts
/// with it (`keyword.control.repeat` -> `keyword`); `None` entries exist so
/// that a more specific name can opt out of its parent's color.
const CAPTURES: &[(&str, Option<HighlightKind>)] = &[
    ("attribute", Some(HighlightKind::Attribute)),
    ("boolean", Some(HighlightKind::Constant)),
    ("character", Some(HighlightKind::String)),
    ("character.special", Some(HighlightKind::Constant)),
    ("charset", Some(HighlightKind::Keyword)),
    ("cImport", Some(HighlightKind::Keyword)),
    ("comment", Some(HighlightKind::Comment)),
    ("conditional", Some(HighlightKind::Keyword)),
    ("constant", Some(HighlightKind::Constant)),
    ("constructor", Some(HighlightKind::Type)),
    ("delimiter", Some(HighlightKind::Punctuation)),
    ("embedded", None),
    ("escape", Some(HighlightKind::Constant)),
    ("exception", Some(HighlightKind::Keyword)),
    ("field", Some(HighlightKind::Property)),
    ("function", Some(HighlightKind::Function)),
    ("import", Some(HighlightKind::Keyword)),
    ("include", Some(HighlightKind::Keyword)),
    ("keyframes", Some(HighlightKind::Keyword)),
    ("keyword", Some(HighlightKind::Keyword)),
    // Without this, `keyword.function` (Swift's `func`) ties with `function`.
    ("keyword.function", Some(HighlightKind::Keyword)),
    ("keyword.operator", Some(HighlightKind::Operator)),
    ("label", Some(HighlightKind::Attribute)),
    ("media", Some(HighlightKind::Keyword)),
    ("method", Some(HighlightKind::Function)),
    ("module", Some(HighlightKind::Type)),
    ("namespace", Some(HighlightKind::Type)),
    ("none", None),
    ("number", Some(HighlightKind::Number)),
    ("operator", Some(HighlightKind::Operator)),
    ("parameter", Some(HighlightKind::Variable)),
    ("property", Some(HighlightKind::Property)),
    ("punctuation", Some(HighlightKind::Punctuation)),
    ("repeat", Some(HighlightKind::Keyword)),
    ("storageclass", Some(HighlightKind::Keyword)),
    ("string", Some(HighlightKind::String)),
    ("string.escape", Some(HighlightKind::Constant)),
    ("string.special.key", Some(HighlightKind::Property)),
    ("supports", Some(HighlightKind::Keyword)),
    ("tag", Some(HighlightKind::Tag)),
    ("text.emphasis", Some(HighlightKind::Emphasis)),
    ("text.literal", Some(HighlightKind::String)),
    ("text.reference", Some(HighlightKind::Link)),
    ("text.strong", Some(HighlightKind::Emphasis)),
    ("text.title", Some(HighlightKind::Heading)),
    ("text.uri", Some(HighlightKind::Link)),
    ("type", Some(HighlightKind::Type)),
    ("variable", Some(HighlightKind::Variable)),
    ("variable.builtin", Some(HighlightKind::Keyword)),
    ("variable.member", Some(HighlightKind::Property)),
    ("variable.parameter", Some(HighlightKind::Variable)),
];

/// Canonical name for whatever a caller or an injection (a markdown code
/// fence, say) calls a language.
fn canonical(name: &str) -> Option<&'static str> {
    let lower = name.trim().to_ascii_lowercase();
    Some(match lower.as_str() {
        "rust" | "rs" => "rust",
        "typescript" | "ts" | "mts" | "cts" => "typescript",
        "tsx" => "tsx",
        "javascript" | "js" | "jsx" | "mjs" | "cjs" | "node" => "javascript",
        "json" | "jsonc" | "json5" => "json",
        "toml" => "toml",
        "yaml" | "yml" => "yaml",
        "markdown" | "md" => "markdown",
        "markdown_inline" => MARKDOWN_INLINE,
        "python" | "py" | "python3" => "python",
        "go" | "golang" => "go",
        "bash" | "sh" | "shell" | "zsh" | "console" => "bash",
        "html" | "htm" | "xhtml" => "html",
        "css" => "css",
        "c" | "h" => "c",
        "cpp" | "c++" | "cc" | "cxx" | "hpp" => "cpp",
        "zig" => "zig",
        "swift" => "swift",
        _ => return None,
    })
}

fn build(name: &'static str) -> Option<HighlightConfiguration> {
    use tree_sitter_javascript as js;
    use tree_sitter_typescript as ts;

    // Later patterns win, so a derived language's own query goes after the
    // query of the language it extends.
    let join = |parts: &[&str]| parts.join("\n");
    let (language, highlights, injections, locals): (tree_sitter::Language, String, String, String) = match name {
        "rust" => (
            tree_sitter_rust::LANGUAGE.into(),
            tree_sitter_rust::HIGHLIGHTS_QUERY.into(),
            tree_sitter_rust::INJECTIONS_QUERY.into(),
            String::new(),
        ),
        "typescript" => (
            ts::LANGUAGE_TYPESCRIPT.into(),
            join(&[js::HIGHLIGHT_QUERY, ts::HIGHLIGHTS_QUERY]),
            js::INJECTIONS_QUERY.into(),
            join(&[js::LOCALS_QUERY, ts::LOCALS_QUERY]),
        ),
        "tsx" => (
            ts::LANGUAGE_TSX.into(),
            join(&[js::HIGHLIGHT_QUERY, js::JSX_HIGHLIGHT_QUERY, ts::HIGHLIGHTS_QUERY]),
            js::INJECTIONS_QUERY.into(),
            join(&[js::LOCALS_QUERY, ts::LOCALS_QUERY]),
        ),
        "javascript" => (
            js::LANGUAGE.into(),
            join(&[js::HIGHLIGHT_QUERY, js::JSX_HIGHLIGHT_QUERY]),
            js::INJECTIONS_QUERY.into(),
            js::LOCALS_QUERY.into(),
        ),
        "json" => (
            tree_sitter_json::LANGUAGE.into(),
            tree_sitter_json::HIGHLIGHTS_QUERY.into(),
            String::new(),
            String::new(),
        ),
        "toml" => (
            tree_sitter_toml_ng::LANGUAGE.into(),
            tree_sitter_toml_ng::HIGHLIGHTS_QUERY.into(),
            String::new(),
            String::new(),
        ),
        "yaml" => (
            tree_sitter_yaml::LANGUAGE.into(),
            tree_sitter_yaml::HIGHLIGHTS_QUERY.into(),
            String::new(),
            String::new(),
        ),
        "markdown" => (
            tree_sitter_md::LANGUAGE.into(),
            tree_sitter_md::HIGHLIGHT_QUERY_BLOCK.into(),
            // The block grammar's `inline` nodes have children; without
            // include-children the inline layer gets no text at all.
            tree_sitter_md::INJECTION_QUERY_BLOCK.replace(
                "(#set! injection.language \"markdown_inline\"))",
                "(#set! injection.language \"markdown_inline\")\n  (#set! injection.include-children))",
            ),
            String::new(),
        ),
        MARKDOWN_INLINE => (
            tree_sitter_md::INLINE_LANGUAGE.into(),
            tree_sitter_md::HIGHLIGHT_QUERY_INLINE.into(),
            tree_sitter_md::INJECTION_QUERY_INLINE.into(),
            String::new(),
        ),
        "python" => (
            tree_sitter_python::LANGUAGE.into(),
            tree_sitter_python::HIGHLIGHTS_QUERY.into(),
            String::new(),
            String::new(),
        ),
        "go" => (
            tree_sitter_go::LANGUAGE.into(),
            tree_sitter_go::HIGHLIGHTS_QUERY.into(),
            String::new(),
            String::new(),
        ),
        "bash" => (
            tree_sitter_bash::LANGUAGE.into(),
            tree_sitter_bash::HIGHLIGHT_QUERY.into(),
            String::new(),
            String::new(),
        ),
        "html" => (
            tree_sitter_html::LANGUAGE.into(),
            tree_sitter_html::HIGHLIGHTS_QUERY.into(),
            tree_sitter_html::INJECTIONS_QUERY.into(),
            String::new(),
        ),
        "css" => (
            tree_sitter_css::LANGUAGE.into(),
            tree_sitter_css::HIGHLIGHTS_QUERY.into(),
            String::new(),
            String::new(),
        ),
        "c" => (
            tree_sitter_c::LANGUAGE.into(),
            tree_sitter_c::HIGHLIGHT_QUERY.into(),
            String::new(),
            String::new(),
        ),
        "cpp" => (
            tree_sitter_cpp::LANGUAGE.into(),
            join(&[tree_sitter_c::HIGHLIGHT_QUERY, tree_sitter_cpp::HIGHLIGHT_QUERY]),
            String::new(),
            String::new(),
        ),
        "zig" => (
            tree_sitter_zig::LANGUAGE.into(),
            tree_sitter_zig::HIGHLIGHTS_QUERY.into(),
            String::new(),
            String::new(),
        ),
        "swift" => (
            tree_sitter_swift::LANGUAGE.into(),
            // A node with two captures shows only one; `@spell` (spell
            // checking, no color) would hide `@comment`.
            tree_sitter_swift::HIGHLIGHTS_QUERY.replace(" @spell", ""),
            String::new(),
            String::new(),
        ),
        _ => return None,
    };
    let mut config = HighlightConfiguration::new(language, name, &highlights, &injections, &locals).ok()?;
    let names: Vec<&str> = CAPTURES.iter().map(|(name, _)| *name).collect();
    config.configure(&names);
    Some(config)
}

/// Compiling a grammar's queries takes milliseconds; each is done once.
fn config(name: &str) -> Option<&'static HighlightConfiguration> {
    const SLOTS: usize = SUPPORTED.len() + 1;
    static CONFIGS: [OnceLock<Option<HighlightConfiguration>>; SLOTS] = [const { OnceLock::new() }; SLOTS];
    let name = canonical(name)?;
    let slot = SUPPORTED.iter().position(|s| *s == name).unwrap_or(SUPPORTED.len());
    CONFIGS[slot].get_or_init(|| build(name)).as_ref()
}

struct Lines<'a> {
    text: &'a str,
    /// Start and end (without the terminator) of each line.
    bounds: Vec<(usize, usize)>,
    spans: Vec<Vec<HighlightSpan>>,
    /// The line the previous span landed on; spans arrive in order.
    cursor: usize,
}

impl<'a> Lines<'a> {
    fn new(text: &'a str) -> Lines<'a> {
        let base = text.as_ptr() as usize;
        let bounds: Vec<(usize, usize)> = text
            .lines()
            .map(|line| {
                let start = line.as_ptr() as usize - base;
                (start, start + line.len())
            })
            .collect();
        Lines {
            text,
            spans: vec![Vec::new(); bounds.len()],
            bounds,
            cursor: 0,
        }
    }

    fn add(&mut self, mut start: usize, end: usize, kind: HighlightKind) {
        let end = end.min(self.text.len());
        while start < end && self.cursor < self.bounds.len() {
            let (line_start, line_end) = self.bounds[self.cursor];
            if start >= line_end {
                // Past this line's text (or sitting on its terminator).
                if self.cursor + 1 == self.bounds.len() {
                    return;
                }
                self.cursor += 1;
                continue;
            }
            let from = start.max(line_start);
            let to = end.min(line_end);
            if from < to {
                let range = from - line_start..to - line_start;
                match self.spans[self.cursor].last_mut() {
                    Some(prev) if prev.kind == kind && prev.range.end == range.start => prev.range.end = range.end,
                    _ => self.spans[self.cursor].push(HighlightSpan { range, kind }),
                }
            }
            if end <= line_end {
                return;
            }
            start = line_end;
        }
    }
}

/// Highlight spans for each line of `text` (one inner `Vec` per line, spans
/// sorted and non-overlapping). Unknown languages yield empty lines. Lines
/// are those of `str::lines`, so spans never cover a line terminator.
pub fn highlight(text: &str, language: &Language) -> Vec<Vec<HighlightSpan>> {
    let mut lines = Lines::new(text);
    let Some(config) = config(&language.0) else { return lines.spans };

    let mut highlighter = Highlighter::new();
    // A closure, not the fn item: passing the fn directly pins the callback's
    // lifetime to 'static and with it `text`.
    #[allow(clippy::redundant_closure)]
    let Ok(events) = highlighter.highlight(config, text.as_bytes(), None, None, |name| config_for_injection(name)) else {
        return lines.spans;
    };
    // Innermost capture last; `None` entries are captures with no color.
    let mut stack: Vec<Option<HighlightKind>> = Vec::new();
    for event in events {
        match event {
            Ok(HighlightEvent::HighlightStart(highlight)) => {
                stack.push(CAPTURES.get(highlight.0).and_then(|(_, kind)| *kind));
            }
            Ok(HighlightEvent::HighlightEnd) => {
                stack.pop();
            }
            Ok(HighlightEvent::Source { start, end }) => {
                if let Some(kind) = stack.iter().rev().find_map(|kind| *kind) {
                    // Some grammars (Rust) tag numbers as builtin constants.
                    let kind = if kind == HighlightKind::Constant && looks_numeric(&text[start..end]) {
                        HighlightKind::Number
                    } else {
                        kind
                    };
                    lines.add(start, end, kind);
                }
            }
            // Keep what was highlighted so far.
            Err(_) => break,
        }
    }
    lines.spans
}

fn looks_numeric(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    digits.as_bytes().first().is_some_and(u8::is_ascii_digit)
}

fn config_for_injection(name: &str) -> Option<&'static HighlightConfiguration> {
    config(name)
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    fn run(text: &str, language: &str) -> Vec<Vec<HighlightSpan>> {
        let spans = crate::highlight(text, &Language(language.to_string()));
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(spans.len(), lines.len(), "one entry per line");
        for (line, spans) in lines.iter().zip(&spans) {
            let mut at = 0;
            for span in spans {
                assert!(span.range.start >= at, "sorted, no overlap: {spans:?}");
                assert!(span.range.start < span.range.end, "empty span: {spans:?}");
                assert!(span.range.end <= line.len(), "span leaves line {line:?}: {span:?}");
                assert!(line.is_char_boundary(span.range.start) && line.is_char_boundary(span.range.end));
                at = span.range.end;
            }
        }
        spans
    }

    /// The kind of the span covering the first occurrence of `needle`.
    fn kind_of(text: &str, language: &str, needle: &str) -> Option<HighlightKind> {
        let spans = run(text, language);
        for (line, spans) in text.lines().zip(&spans) {
            if let Some(at) = line.find(needle) {
                return spans.iter().find(|s| s.range.start <= at && at + needle.len() <= s.range.end).map(|s| s.kind);
            }
        }
        panic!("{needle:?} not in text");
    }

    #[test]
    fn rust_spans_are_per_line_and_typed() {
        let text = "// 注释 comment\nfn main() {\n    let s: String = \"héllo\".to_string();\n    let n = 42;\n}\n";
        let spans = run(text, "rust");
        assert_eq!(spans.len(), 5);
        assert_eq!(
            spans[0],
            vec![HighlightSpan {
                range: 0..17,
                kind: HighlightKind::Comment
            }]
        );
        assert_eq!(
            spans[1][0],
            HighlightSpan {
                range: 0..2,
                kind: HighlightKind::Keyword
            }
        );
        assert_eq!(
            spans[1][1],
            HighlightSpan {
                range: 3..7,
                kind: HighlightKind::Function
            }
        );
        assert_eq!(kind_of(text, "rust", "String"), Some(HighlightKind::Type));
        assert_eq!(kind_of(text, "rust", "\"héllo\""), Some(HighlightKind::String));
        assert_eq!(kind_of(text, "rust", "42"), Some(HighlightKind::Number));
        assert_eq!(kind_of(text, "rust", "to_string"), Some(HighlightKind::Function));
    }

    #[test]
    fn multi_line_tokens_are_split_at_line_ends() {
        let text = "/* one\r\n   two */\r\nlet x = `a\nb`;";
        let spans = run(text, "javascript");
        assert_eq!(
            spans[0],
            vec![HighlightSpan {
                range: 0..6,
                kind: HighlightKind::Comment
            }]
        );
        assert_eq!(
            spans[1],
            vec![HighlightSpan {
                range: 0..9,
                kind: HighlightKind::Comment
            }]
        );
        assert_eq!(spans[2].last().unwrap().kind, HighlightKind::String);
        assert_eq!(
            spans[3][0],
            HighlightSpan {
                range: 0..2,
                kind: HighlightKind::String
            }
        );
    }

    #[test]
    fn every_supported_language_highlights() {
        use HighlightKind::*;
        type Case = (&'static str, &'static str, &'static [(&'static str, HighlightKind)]);
        let cases: &[Case] = &[
            ("rust", "pub struct Point { x: i32 }\n", &[("pub", Keyword), ("Point", Type)]),
            (
                "typescript",
                "interface User { name: string }\nconst n: number = 1; // c\n",
                &[("interface", Keyword), ("string", Type), ("1", Number), ("// c", Comment)],
            ),
            (
                "tsx",
                "const App = () => <div className=\"a\">hi</div>;\n",
                &[("const", Keyword), ("div", Tag), ("\"a\"", String)],
            ),
            (
                "javascript",
                "function add(a, b) { return a + 'x'; }\n",
                &[("function", Keyword), ("add", Function), ("'x'", String)],
            ),
            ("json", "{\"key\": [1, true, \"v\"]}\n", &[("1", Number), ("\"v\"", String)]),
            (
                "toml",
                "[package]\nname = \"vibevalley\" # c\n",
                &[("\"vibevalley\"", String), ("# c", Comment)],
            ),
            ("yaml", "name: vibevalley # c\ncount: 3\n", &[("name", Property), ("# c", Comment)]),
            ("markdown", "# Title\n\nSome *emphasis* and `code`.\n", &[("Title", Heading)]),
            (
                "python",
                "def greet(name):\n    return f\"hi {name}\"  # c\n",
                &[("def", Keyword), ("greet", Function), ("# c", Comment)],
            ),
            (
                "go",
                "package main\nfunc main() { x := \"s\" }\n",
                &[("package", Keyword), ("func", Keyword), ("\"s\"", String)],
            ),
            (
                "bash",
                "#!/bin/bash\nif [ -f x ]; then echo \"hi\"; fi\n",
                &[("if", Keyword), ("echo", Function), ("\"hi\"", String)],
            ),
            (
                "html",
                "<!-- c --><a href=\"x\">t</a>\n",
                &[("<!-- c -->", Comment), ("a", Tag), ("href", Attribute)],
            ),
            ("css", "/* c */ .a { color: red; }\n", &[("/* c */", Comment), ("color", Property)]),
            (
                "c",
                "#include <stdio.h>\nint main(void) { return 0; } // c\n",
                &[("int", Type), ("return", Keyword), ("0", Number)],
            ),
            (
                "cpp",
                "class Foo { public: int bar() { return 1; } };\n",
                &[("class", Keyword), ("return", Keyword), ("1", Number)],
            ),
            (
                "zig",
                "const std = @import(\"std\");\npub fn main() void {} // c\n",
                &[("const", Keyword), ("\"std\"", String), ("// c", Comment)],
            ),
            (
                "swift",
                "func greet(name: String) -> String { return \"hi\" } // c\n",
                &[("func", Keyword), ("\"hi\"", String), ("// c", Comment)],
            ),
        ];
        let covered: Vec<&str> = cases.iter().map(|c| c.0).collect();
        assert_eq!(covered, SUPPORTED, "a case for every supported language");
        for (language, text, expected) in cases {
            for (needle, kind) in *expected {
                assert_eq!(kind_of(text, language, needle), Some(*kind), "{language}: {needle:?}");
            }
        }
    }

    #[test]
    fn markdown_inline_and_fenced_code_are_injected() {
        let text = "# 标题\n\nSee [the docs](https://example.com) and *this*.\n\n```rust\nfn main() {}\n```\n";
        assert_eq!(kind_of(text, "markdown", "标题"), Some(HighlightKind::Heading));
        assert_eq!(kind_of(text, "markdown", "https://example.com"), Some(HighlightKind::Link));
        assert_eq!(kind_of(text, "markdown", "this"), Some(HighlightKind::Emphasis));
        assert_eq!(kind_of(text, "markdown", "fn"), Some(HighlightKind::Keyword));

        let html = "<script>const x = 1;</script><style>a { color: red }</style>\n";
        assert_eq!(kind_of(html, "html", "const"), Some(HighlightKind::Keyword));
        assert_eq!(kind_of(html, "html", "color"), Some(HighlightKind::Property));
    }

    #[test]
    fn unknown_language_and_aliases() {
        let text = "fn main() {}\nsecond\n\nfourth";
        assert_eq!(run(text, "klingon"), vec![Vec::new(); 4]);
        assert_eq!(run(text, ""), vec![Vec::new(); 4]);
        assert!(run("", "rust").is_empty());
        assert_eq!(run("\n\n", "rust"), vec![Vec::new(); 2]);
        assert_eq!(run(text, "rs"), run(text, "rust"));
        assert_eq!(run("int x;", "c++"), run("int x;", "cpp"));
        assert_eq!(run("a: 1", "YAML"), run("a: 1", "yaml"));
    }

    #[test]
    fn malformed_input_does_not_panic() {
        let nasty = [
            "fn (((((( { \" unterminated\n}}}}}} ]]] /* never closed",
            "\"\\",
            "<<<<<<< HEAD\n=======\n>>>>>>> theirs\n",
            "\u{0}\u{1}\u{feff}\u{202e}数据\r\r\n\r",
            "```\n```rust\n`\n*_[](<",
            "{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{{",
            "'''\n\"\"\"\n${{{`",
        ];
        let deep = format!("{}{}", "(".repeat(5000), "[".repeat(5000));
        for language in SUPPORTED {
            for text in nasty.iter().copied().chain([deep.as_str()]) {
                run(text, language);
            }
        }
    }

    /// Benchmark-style; run with `--nocapture` for the timings.
    #[test]
    fn twenty_thousand_lines_highlight_quickly() {
        let unit = "\
/// Computes the thing for `input`.
pub fn compute_NNN(input: &[u32], scale: f64) -> Result<Vec<String>, Error> {
    let mut out = Vec::with_capacity(input.len());
    for (index, value) in input.iter().enumerate() {
        if *value % 2 == 0 && index != NNN {
            out.push(format!(\"{index}: {}\", (*value as f64) * scale));
        } else {
            out.push(String::from(\"odd\")); // skipped
        }
    }
    Ok(out)
}

";
        let mut text = String::new();
        let mut n = 0;
        while text.lines().count() < 20_000 {
            text.push_str(&unit.replace("NNN", &n.to_string()));
            n += 1;
        }
        let line_count = text.lines().count();

        // The first call also compiles the grammar's queries.
        let started = Instant::now();
        crate::highlight("fn warm() {}", &Language("rust".into()));
        let warm = started.elapsed();
        let started = Instant::now();
        let spans = crate::highlight(&text, &Language("rust".into()));
        let elapsed = started.elapsed();
        println!(
            "rust: {line_count} lines ({} KiB) in {elapsed:?}; query compile + first call {warm:?}",
            text.len() / 1024
        );
        assert_eq!(spans.len(), line_count);
        assert!(spans.iter().filter(|l| !l.is_empty()).count() > line_count * 3 / 4);
        assert!(elapsed.as_millis() < 1000, "took {elapsed:?}");

        let markdown = "## Section\n\nSome *text* with `code` and a [link](http://x.y).\n\n- item one\n- item two\n\n".repeat(2500);
        let started = Instant::now();
        let spans = crate::highlight(&markdown, &Language("markdown".into()));
        println!("markdown: {} lines in {:?}", spans.len(), started.elapsed());
        assert_eq!(spans.len(), markdown.lines().count());
    }
}
