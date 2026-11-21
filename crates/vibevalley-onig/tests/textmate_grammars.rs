// Real-world TextMate grammar patterns (TypeScript, Rust, Markdown, JSON, Python)
// plus VM safety & concurrency guarantees (ReDoS step limit, call depth limit, Send + Sync).
use vibevalley_onig::{CaptureIndex, ExecError, ExecLimits, FindOption, OnigRegExp, OnigScanner, OnigString, ScannerCache};

fn assert_send_sync<T: Send + Sync>() {}

#[test]
fn public_types_are_send_and_sync() {
    assert_send_sync::<OnigRegExp>();
    assert_send_sync::<OnigScanner>();
    assert_send_sync::<OnigString>();
    assert_send_sync::<ScannerCache>();
}

#[test]
fn textmate_typescript_patterns() {
    let ts_scanner = OnigScanner::new(&[
        // Single-line comment
        r"(//).*$",
        // Block comment open
        r"/\*(?!\*)",
        // Template literal open
        r"`",
        // TypeScript function / method declaration with generics
        r"(?x)\b(async\s+)?(function)\s*(\*)?\s*([_$[:alpha:]][_$[:alnum:]]*)\s*(?=<|\()",
        // Arrow function parameter / keyword
        r"\b(const|let|var|interface|type|export|import|return|await)\b",
        // Numeric literal (hex, bin, oct, float with separators)
        r"\b(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)\b",
        // Double-quoted string
        r#""(?:[^"\\]|\\.)*""#,
    ])
    .unwrap();

    let line = OnigString::new(r#"export async function parseNode<T>(x = 0xFF_01) // done"#);
    let mut cache = ScannerCache::new(ts_scanner.len());

    // `export`
    let m1 = ts_scanner.find_next_match_cached(&line, 0, FindOption::NONE, &mut cache).unwrap();
    assert_eq!(m1.index, 4);
    assert_eq!(&line.content()[m1.full().start..m1.full().end], "export");

    // `async function parseNode`
    let m2 = ts_scanner.find_next_match_cached(&line, m1.full().end, FindOption::NONE, &mut cache).unwrap();
    assert_eq!(m2.index, 3);
    assert_eq!(m2.get(4).map(|c| &line.content()[c.start..c.end]), Some("parseNode"));

    // `0xFF_01`
    let m3 = ts_scanner.find_next_match_cached(&line, m2.full().end, FindOption::NONE, &mut cache).unwrap();
    assert_eq!(m3.index, 5);
    assert_eq!(&line.content()[m3.full().start..m3.full().end], "0xFF_01");

    // `// done`
    let m4 = ts_scanner.find_next_match_cached(&line, m3.full().end, FindOption::NONE, &mut cache).unwrap();
    assert_eq!(m4.index, 0);
    assert_eq!(&line.content()[m4.full().start..m4.full().end], "// done");
}

#[test]
fn textmate_rust_patterns() {
    // Rust raw string literal `r###"..."###` using backreference inside absent expression.
    // Must stop at the first closing `"##`, not span across two raw strings on the same line.
    let raw_str = OnigRegExp::new(r#"b?r(#*)"(?~"\1)"\1"#).unwrap();
    let two_raw = r####"let a = r##"hello "# world"##; let b = r##"second"##;"####;
    let m = raw_str.find(two_raw).unwrap().unwrap();
    assert_eq!(&two_raw[m.start()..m.end()], r###"r##"hello "# world"##"###);

    // Rust lifetime vs char literal disambiguation + macro invocation + path turbofish
    let rust_scanner = OnigScanner::new(&[
        // Lifetime `'a`, `'static`, `'_` (not followed by closing `'`)
        r"'([a-zA-Z_][a-zA-Z0-9_]*)(?!')",
        // Char literal `'x'`, `'\n'`, `'\u{1F600}'`
        r"'(?:[^'\\]|\\(?:['\\nrt0]|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]{1,6}\}))'",
        // Macro invocation `println!`
        r"\b([a-zA-Z_][a-zA-Z0-9_]*)!",
        // Keywords
        r"\b(pub|fn|struct|enum|impl|trait|match|let|mut|where|async|await)\b",
    ])
    .unwrap();

    let code = "pub fn foo<'a>(ch: '\\u{1F600}') { println!(\"hi\"); }";
    let m1 = rust_scanner.find_next_match(code, 0, FindOption::NONE).unwrap();
    assert_eq!(m1.index, 3); // `pub`
    let m2 = rust_scanner.find_next_match(code, 10, FindOption::NONE).unwrap();
    assert_eq!(m2.index, 0); // `'a`
    assert_eq!(&code[m2.full().start..m2.full().end], "'a");
    let m3 = rust_scanner.find_next_match(code, 18, FindOption::NONE).unwrap();
    assert_eq!(m3.index, 1); // `'\u{1F600}'`
    assert_eq!(&code[m3.full().start..m3.full().end], "'\\u{1F600}'");
    let m4 = rust_scanner.find_next_match(code, 33, FindOption::NONE).unwrap();
    assert_eq!(m4.index, 2); // `println!`
    assert_eq!(m4.get(1).map(|c| &code[c.start..c.end]), Some("println"));
}

#[test]
fn textmate_markdown_patterns() {
    // Markdown ATX heading, fenced code block opener, inline code with matching backtick count, links
    let md_scanner = OnigScanner::new(&[
        // ATX heading
        r"^(#{1,6})\s+(.+?)(?:\s+#+)?$",
        // Fenced code block opener
        r"^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)\s*$",
        // Inline code span matching equal number of backticks
        r"(`+)(?!`)(.+?)(?<!`)\1(?!`)",
        // Markdown link `[text](url)`
        r"\[([^\]]+)\]\(([^)\s]+)\)",
    ])
    .unwrap();

    let h = "## Architecture Overview ##";
    let mh = md_scanner.find_next_match(h, 0, FindOption::NONE).unwrap();
    assert_eq!(mh.index, 0);
    assert_eq!(mh.get(1).map(|c| &h[c.start..c.end]), Some("##"));
    assert_eq!(mh.get(2).map(|c| &h[c.start..c.end]), Some("Architecture Overview"));

    let fence = "  ````rust";
    let mf = md_scanner.find_next_match(fence, 0, FindOption::NONE).unwrap();
    assert_eq!(mf.index, 1);
    assert_eq!(mf.get(1).map(|c| &fence[c.start..c.end]), Some("````"));
    assert_eq!(mf.get(2).map(|c| &fence[c.start..c.end]), Some("rust"));

    let inline = "Use ``a `b` c`` and [docs](https://example.com) here.";
    let mi = md_scanner.find_next_match(inline, 0, FindOption::NONE).unwrap();
    assert_eq!(mi.index, 2);
    assert_eq!(mi.get(2).map(|c| &inline[c.start..c.end]), Some("a `b` c"));

    let ml = md_scanner.find_next_match(inline, mi.full().end, FindOption::NONE).unwrap();
    assert_eq!(ml.index, 3);
    assert_eq!(ml.get(1).map(|c| &inline[c.start..c.end]), Some("docs"));
    assert_eq!(ml.get(2).map(|c| &inline[c.start..c.end]), Some("https://example.com"));
}

#[test]
fn textmate_json_patterns() {
    let json_scanner = OnigScanner::new(&[
        // Property key (double-quoted string followed by `:`)
        r#""((?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*)"(?=\s*:)"#,
        // String value
        r#""(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*""#,
        // Number
        r"-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?",
        // Constants
        r"\b(?:true|false|null)\b",
    ])
    .unwrap();

    let json = r#"{"emoji": "🚀\u0020ok", "count": -42.5e+2, "ok": true}"#;
    let m1 = json_scanner.find_next_match(json, 0, FindOption::NONE).unwrap();
    assert_eq!(m1.index, 0);
    assert_eq!(m1.get(1).map(|c| &json[c.start..c.end]), Some("emoji"));

    let m2 = json_scanner.find_next_match(json, m1.full().end, FindOption::NONE).unwrap();
    assert_eq!(m2.index, 1);
    assert_eq!(&json[m2.full().start..m2.full().end], r#""🚀\u0020ok""#);

    let m3 = json_scanner.find_next_match(json, m2.full().end, FindOption::NONE).unwrap();
    assert_eq!(m3.index, 0);
    assert_eq!(m3.get(1).map(|c| &json[c.start..c.end]), Some("count"));

    let m4 = json_scanner.find_next_match(json, m3.full().end, FindOption::NONE).unwrap();
    assert_eq!(m4.index, 2);
    assert_eq!(&json[m4.full().start..m4.full().end], "-42.5e+2");

    let m5 = json_scanner.find_next_match(json, m4.full().end, FindOption::NONE).unwrap();
    assert_eq!(m5.index, 0);
    let m6 = json_scanner.find_next_match(json, m5.full().end, FindOption::NONE).unwrap();
    assert_eq!(m6.index, 3);
    assert_eq!(&json[m6.full().start..m6.full().end], "true");
}

#[test]
fn textmate_python_patterns() {
    let py_scanner = OnigScanner::new(&[
        // Decorator
        r"^(\s*)(@)([[:alpha:]_][[:alnum:]_]*(?:\.[[:alpha:]_][[:alnum:]_]*)*)",
        // Function definition
        r"(?x)\b(async\s+)?(def)\s+([[:alpha:]_][[:alnum:]_]*)\s*(?=\()",
        // Triple-quoted string (with raw/f-string prefix)
        r#"(?i)\b([rfbu]{0,2})("""|''')"#,
        // Comment
        r"#.*$",
    ])
    .unwrap();

    let dec = "    @functools.lru_cache(maxsize=128)";
    let md = py_scanner.find_next_match(dec, 0, FindOption::NONE).unwrap();
    assert_eq!(md.index, 0);
    assert_eq!(md.get(3).map(|c| &dec[c.start..c.end]), Some("functools.lru_cache"));

    let def = "async def compute_π(x):";
    let mf = py_scanner.find_next_match(def, 0, FindOption::NONE).unwrap();
    assert_eq!(mf.index, 1);
    assert_eq!(mf.get(3).map(|c| &def[c.start..c.end]), Some("compute_π"));

    let fstr = r#"msg = rf"""hello {name}""" # greet"#;
    let ms = py_scanner.find_next_match(fstr, 0, FindOption::NONE).unwrap();
    assert_eq!(ms.index, 2);
    assert_eq!(ms.get(1).map(|c| &fstr[c.start..c.end]), Some("rf"));
    assert_eq!(ms.get(2).map(|c| &fstr[c.start..c.end]), Some("\"\"\""));
}

#[test]
fn vm_enforces_step_and_call_depth_limits() {
    // Classic ReDoS pattern must abort cleanly at step limit without hanging.
    let redos = OnigRegExp::new("(a+)+$").unwrap().with_limits(ExecLimits {
        max_steps: 10_000,
        max_backtrack_stack: 4_096,
        max_call_depth: 32,
    });
    let err = redos.find("aaaaaaaaaaaaaaaaaaaaaaaaaaaa!").unwrap_err();
    assert_eq!(err, ExecError::StepLimitExceeded);

    // Scanner gracefully skips patterns that hit step limit rather than crashing tokenization.
    let scanner = OnigScanner::with_config(
        &["(a+)+$", "!"],
        vibevalley_onig::ScannerConfig {
            limits: ExecLimits {
                max_steps: 10_000,
                max_backtrack_stack: 4_096,
                max_call_depth: 32,
            },
            ..Default::default()
        },
    )
    .unwrap();
    let m = scanner.find_next_match("aaaaaaaaaaaaaaaaaaaaaaaaaaaa!", 0, FindOption::NONE).unwrap();
    assert_eq!(m.index, 1);
    assert_eq!(m.full(), CaptureIndex::new(28, 29));

    // Deep subroutine recursion must abort cleanly with CallDepthExceeded (no native stack overflow).
    let deep = OnigRegExp::new("(?<r>\\(\\g<r>\\)|x)").unwrap().with_limits(ExecLimits {
        max_steps: 100_000,
        max_backtrack_stack: 8_192,
        max_call_depth: 8,
    });
    let nested = format!("{}x{}", "(".repeat(20), ")".repeat(20));
    assert_eq!(deep.find(&nested).unwrap_err(), ExecError::CallDepthExceeded);
}
