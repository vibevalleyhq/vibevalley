mod support;

use std::collections::HashSet;
use std::time::Instant;

use indexmap::IndexMap;
use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::railroad::{Notation, RailroadNode, RailroadRule};
use vibevalley_pele::util::yaml::YamlValue;
use vibevalley_pele::{DiagramConfig, ParseOptions, ParsedModel, RenderOptions, detect_type, parse, render, supports};

use support::{
    Lcg, Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, load_fixture,
    resolved_options,
};

struct Rect {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn rects(svg: &str) -> Vec<Rect> {
    let doc = roxmltree::Document::parse(svg).unwrap();
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "rect")
        .map(|n| Rect {
            x: n.attribute("x").unwrap_or("0").parse().unwrap(),
            y: n.attribute("y").unwrap_or("0").parse().unwrap(),
            w: n.attribute("width").unwrap_or("0").parse().unwrap(),
            h: n.attribute("height").unwrap_or("0").parse().unwrap(),
        })
        .collect()
}

fn railroad_config(entries: &[(&str, YamlValue)]) -> DiagramConfig {
    let mut section = IndexMap::new();
    for (k, v) in entries {
        section.insert((*k).to_string(), v.clone());
    }
    let mut config = DiagramConfig::default();
    config.sections.insert("railroad".to_string(), section);
    config
}

fn assert_tidy(svg: &str, width: f64, height: f64, where_ctx: &str) {
    assert_well_formed(svg).unwrap_or_else(|e| panic!("{where_ctx}: {e}"));
    let boxes = rects(svg);
    for b in &boxes {
        assert!((b.x + b.y + b.w + b.h).is_finite(), "{where_ctx}: non-finite box");
        assert!(
            b.x >= 0.0 && b.y >= 0.0 && b.x + b.w <= width + 1e-6 && b.y + b.h <= height + 1e-6,
            "{where_ctx}: box outside ({},{},{},{}) vs ({width},{height})",
            b.x,
            b.y,
            b.w,
            b.h
        );
    }
    if boxes.len() <= 400 {
        for i in 0..boxes.len() {
            for j in (i + 1)..boxes.len() {
                let a = &boxes[i];
                let b = &boxes[j];
                let apart = a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6;
                assert!(apart, "{where_ctx}: boxes {i} and {j} overlap");
            }
        }
    }
    let doc = roxmltree::Document::parse(svg).unwrap();
    let re_coord = Regex::new(r"M(-?[\d.]+),(-?[\d.]+)|H(-?[\d.]+)|V(-?[\d.]+)").unwrap();
    for el in doc.descendants().filter(|n| n.is_element() && n.tag_name().name() == "path") {
        let d = el.attribute("d").unwrap_or("");
        assert!(
            !d.contains("NaN") && !d.contains("Infinity") && !d.contains("undefined"),
            "{where_ctx}: bad path {d}"
        );
        for cap in re_coord.captures_iter(d) {
            for g in [1usize, 3] {
                if let Some(m) = cap.get(g) {
                    let x: f64 = m.as_str().parse().unwrap();
                    assert!(x >= -1e-6 && x <= width + 1e-6, "{where_ctx}: x {x} out of [0, {width}]");
                }
            }
            for g in [2usize, 4] {
                if let Some(m) = cap.get(g) {
                    let y: f64 = m.as_str().parse().unwrap();
                    assert!(y >= -1e-6 && y <= height + 1e-6, "{where_ctx}: y {y} out of [0, {height}]");
                }
            }
        }
    }
}

fn check_both(src: &str, extra_css: RenderOptions<'_>, extra_res: RenderOptions<'_>) -> bool {
    let ok = match render(src, &extra_css) {
        Ok(r) => {
            assert_inert(&r.svg, src);
            true
        }
        Err(_) => false,
    };
    if let Ok(r) = render(src, &extra_res) {
        assert_inert_resolved(&r.svg, src);
        assert_resvg_parses(&r.svg, src);
    }
    ok
}

fn pick<'a, T>(rnd: &mut Lcg, list: &'a [T]) -> &'a T {
    &list[rnd.next_usize(list.len())]
}

fn several(rnd: &mut Lcg, max: usize, mut make: impl FnMut(&mut Lcg) -> String, joints: &[&str]) -> String {
    let n = 1 + rnd.next_usize(max);
    let mut parts = Vec::with_capacity(n);
    for _ in 0..n {
        parts.push(make(rnd));
    }
    parts.join(pick(rnd, joints))
}

const STRINGS: &[&str] = &[
    "\"a\"",
    "'b'",
    "\"x y\"",
    "\"\\n\"",
    "\"\\\"\"",
    "\"q\\\\\"",
    "\"\"",
    "\"+\"",
    "\"é\"",
    "'it\\'s'",
    "\"a  b\"",
    "\"?\"",
    "\";\"",
    "\"(*\"",
];
const NAMES: &[&str] = &[
    "r",
    "rule",
    "my_rule",
    "a-b",
    "A1",
    "terminals",
    "x_",
    "choice2",
    "accTitles",
    "digit",
    "Expr",
    "b",
    "c",
    "d",
    "e",
    "f",
    "g",
    "h",
    "i",
    "titles",
    "title-x",
];

fn ir_expr(rnd: &mut Lcg, depth: usize) -> String {
    let r = rnd.next_f64();
    if depth == 0 || r < 0.4 {
        return format!("{}({})", pick(rnd, &["terminal", "nonterminal", "special"]), pick(rnd, STRINGS));
    }
    if r < 0.75 {
        let ctor = *pick(rnd, &["sequence", "choice"]);
        let args = several(rnd, 3, |r| ir_expr(r, depth - 1), &[", ", ",", " , ", ",\n  "]);
        return format!("{ctor}({args})");
    }
    format!("{}( {} )", pick(rnd, &["optional", "oneOrMore", "zeroOrMore"]), ir_expr(rnd, depth - 1))
}

