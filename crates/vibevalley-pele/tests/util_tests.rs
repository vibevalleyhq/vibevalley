mod support;

use std::sync::OnceLock;
use std::time::Instant;

use indexmap::IndexMap;
use regex::Regex;
use vibevalley_pele::config::DiagramConfig;
use vibevalley_pele::detect::{DiagramType, MermaidType};
use vibevalley_pele::preprocess::{cleanup_comments, encode_entities, preprocess};
use vibevalley_pele::util::url::{internal_link, link_url, sanitize_url};
use vibevalley_pele::util::yaml::{YamlValue, parse_yaml};
use vibevalley_pele::{
    ErrorCode, METRICS_MEASURER, ParseOptions, Registry, RenderOptions, TextMeasurer, TextStyle, ThemeMode, detect_type, parse, render, render_model, supports,
};

use support::{Lcg, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, inert_problem, resolved_options};

// Mermaid's original encodeEntities used as reference oracle on short lines.
// JS regex `.` excludes both `\n` and `\r`, matching Rust `[^\r\n]`.
fn reference_encode_entities(text: &str) -> String {
    static RES: OnceLock<(Regex, Regex, Regex, Regex)> = OnceLock::new();
    let (re_style, re_class, re_entity, re_num) = RES.get_or_init(|| {
        (
            Regex::new(r"style[^\r\n]*:\S*#[^\r\n]*;").unwrap(),
            Regex::new(r"classDef[^\r\n]*:\S*#[^\r\n]*;").unwrap(),
            Regex::new(r"#\w+;").unwrap(),
            Regex::new(r"^\+?\d+$").unwrap(),
        )
    });

    let s1 = re_style.replace_all(text, |caps: &regex::Captures<'_>| {
        let m = &caps[0];
        m[..m.len() - 1].to_string()
    });
    let s2 = re_class.replace_all(&s1, |caps: &regex::Captures<'_>| {
        let m = &caps[0];
        m[..m.len() - 1].to_string()
    });
    re_entity
        .replace_all(&s2, |caps: &regex::Captures<'_>| {
            let m = &caps[0];
            let inner = &m[1..m.len() - 1];
            let prefix = if re_num.is_match(inner) { "ﬂ°°" } else { "ﬂ°" };
            format!("{prefix}{inner}¶ß")
        })
        .into_owned()
}

#[test]
fn entity_encoding_matches_mermaid_on_hand_picked_lines() {
    for text in [
        "style A fill:#f9f,stroke:#333;",
        "style A fill:#f9f;stroke:#333;\nB --> C;",
        "classDef green fill:#9f6,stroke:#333,stroke-width:2px;",
        r#"A["a #35; b #quot;c#quot;"]"#,
        "style A color: #fff;",
        "style A fill:red;",
        "mystyle x:#1; classDef y:#2; z;",
        "style a:#b\n;",
        "style a b :c#d e;f;g",
        "#;# ; #a ;#a;",
    ] {
        assert_eq!(encode_entities(text, None), reference_encode_entities(text), "mismatch for {text:?}");
    }
}

#[test]
fn entity_encoding_matches_mermaid_on_random_lines() {
    let mut rng = Lcg::new(11);
    let parts = ["style", "classDef", ":", "#", ";", " ", "\n", "a", "fill", "9", "\t", ":#", "#f9f;", "\r"];
    for _ in 0..20_000 {
        let mut text = String::new();
        let count = rng.next_usize(14);
        for _ in 0..count {
            text.push_str(parts[rng.next_usize(parts.len())]);
        }
        assert_eq!(encode_entities(&text, None), reference_encode_entities(&text), "mismatch for {text:?}");
    }
}

#[test]
fn entity_encoding_stays_linear_where_regex_backtracks() {
    let started = Instant::now();
    let _ = encode_entities(&format!("graph TD\nstyle A {}", "style:x#".repeat(20_000)), None);
    let _ = encode_entities(&format!("classDef {}", ":#".repeat(50_000)), None);
    assert!(started.elapsed().as_millis() < 1000, "encode_entities took {:?}", started.elapsed());
}

