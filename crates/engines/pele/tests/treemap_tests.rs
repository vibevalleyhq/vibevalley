use std::collections::{HashMap, HashSet};
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::treemap::format::ValueFormatter;
use vibevalley_pele::diagram::treemap::layout::{BoxNode, Insets, layout_treemap};
use vibevalley_pele::diagram::treemap::model::TreemapNode;
use vibevalley_pele::diagram::treemap::parser::parse_treemap;
use vibevalley_pele::{METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, TextMeasurer, TextStyle, parse, render, supports};

use crate::support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

const BASIC: &str = "treemap-beta\n\"Category A\"\n    \"Item A1\": 10\n    \"Item A2\": 20\n\"Category B\"\n    \"Item B1\": 15\n    \"Item B2\": 25\n";
const BUDGET: &str = "treemap-beta\n\"Budget\"\n    \"Operations\"\n        \"Salaries\": 700000\n        \"Equipment\": 200000\n        \"Supplies\": 100000\n    \"Marketing\"\n        \"Advertising\": 400000\n        \"Events\": 100000";

fn config(treemap: &str, body: &str) -> String {
    format!("---\nconfig:\n  treemap:\n{treemap}\n---\n{body}")
}

fn leaf(name: &str, value: f64) -> TreemapNode {
    TreemapNode {
        name: name.to_string(),
        children: None,
        value: Some(value),
        class_selector: None,
        css_compiled_styles: None,
    }
}

fn section(name: &str, children: Vec<TreemapNode>) -> TreemapNode {
    TreemapNode {
        name: name.to_string(),
        children: Some(children),
        value: None,
        class_selector: None,
        css_compiled_styles: None,
    }
}

fn overlap(a: &BoxNode<'_>, b: &BoxNode<'_>) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

struct RectInfo {
    id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    attrs: HashMap<String, String>,
}

fn rects(svg: &str) -> Vec<RectInfo> {
    let doc = roxmltree::Document::parse(svg).unwrap();
    let mut out = Vec::new();
    let mut id = String::new();
    for node in doc.descendants().filter(|n| n.is_element()) {
        if node.tag_name().name() == "g"
            && let Some(did) = node.attribute("data-id")
        {
            id = did.to_string();
        }
        if node.tag_name().name() == "rect" {
            let mut attrs = HashMap::new();
            for a in node.attributes() {
                attrs.insert(a.name().to_string(), a.value().to_string());
            }
            out.push(RectInfo {
                id: id.clone(),
                x: attrs["x"].parse().unwrap(),
                y: attrs["y"].parse().unwrap(),
                w: attrs["width"].parse().unwrap(),
                h: attrs["height"].parse().unwrap(),
                attrs,
            });
        }
    }
    out
}

fn smallest_gap(boxes: &[&RectInfo]) -> f64 {
    let mut least = f64::INFINITY;
    for a in boxes {
        for b in boxes {
            if a.w.min(a.h).min(b.w).min(b.h) < 8.0 {
                continue;
            }
            if a.y < b.y + b.h && b.y < a.y + a.h && b.x >= a.x + a.w {
                least = least.min(b.x - a.x - a.w);
            }
            if a.x < b.x + b.w && b.x < a.x + a.w && b.y >= a.y + a.h {
                least = least.min(b.y - a.y - a.h);
            }
        }
    }
    least
}