fn ebnf_primary(rnd: &mut Lcg, depth: usize) -> String {
    let r = rnd.next_f64();
    if depth == 0 || r < 0.78 {
        if rnd.next_f64() < 0.1 {
            return (*pick(rnd, &["? any ?", "?x?", "? two words ?"])).to_string();
        }
        let pool = if rnd.next_f64() < 0.5 { STRINGS } else { NAMES };
        return (*pick(rnd, pool)).to_string();
    }
    let (open, close) = *pick(rnd, &[("( ", " )"), ("[ ", " ]"), ("{ ", " }"), ("(", ")")]);
    format!("{open}{}{close}", ebnf_choice(rnd, depth - 1))
}

fn ebnf_term(rnd: &mut Lcg, depth: usize) -> String {
    let mut s = ebnf_primary(rnd, depth);
    while rnd.next_f64() < 0.25 {
        let choice = rnd.next_usize(5);
        match choice {
            0 => s.push('?'),
            1 => s.push('*'),
            2 => s.push('+'),
            3 => {
                s.push_str(" - ");
                s.push_str(&ebnf_primary(rnd, depth.saturating_sub(1)));
            }
            _ => {
                s.push('-');
                s.push_str(&ebnf_primary(rnd, depth.saturating_sub(1)));
            }
        }
    }
    s
}

fn ebnf_choice(rnd: &mut Lcg, depth: usize) -> String {
    several(
        rnd,
        3,
        |r| several(r, 3, |r2| ebnf_term(r2, depth), &[" ", " , ", ",", " (* c *) "]),
        &[" | ", "|"],
    )
}

fn abnf_alt(rnd: &mut Lcg, depth: usize) -> String {
    several(
        rnd,
        3,
        |r| {
            several(
                r,
                3,
                |r2| {
                    let rep = *pick(r2, &["", "", "", "*", "1*", "2*3", "3", "*4", "0*1", "1", "0"]);
                    if depth == 0 || r2.next_f64() < 0.78 {
                        let atom = *pick(r2, &["\"s\"", "\"a b\"", "\"\"", "%x41", "%d1.2", "%b0-1", "name", "DIGIT", "rule-name", "a1"]);
                        return format!("{rep}{atom}");
                    }
                    let (open, close) = *pick(r2, &[("( ", " )"), ("[ ", " ]"), ("(", ")")]);
                    format!("{rep}{open}{}{close}", abnf_alt(r2, depth - 1))
                },
                &[" ", "  ", "\n  "],
            )
        },
        &[" / ", "/"],
    )
}

fn peg_choice(rnd: &mut Lcg, depth: usize) -> String {
    several(
        rnd,
        3,
        |r| {
            several(
                r,
                3,
                |r2| {
                    let head = *pick(r2, &["", "", "", "&", "!"]);
                    let tail = *pick(r2, &["", "", "", "?", "*", "+"]);
                    if depth == 0 || r2.next_f64() < 0.78 {
                        let atom = if r2.next_f64() < 0.1 {
                            "."
                        } else {
                            let pool = if r2.next_f64() < 0.5 { STRINGS } else { NAMES };
                            *pick(r2, pool)
                        };
                        return format!("{head}{atom}{tail}");
                    }
                    format!("{head}( {} ){tail}", peg_choice(r2, depth - 1))
                },
                &[" ", "  ", " # c\n  "],
            )
        },
        &[" / ", "/"],
    )
}

fn gen_grammar(notation: Notation, rnd: &mut Lcg) -> String {
    let kw = match notation {
        Notation::Railroad => "railroad-beta",
        Notation::Ebnf => "railroad-ebnf-beta",
        Notation::Abnf => "railroad-abnf-beta",
        Notation::Peg => "railroad-peg-beta",
    };
    let headers = [
        "title T\n",
        "title \"Quoted \\\" t\"\n",
        "title 'q'\n",
        "accTitle: a  b\n",
        "accDescr: d\n",
        "accDescr {\n multi\n line\n}\n",
        "title\n",
    ];
    let mut s = format!("{kw}{}", pick(rnd, &["\n", " ", "\n\n"]));
    while rnd.next_f64() < 0.25 {
        s.push_str(pick(rnd, &headers));
    }
    let rules = rnd.next_usize(4);
    for _ in 0..rules {
        let rule = match notation {
            Notation::Railroad => format!("{} = {} ;", pick(rnd, NAMES), ir_expr(rnd, 4)),
            Notation::Ebnf => format!("{} {} {} ;", pick(rnd, NAMES), pick(rnd, &["=", "::="]), ebnf_choice(rnd, 3)),
            Notation::Abnf => format!(
                "{} = {} ;{}",
                pick(rnd, &["r", "rule", "a-b", "A1", "titles"]),
                abnf_alt(rnd, 3),
                pick(rnd, &["", "", "", " c"])
            ),
            Notation::Peg => format!("{} <- {} ;", pick(rnd, NAMES), peg_choice(rnd, 3)),
        };
        s.push_str(&rule);
        s.push_str(pick(rnd, &["\n", "\n\n", "\n%% c\n"]));
    }
    s
}

fn ebnf(rules: &str, opts: &RenderOptions<'_>) -> vibevalley_pele::RenderResult {
    render(&format!("railroad-ebnf-beta\n{rules}"), opts).unwrap()
}