#[test]
fn preprocess_removes_comments_and_keeps_directives() {
    assert_eq!(cleanup_comments("%% one\ngraph TD\n  %% two\n  A --> B\n", None), "graph TD\n  A --> B\n");
    assert_eq!(cleanup_comments("%%{init: {}}%%\ngraph TD", None), "%%{init: {}}%%\ngraph TD");
}

#[test]
fn preprocess_reads_title_and_config_from_front_matter() {
    let result = preprocess("---\ntitle: My chart\nconfig:\n  flowchart:\n    curve: linear\n---\ngraph TD\n  A", None).unwrap();
    assert_eq!(result.title.as_deref(), Some("My chart"));
    assert_eq!(result.config.flowchart.curve.as_deref(), Some("linear"));
    assert_eq!(result.text, "graph TD\n  A");
}

#[test]
fn preprocess_merges_init_directives_over_front_matter() {
    let result = preprocess(
        "---\nconfig:\n  flowchart:\n    curve: linear\n    rankSpacing: 10\n---\n%%{init: {'flowchart': {'rankSpacing': 99}}}%%\ngraph TD\n  A",
        None,
    )
    .unwrap();
    assert_eq!(result.config.flowchart.curve.as_deref(), Some("linear"));
    assert_eq!(result.config.flowchart.rank_spacing, Some(99.0));
    assert_eq!(result.text, "graph TD\n  A");
}

#[test]
fn preprocess_ignores_prototype_keys_in_config() {
    let a = preprocess(
        r#"%%{init: {"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}}}%%
graph TD
A"#,
        None,
    )
    .unwrap();
    let b = preprocess("---\nconfig:\n  __proto__:\n    polluted: true\n---\ngraph TD\nA", None).unwrap();
    assert!(!a.raw_config.contains_key("__proto__"));
    assert!(!a.raw_config.contains_key("constructor"));
    assert!(!b.raw_config.contains_key("__proto__"));
}

#[test]
fn preprocess_normalizes_line_endings_and_attribute_quotes() {
    let result = preprocess("graph TD\r\nA[\"<span class=\"x\">hi</span>\"]\r", None).unwrap();
    assert_eq!(result.text, "graph TD\nA[\"<span class='x'>hi</span>\"]\n");
}

#[test]
fn preprocess_handles_unclosed_tags_in_linear_time() {
    let input = format!("graph TD\nA[\"{}\"]", "<a".repeat(50_000));
    let started = Instant::now();
    let _ = preprocess(&input, None).unwrap();
    assert!(started.elapsed().as_millis() < 500, "preprocess took {:?}", started.elapsed());
}

#[test]
fn url_sanitizer_matches_reference_outputs() {
    let cases: &[(&str, &str)] = &[
        ("https://example.com", "https://example.com/"),
        ("http://EXAMPLE.com/Path?q=1#frag", "http://example.com/Path?q=1#frag"),
        ("click.html", "click.html"),
        ("./relative/path", "./relative/path"),
        ("/absolute/path", "/absolute/path"),
        ("mailto:someone@example.com", "mailto:someone@example.com"),
        ("obsidian://open?vault=Notes&file=Idea", "obsidian://open?vault=Notes&file=Idea"),
        ("javascript:alert(1)", "about:blank"),
        ("JaVaScRiPt:alert(1)", "about:blank"),
        ("  javascript:alert(1)", "about:blank"),
        ("java\nscript:alert(1)", "about:blank"),
        ("jav&#x09;ascript:alert(1)", "about:blank"),
        ("&#106;avascript:alert(1)", "about:blank"),
        ("data:text/html,<script>alert(1)</script>", "about:blank"),
        ("vbscript:msgbox(1)", "about:blank"),
        ("javascript&colon;alert(1)", "about:blank"),
        ("%6A%61%76%61%73%63%72%69%70%74:alert(1)", "about:blank"),
        ("https://example.com/a b", "https://example.com/a%20b"),
        ("http://", "about:blank"),
        ("ftp://example.com/file", "ftp://example.com/file"),
        ("www.example.com", "www.example.com"),
        ("C:\\Users\\file.txt", "C:/Users/file.txt"),
        ("\\\\server\\share", "\\\\server\\share"),
        ("note name with spaces", "note name with spaces"),
        ("#heading", "#heading"),
        ("?query=1", "?query=1"),
        ("", "about:blank"),
        ("about:blank", "about:blank"),
        ("tel:+123456", "tel:+123456"),
        ("https://example.com/%E0%A4%A", "https://example.com/%E0%A4%A"),
    ];
    for &(input, expected) in cases {
        assert_eq!(sanitize_url(input), expected, "url={input:?}");
    }
}