fn deep_tree() -> String {
    let mut src = String::from("treemap\n");
    for i in 0..6 {
        src.push_str(&format!("\"top {i}\"\n"));
        for j in 0..8 {
            src.push_str(&format!("  \"mid {i}.{j}\"\n    \"inner {i}.{j}\"\n"));
            for k in 0..8 {
                let v = 1usize + ((i * 64 + j * 8 + k) % 37usize).pow(3);
                src.push_str(&format!("      \"leaf {i}.{j}.{k}\": {v}\n"));
            }
        }
    }
    src
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
fn treemap_layout_and_value_format_match_upstream() {
    let insets = Insets {
        gap: 4.0,
        header: 28.0,
        short: 18.0,
        side: 6.0,
    };

    // Proportional areas and zero overlap
    let nodes: Vec<TreemapNode> = [40.0, 30.0, 20.0, 8.0, 2.0]
        .iter()
        .enumerate()
        .map(|(i, &v)| leaf(&format!("n{i}"), v))
        .collect();
    let lay = layout_treemap(&nodes, 1000.0, 600.0, Insets { gap: 0.0, ..insets });
    assert_eq!(lay.placed.len(), 5);
    for &id in &lay.placed {
        let b = &lay.boxes[id];
        assert!(((b.w * b.h) / 600_000.0 - b.value / 100.0).abs() < 0.01);
        for &other in &lay.placed {
            if id != other {
                assert!(!overlap(b, &lay.boxes[other]));
            }
        }
    }

    // Aspect ratios close to square
    let sq_nodes: Vec<TreemapNode> = (0..40).map(|i| leaf(&format!("n{i}"), (1 + (i % 7)) as f64)).collect();
    let sq = layout_treemap(&sq_nodes, 800.0, 500.0, Insets { gap: 0.0, ..insets });
    let ratios: Vec<f64> = sq
        .placed
        .iter()
        .map(|&id| {
            let b = &sq.boxes[id];
            (b.w / b.h).max(b.h / b.w)
        })
        .collect();
    let avg: f64 = ratios.iter().sum::<f64>() / (ratios.len() as f64);
    assert!(avg < 1.6 && ratios.iter().copied().fold(0.0f64, f64::max) < 4.0);

    // Gap between siblings
    let pair_nodes = [leaf("a", 1.0), leaf("b", 1.0)];
    let pair = layout_treemap(&pair_nodes, 400.0, 200.0, Insets { gap: 10.0, ..insets });
    let mut pb: Vec<&BoxNode<'_>> = pair.placed.iter().map(|&id| &pair.boxes[id]).collect();
    pb.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    assert_eq!((pb[0].x, pb[0].y, pb[0].h), (0.0, 0.0, 200.0));
    assert_eq!(pb[1].x + pb[1].w, 400.0);
    assert_eq!(pb[1].x - (pb[0].x + pb[0].w), 10.0);

    // Nested sections under header + headerless small section
    let tree = vec![
        section("s", vec![leaf("a", 3.0), section("t", vec![leaf("b", 1.0), leaf("c", 1.0)])]),
        leaf("d", 2.0),
    ];
    let nested = layout_treemap(&tree, 600.0, 400.0, insets);
    let mut names: Vec<&str> = nested.placed.iter().map(|&id| nested.boxes[id].node.name.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["a", "b", "c", "d", "s", "t"]);
    for &id in &nested.placed {
        let b = &nested.boxes[id];
        if let Some(pid) = b.parent {
            let p = &nested.boxes[pid];
            assert!(b.x >= p.x + insets.side);
            assert!(b.y >= p.y + insets.header);
            assert!(b.x + b.w <= p.x + p.w - insets.side);
            assert!(b.y + b.h <= p.y + p.h - insets.side);
        }
    }

    let small_tree = vec![section("s", vec![leaf("a", 2.0), section("t", vec![leaf("b", 1.0), leaf("c", 1.0)])])];
    let small_lay = layout_treemap(&small_tree, 300.0, 30.0, insets);
    let s_box = small_lay.placed.iter().map(|&id| &small_lay.boxes[id]).find(|b| b.node.name == "s").unwrap();
    assert!(!s_box.headed);

    // Non-positive values omitted
    let mixed = vec![
        leaf("a", 1.0),
        leaf("zero", 0.0),
        leaf("neg", -5.0),
        leaf("nan", f64::NAN),
        section("empty", vec![]),
    ];
    let ml = layout_treemap(&mixed, 100.0, 100.0, insets);
    assert_eq!(ml.placed.len(), 1);
    assert_eq!(ml.boxes[ml.placed[0]].node.name, "a");
    assert!(layout_treemap(&[], 100.0, 100.0, insets).placed.is_empty());
    assert!(
        layout_treemap(&[leaf("huge", 1e308), leaf("also", 1e308)], 100.0, 100.0, insets)
            .placed
            .is_empty()
    );

    // Value formatters
    assert_eq!(ValueFormatter::from_spec(",").format(1_234_567.5), "1,234,567.5");
    assert_eq!(ValueFormatter::from_spec(",").format(0.35), "0.35");
    assert_eq!(ValueFormatter::from_spec("$").format(1234.0), "$1234");
    assert_eq!(ValueFormatter::from_spec(".1f").format(12.0), "12.0");
    assert_eq!(ValueFormatter::from_spec(".1%").format(0.357), "35.7%");
    assert_eq!(ValueFormatter::from_spec("$0,0").format(700_000.0), "$700,000");
    assert_eq!(ValueFormatter::from_spec("$.2f").format(5.0), "$5.00");
    assert_eq!(ValueFormatter::from_spec("$,.2f").format(1234.5), "$1,234.50");
    assert_eq!(ValueFormatter::from_spec("$.1%").format(0.25), "$25.0%");
    assert_eq!(ValueFormatter::from_spec("d").format(12.6), "13");
    assert_eq!(ValueFormatter::from_spec("+,").format(1000.0), "+1,000");
    assert_eq!(ValueFormatter::from_spec(".3~f").format(1.5), "1.5");
    assert_eq!(ValueFormatter::from_spec("not a format").format(1234.0), "1,234");
    assert_eq!(ValueFormatter::from_spec("").format(1234.0), "1234");
    assert_eq!(ValueFormatter::from_spec(".999f").format(1.0), format!("1.{}", "0".repeat(20)));
}

#[test]
fn treemap_renders_sections_leaves_styles_crowding_and_tooltips() {
    let res = render(BASIC, &css_options()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Treemap);
    assert!(supports("treemap\n\"a\": 1"));
    assert_eq!((res.width, res.height), (656.0, 416.0));
    assert_eq!(res.svg.matches(r#"class="pele-node pele-section""#).count(), 2);
    assert_eq!(res.svg.matches(r#"class="pele-node pele-leaf""#).count(), 4);
    assert!(res.svg.contains(r#"font-weight="var(--_hw)">Category A<"#));
    assert!(res.svg.contains(">Item B2<"));
    assert!(res.svg.contains(">25<"));
    assert!(Regex::new(r#"class="pele-value"[^>]*>40<"#).unwrap().is_match(&res.svg));

    let resolved = render(BASIC, &resolved_options()).unwrap();
    assert_inert_resolved(&resolved.svg, "treemap basic resolved");
    assert_resvg_parses(&resolved.svg, "treemap basic resolved");
    let dark = render(BASIC, &dark_options()).unwrap();
    assert_inert_resolved(&dark.svg, "treemap basic dark");
    assert_resvg_parses(&dark.svg, "treemap basic dark");

    // classDef styles & contrast ink
    let styled = render(
        "treemap\n\"S\":::frame\n  \"a\": 1:::hot\n  \"b\": 2\nclassDef hot fill:red,color:blue,stroke:#FFD600;\nclassDef frame fill:#eee,stroke-width:2px",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(styled.contains(r#"class="pele-node pele-leaf hot" data-id="a""#));
    assert!(
        Regex::new(r#"data-id="a"><rect[^>]* style="rx:var\(--_r\);fill:red;stroke:#FFD600;"/><text[^>]* style="fill:blue;">a<"#)
            .unwrap()
            .is_match(&styled)
    );

    let contrast = render(
        "treemap\n\"Section\":::frame\n  \"a\": 10:::dark\n  \"b\": 20:::own\n  \"c\": 30\nclassDef frame fill:#FFF9C4\nclassDef dark fill:navy\nclassDef own fill:navy,color:#ddd",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(contrast.contains("--pele-fg-on-light"));
    assert!(contrast.contains("--pele-fg-on-dark"));

    // Class names starting with title
    let title_cls = render("treemap\n\"S\":::titles\n  \"a\": 1:::title_2\nclassDef title_2 fill:red", &css_options())
        .unwrap()
        .svg;
    assert!(title_cls.contains(r#"class="pele-node pele-section titles""#));
    assert!(title_cls.contains(r#"class="pele-node pele-leaf title_2" data-id="a""#));

    // Money format & config options
    let money = render(
        &config(
            "    valueFormat: '$0,0'",
            "treemap\n\"Budget\"\n  \"Salaries\": 700000\n  \"Equipment\": 200000",
        ),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(money.contains(">$700,000<"));
    assert!(money.contains(">$900,000<"));
    assert!(
        !render(&config("    showValues: false", BASIC), &css_options())
            .unwrap()
            .svg
            .contains("pele-value")
    );

    // Tooltips on hidden/headerless sections
    let no_head = render(&config("    nodeHeight: 3", "treemap\n\"A & B\"\n  \"Inner\"\n    \"Leaf\": 1"), &css_options())
        .unwrap()
        .svg;
    assert!(no_head.contains("<title>A &amp; B › Inner</title>"));
    assert!(no_head.contains("<title>A &amp; B › Inner › Leaf</title>"));
    assert!(!res.svg.contains("<title>"));

    // Crowded deep tree spacing & corner capping
    let deep_svg = render(&deep_tree(), &css_options()).unwrap().svg;
    assert_eq!(deep_svg.matches(r#"class="pele-node pele-leaf""#).count(), 6 * 8 * 8);
    assert_eq!(deep_svg.matches(r#"class="pele-node pele-section""#).count(), 6 + 6 * 8 * 2);
    let deep_boxes = rects(&deep_svg);
    let top_refs: Vec<&RectInfo> = deep_boxes.iter().filter(|r| r.id.starts_with("top ")).collect();
    let mut gaps = HashSet::new();
    let tg = smallest_gap(&top_refs);
    if tg.is_finite() {
        gaps.insert(tg as i64);
    }
    assert_eq!(gaps.into_iter().collect::<Vec<_>>(), vec![2]);

    let budget_boxes = rects(&render(BUDGET, &css_options()).unwrap().svg);
    let ops = budget_boxes.iter().find(|r| r.id == "Operations").unwrap();
    let bud = budget_boxes.iter().find(|r| r.id == "Budget").unwrap();
    assert_eq!(ops.x - bud.x, 6.0);
    assert_eq!(ops.y - bud.y, 28.0);

    // Small box corner radius cap in both CSS and Resolved modes
    let cap_css = render("treemap\n\"big\": 1000\n\"small\": 4", &css_options()).unwrap().svg;
    let small_r = rects(&cap_css).into_iter().find(|r| r.id == "small").unwrap();
    assert!(small_r.attrs["style"].starts_with("rx:min(var(--_r),"));
    let cap_res = render("treemap\n\"big\": 1000\n\"small\": 4", &resolved_options()).unwrap().svg;
    assert_inert_resolved(&cap_res, "treemap small corner");
    assert_resvg_parses(&cap_res, "treemap small corner");

    // Hierarchy from indentation
    let parsed_h = parse(
        "treemap\n\"A\"\n  \"B\"\n    \"c\": 1\n  \"d\": 2\n\"E\"\n      \"f\": 3\n \"g\": 4",
        &ParseOptions::default(),
    )
    .unwrap();
    match parsed_h.model {
        ParsedModel::Treemap(m) => {
            assert_eq!(m.roots.len(), 2);
            assert_eq!(m.roots[0].name, "A");
            assert_eq!(m.roots[0].children.as_ref().unwrap().len(), 2);
            assert_eq!(m.roots[1].name, "E");
            assert_eq!(m.roots[1].children.as_ref().unwrap().len(), 2);
        }
        other => panic!("expected Treemap model, got {other:?}"),
    }

    // Empty / non-positive treemaps
    for src in ["treemap", "treemap\n\"Only a section\"", "treemap\n\"a\": 0\n\"b\": ."] {
        let r = render(src, &resolved_options()).unwrap();
        assert!(r.svg.contains("<svg") && !r.svg.contains("NaN") && !r.svg.contains("pele-node"));
        assert_resvg_parses(&r.svg, src);
    }

    // Class font-size fitting
    let sized_text = render(
        "treemap\n\"A section with a long name\":::head\n  \"A leaf with a fairly long name\": 30:::big\n  \"Another leaf with a long name\": 20:::big\n  \"rest\": 400\nclassDef big font-size:20px\nclassDef head font-size:18px",
        &css_options(),
    )
    .unwrap()
    .svg;
    let re_grp = Regex::new(r#"<g class="pele-node pele-(leaf|section) (big|head)"[^>]*>(.*?)</g>"#).unwrap();
    let re_w = Regex::new(r#"<rect[^>]* width="([\d.]+)""#).unwrap();
    let re_tx = Regex::new(r#"<text[^>]*>([^<]*)</text>"#).unwrap();
    let mut matched = 0;
    for g in re_grp.captures_iter(&sized_text) {
        matched += 1;
        let w: f64 = re_w.captures(&g[3]).unwrap()[1].parse().unwrap();
        for t in re_tx.captures_iter(&g[3]) {
            let tw = if &g[1] == "leaf" {
                METRICS_MEASURER.width(&t[1], 20.0, TextStyle::NONE)
            } else {
                METRICS_MEASURER.width(&t[1], 18.0, TextStyle::BOLD)
            };
            assert!(tw <= w - 8.0, "text {} width {tw} > {}", &t[1], w - 8.0);
        }
    }
    assert_eq!(matched, 3);
}

#[test]
fn treemap_is_inert_for_corpus_hostile_and_mutated_inputs() {
    let corpus = load_fixture("treemap-corpus.json");
    assert!(corpus.len() >= 8);
    for src in &corpus {
        check_both(src, None, None);
    }

    let mut rendered = 0usize;
    for &p in PAYLOADS {
        let templates = [
            format!("treemap\n\"{p}\"\n  \"a\": 1"),
            format!("treemap\n'{p}'\n  \"a\": 1"),
            format!("treemap\n\"s\"\n  \"{p}\": 1\n  \"b\": 2"),
            format!("treemap\n\"{p}\": 5"),
            format!("treemap\n\"s\":::{p}\n  \"a\": 1"),
            format!("treemap\n\"s\"\n  \"a\": 1:::{p}"),
            format!("treemap\n\"s\":::c1\n  \"a\": 1:::c1\nclassDef c1 fill:{p}"),
            format!("treemap\n\"s\":::c1\n  \"a\": 1:::c1\nclassDef c1 {p}:red"),
            format!("treemap\n\"s\":::c1\n  \"a\": 1:::c1\nclassDef c1 color:{p},stroke:{p},font-family:{p},font-size:{p}"),
            format!("treemap\n\"s\":::c1\n  \"a\": 1:::c1\nclassDef c1 {p}"),
            format!("treemap\n\"s\"\n  \"a\": 1\nclassDef {p} fill:red"),
            format!("treemap\n\"s\"\n  \"a\": {p}"),
            format!("treemap\ntitle {p}\n\"a\": 1"),
            format!("treemap title {p}"),
            format!("treemap\naccTitle: {p}\naccDescr: {p}\n\"a\": 1"),
            format!("treemap\naccDescr {{\n {p}\n }}\n\"a\": 1"),
            format!("treemap\n\"a\": 1 %% {p}"),
            format!("treemap-beta {p}\n\"a\": 1"),
            format!("---\ntitle: \"{p}\"\n---\ntreemap\n\"a\": 1"),
            format!("---\nconfig:\n  treemap:\n    valueFormat: \"{p}\"\n    padding: \"{p}\"\n    showValues: \"{p}\"\n---\ntreemap\n\"s\"\n  \"a\": 1"),
        ];
        for src in templates {
            if check_both(&src, None, None) {
                rendered += 1;
            }
        }
        assert!(check_both("treemap\naccTitle: t\n\"a\": 1", Some(p), Some(p)));
    }
    assert!(rendered > 250, "rendered={rendered}");

    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend_from_slice(&["\"", "'", ":", ":::", ",", "\n", "\n  ", "title ", "\"a\": 1", "classDef c1 fill:", ":::c1"]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..2000 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            check_both(&src, None, None);
        }
    }
}

#[test]
fn treemap_stays_fast_on_stress_inputs() {
    const N: usize = 50_000;
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..css_options()
    };
    let leaves_5k: String = (0..5000).map(|i| format!("\"l{i}\": {}\n", i + 1)).collect();
    let deep_300: String = (0..300).map(|i| format!("{}\"s{i}\"\n", " ".repeat(i))).collect();
    let cases: Vec<Box<dyn Fn()>> = vec![
        Box::new(|| {
            let _ = render(&format!("treemap\n{leaves_5k}"), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("treemap\n\"s\"\n{}", " \"l\": 1\n".repeat(5000)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("treemap\n{deep_300}{}\"leaf\": 1\n", " ".repeat(300)), &big);
        }),
        Box::new(|| {
            let _ = parse(
                &format!("treemap\n{}", "\"s\"\n \"t\"\n".repeat(10_000)),
                &ParseOptions {
                    limit: Some(usize::MAX),
                    ..Default::default()
                },
            );
        }),
        Box::new(|| {
            let _ = render(&format!("treemap\n\"{}\": 1", "word ".repeat(N / 5)), &big);
        }),
        Box::new(|| {
            let _ = render(&format!("treemap\n\"a\": {}", "9".repeat(N)), &big);
        }),
        Box::new(|| {
            let _ = parse_treemap(&format!("treemap\nclassDef{}1", " ".repeat(N)), None);
        }),
        Box::new(|| {
            let _ = parse_treemap(&format!("treemap\n{}ab", "classDef\n ".repeat(N / 2)), None);
        }),
        Box::new(|| {
            let _ = parse_treemap(&format!("treemap\n{}{{", "accDescr\n".repeat(N / 10)), None);
        }),
        Box::new(|| {
            let _ = parse_treemap(&format!("treemap\naccDescr {{{}", " a\n".repeat(N / 3)), None);
        }),
        Box::new(|| {
            let _ = render(
                &format!("---\nconfig:\n  treemap:\n    valueFormat: \"{}x\"\n---\ntreemap\n\"a\": 1", "0".repeat(N)),
                &big,
            );
        }),
    ];
    for (i, run) in cases.iter().enumerate() {
        let started = Instant::now();
        run();
        assert!(started.elapsed().as_millis() < 3000, "slow treemap stress case #{i}: {:?}", started.elapsed());
    }
}
