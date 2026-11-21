mod support;

use std::time::Instant;

use indexmap::IndexMap;
use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::kanban::KanbanModel;
use vibevalley_pele::diagram::kanban::parser::tokenize;
use vibevalley_pele::util::yaml::YamlValue;
use vibevalley_pele::{
    DiagramConfig, LinkInfo, METRICS_MEASURER, MathSvg, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, parse, render, supports,
};

use support::{
    Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, load_fixture, resolved_options,
};

const BASE: &str = "---\nconfig:\n  kanban:\n    ticketBaseUrl: 'https://example.com/browse/#TICKET#'\n---\n";

fn kanban_model(src: &str) -> KanbanModel {
    match parse(src, &ParseOptions::default()).unwrap().model {
        ParsedModel::Kanban(m) => m,
        other => panic!("expected KanbanModel, got {other:?}"),
    }
}

fn kanban_config(entries: &[(&str, YamlValue)]) -> DiagramConfig {
    let mut section = IndexMap::new();
    for (k, v) in entries {
        section.insert((*k).to_string(), v.clone());
    }
    let mut config = DiagramConfig::default();
    config.sections.insert("kanban".to_string(), section);
    config
}

fn check_both(src: &str, id_prefix: Option<&str>, font_family: Option<&str>, with_icons: bool) -> bool {
    let icon_fn = |_name: &str| Some(r#"<path d="M0,0"/>"#.to_string());
    let mut css = css_options();
    css.id_prefix = id_prefix.map(str::to_string);
    css.font_family = font_family.map(str::to_string);
    if with_icons {
        css.icons = Some(&icon_fn);
    }
    let ok = match render(src, &css) {
        Ok(r) => {
            assert_inert(&r.svg, src);
            true
        }
        Err(_) => false,
    };

    let mut res = resolved_options();
    res.id_prefix = id_prefix.map(str::to_string);
    res.font_family = font_family.map(str::to_string);
    if with_icons {
        res.icons = Some(&icon_fn);
    }
    if let Ok(r) = render(src, &res) {
        assert_inert_resolved(&r.svg, src);
        assert_resvg_parses(&r.svg, src);
    }
    ok
}

#[test]
fn kanban_renders_columns_cards_metadata_priorities_links_and_wrapping() {
    let src = "kanban\n  todo[To do]\n    a[First]\n    b[Second]\n  done[Done]\n    c[Third]\n  later[Later]";
    let res = render(src, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Kanban);
    assert!(supports("kanban\n  a"));
    assert_eq!(res.svg.matches(r#"class="pele-cluster pele-column""#).count(), 3);
    assert_eq!(res.svg.matches(r#"class="pele-node pele-card""#).count(), 3);
    for text in ["To do", "First", "Second", "Done", "Third", "Later"] {
        assert!(res.svg.contains(&format!(">{text}</text>")), "missing {text}");
    }
    let counts: Vec<&str> = Regex::new(r#"class="pele-count"[^>]*>(\d+)<"#)
        .unwrap()
        .captures_iter(&res.svg)
        .map(|c| c.get(1).unwrap().as_str())
        .collect();
    assert_eq!(counts, vec!["2", "1", "0"]);
    assert!(res.svg.contains(r#"data-id="todo""#));
    assert!(res.svg.contains(r#"data-id="a""#));

    let light = render(src, &resolved_options()).unwrap();
    assert_inert_resolved(&light.svg, "kanban light");
    assert_resvg_parses(&light.svg, "kanban light");
    let dark = render(src, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "kanban dark");
    assert_resvg_parses(&dark.svg, "kanban dark");

    // Equal widths and heights across columns; sectionWidth override
    let eq = render("kanban\n  a\n    one\n    two\n    three\n  b\n    four\n  c", &css_options()).unwrap();
    let re_col = Regex::new(r#"pele-column" data-id="[^"]*" transform="translate\(([\d.]+),[\d.]+\)"><rect width="(\d+)" height="([\d.]+)""#).unwrap();
    let cols: Vec<(f64, &str, &str)> = re_col
        .captures_iter(&eq.svg)
        .map(|c| (c[1].parse().unwrap(), c.get(2).unwrap().as_str(), c.get(3).unwrap().as_str()))
        .collect();
    assert_eq!(cols.len(), 3);
    assert!(cols.iter().all(|c| c.1 == "200"));
    assert!(cols.iter().all(|c| c.2 == cols[0].2));
    assert!(((cols[1].0 - cols[0].0) - (cols[2].0 - cols[1].0)).abs() < 1e-6);

    let wide = render("---\nconfig:\n  kanban:\n    sectionWidth: 320\n---\nkanban\n  a\n    one\n  b", &css_options()).unwrap();
    assert!(wide.svg.contains(r#"<rect width="320""#));
    assert!(wide.width > 640.0);

    // Deeper lines become cards of the last column
    let nested = kanban_model("kanban\n  root\n    child1\n      leaf1\n    child2\n  second\n      deep");
    let ids: Vec<Vec<&str>> = nested.sections.iter().map(|s| s.items.iter().map(|i| i.id.as_str()).collect()).collect();
    assert_eq!(ids, vec![vec!["child1", "leaf1", "child2"], vec!["deep"]]);

    // Rejects a line after one indented less than the first column
    assert_eq!(kanban_model("kanban\n    a\n  shallow").sections[0].items[0].id, "shallow");
    let bad = render("kanban\n    a\n  shallow\n    b", &css_options()).unwrap_err();
    assert!(bad.message.contains(r#"Items without section detected, found section ("shallow")"#));

    // Single-line and multi-line metadata
    let one = &kanban_model("kanban\n  todo\n    a[Task]@{ ticket: MC-2037, assigned: 'knsv', priority: 'High', icon: star }").sections[0].items[0];
    assert_eq!(one.id, "a");
    assert_eq!(one.label, "Task");
    assert_eq!(one.ticket.as_deref(), Some("MC-2037"));
    assert_eq!(one.assigned.as_deref(), Some("knsv"));
    assert_eq!(one.priority.as_deref(), Some("High"));
    assert_eq!(one.icon.as_deref(), Some("star"));

    let many =
        &kanban_model("kanban\n  todo\n    a@{\n      assigned: knsv\n      label: \"A new\n        label\"\n      ticket: 12\n    }").sections[0].items[0];
    assert_eq!(many.assigned.as_deref(), Some("knsv"));
    assert_eq!(many.label, "A new<br/>label");
    assert_eq!(many.ticket.as_deref(), Some("12"));

    // Assignee and ticket without link
    let plain_meta = render("kanban\n  todo\n    a[Task]@{ ticket: MC-1, assigned: 'knsv' }", &css_options()).unwrap();
    assert!(
        Regex::new(r#"class="pele-ticket" fill="var\(--_m\)"[^>]*>MC-1<"#)
            .unwrap()
            .is_match(&plain_meta.svg)
    );
    assert!(
        Regex::new(r#"class="pele-assigned" fill="var\(--_m\)"[^>]*text-anchor="end">knsv<"#)
            .unwrap()
            .is_match(&plain_meta.svg)
    );
    assert!(!plain_meta.svg.contains("<a "));
    assert!(plain_meta.links.is_empty());

    // Ticket link through ticketBaseUrl including "$&"
    let linked = render(
        &format!("{BASE}kanban\n  todo\n    a[Task]@{{ ticket: MC-1 }}\n    b[Other]@{{ ticket: \"$&\" }}"),
        &css_options(),
    )
    .unwrap();
    assert!(
        linked
            .svg
            .contains(r#"<a href="https://example.com/browse/MC-1" target="_blank" rel="noopener">"#)
    );
    assert_eq!(
        linked.links,
        vec![
            LinkInfo {
                id: "a".to_string(),
                href: "https://example.com/browse/MC-1".to_string(),
                internal: false,
            },
            LinkInfo {
                id: "b".to_string(),
                href: "https://example.com/browse/$&".to_string(),
                internal: false,
            },
        ]
    );

    // Unsafe ticket links dropped
    let js_base = render(
        "---\nconfig:\n  kanban:\n    ticketBaseUrl: 'javascript:alert(#TICKET#)'\n---\nkanban\n  todo\n    a[Task]@{ ticket: MC-1 }",
        &css_options(),
    )
    .unwrap();
    assert!(!js_base.svg.contains("<a "));
    assert!(js_base.svg.contains(">MC-1<"));
    assert!(js_base.links.is_empty());
    let js_ticket = render(
        "---\nconfig:\n  kanban:\n    ticketBaseUrl: '#TICKET#'\n---\nkanban\n  todo\n    a[Task]@{ ticket: 'javascript:alert(1)' }",
        &css_options(),
    )
    .unwrap();
    assert!(!js_ticket.svg.contains("<a "));

    // Priorities
    let prio_src = concat!(
        "kanban\n  todo\n",
        "    a[A]@{ priority: 'Very High' }\n",
        "    b[B]@{ priority: High }\n",
        "    c[C]@{ priority: Medium }\n",
        "    d[D]@{ priority: 'Low' }\n",
        "    e[E]@{ priority: 'Very Low' }\n",
        "    f[F]@{ priority: high }\n",
        "    g[G]@{ priority: whenever }",
    );
    let prio = render(prio_src, &css_options()).unwrap();
    let edge = |id: &str| -> Option<String> {
        let re = Regex::new(&format!(
            r#"data-id="{id}"[^>]*><rect[^>]*/><path class="pele-priority"[^>]*fill="none" (.*?) stroke-width"#
        ))
        .unwrap();
        re.captures(&prio.svg).map(|c| c[1].to_string())
    };
    let red = r#"stroke="var(--pele-critical,#e45756)""#.to_string();
    let grey = r#"stroke="var(--_m)""#.to_string();
    let faint = r#" opacity="0.5""#;
    let edges: Vec<Option<String>> = ["a", "b", "c", "d", "e", "f", "g"].into_iter().map(edge).collect();
    assert_eq!(
        edges,
        vec![
            Some(red.clone()),
            Some(format!("{red}{faint}")),
            None,
            Some(format!("{grey}{faint}")),
            Some(grey),
            Some(format!("{red}{faint}")),
            None,
        ]
    );
    assert!(!prio.svg.contains("--pele-series-"));
    assert!(prio.svg.contains(r#"class="pele-node pele-card pele-priority-very-high" data-id="a""#));
    assert!(prio.svg.contains(r#"class="pele-node pele-card" data-id="g""#));

    // Classes and icons
    let icon_resolver = |name: &str| Some(format!(r#"<path d="M0,0" data-icon="{name}"/>"#));
    let cls_src = "kanban\n  todo[To do]\n  :::wide\n  ::icon(inbox)\n    a[Task]@{ icon: star }\n    :::urgent large";
    let styled = render(
        cls_src,
        &RenderOptions {
            icons: Some(&icon_resolver),
            ..css_options()
        },
    )
    .unwrap();
    assert!(styled.svg.contains(r#"class="pele-cluster pele-column wide" data-id="todo""#));
    assert!(styled.svg.contains(r#"class="pele-node pele-card urgent large" data-id="a""#));
    assert!(styled.svg.contains(r#"<svg class="pele-icon" data-icon="inbox""#));
    assert!(styled.svg.contains(r#"<path d="M0,0" data-icon="star"/></svg>"#));

    // Text wrapping & long word breaking
    let short = render("kanban\n  todo\n    a[Short]", &css_options()).unwrap();
    let long = render(&format!("kanban\n  todo\n    a[{}]", "several words that wrap ".repeat(4)), &css_options()).unwrap();
    let word = render(&format!("kanban\n  todo\n    a[{}]", "x".repeat(120)), &css_options()).unwrap();
    assert!(long.height > short.height);
    assert_eq!(long.width, short.width);
    assert_eq!(word.width, short.width);
    let pieces: Vec<&str> = Regex::new(r#"class="pele-label"[^>]*>(x+)<"#)
        .unwrap()
        .captures_iter(&word.svg)
        .map(|c| c.get(1).unwrap().as_str())
        .collect();
    assert!(pieces.len() > 3);
    assert_eq!(pieces.concat(), "x".repeat(120));
    for piece in pieces {
        assert!(METRICS_MEASURER.width(piece, 14.0, TextStyle::NONE) <= 164.0);
    }

    // Metadata label override & markdown formatting
    let md = render("kanban\n  todo\n    a[Old]@{ label: \"New **bold** text\" }", &css_options()).unwrap();
    assert!(!md.svg.contains("Old"));
    assert!(md.svg.contains(r#"font-weight="var(--_w)">bold</tspan>"#));

    // Invalid YAML vs non-mapping YAML
    assert!(render("kanban\n  todo\n    a@{ label: \"x }", &css_options()).is_err());
    assert!(
        render("kanban\n  todo\n    a@{ a: [ }", &css_options())
            .unwrap_err()
            .message
            .contains("not valid YAML")
    );
    assert!(render("kanban\n  todo\n    a@{\n}", &css_options()).unwrap().svg.contains(">a</text>"));
    assert!(render("kanban\n  todo\n    a@{\n - x\n}", &css_options()).unwrap().svg.contains(">a</text>"));
    assert!(render("kanban\n  todo\n    a@{}", &css_options()).unwrap().svg.contains(">a</text>"));

    // Shape validation
    assert!(
        render("kanban\n  todo\n    a@{ shape: Rect }", &css_options())
            .unwrap_err()
            .message
            .contains("No such shape: Rect. Shape names should be lowercase.")
    );
    assert!(
        render("kanban\n  todo\n    a@{ shape: kanban_item }", &css_options())
            .unwrap_err()
            .message
            .contains("No such shape")
    );
    assert!(
        render("kanban\n  todo\n    a@{ shape: rect }", &css_options())
            .unwrap()
            .svg
            .contains(">a</text>")
    );

    // Decoration before first node ignored
    assert!(
        render("kanban\n::icon(star)\n:::big\ntodo", &css_options())
            .unwrap()
            .svg
            .contains(">todo</text>")
    );

    // Front matter title
    let untitled = render("kanban\n  todo\n    a", &css_options()).unwrap();
    let titled = render("---\ntitle: Sprint 12\n---\nkanban\n  todo\n    a", &css_options()).unwrap();
    assert!(titled.svg.contains(r#"class="pele-title" font-weight="var(--_tw)""#));
    assert!(titled.svg.contains(">Sprint 12<"));
    assert!(titled.height > untitled.height);

    // Empty board & max_width folding & math resolver
    assert!(render("kanban\n\n", &css_options()).unwrap().svg.contains("<svg"));
    let folded = render(
        "kanban\n  c1\n    a\n  c2\n    b\n  c3\n    c",
        &RenderOptions {
            max_width: Some(300.0),
            ..resolved_options()
        },
    )
    .unwrap();
    assert_inert_resolved(&folded.svg, "kanban folded");
    assert_resvg_parses(&folded.svg, "kanban folded");
    assert!(folded.width <= 300.0);

    let math_resolver = |_tex: &str, _size: f64| {
        Some(MathSvg {
            svg: r#"<path d="M0,0H120V16H0Z"/>"#.to_string(),
            width: 240.0,
            height: 20.0,
        })
    };
    let with_math = render(
        "kanban\n  todo\n    a[$$x^2$$]",
        &RenderOptions {
            math: Some(&math_resolver),
            ..resolved_options()
        },
    )
    .unwrap();
    assert!(with_math.width > 240.0);
    assert!(with_math.svg.contains(r#"class="pele-math""#));
    assert_well_formed(&with_math.svg).unwrap();
    assert!(!with_math.svg.contains("var(--") && !with_math.svg.contains("<foreignObject"));
    assert_resvg_parses(&with_math.svg, "kanban math");

    // Determinism & finite numbers
    let det_src = format!(
        "{BASE}kanban\n  Todo\n    [Create Documentation]\n  id9[Ready]\n    id8[Design grammar]@{{ assigned: 'knsv', ticket: MC-1, priority: 'Low' }}"
    );
    let first = render(&det_src, &css_options()).unwrap().svg;
    assert_eq!(render(&det_src, &css_options()).unwrap().svg, first);
    assert!(!first.contains("NaN") && !first.contains("Infinity") && !first.contains("undefined"));
}

#[test]
fn kanban_is_inert_for_corpus_hostile_ticket_urls_and_mutated_inputs() {
    let corpus = load_fixture("kanban-corpus.json");
    assert!(corpus.len() >= 30);
    let mut corpus_ok = 0usize;
    for src in &corpus {
        if check_both(src, None, None, true) {
            corpus_ok += 1;
        }
    }
    assert!(corpus_ok > 30, "corpus_ok={corpus_ok}");

    let mut rendered = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("kanban\n  {p}\n    card"),
            format!("kanban\n  todo\n    {p}"),
            format!("kanban\n  todo[{p}]\n    a[{p}]"),
            format!("kanban\n  {p}[Todo]\n    {p}[Card]"),
            format!("kanban\n  todo({p})\n    a(({p}))\n    b{{{{{p}}}}}\n    c)){p}(("),
            format!("kanban\n  todo[\"{p}\"]\n    a[\"{p}\"]"),
            format!("kanban\n  todo[\"`{p}`\"]\n    a[\"`**{p}**\n{p}`\"]"),
            format!("kanban\n  todo\n    a@{{ label: \"{p}\" }}"),
            format!("kanban\n  todo\n    a@{{ label: '{p}' }}"),
            format!("kanban\n  todo\n    a@{{ assigned: \"{p}\" }}"),
            format!("kanban\n  todo\n    a@{{ ticket: \"{p}\" }}"),
            format!("kanban\n  todo\n    a@{{ priority: \"{p}\" }}"),
            format!("kanban\n  todo\n    a@{{ icon: \"{p}\" }}"),
            format!("kanban\n  todo\n    a@{{ shape: \"{p}\" }}"),
            format!("kanban\n  todo\n    a@{{ {p}: 1 }}"),
            format!("kanban\n  todo\n    a@{{ {p} }}"),
            format!("kanban\n  todo\n    a@{{\n      assigned: {p}\n      ticket: {p}\n      priority: {p}\n    }}"),
            format!("kanban\n  todo@{{ label: \"{p}\", ticket: \"{p}\", assigned: \"{p}\", priority: \"{p}\", icon: \"{p}\" }}\n    a"),
            format!("{BASE}kanban\n  todo\n    a@{{ ticket: \"{p}\" }}"),
            format!("---\nconfig:\n  kanban:\n    ticketBaseUrl: \"{p}\"\n---\nkanban\n  todo\n    a@{{ ticket: T-1 }}"),
            format!("---\nconfig:\n  kanban:\n    ticketBaseUrl: \"{p}#TICKET#\"\n---\nkanban\n  todo\n    a@{{ ticket: \"{p}\" }}"),
            format!("---\nconfig:\n  kanban:\n    ticketBaseUrl: \"#TICKET#\"\n---\nkanban\n  todo\n    a@{{ ticket: \"{p}\" }}"),
            format!("%%{{init: {{\"kanban\": {{\"ticketBaseUrl\": \"{p}\", \"sectionWidth\": \"{p}\"}}}}}}%%\nkanban\n  todo\n    a@{{ ticket: T-1 }}"),
            format!("kanban\n  todo\n  ::icon({p})\n    a\n    ::icon({p})"),
            format!("kanban\n  todo\n  :::{p}\n    a\n    :::{p} {p}"),
            format!("kanban\n  todo\n    a %% {p}\n    b[c] %% {p}"),
            format!("kanban\n  todo\n    fa:fa-{p} x"),
            format!("kanban {p}\n  todo"),
            format!("---\ntitle: \"{p}\"\n---\nkanban\n  todo\n    a"),
        ];
        for src in templates {
            if check_both(&src, None, None, true) {
                rendered += 1;
            }
        }
    }
    assert!(rendered > 400, "rendered={rendered}");

    // Ticket URL safety across all payloads & script tickets
    let re_script = Regex::new(r"(?i)^\s*(?:javascript|vbscript|data)\s*:").unwrap();
    for &payload in PAYLOADS {
        for base in [payload.to_string(), format!("{payload}#TICKET#"), "#TICKET#".to_string()] {
            let cfg = kanban_config(&[("ticketBaseUrl", YamlValue::String(base.clone()))]);
            for ticket in ["T-1", "javascript:alert(1)", " JaVaScRiPt:alert(1)", "data:text/html,x", "$&", "$'"] {
                let src = format!("kanban\n  todo\n    a@{{ ticket: \"{ticket}\" }}");
                let res = render(
                    &src,
                    &RenderOptions {
                        config: Some(cfg.clone()),
                        ..css_options()
                    },
                )
                .unwrap();
                assert_inert(&res.svg, &format!("ticketBaseUrl={base:?}, ticket={ticket:?}"));
                for link in &res.links {
                    assert!(!re_script.is_match(&link.href), "unsafe link {} for base={base:?} ticket={ticket:?}", link.href);
                }
            }
        }
    }

    // Escaping text, ids, metadata and classes
    let esc_src = format!("{BASE}kanban\n  a<b>\"&[<i onload=x>\"&]\n  :::a\"b <c> d=e\n    c@{{ ticket: '\"><x>&', assigned: 'x < y \"&' }}");
    let escaped = render(&esc_src, &css_options()).unwrap();
    assert_inert(&escaped.svg, "kanban escaping");
    assert!(escaped.svg.contains(r#"data-id="a&lt;b&gt;&quot;&amp;""#));
    assert!(escaped.svg.contains(r#"class="pele-cluster pele-column a b c d e""#));
    assert!(escaped.svg.contains(">x &lt; y &quot;&amp;</text>"));
    assert!(!escaped.svg.contains("<i"));
    assert!(!escaped.svg.contains("<x>"));
    assert_eq!(escaped.links.len(), 1);
    assert!(escaped.links[0].href.starts_with("https://example.com/browse/"));

    // Hostile option values
    for &p in PAYLOADS {
        assert!(check_both("kanban\n  todo\n    a@{ icon: x, ticket: y }", Some(p), Some(p), true));
    }

    // Mutated inputs
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&[
        "\"",
        "[",
        "]",
        "(",
        ")",
        "\n",
        "\n    ",
        ":::",
        "::icon(",
        "@{ ",
        " }",
        "@{ ticket: \"",
        "@{ label: \"",
        "assigned: ",
        "priority: High",
        ", ",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..2000 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            check_both(&src, None, None, true);
        }
    }
}

#[test]
fn kanban_stays_fast_on_stress_inputs() {
    const N: usize = 50_000;
    let big_parse = ParseOptions {
        limit: Some(usize::MAX),
        ..ParseOptions::default()
    };
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let linked = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        config: Some(kanban_config(&[(
            "ticketBaseUrl",
            YamlValue::String("https://example.com/browse/#TICKET#".to_string()),
        )])),
        ..css_options()
    };

    let tok_cases = [
        format!("kanban\n{}", "(a) ".repeat(N / 4)),
        format!("kanban\ntodo\n{} a", " \n".repeat(N / 2)),
        format!("kanban\ntodo{}", format!("\n{}a", " ".repeat(99)).repeat(N / 100)),
        format!("kanban\ntodo\n a{}", "@".repeat(N)),
        format!("kanban\ntodo\n a{}", "@{".repeat(N / 2)),
        format!("kanban\ntodo\n a{}", "@{}".repeat(N / 3)),
        format!("kanban\ntodo\n a@{{{}", " a: 1,\n".repeat(N / 7)),
        format!("kanban\ntodo\n a@{{ label: \"{}", "x\n   ".repeat(N / 5)),
        format!("kanban\ntodo\n a@{{{}", "\"".repeat(N)),
        format!("kanban\ntodo\n{}", " a@{ ^ }\n".repeat(N / 9)),
        format!("kanban\ntodo[{}]", "}\n".repeat(N / 2)),
    ];
    for (i, src) in tok_cases.iter().enumerate() {
        let started = Instant::now();
        let _ = tokenize(src);
        assert!(started.elapsed().as_millis() < 3000, "slow kanban tok #{i}: {:?}", started.elapsed());
    }

    let parse_cases = [
        format!("kanban\ntodo\n{}", " a\n".repeat(16_000)),
        format!("kanban\ntodo\n a@{{ a: {} }}\n", "[".repeat(20_000)),
        format!("kanban\ntodo\n a@{{\n a{}\n}}\n", " ".repeat(N)),
    ];
    for (i, src) in parse_cases.iter().enumerate() {
        let started = Instant::now();
        let _ = parse(src, &big_parse);
        assert!(started.elapsed().as_millis() < 3000, "slow kanban parse #{i}: {:?}", started.elapsed());
    }

    let keys_7k: String = (0..7000).map(|i| format!("k{i}: 1, ")).collect();
    let render_cases: Vec<(String, bool)> = vec![
        (format!("kanban\ntodo\n{}", " a\n".repeat(16_000)), false),
        (format!("kanban\n{}", "a\n".repeat(16_000)), false),
        (format!("kanban\n{}", "c[Column]\n a[Card]\n b[Card]\n".repeat(4_000)), false),
        (
            format!(
                "kanban\ntodo\n{}",
                " a[Card]@{ ticket: T-1, assigned: 'k', priority: 'High', icon: star }\n".repeat(750)
            ),
            true,
        ),
        (
            format!(
                "kanban\ntodo\n{}",
                " a@{\n  assigned: k\n  ticket: T-1\n  label: \"x\n   y\"\n }\n".repeat(1_000)
            ),
            true,
        ),
        (format!("kanban\ntodo\n a@{{ {keys_7k}label: x }}"), false),
        (format!("kanban\ntodo\n a[{}]", "word ".repeat(N / 5)), false),
        (format!("kanban\ntodo\n a[{}]", "w".repeat(N)), false),
        (format!("kanban\ntodo[{}]", "w".repeat(N)), false),
        (format!("kanban\ntodo\n a[\"`{}`\"]", "*a _b ".repeat(N / 6)), false),
        (format!("kanban\ntodo\n a[{}]", "#35;&amp;<br>".repeat(N / 13)), false),
        (format!("kanban\ntodo\n a@{{ ticket: \"{}\" }}", "T".repeat(N)), true),
        (format!("kanban\ntodo\n a@{{ ticket: \"&{}x\" }}", "#38;".repeat(N / 4)), true),
        (format!("kanban\ntodo\n a@{{ assigned: \"{}\" }}", "ab ".repeat(N / 3)), false),
        (format!("kanban\ntodo\n:::{}", "a ".repeat(N / 2)), false),
        (format!("kanban\n todo\n{}b\nc\n", "  a\n".repeat(16_000)), false),
    ];
    for (i, (src, is_linked)) in render_cases.iter().enumerate() {
        let started = Instant::now();
        let _ = render(src, if *is_linked { &linked } else { &big });
        assert!(started.elapsed().as_millis() < 3000, "slow kanban render #{i}: {:?}", started.elapsed());
    }

    let long_word = render(&format!("kanban\ntodo\n a[{}]", "w".repeat(N)), &big).unwrap();
    assert_eq!(long_word.width, 216.0);
    assert!(long_word.svg.matches(r#"class="pele-label""#).count() > 1000);
}
