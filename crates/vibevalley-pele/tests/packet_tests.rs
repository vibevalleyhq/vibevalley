mod support;

use std::collections::{HashMap, HashSet};
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::packet::parser::parse_packet;
use vibevalley_pele::{ErrorCode, ParseOptions, ParsedModel, RenderOptions, parse, render, supports};

use support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const TCP: &str = "packet\n0-15: \"Source Port\"\n16-31: \"Destination Port\"\n32-63: \"Sequence Number\"\n64: \"URG\"";

fn config(packet: &str, body: &str) -> String {
    format!("---\nconfig:\n  packet:\n{packet}\n---\n{body}")
}

fn boxes(svg: &str) -> HashMap<String, f64> {
    let doc = roxmltree::Document::parse(svg).unwrap();
    let mut out = HashMap::new();
    let mut id = String::new();
    for node in doc.descendants().filter(|n| n.is_element()) {
        if node.tag_name().name() == "g"
            && let Some(did) = node.attribute("data-id")
        {
            id = did.to_string();
        }
        if node.tag_name().name() == "rect"
            && let Some(x) = node.attribute("x").and_then(|s| s.parse::<f64>().ok())
        {
            out.insert(id.clone(), x);
        }
    }
    out
}

fn check_both(src: &str, id_prefix: Option<&str>, font_family: Option<&str>) -> bool {
    let opts_css = RenderOptions {
        id_prefix: id_prefix.map(str::to_string),
        font_family: font_family.map(str::to_string),
        ..css_options()
    };
    let opts_res = RenderOptions {
        id_prefix: id_prefix.map(str::to_string),
        font_family: font_family.map(str::to_string),
        ..resolved_options()
    };
    let ok = match render(src, &opts_css) {
        Ok(r) => {
            assert_inert(&r.svg, src);
            true
        }
        Err(_) => false,
    };
    if let Ok(r) = render(src, &opts_res) {
        assert_inert_resolved(&r.svg, src);
        assert_resvg_parses(&r.svg, src);
    }
    ok
}