#[test]
fn url_sanitizer_keeps_percent_escapes_and_blocks_encoded_schemes() {
    for url in [
        "obsidian://open?vault=V&file=A%26B%23C",
        "https://example.com/?q=a%26b",
        "mailto:a@example.com?subject=a%20b",
        "Note%20name",
        "./a%23b.html",
    ] {
        assert_eq!(sanitize_url(url), url, "url={url:?}");
    }
    assert_eq!(sanitize_url("%6A%61%76%61%73%63%72%69%70%74:alert(1)"), "about:blank");
    let opts = RenderOptions::default();
    for url in ["fi%6ce:///etc/passwd", "%2F%2Fevil.example/share", "obs%69dian://open"] {
        let sanitized = sanitize_url(url);
        assert!(link_url(&sanitized, &opts).is_none(), "url={url:?}");
    }
}

#[test]
fn internal_links_allow_note_names_and_reject_scripts_or_network_paths() {
    let default_opts = RenderOptions::default();
    for name in ["Note", "Folder\\note", "Note%23heading", "👩‍💻", "Note#heading", "  Note  "] {
        assert!(internal_link(name, &default_opts), "name={name:?}");
    }
    let about_opts = RenderOptions {
        link_schemes: Some(vec!["about".to_string()]),
        ..RenderOptions::default()
    };
    for name in [
        "javascript:alert(1)",
        "java\u{fffe}script:alert(1)",
        "\\\\nevil.example",
        "\t/\\nevil.example",
        "/\t/evil.example",
    ] {
        assert!(!internal_link(name, &about_opts), "name={name:?}");
    }
}

fn map(entries: Vec<(&str, YamlValue)>) -> YamlValue {
    let mut m = IndexMap::new();
    for (k, v) in entries {
        m.insert(k.to_string(), v);
    }
    YamlValue::Map(m)
}

fn s(v: &str) -> YamlValue {
    YamlValue::String(v.to_string())
}