#[test]
fn railroad_renders_all_four_notations_constructs_titles_and_config() {
    let sources = [
        ("railroad-beta\nr = terminal(\"a\") ;", Notation::Railroad),
        ("railroad-ebnf-beta\nr = \"a\" ;", Notation::Ebnf),
        ("railroad-abnf-beta\nr = \"a\" ;", Notation::Abnf),
        ("railroad-peg-beta\nr <- \"a\" ;", Notation::Peg),
    ];
    let mut svgs = HashSet::new();
    for (src, expected_notation) in sources {
        assert_eq!(detect_type(src), Some(DiagramType::Railroad));
        assert!(supports(src));
        let parsed = parse(src, &ParseOptions::default()).unwrap();
        match parsed.model {
            ParsedModel::Railroad(m) => {
                assert_eq!(m.notation, expected_notation);
                assert_eq!(
                    m.rules,
                    vec![RailroadRule {
                        name: "r".to_string(),
                        definition: RailroadNode::Terminal("a".to_string()),
                    }]
                );
            }
            other => panic!("expected Railroad, got {other:?}"),
        }
        let r = render(src, &css_options()).unwrap();
        assert_eq!(r.diagram_type, DiagramType::Railroad);
        assert!(r.svg.contains(r#"class="pele pele-railroad""#));
        assert_eq!(r.svg.matches(r#"class="pele-node pele-terminal""#).count(), 1);
        svgs.insert(r.svg);

        let light = render(src, &resolved_options()).unwrap();
        assert_inert_resolved(&light.svg, src);
        assert_resvg_parses(&light.svg, src);
        let dark = render(src, &dark_options()).unwrap();
        assert_inert_resolved(&dark.svg, src);
        assert_resvg_parses(&dark.svg, src);
    }
    assert_eq!(svgs.len(), 1);

    // Case-insensitive detect, case-sensitive parse rejection
    assert_eq!(detect_type("Railroad-EBNF-Beta\nr = \"a\" ;"), Some(DiagramType::Railroad));
    assert!(render("Railroad-EBNF-Beta\nr = \"a\" ;", &css_options()).is_err());
    assert!(
        render("RAILROAD-BETA\nr = terminal(\"a\") ;", &css_options())
            .unwrap_err()
            .message
            .contains("railroad-beta")
    );

    // Rule headings, markers, tracks
    let multi = ebnf("first = \"a\" b ;\nsecond = c ;", &css_options());
    assert_eq!(multi.svg.matches(r#"<g class="pele-rule""#).count(), 2);
    assert!(multi.svg.contains(r#"<g class="pele-rule" data-id="first">"#));
    assert!(
        Regex::new(r#"<text class="pele-rule-name"[^>]*font-weight="var\(--_hw\)"[^>]*>first</text>"#)
            .unwrap()
            .is_match(&multi.svg)
    );
    assert_eq!(multi.svg.matches(r#"class="pele-marker pele-start""#).count(), 2);
    assert_eq!(multi.svg.matches(r#"class="pele-marker pele-end""#).count(), 2);
    assert_eq!(multi.svg.matches(r#"class="pele-edge pele-track""#).count(), 2);

    // Terminal pill vs nonterminal box
    let tn = ebnf("r = \"lit\" name ;", &css_options());
    let tn_rects = rects(&tn.svg);
    assert!(
        Regex::new(r#"<g class="pele-node pele-terminal"><rect[^>]* rx="15" fill="var\(--_s\)""#)
            .unwrap()
            .is_match(&tn.svg)
    );
    assert!(
        Regex::new(r#"<g class="pele-node pele-nonterminal" data-id="name"><rect[^>]* fill="var\(--_bg\)"[^>]* style="rx:var\(--_r\)""#)
            .unwrap()
            .is_match(&tn.svg)
    );
    assert!(tn.svg.contains(r#"font-family="var(--_fm)">lit</text>"#));
    assert_eq!(tn_rects[0].h, 30.0);
    assert!(tn_rects[1].x > tn_rects[0].x + tn_rects[0].w);
    assert_eq!(tn_rects[1].y, tn_rects[0].y);

    // Choice stacking and quarter-turn arcs
    let one = ebnf("r = a ;", &css_options());
    let ch = ebnf("r = a | bb | \"c\" ;", &css_options());
    let ch_rects = rects(&ch.svg);
    assert_eq!(ch_rects[0].y, rects(&one.svg)[0].y);
    assert!(ch_rects[1].y >= ch_rects[0].y + ch_rects[0].h);
    assert!(ch_rects[2].y >= ch_rects[1].y + ch_rects[1].h);
    assert!(((ch_rects[0].x + ch_rects[0].w / 2.0) - (ch_rects[1].x + ch_rects[1].w / 2.0)).abs() < 1e-6);
    assert!(ch.height > one.height);
    assert_eq!(ch.svg.matches("a10,10 0 0 1 10,10").count(), 1);
    assert_eq!(ch.svg.matches("a10,10 0 0 0 10,10").count(), 2);

    // Optional
    let opt = ebnf("r = [ a ] ;", &css_options());
    assert_eq!(opt.svg, ebnf("r = a? ;", &css_options()).svg);
    assert_eq!(opt.width, one.width + 40.0);
    assert!(opt.height > one.height);
    assert!(rects(&opt.svg)[0].y > rects(&one.svg)[0].y);
    assert!(!opt.svg.contains(r#"class="pele-marker" d="#));

    // Repetitions
    let more = ebnf("r = a+ ;", &css_options());
    let any = ebnf("r = a* ;", &css_options());
    assert_eq!(more.width, one.width + 20.0);
    assert_eq!(rects(&more.svg)[0].y, rects(&one.svg)[0].y);
    assert!(more.height > one.height);
    assert_eq!(more.svg.matches(r#"class="pele-marker" d="M"#).count(), 1);
    assert_eq!(any.svg, ebnf("r = { a } ;", &css_options()).svg);
    assert_eq!(any.width, more.width + 40.0);
    assert!(rects(&any.svg)[0].y > rects(&more.svg)[0].y);

    // ABNF repeat counts
    let abnf = |rule: &str| render(&format!("railroad-abnf-beta\n{rule}"), &css_options()).unwrap().svg;
    assert!(abnf("r = 3a ;").contains(">3×<"));
    assert!(abnf("r = 2*4a ;").contains(">2–4×<"));
    assert!(abnf("r = 2*a ;").contains(">≥2×<"));
    assert!(abnf("r = *5a ;").contains(">≤5×<"));
    assert!(abnf(&format!("r = {}a ;", "9".repeat(400))).contains(">∞×<"));
    assert!(!abnf("r = *a ;").contains("pele-count"));
    assert!(!abnf("r = 1*a ;").contains("pele-count"));
    assert_eq!(abnf("r = 1a ;"), abnf("r = a ;"));
    assert_eq!(abnf("r = 0*1a ;"), abnf("r = [ a ] ;"));

    // Special sequences, EBNF exceptions, PEG predicates
    let special = ebnf("r = ? any character ? ;", &css_options()).svg;
    assert!(
        Regex::new(r#"<g class="pele-node pele-special"><rect[^>]* stroke-dasharray="4 3""#)
            .unwrap()
            .is_match(&special)
    );
    assert!(special.contains(r#"<tspan fill="var(--_m)">? </tspan>any character<tspan fill="var(--_m)"> ?</tspan>"#));
    let exc = ebnf("r = letter - \"x\" ;", &css_options()).svg;
    assert_eq!(exc.matches("pele-terminal").count(), 2);
    assert!(exc.contains(">-</text>"));
    let peg = render("railroad-peg-beta\nR <- !Keyword &\"k\" . !( a b ) ;", &css_options()).unwrap().svg;
    assert_eq!(peg.matches("pele-special").count(), 4);
    assert!(peg.contains(">!Keyword<"));
    assert!(peg.contains(">&amp;&quot;k&quot;<"));
    assert!(peg.contains(">.<"));
    assert!(peg.contains(">!(...)<"));

    // Text as written
    let lit = render(
        "railroad-beta\nr = sequence(terminal(\"<br>\"), terminal(\"*a*\"), terminal(\"#35;\"), terminal(\"&lt;\"), terminal(\" \"), terminal(\"a  b\"), terminal(\"\\n\\t\"), nonterminal(\"fa:fa-user\")) ;",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(lit.contains(">&lt;br&gt;</text>"));
    assert!(lit.contains(">*a*</text>"));
    assert!(lit.contains(">#</text>"));
    assert!(lit.contains(">&amp;lt;</text>"));
    assert!(lit.contains(">␣</text>"));
    assert!(lit.contains(r#" xml:space="preserve" font-family="var(--_fm)">a  b</text>"#));
    assert!(lit.contains(">\\n\\t</text>"));
    assert!(lit.contains(">fa:fa-user</text>"));

    // Rule names starting with "title"
    for src in [
        "railroad-beta\ntitles = nonterminal(\"title-x\") ;\ntitle-x = terminal(\"a\") ;",
        "railroad-ebnf-beta\ntitles = title-x ;\ntitle-x = \"a\" ;",
        "railroad-abnf-beta\ntitles = title-x ;\ntitle-x = \"a\" ;",
        "railroad-peg-beta\ntitles <- title-x ;\ntitle-x <- \"a\" ;",
    ] {
        let m = parse(src, &ParseOptions::default()).unwrap();
        if let ParsedModel::Railroad(rr) = m.model {
            let names: Vec<&str> = rr.rules.iter().map(|r| r.name.as_str()).collect();
            assert_eq!(names, vec!["titles", "title-x"], "src={src}");
        }
        assert!(render(src, &css_options()).unwrap().svg.contains(r#"data-id="title-x""#));
    }

    // Titles & accTitle/accDescr
    let qt = ebnf("title \"Quoted \\\"title\\\"\"\nr = a ;", &css_options()).svg;
    assert!(qt.contains(r#"class="pele-title" font-weight="var(--_tw)""#));
    assert!(qt.contains(">Quoted &quot;title&quot;<"));
    assert!(
        render("---\ntitle: From front matter\n---\nrailroad-peg-beta\nR <- a ;", &css_options())
            .unwrap()
            .svg
            .contains(">From front matter<")
    );
    let own = render("---\ntitle: From front matter\n---\nrailroad-abnf-beta\ntitle Own\nr = a ;", &css_options())
        .unwrap()
        .svg;
    assert!(own.contains(">Own<") && !own.contains("From front matter"));
    assert!(!ebnf("r = a ;", &css_options()).svg.contains("pele-title"));

    let acc = ebnf("accTitle: Grammar\naccDescr {\n  Two\n  lines\n}\nr = a ;", &css_options()).svg;
    assert!(acc.contains(r#"<title id="pele-title">Grammar</title>"#));
    assert!(acc.contains("<desc id=\"pele-desc\">Two\nlines</desc>"));

    // Railroad config keys
    let cfg_src = "railroad-ebnf-beta\nr = a ( b | c )* [ d ] ;\ns = e ;";
    let with_cfg = |block: &str| render(&format!("---\nconfig:\n  railroad:\n{block}\n---\n{cfg_src}"), &css_options()).unwrap();
    let plain = render(cfg_src, &css_options()).unwrap();
    assert!(with_cfg("    arcRadius: 20").width > plain.width);
    assert!(with_cfg("    arcRadius: 20").svg.contains("a20,20 0 0 1 20,20"));
    assert!(with_cfg("    padding: 20").width > plain.width);
    assert!(with_cfg("    padding: 20").height > plain.height);
    assert_eq!(with_cfg("    horizontalSeparation: 40").width, plain.width + 48.0);
    assert_eq!(with_cfg("    horizontalSeparation: 40").height, plain.height);
    assert!(with_cfg("    verticalSeparation: 30").height > plain.height);
    assert_eq!(with_cfg("    verticalSeparation: 30").width, plain.width);
    assert!(
        with_cfg("    fontSize: 20")
            .svg
            .contains(r#"<g class="pele-rules" transform="translate(0.5,0.5)" font-size="20""#)
    );
    assert!(with_cfg("    fontSize: 20").width > plain.width);
    assert!(with_cfg("    strokeWidth: 2").svg.contains(r#"stroke="var(--_l)" stroke-width="2""#));
    assert!(!plain.svg.contains("stroke-width"));
    assert!(with_cfg("    markerRadius: 8").svg.contains(r#"r="8""#));
    assert!(!with_cfg("    showMarkers: false").svg.contains("<circle"));
    assert_eq!(with_cfg("    showMarkers: false").width, plain.width - 16.0);
    assert_eq!(with_cfg("    arcRadius: wide\n    padding: -4\n    fontSize: \"x\"").svg, plain.svg);
    let direct_cfg = render(
        cfg_src,
        &RenderOptions {
            config: Some(railroad_config(&[("arcRadius", YamlValue::Number(20.0))])),
            ..css_options()
        },
    )
    .unwrap();
    assert_eq!(direct_cfg.svg, with_cfg("    arcRadius: 20").svg);

    // Duplicate rule name, empty grammar, responsive & fontSize, max_width folding
    let dup = ebnf("r = a ;\nr = b ;", &css_options());
    assert_eq!(dup.svg.matches(r#"<g class="pele-rule" data-id="r">"#).count(), 2);
    if let ParsedModel::Railroad(rr) = parse("railroad-ebnf-beta\nr = a ;\nr = b ;", &ParseOptions::default()).unwrap().model {
        assert_eq!(
            rr.rules.into_iter().map(|r| r.definition).collect::<Vec<_>>(),
            vec![RailroadNode::NonTerminal("a".to_string()), RailroadNode::NonTerminal("b".to_string())]
        );
    }
    let empty = render("railroad-beta", &css_options()).unwrap();
    assert!(empty.svg.contains("<svg") && !empty.svg.contains("pele-rule"));
    assert!(
        render("railroad-ebnf-beta\ntitle Only a title", &css_options())
            .unwrap()
            .svg
            .contains(">Only a title<")
    );

    let scale_src = "railroad-ebnf-beta\nr = a ( b | \"c\" )+ ;";
    assert_eq!(render(scale_src, &css_options()).unwrap().svg, render(scale_src, &css_options()).unwrap().svg);
    assert!(
        render(
            scale_src,
            &RenderOptions {
                font_size: Some(24.0),
                ..css_options()
            }
        )
        .unwrap()
        .width
            > render(scale_src, &css_options()).unwrap().width
    );
    assert!(render(scale_src, &css_options()).unwrap().svg.contains("max-width:100%;height:auto;"));
    assert!(
        !render(
            scale_src,
            &RenderOptions {
                responsive: Some(false),
                ..css_options()
            }
        )
        .unwrap()
        .svg
        .contains("max-width")
    );

    let folded = ebnf(
        "r = alpha beta gamma delta epsilon zeta ;",
        &RenderOptions {
            max_width: Some(260.0),
            ..resolved_options()
        },
    );
    assert_inert_resolved(&folded.svg, "railroad folded");
    assert_resvg_parses(&folded.svg, "railroad folded");
    assert_tidy(&folded.svg, folded.width, folded.height, "railroad folded");
}

#[test]
fn railroad_keeps_every_box_apart_and_inside_the_drawing_across_corpus_generated_and_configs() {
    let corpus = load_fixture("railroad-corpus.json");
    assert!(corpus.len() >= 80);

    let mut drawn = 0usize;
    for src in &corpus {
        if let Ok(r) = render(src, &css_options()) {
            assert_tidy(&r.svg, r.width, r.height, src);
            drawn += 1;
        }
    }
    for notation in [Notation::Railroad, Notation::Ebnf, Notation::Abnf, Notation::Peg] {
        let mut rnd = Lcg::new(11);
        for _ in 0..80 {
            let src = gen_grammar(notation, &mut rnd);
            if let Ok(r) = render(&src, &css_options()) {
                assert_tidy(&r.svg, r.width, r.height, &src);
                drawn += 1;
            }
        }
    }
    assert!(drawn > 300, "drawn={drawn}");

    let cfg_src = "railroad-ebnf-beta\ntitle T\nr = a ( b | [ c d ] | { e | f } )+ g? ;\ns = ( ( a+ )+ | b* )* - \"x\" ;";
    let configs = [
        vec![("arcRadius", YamlValue::Number(0.0))],
        vec![("arcRadius", YamlValue::Number(40.0)), ("verticalSeparation", YamlValue::Number(0.0))],
        vec![
            ("padding", YamlValue::Number(0.0)),
            ("horizontalSeparation", YamlValue::Number(0.0)),
            ("verticalSeparation", YamlValue::Number(0.0)),
        ],
        vec![
            ("arcRadius", YamlValue::Number(7.5)),
            ("padding", YamlValue::Number(3.3)),
            ("verticalSeparation", YamlValue::Number(2.5)),
            ("horizontalSeparation", YamlValue::Number(1.5)),
            ("fontSize", YamlValue::Number(9.5)),
        ],
        vec![
            ("arcRadius", YamlValue::Number(1e9)),
            ("padding", YamlValue::Number(1e9)),
            ("fontSize", YamlValue::Number(1e9)),
            ("markerRadius", YamlValue::Number(1e9)),
            ("strokeWidth", YamlValue::Number(1e9)),
        ],
        vec![
            ("arcRadius", YamlValue::Number(f64::INFINITY)),
            ("padding", YamlValue::Number(f64::NAN)),
            ("fontSize", YamlValue::Number(-1.0)),
            ("showMarkers", YamlValue::String("no".to_string())),
            ("markerRadius", YamlValue::Null),
        ],
    ];
    for (i, entries) in configs.iter().enumerate() {
        let cfg = railroad_config(entries);
        let r = render(
            cfg_src,
            &RenderOptions {
                config: Some(cfg.clone()),
                ..css_options()
            },
        )
        .unwrap();
        assert_tidy(&r.svg, r.width, r.height, &format!("unusual config #{i}"));
        let rr = render(
            cfg_src,
            &RenderOptions {
                config: Some(cfg),
                ..resolved_options()
            },
        )
        .unwrap();
        assert_inert_resolved(&rr.svg, &format!("unusual config #{i} resolved"));
        assert_resvg_parses(&rr.svg, &format!("unusual config #{i} resolved"));
    }
}

#[test]
fn railroad_is_inert_for_corpus_hostile_and_mutated_inputs() {
    let corpus = load_fixture("railroad-corpus.json");
    for src in &corpus {
        check_both(src, css_options(), resolved_options());
    }

    let mut rendered = 0usize;
    for &p in PAYLOADS {
        let q = p.replace('\\', "\\\\").replace('"', "\\\"");
        let sq = p.replace('\\', "\\\\").replace('\'', "\\'");
        let bare = p.replace('"', "'");
        let no_qsemi = p.replace(['?', ';'], "");
        let templates = [
            format!("railroad-beta\nr = terminal(\"{q}\") ;"),
            format!("railroad-beta\nr = terminal('{sq}') ;"),
            format!("railroad-beta\nr = nonterminal(\"{q}\") ;"),
            format!("railroad-beta\nr = special(\"{q}\") ;"),
            format!("railroad-beta\nr = sequence(terminal(\"{q}\"), choice(nonterminal(\"{q}\"), optional(special(\"{q}\")))) ;"),
            format!("railroad-beta\nr = zeroOrMore(oneOrMore(terminal(\"{q}\"))) ;"),
            format!("railroad-beta\nr = terminal(\"{p}\") ;"),
            format!("railroad-beta\n{p} = terminal(\"a\") ;"),
            format!("railroad-beta\nr = {p} ;"),
            format!("railroad-beta\nr = {p}(\"a\") ;"),
            format!("railroad-beta\ntitle {p}\nr = terminal(\"a\") ;"),
            format!("railroad-beta\ntitle \"{p}\"\nr = terminal(\"a\") ;"),
            format!("railroad-beta title {p}"),
            format!("railroad-beta\naccTitle: {p}\naccDescr: {p}\nr = terminal(\"a\") ;"),
            format!("railroad-beta\naccDescr {{\n {p}\n }}\nr = terminal(\"a\") ;"),
            format!("railroad-beta\n/* {p} */\nr = terminal(\"a\") ; %% {p}"),
            format!("railroad-beta {p}\nr = terminal(\"a\") ;"),
            format!("railroad-ebnf-beta\nr = \"{q}\" ;"),
            format!("railroad-ebnf-beta\nr = \"{p}\" ;"),
            format!("railroad-ebnf-beta\nr = ? {no_qsemi} ? ;"),
            format!("railroad-ebnf-beta\nr = ? {p} ? ;"),
            format!("railroad-ebnf-beta\nr = a - \"{q}\" | [ \"{q}\" ] | {{ ? {no_qsemi} ? }}+ ;"),
            format!("railroad-ebnf-beta\nr = {p} ;"),
            format!("railroad-ebnf-beta\n{p} ::= a ;"),
            format!("railroad-ebnf-beta\nr = a (* {p} *) b /* {p} */ ;"),
            format!("railroad-ebnf-beta\ntitle {p}\naccTitle: {p}\naccDescr {{ {p} }}\nr = a ;"),
            format!("railroad-abnf-beta\nr = \"{bare}\" ;"),
            format!("railroad-abnf-beta\nr = 2*3\"{bare}\" [ \"{bare}\" ] / *( \"{bare}\" ) ;"),
            format!("railroad-abnf-beta\nr = \"{p}\" ;"),
            format!("railroad-abnf-beta\nr = {p} ;"),
            format!("railroad-abnf-beta\nr = %x{p} ;"),
            format!("railroad-abnf-beta\nr = {p}*{p}a ;"),
            format!("railroad-abnf-beta\n{p} = a ;"),
            format!("railroad-abnf-beta\nr = a ; {p}\n ;\n"),
            format!("railroad-abnf-beta\ntitle \"{p}\"\nr = a ;"),
            format!("railroad-peg-beta\nR <- \"{q}\" ;"),
            format!("railroad-peg-beta\nR <- !\"{q}\" &'x' ( \"{q}\" )* . ;"),
            format!("railroad-peg-beta\nR <- \"{p}\" ;"),
            format!("railroad-peg-beta\nR <- {p} ;"),
            format!("railroad-peg-beta\nR <- !{p} ;"),
            format!("railroad-peg-beta\n{p} <- a ;"),
            format!("railroad-peg-beta\nR <- a # {p}\n ;"),
            format!("railroad-peg-beta\ntitle {p}\naccDescr: {p}\nR <- a ;"),
            format!("---\ntitle: \"{q}\"\n---\nrailroad-ebnf-beta\nr = a ;"),
            format!("---\ntitle: {p}\n---\nrailroad-ebnf-beta\nr = a ;"),
            format!(
                "---\nconfig:\n  railroad:\n    arcRadius: \"{q}\"\n    padding: \"{q}\"\n    fontSize: \"{q}\"\n    fontFamily: \"{q}\"\n    terminalFill: \"{q}\"\n    lineColor: \"{q}\"\n    strokeWidth: \"{q}\"\n    showMarkers: \"{q}\"\n    markerRadius: \"{q}\"\n---\nrailroad-ebnf-beta\nr = a \"b\" ? c ? ;"
            ),
            format!(
                "%%{{init: {{\"railroad\": {{\"arcRadius\": \"{q}\", \"strokeWidth\": \"{q}\"}}, \"themeVariables\": {{\"fontFamily\": \"{q}\"}}}}}}%%\nrailroad-ebnf-beta\nr = a+ ;"
            ),
        ];
        for src in templates {
            if check_both(&src, css_options(), resolved_options()) {
                rendered += 1;
            }
        }
    }
    assert!(rendered > 700, "rendered={rendered}");

    // Escaping check
    let esc_svg = render(
        "railroad-beta\ntitle <b onclick=alert(1)>T</b>\nr = sequence(terminal(\"<img src=x onerror=alert(1)>\"), nonterminal(\"\\\"><script>alert(1)</script>\"), special(\"</text></g></svg><script>a&b</script>\")) ;",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_inert(&esc_svg, "railroad escape");
    assert!(!esc_svg.contains("<img") && !esc_svg.contains("<script") && !esc_svg.contains("onclick"));
    assert!(esc_svg.contains("&lt;img src=x onerror=alert(1)&gt;"));
    assert!(esc_svg.contains(r#"data-id="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;""#));
    assert!(esc_svg.contains("a&amp;b"));

    // Hostile option values
    let opt_src = "railroad-ebnf-beta\naccTitle: t\naccDescr: d\nr = a \"b\" ? c ? - d* ;";
    for &p in PAYLOADS {
        let mut css = css_options();
        css.id_prefix = Some(p.to_string());
        css.font_family = Some(p.to_string());
        let mut res = resolved_options();
        res.id_prefix = Some(p.to_string());
        res.font_family = Some(p.to_string());
        assert!(check_both(opt_src, css, res));

        let cfg = railroad_config(&[
            ("arcRadius", YamlValue::String(p.to_string())),
            ("padding", YamlValue::String(p.to_string())),
            ("fontSize", YamlValue::String(p.to_string())),
            ("strokeWidth", YamlValue::String(p.to_string())),
            ("markerRadius", YamlValue::String(p.to_string())),
            ("showMarkers", YamlValue::String(p.to_string())),
        ]);
        let css_c = RenderOptions {
            config: Some(cfg.clone()),
            ..css_options()
        };
        let res_c = RenderOptions {
            config: Some(cfg),
            ..resolved_options()
        };
        assert!(check_both(opt_src, css_c, res_c));
    }

    // Mutated and generated fuzz inputs (2,000 samples across all 4 notations)
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&[
        "railroad-beta",
        "railroad-ebnf-beta",
        "railroad-abnf-beta",
        "railroad-peg-beta",
        "terminal(",
        "nonterminal(",
        "special(",
        "sequence(",
        "choice(",
        "optional(",
        "oneOrMore(",
        "zeroOrMore(",
        "::=",
        "<-",
        "|",
        "/",
        "[",
        "]",
        "{",
        "}",
        "(",
        ")",
        "?",
        "*",
        "+",
        " - ",
        "? x ?",
        "(*",
        "*)",
        "/*",
        "*/",
        ";",
        "#",
        "&",
        "!",
        ".",
        "%x41",
        "2*4",
        "title ",
        "accDescr {",
        "\n",
    ]);
    let mut mutator = Mutator::new(&corpus, frags.clone(), 3);
    let mut rnd = Lcg::new(7);
    let notations = [Notation::Railroad, Notation::Ebnf, Notation::Abnf, Notation::Peg];
    for i in 0..2000 {
        let src = if i % 2 == 0 {
            mutator.next_sample()
        } else {
            let g = [gen_grammar(notations[i % 4], &mut rnd)];
            let mut m = Mutator::new(&g, frags.clone(), (i as u32).wrapping_add(13));
            m.next_sample()
        };
        if src.len() <= 4000 {
            check_both(&src, css_options(), resolved_options());
        }
    }
}

#[test]
fn railroad_stays_fast_on_stress_inputs_and_enforces_default_limit() {
    const N: usize = 50_000;
    const IR: &str = "railroad-beta\n";
    const EBNF: &str = "railroad-ebnf-beta\n";
    const ABNF: &str = "railroad-abnf-beta\n";
    const PEG: &str = "railroad-peg-beta\n";

    let big_parse = ParseOptions {
        limit: Some(usize::MAX),
        ..ParseOptions::default()
    };
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };

    let parse_cases = [
        format!("{EBNF}r = ?{}", " a".repeat(N / 2)),
        format!("{EBNF}r = {}", "?  ".repeat(N / 3)),
        format!("{EBNF}{}", format!("? {};", "a ".repeat(50)).repeat(N / 103)),
        format!("{EBNF}r = {}", "(* a ".repeat(N / 5)),
        format!("{EBNF}r = {}", "(*)".repeat(N / 3)),
        format!("{IR}{}", "/* a ".repeat(N / 5)),
        format!("{EBNF}{}", "/**/(**)".repeat(N / 8)),
        format!("{EBNF}{}", "accDescr { ".repeat(N / 11)),
        format!("{EBNF}{}", format!("accDescr{}", " ".repeat(92)).repeat(N / 100)),
        format!("{IR}{}", format!("accDescr: {}\n", "% ".repeat(45)).repeat(N / 101)),
        format!("{PEG}{}", format!("accTitle{}", " ".repeat(42)).repeat(N / 50)),
        format!("{IR}title {}", "a % ".repeat(N / 4)),
        format!("{ABNF}{}", "title ".repeat(N / 6)),
        format!("{IR}{}", "titlea".repeat(N / 6)),
        format!("{IR}r = terminal(\"{}", "a\\\"".repeat(N / 3)),
        format!("{PEG}R <- '{}'", "\\\\".repeat(N / 2)),
        format!("{ABNF}r = \"{}", "a ".repeat(N / 2)),
        format!("{EBNF}r = a {}", "---\n".repeat(N / 4)),
        format!("{IR}{}", "%%{ a ".repeat(N / 6)),
        format!("{EBNF}r = a {}", "-".repeat(N)),
        format!("{ABNF}r = {}a ;", "1".repeat(N)),
        format!("{ABNF}r = {}", "12*34 ".repeat(N / 6)),
        format!("{ABNF}r = %x{} ;", "41.".repeat(N / 3)),
        format!("{ABNF}{}", "; a comment\n".repeat(N / 12)),
        format!("{PEG}{}", "# a comment\n".repeat(N / 12)),
        format!("{IR}{}", "terminal".repeat(N / 8)),
        format!("{EBNF}r = {}", "([{".repeat(N / 3)),
        format!("{IR}r = {}", "choice(".repeat(N / 7)),
        format!("{PEG}R <- {}a ;", "!&".repeat(N / 2)),
    ];
    for (i, src) in parse_cases.iter().enumerate() {
        let started = Instant::now();
        let _ = parse(src, &big_parse);
        assert!(started.elapsed().as_millis() < 3000, "slow railroad parse #{i}: {:?}", started.elapsed());
    }

    let choice_12k: String = (0..12_000).map(|i| format!("a{i} | ")).collect();
    let rules_5k: String = (0..5_000).map(|i| format!("r{i} = a ;\n")).collect();
    let render_cases = [
        format!("{EBNF}{} = {} ;", "a".repeat(N), "b".repeat(N)),
        format!("{EBNF}r = \"{}\" ;", "word ".repeat(N / 5)),
        format!("{EBNF}r = \"{}\" ;", "#35;&amp;<br>*_".repeat(N / 15)),
        format!("{PEG}R <- \"{}\" ;", "\\n\\t\\\\".repeat(N / 6)),
        format!("{EBNF}r = {}a{} ;", "(".repeat(N / 2), ")".repeat(N / 2)),
        format!("{EBNF}r = {}a{} ;", "[".repeat(12_000), "]".repeat(12_000)),
        format!("{EBNF}r = {}a{} ;", "{".repeat(12_000), "}".repeat(12_000)),
        format!("{EBNF}r = a{} ;", "*+?".repeat(N / 3)),
        format!("{EBNF}r = a{} ;", " - b".repeat(12_000)),
        format!("{EBNF}r = a{}{} ;", " - ( b".repeat(8_000), " )".repeat(8_000)),
        format!("{EBNF}r = {choice_12k}z ;"),
        format!("{EBNF}r = {};", "a ".repeat(12_000)),
        format!("{EBNF}r = {}b{} ;", "( a | ".repeat(5_000), " )".repeat(5_000)),
        format!("{EBNF}{rules_5k}"),
        format!("{EBNF}{}", "r = a | b ;\n".repeat(5_000)),
        format!("{IR}r = {}terminal(\"a\"){} ;", "optional(oneOrMore(".repeat(2_500), "))".repeat(2_500)),
        format!("{IR}r = {}terminal(\"a\"){} ;", "sequence(".repeat(6_000), ")".repeat(6_000)),
        format!("{IR}r = choice({}special(\"b\")) ;", "terminal(\"a\"),".repeat(6_000)),
        format!("{ABNF}r = {}a{} ;", "2*3( ".repeat(10_000), " )".repeat(10_000)),
        format!("{ABNF}r = {}a{} ;", "[".repeat(12_000), "]".repeat(12_000)),
        format!("{ABNF}r = {}*{}a {}b ;", "9".repeat(400), "9".repeat(400), "9".repeat(400)),
        format!("{ABNF}r = {}b ;", "a / ".repeat(12_000)),
        format!("{PEG}R <- {}a{} ;", "!( &( ".repeat(5_000), " ) )".repeat(5_000)),
        format!("{PEG}R <- {}a{} ;", "( ".repeat(10_000), " )*".repeat(10_000)),
        format!("{PEG}R <- {};", "!a &\"b\" ".repeat(6_000)),
    ];
    for (i, src) in render_cases.iter().enumerate() {
        let started = Instant::now();
        let _ = render(src, &big);
        assert!(started.elapsed().as_millis() < 3000, "slow railroad render #{i}: {:?}", started.elapsed());
    }

    let over = render(&format!("{EBNF}{}", "r = a | b ;\n".repeat(5_000)), &css_options()).unwrap_err();
    assert!(over.message.contains("limit of 50000"));
}