#[test]
fn packet_renders_rows_bit_numbers_and_options() {
    let res = render(TCP, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Packet);
    assert!(supports("packet-beta\n0: \"a\""));
    assert_eq!(res.svg.matches(r#"class="pele-node""#).count(), 4);
    assert!(res.svg.contains(">Source Port<"));
    assert!(res.svg.contains(r#"data-id="32-63""#));
    assert_eq!(res.width, (32 * 32 - 5 + 16) as f64);

    let doc = roxmltree::Document::parse(&res.svg).unwrap();
    let ys: HashSet<&str> = doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "rect")
        .filter_map(|n| n.attribute("y"))
        .collect();
    assert_eq!(ys.len(), 3);

    let resolved = render(TCP, &resolved_options()).unwrap();
    assert_inert_resolved(&resolved.svg, "packet tcp resolved");
    assert_resvg_parses(&resolved.svg, "packet tcp resolved");
    let dark = render(TCP, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "packet tcp dark");
    assert_resvg_parses(&dark.svg, "packet tcp dark");

    // Bit numbers for range and single bit
    let bn = render("packet\n0-15: \"a\"\n16: \"b\"", &css_options()).unwrap().svg;
    let bits = &bn[bn.find("pele-packet-bits").unwrap()..];
    assert_eq!(bits.matches("<text").count(), 3);
    assert!(bits.contains(">0<"));
    assert!(bits.contains(r#"text-anchor="end">15<"#));
    assert!(bits.contains(r#"text-anchor="middle">16<"#));

    // showBits: false
    let shown = render("packet\n0-15: \"a\"\n16-47: \"b\"", &css_options()).unwrap();
    let hidden = render(&config("    showBits: false", "packet\n0-15: \"a\"\n16-47: \"b\""), &css_options()).unwrap();
    assert!(!hidden.svg.contains("pele-packet-bits"));
    assert!(hidden.height < shown.height);

    // Field spanning multiple rows
    let span = render("packet\n0-10: \"test\"\n11-90: \"multiple\"", &css_options()).unwrap().svg;
    assert_eq!(span.matches(">multiple<").count(), 3);
    assert!(span.contains(r#"data-id="11-31""#));
    assert!(span.contains(r#"data-id="32-63""#));
    assert!(span.contains(r#"data-id="64-90""#));

    // Layout config options
    let body = "packet\n0-7: \"a\"\n8-15: \"b\"\n16-23: \"c\"";
    let base = render(body, &css_options()).unwrap();
    let narrow = render(&config("    bitsPerRow: 8\n    bitWidth: 10", body), &css_options()).unwrap();
    assert_eq!(narrow.width, (8 * 10 - 5 + 16) as f64);
    assert!(narrow.height > base.height);
    let tall = render(&config("    rowHeight: 80", body), &css_options()).unwrap();
    assert_eq!(tall.height, base.height + 48.0);
    let loose = render(&config("    bitsPerRow: 8\n    paddingY: 30", body), &css_options()).unwrap();
    let tight = render(&config("    bitsPerRow: 8\n    paddingY: 0", body), &css_options()).unwrap();
    assert_eq!(loose.height - tight.height, 60.0);

    let px_svg = render(&config("    paddingX: 20", body), &css_options()).unwrap().svg;
    let gap = boxes(&px_svg);
    let doc_px = roxmltree::Document::parse(&px_svg).unwrap();
    let first_w: f64 = doc_px
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "rect")
        .unwrap()
        .attribute("width")
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(first_w, (8 * 32 - 20) as f64);
    assert_eq!(gap["8-15"] - gap["0-7"], (8 * 32) as f64);
}

#[test]
fn packet_descending_truncation_title_and_validation() {
    let body = "packet\n0-7: \"DATA\"\n8-11: \"TYPE\"\n12: \"EN\"\n13-15: \"RESERVED\"\n16-19: \"NEXT\"";
    let asc = boxes(&render(&config("    bitsPerRow: 16", body), &css_options()).unwrap().svg);
    let desc_svg = render(&config("    bitsPerRow: 16\n    bitOrder: descending", body), &css_options())
        .unwrap()
        .svg;
    let desc = boxes(&desc_svg);
    assert!(asc["0-7"] < asc["8-11"]);
    assert!(desc["0-7"] > desc["8-11"]);
    assert_eq!(desc["13-15"], asc["0-7"]);
    assert_eq!(desc["16-19"], asc["0-7"] + (12 * 32) as f64);
    let bits = &desc_svg[desc_svg.find("pele-packet-bits").unwrap()..];
    assert!(bits.find(">7<").unwrap() < bits.find(">0<").unwrap());
    assert!(bits.contains(r#"text-anchor="end">0<"#));

    let shrunk = render("packet\n0: \"Wide\"\n1: \"Extraordinarily long\"\n2-31: \"x\"", &css_options())
        .unwrap()
        .svg;
    assert!(Regex::new(r#"font-size="\d+">Wide<"#).unwrap().is_match(&shrunk));
    assert!(shrunk.contains(">Extr…"));
    assert!(!shrunk.contains("Extraordinarily"));

    // Title sits under fields
    let own = render("---\ntitle: From front matter\n---\npacket\ntitle Own\n0-31: \"a\"", &css_options()).unwrap();
    assert!(own.svg.contains(">Own<"));
    assert!(!own.svg.contains("From front matter"));
    assert!(
        render("---\ntitle: From front matter\n---\npacket\n0-31: \"a\"", &css_options())
            .unwrap()
            .svg
            .contains(">From front matter<")
    );
    let doc = roxmltree::Document::parse(&own.svg).unwrap();
    let rect_y: f64 = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "rect")
        .unwrap()
        .attribute("y")
        .unwrap()
        .parse()
        .unwrap();
    let title_text = doc
        .descendants()
        .find(|n| n.is_element() && n.attribute("class") == Some("pele-title"))
        .unwrap();
    let tspan = title_text.children().find(|n| n.is_element() && n.tag_name().name() == "tspan").unwrap();
    let title_y: f64 = tspan.attribute("y").unwrap().parse().unwrap();
    assert!(title_y > rect_y + 32.0);

    // Empty and title-only packets
    assert!(render("packet", &resolved_options()).unwrap().svg.contains("<svg"));
    let titled = render("packet\ntitle Nothing yet", &resolved_options()).unwrap();
    assert!(titled.svg.contains(">Nothing yet<"));
    assert!(titled.width < 300.0);
    assert_resvg_parses(&titled.svg, "title-only packet");

    // Validation errors
    let e1 = render("packet\n0-16: \"a\"\n18-20: \"b\"", &css_options()).unwrap_err();
    assert_eq!(e1.code, ErrorCode::Semantic);
    assert_eq!(e1.message, "Packet block 18 - 20 is not contiguous. It should start from 17.");
    let e2 = render("packet\n0-16: \"a\"\n25-20: \"b\"", &css_options()).unwrap_err();
    assert_eq!(e2.message, "Packet block 25 - 20 is invalid. End must be greater than start.");
    let e3 = render("packet\n+0: \"a\"", &css_options()).unwrap_err();
    assert_eq!(e3.message, "Packet block 0 is invalid. Cannot have a zero bit field.");

    // Model + 10k row cap
    let parsed = parse(
        &config("    bitsPerRow: 8", "packet\ntitle T\naccTitle: A\naccDescr: D\n+4: \"a\"\n+8: \"b\""),
        &ParseOptions::default(),
    )
    .unwrap();
    match parsed.model {
        ParsedModel::Packet(m) => {
            assert_eq!(m.title.as_deref(), Some("T"));
            assert_eq!(m.acc_title.as_deref(), Some("A"));
            assert_eq!(m.bits_per_row, 8);
            assert_eq!(m.rows.len(), 2);
            assert_eq!(m.rows[0].len(), 2);
            assert_eq!((m.rows[0][0].start, m.rows[0][0].end, m.rows[0][0].label.as_str()), (0, 3, "a"));
            assert_eq!((m.rows[0][1].start, m.rows[0][1].end, m.rows[0][1].label.as_str()), (4, 7, "b"));
            assert_eq!((m.rows[1][0].start, m.rows[1][0].end, m.rows[1][0].label.as_str()), (8, 11, "b"));
        }
        other => panic!("expected Packet model, got {other:?}"),
    }

    let capped = parse(&config("    bitsPerRow: 1", "packet\n+20000: \"a\"\n+1: \"b\""), &ParseOptions::default()).unwrap();
    if let ParsedModel::Packet(m) = capped.model {
        assert_eq!(m.rows.len(), 10_000);
    }

    // Accessible names, invalid config, and max_width rewrapping
    let acc = render("packet\naccTitle: Name\naccDescr: Text\n0-31: \"a\"", &css_options()).unwrap();
    assert!(acc.svg.contains(r#"<title id="pele-title">Name</title>"#));
    assert!(acc.svg.contains(r#"<desc id="pele-desc">Text</desc>"#));
    let odd = render(
        &config("    bitsPerRow: -4\n    bitWidth: \"wide\"\n    rowHeight: 0\n    paddingX: 9999", TCP),
        &resolved_options(),
    )
    .unwrap();
    assert!(!odd.svg.contains("NaN") && !odd.svg.contains("Infinity") && !odd.svg.contains("width=\"-"));
    assert_resvg_parses(&odd.svg, "packet odd config");

    let narrow_auto = render(
        TCP,
        &RenderOptions {
            max_width: Some(320.0),
            ..resolved_options()
        },
    )
    .unwrap();
    assert!(narrow_auto.width <= 320.0);
    assert_inert_resolved(&narrow_auto.svg, "packet max_width");
    assert_resvg_parses(&narrow_auto.svg, "packet max_width");
}

#[test]
fn packet_is_inert_for_corpus_hostile_and_mutated_inputs() {
    let corpus = load_fixture("packet-corpus.json");
    assert!(corpus.len() >= 20);
    for src in &corpus {
        check_both(src, None, None);
    }

    let mut rendered = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("packet\n0-31: \"{p}\""),
            format!("packet\n0-31: '{p}'"),
            format!("packet\n0: \"{p}\"\n1: \"{p}\"\n2-31: \"ok\""),
            format!("packet\n+8: \"{p}\"\n+200: \"{p}\""),
            format!("packet\ntitle {p}\n0-31: \"a\""),
            format!("packet title {p}"),
            format!("packet\naccTitle: {p}\naccDescr: {p}\n0-31: \"a\""),
            format!("packet\naccDescr {{\n {p}\n }}\n0-31: \"a\""),
            format!("packet\n0-31: \"a\" %% {p}"),
            format!("packet\n{p}: \"a\""),
            format!("packet\n0-{p}: \"a\""),
            format!("packet {p}\n0-31: \"a\""),
            format!("---\ntitle: \"{p}\"\n---\npacket\n0-31: \"a\""),
            format!(
                "---\nconfig:\n  packet:\n    bitOrder: \"{p}\"\n    bitsPerRow: \"{p}\"\n    showBits: \"{p}\"\n    rowHeight: \"{p}\"\n---\npacket\n0-31: \"a\""
            ),
            format!(r#"%%{{init: {{"packet": {{"bitWidth": "{p}", "paddingX": "{p}"}}, "themeVariables": {{"packet": {{"blockFillColor": "{p}"}}}}}}}}%%"#)
                + "\npacket\n0-31: \"a\"",
        ];
        for src in templates {
            if check_both(&src, None, None) {
                rendered += 1;
            }
        }
        assert!(check_both("packet\naccTitle: t\n0-31: \"a\"", Some(p), Some(p)));
    }
    assert!(rendered > 150, "rendered={rendered}");

    let esc_svg = render("packet\n0-31: \"<b>&amp;</b> <script>x</script>\"", &css_options()).unwrap().svg;
    assert!(esc_svg.contains("&lt;b&gt;&amp;&lt;/b&gt; &lt;script&gt;x&lt;/script&gt;"));

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\"", "'", ":", "-", "+", "\n", "title ", "0-7: \"", "+8: \""]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..2000 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            check_both(&src, None, None);
        }
    }
}

#[test]
fn packet_stays_fast_on_stress_inputs() {
    const N: usize = 50_000;
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let s1: String = (0..4000).map(|i| format!("{i}: \"f{i}\"\n")).collect();
    let s2: String = (0..5000).map(|i| format!("+{}: \"f\"\n", (i % 40) + 1)).collect();
    let cases: Vec<Box<dyn Fn()>> = vec![
        Box::new(|| {
            let _ = render(&format!("packet\n{s1}"), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("packet\n{s2}"), &big);
        }),
        Box::new(|| {
            let _ = render("packet\n+1000000000: \"wide\"\n+1: \"after\"", &big);
        }),
        Box::new(|| {
            let _ = render(&format!("packet\n+{}: \"x\"\n+1: \"y\"", "9".repeat(400)), &big);
        }),
        Box::new(|| {
            let _ = render(&config("    bitsPerRow: 1", "packet\n+20000: \"a\""), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("packet\n0-31: \"{}\"", "word ".repeat(N / 5)), &big);
        }),
        Box::new(|| {
            let _ = render(&config("    bitsPerRow: 1", &format!("packet\n+20000: \"{}\"", "x".repeat(40_000))), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("packet\n0-31: \"{}\"", "#35;&amp;".repeat(N / 9)), &big);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n{}: \"a\"", "1".repeat(N)), None);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n{}", "0".repeat(N)), None);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n0{}", "-".repeat(N)), None);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n{}", "---\n".repeat(N / 4)), None);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n0: \"{}", "a".repeat(N)), None);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n0: \"{}", "\\".repeat(N)), None);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n{}", "%%{\n".repeat(N / 4)), None);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\naccDescr {{{}", " a\n".repeat(N / 3)), None);
        }),
        Box::new(|| {
            let _ = render(&format!("packet title {}", "x".repeat(N)), &big);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n{}0: \"a\"", " ".repeat(N)), None);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n{}0: \"a\"", "\n \t".repeat(N / 3)), None);
        }),
        Box::new(|| {
            let _ = parse_packet(&format!("packet\n{}0: \"a\"", "%% c\n".repeat(N / 5)), None);
        }),
        Box::new(|| {
            let _ = parse(
                &format!("packet\n{}", "title t\n".repeat(N / 8)),
                &ParseOptions {
                    limit: Some(usize::MAX),
                    ..Default::default()
                },
            );
        }),
    ];
    for (i, run) in cases.iter().enumerate() {
        let started = Instant::now();
        run();
        assert!(started.elapsed().as_millis() < 3000, "slow packet stress case #{i}: {:?}", started.elapsed());
    }
}