#[test]
fn yaml_reader_parses_all_upstream_cases() {
    let cases: Vec<(&str, YamlValue)> = vec![
        ("{\n shape: rounded \n}", map(vec![("shape", s("rounded"))])),
        ("{\nshape: rounded , label: \"DD\"\n}", map(vec![("shape", s("rounded")), ("label", s("DD"))])),
        (
            "{\n label: \"This is }\", other: \"clock\"\n}",
            map(vec![("label", s("This is }")), ("other", s("clock"))]),
        ),
        (
            "{\n animate: true, animation: fast, w: 100, h: 50.5, x: null, y: ~\n}",
            map(vec![
                ("animate", YamlValue::Bool(true)),
                ("animation", s("fast")),
                ("w", YamlValue::Number(100.0)),
                ("h", YamlValue::Number(50.5)),
                ("x", YamlValue::Null),
                ("y", YamlValue::Null),
            ]),
        ),
        (
            "{\n label: 'single quoted', icon: \"fa:fa-user\", form: circle, pos: t \n}",
            map(vec![
                ("label", s("single quoted")),
                ("icon", s("fa:fa-user")),
                ("form", s("circle")),
                ("pos", s("t")),
            ]),
        ),
        (
            "{\n a: [1, 2, three], b: {c: d, e: [f]}\n}",
            map(vec![
                ("a", YamlValue::Seq(vec![YamlValue::Number(1.0), YamlValue::Number(2.0), s("three")])),
                ("b", map(vec![("c", s("d")), ("e", YamlValue::Seq(vec![s("f")]))])),
            ]),
        ),
        ("{\n}", map(vec![])),
        (
            "\n        shape: circle\n        other: \"clock\"\n     \n",
            map(vec![("shape", s("circle")), ("other", s("clock"))]),
        ),
        (
            "\n        label: |\n          This is a\n          multiline string\n        other: \"clock\"\n     \n",
            map(vec![("label", s("This is a\nmultiline string\n")), ("other", s("clock"))]),
        ),
        (
            "\n        label: >\n          folded\n          text\n\n          second paragraph\n        other: 1\n",
            map(vec![("label", s("folded text\nsecond paragraph\n")), ("other", YamlValue::Number(1.0))]),
        ),
        (
            "\n        label: \"This is a<br/>multiline string\"\n        other: \"clock\"\n",
            map(vec![("label", s("This is a<br/>multiline string")), ("other", s("clock"))]),
        ),
        (
            "title: Hello world\nconfig:\n  theme: dark\n  flowchart:\n    curve: linear\n    htmlLabels: false\n",
            map(vec![
                ("title", s("Hello world")),
                (
                    "config",
                    map(vec![
                        ("theme", s("dark")),
                        ("flowchart", map(vec![("curve", s("linear")), ("htmlLabels", YamlValue::Bool(false))])),
                    ]),
                ),
            ]),
        ),
        (
            "title: \"Quoted: title\"\ndisplayMode: compact\n",
            map(vec![("title", s("Quoted: title")), ("displayMode", s("compact"))]),
        ),
        (
            "config:\n  themeVariables:\n    primaryColor: \"#ff0000\"\n    fontSize: 16px\n  look: handDrawn # trailing comment\n",
            map(vec![(
                "config",
                map(vec![
                    ("themeVariables", map(vec![("primaryColor", s("#ff0000")), ("fontSize", s("16px"))])),
                    ("look", s("handDrawn")),
                ]),
            )]),
        ),
        (
            "list:\n  - a\n  - b: 1\n    c: 2\n  - [x, y]\nempty:\n",
            map(vec![
                (
                    "list",
                    YamlValue::Seq(vec![
                        s("a"),
                        map(vec![("b", YamlValue::Number(1.0)), ("c", YamlValue::Number(2.0))]),
                        YamlValue::Seq(vec![s("x"), s("y")]),
                    ]),
                ),
                ("empty", YamlValue::Null),
            ]),
        ),
        (
            "a: 0x1f\nb: -12\nc: 1e3\nd: .5\ne: \"12\"\nf: True\ng: FALSE\nh: Null\n",
            map(vec![
                ("a", YamlValue::Number(31.0)),
                ("b", YamlValue::Number(-12.0)),
                ("c", YamlValue::Number(1000.0)),
                ("d", YamlValue::Number(0.5)),
                ("e", s("12")),
                ("f", YamlValue::Bool(true)),
                ("g", YamlValue::Bool(false)),
                ("h", YamlValue::Null),
            ]),
        ),
        (
            "key with spaces: plain value\nurl: http://example.com/a#b\n",
            map(vec![("key with spaces", s("plain value")), ("url", s("http://example.com/a#b"))]),
        ),
        (
            "multi: this is\n  continued on the next line\nnext: 1\n",
            map(vec![("multi", s("this is continued on the next line")), ("next", YamlValue::Number(1.0))]),
        ),
        ("# only a comment\n", YamlValue::Null),
        ("", YamlValue::Null),
        ("just a scalar", s("just a scalar")),
        ("- 1\n- 2\n", YamlValue::Seq(vec![YamlValue::Number(1.0), YamlValue::Number(2.0)])),
        (
            "a: {\n  b: 1,\n  c: [2,\n    3]\n}\nd: \"two\n  lines\"\ne: 5\n",
            map(vec![
                (
                    "a",
                    map(vec![
                        ("b", YamlValue::Number(1.0)),
                        ("c", YamlValue::Seq(vec![YamlValue::Number(2.0), YamlValue::Number(3.0)])),
                    ]),
                ),
                ("d", s("two lines")),
                ("e", YamlValue::Number(5.0)),
            ]),
        ),
        (
            "{\n a: 1, # comment\n b: 2\n}",
            map(vec![("a", YamlValue::Number(1.0)), ("b", YamlValue::Number(2.0))]),
        ),
        (
            "__proto__: 1\nb:\n  __proto__: {x: 1}\n",
            map(vec![
                ("__proto__", YamlValue::Number(1.0)),
                ("b", map(vec![("__proto__", map(vec![("x", YamlValue::Number(1.0))]))])),
            ]),
        ),
    ];

    for (src, expected) in cases {
        let parsed = parse_yaml(src).unwrap_or_else(|e| panic!("YAML failed on {src:?}: {e}"));
        assert_eq!(parsed, expected, "YAML mismatch on {src:?}");
    }
}

#[test]
fn yaml_reader_rejects_absurd_nesting_and_unterminated_collections() {
    let deep = format!("{{ a: {} }}", "[".repeat(20_000));
    let err = parse_yaml(&deep).unwrap_err();
    assert!(err.contains("too deep"), "unexpected error: {err}");

    let started = Instant::now();
    let long = format!("a: {{\n{}", " b: 1,\n".repeat(20_000));
    assert!(parse_yaml(&long).is_err());
    assert!(started.elapsed().as_millis() < 1000, "yaml took {:?}", started.elapsed());

    assert!(parse_yaml("{ a: 1").is_err());
}

#[test]
fn metrics_measurer_and_custom_measurer_hook() {
    let regular = METRICS_MEASURER.width("Hello World", 16.0, TextStyle::NONE);
    let bold = METRICS_MEASURER.width("Hello World", 16.0, TextStyle::BOLD);
    let mono = METRICS_MEASURER.width("Hello World", 16.0, TextStyle::MONO);
    let cjk = METRICS_MEASURER.width("日本語テスト", 16.0, TextStyle::NONE);
    let sub = METRICS_MEASURER.width("2", 16.0, TextStyle::SUB);
    let base = METRICS_MEASURER.width("2", 16.0, TextStyle::NONE);

    assert!(regular > 0.0);
    assert!(bold > regular);
    assert!((mono - 11.0 * 0.6 * 16.0).abs() < 1e-6);
    assert!((cjk - 6.0 * 16.0).abs() < 1e-6);
    assert!(sub < base);
    // Soft hyphen and combining marks have zero width.
    assert_eq!(
        METRICS_MEASURER.width("ab\u{00ad}c", 16.0, TextStyle::NONE),
        METRICS_MEASURER.width("abc", 16.0, TextStyle::NONE)
    );
    assert_eq!(
        METRICS_MEASURER.width("e\u{0301}", 16.0, TextStyle::NONE),
        METRICS_MEASURER.width("e", 16.0, TextStyle::NONE)
    );

    // Pluggable custom TextMeasurer (e.g. macOS CoreText hook) directly controls rendered layout.
    struct WideFontMeasurer;
    impl TextMeasurer for WideFontMeasurer {
        fn width(&self, text: &str, size: f64, _style: TextStyle) -> f64 {
            text.chars().count() as f64 * size * 1.5
        }
    }
    let wide = WideFontMeasurer;
    let default_res = render("flowchart LR\n  A[Custom Font] --> B[End]", &resolved_options()).unwrap();
    let wide_opts = RenderOptions {
        measurer: Some(&wide),
        ..resolved_options()
    };
    let wide_res = render("flowchart LR\n  A[Custom Font] --> B[End]", &wide_opts).unwrap();
    assert!(wide_res.width > default_res.width + 80.0);
}

#[test]
fn inertness_checker_accepts_pele_and_rejects_hostile_svg() {
    let drawn = render(
        "flowchart LR\n  A[One] --> B[Two]\n  click A href \"https://example.com/a?b=1#c\"\n  style B fill:#eee,stroke-width:2px",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(inert_problem(&drawn, false), None);
    assert_inert(&drawn, "flowchart");

    let wrap = |inner: &str| format!(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele">{inner}</svg>"#);
    for href in [
        "https://example.com",
        "http://example.com/a",
        "mailto:a@example.com",
        "tel:+15550100",
        "./a/b",
        "/a",
        "a.html",
        "#top",
        "?q=1",
    ] {
        assert_eq!(
            inert_problem(&wrap(&format!(r#"<a href="{href}"><text>x</text></a>"#)), false),
            None,
            "href={href}"
        );
    }

    let bad: &[(&str, &str, &str)] = &[
        ("script element", "<script>alert(1)</script>", "element <script>"),
        ("style element", "<style>a{}</style>", "element <style>"),
        ("foreign object", "<foreignObject></foreignObject>", "element <foreignObject>"),
        ("event handler", r#"<rect onclick="alert(1)"/>"#, "attribute onclick"),
        ("unknown attribute", r#"<rect data-evil="x"/>"#, "attribute data-evil"),
        ("unclosed element", "<g><rect/>", "XML parse error"),
        ("raw ampersand", "<text>a & b</text>", "XML parse error"),
        ("non-numeric size", r#"<rect width="1;x"/>"#, r#"width="1;x" is not a number"#),
        ("rx url", r#"<rect rx="url(#a)"/>"#, "rx="),
        ("href on shape", r#"<rect href="https://example.com"/>"#, "href on <rect>"),
        ("script link", r#"<a href="javascript:alert(1)"></a>"#, "can run script"),
        ("caps script link", r#"<a href=" JaVaScRiPt :alert(1)"></a>"#, "can run script"),
        ("data link", r#"<a href="data:text/html,x"></a>"#, "can run script"),
        ("file link", r#"<a href="file:///etc/passwd"></a>"#, "scheme that is not allowed"),
        ("tabbed file link", r#"<a href="fi&#9;le:///etc/passwd"></a>"#, "scheme that is not allowed"),
        ("network path", r#"<a href="//evil.example/x"></a>"#, "scheme that is not allowed"),
        ("backslash network path", r#"<image href="\\evil.example\x"/>"#, "scheme that is not allowed"),
        ("app link", r#"<a href="obsidian://open"></a>"#, "scheme that is not allowed"),
        ("blank page", r#"<a href="about:blank"></a>"#, "scheme that is not allowed"),
        ("target", r#"<a href="/a" target="evil"></a>"#, r#"target="evil""#),
        ("style url", r#"<rect style="fill:url(//evil.example/x)"/>"#, "style="),
        ("style property", r#"<rect style="position:fixed"/>"#, "style property position"),
        ("root sizing on child", r#"<rect style="height:auto"/>"#, "style property height"),
        ("fill url", r#"<rect fill="url(#a)"/>"#, "fill="),
        ("font-family url", r#"<text font-family="x, url(y)">a</text>"#, "font-family="),
    ];
    for &(name, inner, expected_sub) in bad {
        let problem = inert_problem(&wrap(inner), false).unwrap_or_else(|| panic!("{name}: expected inert_problem to reject"));
        assert!(problem.contains(expected_sub), "{name}: problem {problem:?} did not contain {expected_sub:?}");
    }

    // In resolved mode, CSS variables and color-mix must also be rejected.
    let var_svg = wrap(r#"<rect fill="var(--_s)"/>"#);
    assert!(inert_problem(&var_svg, true).unwrap().contains("unresolved CSS token"));
}

#[test]
fn mermaid_type_detection_and_error_metadata() {
    let cases: &[(&str, DiagramType, MermaidType)] = &[
        ("graph TD\n  A --> B", DiagramType::Flowchart, MermaidType::FlowchartV2),
        ("flowchart LR\n  A --> B", DiagramType::Flowchart, MermaidType::FlowchartV2),
        ("flowchart-elk TD\n  A --> B", DiagramType::Flowchart, MermaidType::FlowchartElk),
        ("sequenceDiagram\n  A->>B: Hi", DiagramType::Sequence, MermaidType::Sequence),
        ("pie\n  \"a\": 1", DiagramType::Pie, MermaidType::Pie),
    ];
    for &(src, dtype, mtype) in cases {
        assert_eq!(detect_type(src), Some(dtype), "src={src:?}");
        assert!(supports(src), "src={src:?}");
        let res = render(src, &css_options()).unwrap();
        assert_eq!(res.diagram_type, dtype);
        assert_eq!(res.mermaid_type, mtype);
        let model = parse(src, &ParseOptions::default()).unwrap();
        assert_eq!(model.mermaid_type, mtype);
        let res2 = render_model(&model, &css_options()).unwrap();
        assert_eq!(res2.diagram_type, dtype);
        assert_eq!(res2.mermaid_type, mtype);
    }

    assert_eq!(detect_type("---\ntitle: T\n---\nclassDiagram\n  class A"), Some(DiagramType::Class));
    assert_eq!(
        render("%%{init: {\"theme\": \"dark\"}}%%\ngraph TD\n  A --> B", &css_options())
            .unwrap()
            .mermaid_type,
        MermaidType::FlowchartV2
    );
    assert_eq!(detect_type("%% note\nstateDiagram-v2\n  [*] --> A"), Some(DiagramType::State));
    assert_eq!(detect_type("hello"), None);

    let syntax = render("flowchart LR\n  A -->", &css_options()).unwrap_err();
    assert_eq!(syntax.code, ErrorCode::Syntax);
    assert_eq!(syntax.diagram_type, Some(DiagramType::Flowchart));
    assert_eq!(syntax.mermaid_type, Some(MermaidType::FlowchartV2));

    let limit_out = render(
        "flowchart LR\n  A --> B",
        &RenderOptions {
            output_limit: Some(10),
            ..css_options()
        },
    )
    .unwrap_err();
    assert_eq!(limit_out.code, ErrorCode::Limit);
    assert_eq!(limit_out.diagram_type, Some(DiagramType::Flowchart));
    assert_eq!(limit_out.mermaid_type, Some(MermaidType::FlowchartV2));

    let unknown = render("not a diagram", &css_options()).unwrap_err();
    assert_eq!(unknown.code, ErrorCode::UnsupportedDiagram);
    assert_eq!(unknown.diagram_type, None);
    assert_eq!(unknown.mermaid_type, None);

    let parse_limit = parse(
        "graph TD\n  A",
        &ParseOptions {
            limit: Some(5),
            ..ParseOptions::default()
        },
    )
    .unwrap_err();
    assert_eq!(parse_limit.code, ErrorCode::Limit);
    assert_eq!(parse_limit.mermaid_type, None);

    // Default ThemeMode is Resolved (resvg-safe).
    assert!(matches!(RenderOptions::default().theme_mode, ThemeMode::Resolved(_)));
    let _ = DiagramConfig::default();
}

#[test]
fn all_33_diagram_types_are_registered_and_render_safely() {
    const ALL_TYPES: [DiagramType; 33] = [
        DiagramType::Flowchart,
        DiagramType::Sequence,
        DiagramType::Class,
        DiagramType::State,
        DiagramType::Er,
        DiagramType::Pie,
        DiagramType::Gantt,
        DiagramType::GitGraph,
        DiagramType::Mindmap,
        DiagramType::Timeline,
        DiagramType::Journey,
        DiagramType::XyChart,
        DiagramType::QuadrantChart,
        DiagramType::Requirement,
        DiagramType::C4,
        DiagramType::Sankey,
        DiagramType::Block,
        DiagramType::Packet,
        DiagramType::Kanban,
        DiagramType::Architecture,
        DiagramType::Radar,
        DiagramType::Treemap,
        DiagramType::Info,
        DiagramType::Agentflow,
        DiagramType::Usecase,
        DiagramType::Railroad,
        DiagramType::TreeView,
        DiagramType::Venn,
        DiagramType::Cynefin,
        DiagramType::Wardley,
        DiagramType::Swimlane,
        DiagramType::Ishikawa,
        DiagramType::EventModeling,
    ];

    let sample_for = |dt: DiagramType| -> &'static str {
        match dt {
            DiagramType::Flowchart => "flowchart LR\n  A --> B",
            DiagramType::Sequence => "sequenceDiagram\n  A->>B: hi",
            DiagramType::Class => "classDiagram\n  class A {\n    +id int\n  }",
            DiagramType::State => "stateDiagram-v2\n  [*] --> Active",
            DiagramType::Er => "erDiagram\n  USER ||--o{ ORDER : places",
            DiagramType::Pie => "pie\n  \"A\" : 1\n  \"B\" : 2",
            DiagramType::Gantt => "gantt\n  dateFormat YYYY-MM-DD\n  section S\n    Task :a1, 2024-01-01, 3d",
            DiagramType::GitGraph => "gitGraph\n  commit\n  branch dev\n  commit",
            DiagramType::Mindmap => "mindmap\n  root((Plan))\n    Build",
            DiagramType::Timeline => "timeline\n  2024 : Launch",
            DiagramType::Journey => "journey\n  section Day\n    Code: 5: Me",
            DiagramType::XyChart => "xychart-beta\n  x-axis [a, b]\n  y-axis 0 --> 10\n  bar [3, 7]",
            DiagramType::QuadrantChart => "quadrantChart\n  x-axis Low --> High\n  y-axis Low --> High\n  Item: [0.5, 0.5]",
            DiagramType::Requirement => "requirementDiagram\n  requirement r1 {\n    id: 1\n    text: Must work\n    risk: low\n    verifymethod: test\n  }",
            DiagramType::C4 => "C4Context\n  Person(u, \"User\")\n  System(s, \"App\")\n  Rel(u, s, \"Uses\")",
            DiagramType::Sankey => "sankey-beta\nA,B,10",
            DiagramType::Block => "block-beta\n  a[\"A\"] b[\"B\"]\n  a --> b",
            DiagramType::Packet => "packet-beta\n  0-7: \"Header\"\n  8-15: \"Body\"",
            DiagramType::Kanban => "kanban\n  todo[Todo]\n    t1[Ship]",
            DiagramType::Architecture => "architecture-beta\n  service api(server)[API]\n  service db(database)[DB]\n  api:R -- L:db",
            DiagramType::Radar => "radar-beta\n  axis a, b, c\n  curve x{1, 2, 3}",
            DiagramType::Treemap => "treemap-beta\n\"Root\"\n  \"A\": 10\n  \"B\": 20",
            DiagramType::Info => "info",
            DiagramType::Agentflow => "agentflow-beta TB\n  A[Agent] --> B[Tool]",
            DiagramType::Usecase => "usecase-beta\n  actor User\n  Login(\"Login\")\n  User --> Login",
            DiagramType::Railroad => "railroad-abnf-beta\nrule = \"test\" ;",
            DiagramType::TreeView => "treeView-beta\n  \"src\"\n    \"lib.rs\"",
            DiagramType::Venn => "venn-beta\n  set A\n  set B\n  union A,B",
            DiagramType::Cynefin => "cynefin-beta\n  clear\n    \"Best practice\"",
            DiagramType::Wardley => "wardley-beta\n  component App [0.7, 0.5]",
            DiagramType::Swimlane => "swimlane-beta LR\n  subgraph Lane\n    A --> B\n  end",
            DiagramType::Ishikawa => "ishikawa-beta\n    Effect\n        Cause\n            Detail",
            DiagramType::EventModeling => "eventmodeling\n    tf 01 ui UI\n    tf 02 cmd RunAction\n    tf 03 evt ActionExecuted",
        }
    };

    let registry = Registry::default();
    assert_eq!(ALL_TYPES.len(), 33);
    for dt in ALL_TYPES {
        assert!(
            registry.registered(dt),
            "DiagramType::{dt:?} ({}) is not registered in Registry::default()",
            dt.as_str()
        );
        let src = sample_for(dt);
        assert!(supports(src), "supports() returned false for {dt:?}");
        assert_eq!(detect_type(src), Some(dt), "detect_type mismatch for {dt:?}");

        let css = render(src, &css_options()).unwrap_or_else(|e| panic!("{dt:?} css render failed: {e}"));
        assert_eq!(css.diagram_type, dt);
        assert_inert(&css.svg, dt.as_str());

        let light = render(src, &resolved_options()).unwrap_or_else(|e| panic!("{dt:?} light render failed: {e}"));
        assert_eq!(light.diagram_type, dt);
        assert_inert_resolved(&light.svg, dt.as_str());
        assert_resvg_parses(&light.svg, dt.as_str());

        let dark = render(src, &dark_options()).unwrap_or_else(|e| panic!("{dt:?} dark render failed: {e}"));
        assert_eq!(dark.diagram_type, dt);
        assert_inert_resolved(&dark.svg, dt.as_str());
        assert_resvg_parses(&dark.svg, dt.as_str());
    }
}
