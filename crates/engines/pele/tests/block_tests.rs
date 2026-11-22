use std::collections::HashMap;
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::block::db::{BlockDb, edge_str_to_edge_data, edge_str_to_edge_start_data, edge_str_to_pattern, edge_str_to_thickness};
use vibevalley_pele::diagram::block::layout::calculate_block_position;
use vibevalley_pele::diagram::block::lexer::tokenize;
use vibevalley_pele::diagram::block::parser::parse_block;
use vibevalley_pele::{ErrorCode, METRICS_MEASURER, ParseOptions, ParsedModel, RenderOptions, ThemeMode, detect_type, parse, render, supports};

use crate::support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

#[derive(Debug, Clone, Copy)]
struct RectBox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

fn preview(s: &str) -> String {
    s.chars().take(120).collect()
}

fn try_render_css(src: &str) -> Option<String> {
    render(src, &css_options()).ok().map(|r| r.svg)
}

fn try_render_resolved(src: &str) -> Option<String> {
    render(src, &resolved_options()).ok().map(|r| r.svg)
}

fn boxes(svg: &str) -> HashMap<String, RectBox> {
    let mut out = HashMap::new();
    let re_node = Regex::new(r#"class="pele-node[^"]*" data-id="([^"]*)" transform="translate\(([-\d.]+),([-\d.]+)\)"><(\w+)([^>]*)>"#).unwrap();
    let re_w = Regex::new(r#"width="([\d.]+)""#).unwrap();
    let re_h = Regex::new(r#"height="([\d.]+)""#).unwrap();
    for cap in re_node.captures_iter(svg) {
        let w = re_w.captures(&cap[5]).map_or(0.0, |c| c[1].parse().unwrap());
        let h = re_h.captures(&cap[5]).map_or(0.0, |c| c[1].parse().unwrap());
        out.insert(
            cap[1].to_string(),
            RectBox {
                x: cap[2].parse().unwrap(),
                y: cap[3].parse().unwrap(),
                w,
                h,
            },
        );
    }
    let re_cluster = Regex::new(r#"class="pele-cluster[^"]*" data-id="([^"]*)"><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)""#).unwrap();
    for cap in re_cluster.captures_iter(svg) {
        let x: f64 = cap[2].parse().unwrap();
        let y: f64 = cap[3].parse().unwrap();
        let w: f64 = cap[4].parse().unwrap();
        let h: f64 = cap[5].parse().unwrap();
        out.insert(
            cap[1].to_string(),
            RectBox {
                x: x + w / 2.0,
                y: y + h / 2.0,
                w,
                h,
            },
        );
    }
    out
}

fn layout_of(src: &str) -> HashMap<String, RectBox> {
    boxes(&render(src, &css_options()).unwrap().svg)
}

fn paths(svg: &str) -> Vec<String> {
    let re = Regex::new(r#"class="pele-edge" data-id="[^"]*"><path d="([^"]*)""#).unwrap();
    re.captures_iter(svg).map(|c| c[1].to_string()).collect()
}

fn label_boxes(svg: &str) -> Vec<RectBox> {
    let re = Regex::new(r#"class="pele-edge-label" data-id="[^"]*"><rect x="([-\d.]+)" y="([-\d.]+)" width="([\d.]+)" height="([\d.]+)""#).unwrap();
    re.captures_iter(svg)
        .map(|c| {
            let x: f64 = c[1].parse().unwrap();
            let y: f64 = c[2].parse().unwrap();
            let w: f64 = c[3].parse().unwrap();
            let h: f64 = c[4].parse().unwrap();
            RectBox {
                x: x + w / 2.0,
                y: y + h / 2.0,
                w,
                h,
            }
        })
        .collect()
}

fn node_label(svg: &str, id: &str) -> Vec<String> {
    let needle = format!(r#"data-id="{id}""#);
    let at = svg.find(&needle).unwrap_or_else(|| panic!("missing node {id}"));
    let start = svg[..at].rfind(r#"<g class="pele-node"#).unwrap();
    let end = at + svg[at..].find("</g>").unwrap();
    let body = &svg[start..end];
    let re_text = Regex::new(r#"(?s)<text class="pele-label"[^>]*>(.*?)</text>"#).unwrap();
    let inner = re_text.captures(body).map_or("", |c| c.get(1).unwrap().as_str());
    let re_tspan = Regex::new(r#"(?s)<tspan(?:\s[^>]*)?>(.*?)</tspan>"#).unwrap();
    let lines: Vec<String> = re_tspan.captures_iter(inner).map(|c| c[1].to_string()).collect();
    if !lines.is_empty() {
        lines
    } else if inner.is_empty() {
        Vec::new()
    } else {
        vec![inner.to_string()]
    }
}

fn assert_close(a: f64, b: f64, tol: f64, ctx: &str) {
    assert!((a - b).abs() <= tol, "{ctx}: {a} vs {b} (tol={tol})");
}

fn expect_separate_labels(src: &str, count: usize) {
    let result = render(src, &css_options()).unwrap();
    let parsed = parse(src, &ParseOptions::default()).unwrap();
    let ParsedModel::Block(db) = parsed.model else {
        panic!("expected block model");
    };
    let doc = roxmltree::Document::parse(&result.svg).unwrap();
    let mut labels: Vec<(String, RectBox)> = Vec::new();
    for el in doc.descendants().filter(|n| n.is_element()) {
        if el.attribute("class") == Some("pele-edge-label") {
            let id = el.attribute("data-id").unwrap_or("").to_string();
            let rect = el.children().find(|c| c.is_element() && c.tag_name().name() == "rect").unwrap();
            let x: f64 = rect.attribute("x").unwrap().parse().unwrap();
            let y: f64 = rect.attribute("y").unwrap().parse().unwrap();
            let w: f64 = rect.attribute("width").unwrap().parse().unwrap();
            let h: f64 = rect.attribute("height").unwrap().parse().unwrap();
            labels.push((
                id,
                RectBox {
                    x: x + w / 2.0,
                    y: y + h / 2.0,
                    w,
                    h,
                },
            ));
        }
    }
    assert_eq!(labels.len(), count);
    let expected_ids: Vec<&str> = db
        .edges
        .iter()
        .filter(|e| e.label.as_deref().is_some_and(|l| !l.is_empty()))
        .map(|e| e.id.as_str())
        .collect();
    let actual_ids: Vec<&str> = labels.iter().map(|(id, _)| id.as_str()).collect();
    assert_eq!(actual_ids, expected_ids);
    assert_eq!(paths(&result.svg).len(), db.edges.len());

    for (i, (aid, a)) in labels.iter().enumerate() {
        assert!(a.w > 0.0 && a.h > 0.0);
        assert!(a.x - a.w / 2.0 >= 0.0);
        assert!(a.y - a.h / 2.0 >= 0.0);
        assert!(a.x + a.w / 2.0 <= result.width);
        assert!(a.y + a.h / 2.0 <= result.height);
        for (bid, b) in &labels[i + 1..] {
            let overlap_x = (a.w + b.w) / 2.0 - (a.x - b.x).abs();
            let overlap_y = (a.h + b.h) / 2.0 - (a.y - b.y).abs();
            assert!(overlap_x.min(overlap_y) <= 0.01, "{aid} overlaps {bid}");
        }
        let hits: Vec<&str> = labels
            .iter()
            .filter(|(_, b)| (a.x - b.x).abs() < b.w / 2.0 && (a.y - b.y).abs() < b.h / 2.0)
            .map(|(id, _)| id.as_str())
            .collect();
        assert_eq!(hits, vec![aid.as_str()]);
    }
    assert_eq!(render(src, &css_options()).unwrap().svg, result.svg);
}

#[test]
fn block_compat_parser_db_color_index_and_layout_position() {
    // Edge style classifiers (blockDB.spec.ts)
    assert_eq!(edge_str_to_thickness("-->"), "normal");
    assert_eq!(edge_str_to_thickness("-.->"), "normal");
    assert_eq!(edge_str_to_thickness("==>"), "thick");
    assert_eq!(edge_str_to_pattern("-->"), "solid");
    assert_eq!(edge_str_to_pattern("==>"), "solid");
    assert_eq!(edge_str_to_pattern("-.->"), "dotted");
    assert_eq!(edge_str_to_edge_start_data("<-->"), "arrow_point");
    assert_eq!(edge_str_to_edge_data("<-->"), "arrow_point");
    assert_eq!(edge_str_to_edge_start_data("<==>"), "arrow_point");
    assert_eq!(edge_str_to_edge_data("<==>"), "arrow_point");
    assert_eq!(edge_str_to_edge_start_data("-->"), "arrow_open");
    assert_eq!(edge_str_to_edge_data("-->"), "arrow_point");
    assert_eq!(edge_str_to_edge_data("--x"), "arrow_cross");
    assert_eq!(edge_str_to_edge_data("--o"), "arrow_circle");

    // calculateBlockPosition (layout.spec.ts)
    assert_eq!(calculate_block_position(2.0, 0).unwrap(), (0, 0));
    assert_eq!(calculate_block_position(2.0, 1).unwrap(), (1, 0));
    assert_eq!(calculate_block_position(2.0, 2).unwrap(), (0, 1));
    assert_eq!(calculate_block_position(2.0, 3).unwrap(), (1, 1));
    assert_eq!(calculate_block_position(2.0, 4).unwrap(), (0, 2));
    assert_eq!(calculate_block_position(1.0, 3).unwrap(), (0, 3));
    assert_eq!(calculate_block_position(0.0, 0).unwrap_err().code, ErrorCode::Semantic);
    assert_eq!(calculate_block_position(2.0, -1).unwrap_err().code, ErrorCode::Semantic);

    // Block parsing specs (block.spec.ts)
    let mut db = BlockDb::new();
    parse_block("block-beta\n  columns 1\n  A:1\n  B:2\n  C:3", &mut db, None).unwrap();
    assert_eq!(db.columns_of("root"), Some(1.0));
    assert!(db.warnings.contains(&"Block B width 2 exceeds configured column width 1".to_string()));

    // Color indices (blockColorIndex.spec.ts)
    let parsed = parse(
        "block-beta\n  a\n  block:outer\n    block:inner\n      b\n    end\n  end\n  block:sibling\n    c\n  end",
        &ParseOptions::default(),
    )
    .unwrap();
    let ParsedModel::Block(db) = parsed.model else {
        panic!("expected block");
    };
    assert_eq!(db.block_by_id("a").unwrap().color_index, None);
    assert_eq!(db.block_by_id("b").unwrap().color_index, None);
    assert_eq!(db.block_by_id("outer").unwrap().color_index, Some(0));
    assert_eq!(db.block_by_id("inner").unwrap().color_index, Some(1));
    assert_eq!(db.block_by_id("sibling").unwrap().color_index, Some(2));

    // Chains keep every link, ids are deterministic, block named root works, redeclaration merges.
    let parsed = parse(
        r#"block
  a --> b --> c -- "x" --> d"#,
        &ParseOptions::default(),
    )
    .unwrap();
    let ParsedModel::Block(db) = parsed.model else {
        panic!("expected block");
    };
    let ids: Vec<&str> = db.top_blocks().iter().map(|b| b.id.as_str()).collect();
    assert_eq!(ids, vec!["a", "b", "c", "d"]);
    let edge_tuples: Vec<(&str, &str, &str, &str)> = db
        .edges
        .iter()
        .map(|e| {
            (
                e.id.as_str(),
                e.start.as_deref().unwrap_or(""),
                e.end.as_deref().unwrap_or(""),
                e.label.as_deref().unwrap_or(""),
            )
        })
        .collect();
    assert_eq!(edge_tuples, vec![("1-a-b", "a", "b", ""), ("1-b-c", "b", "c", ""), ("1-c-d", "c", "d", "x")]);

    let parsed = parse("block\n  a b\n  a[\"Named\"]\n  b((\"x\")) --> a", &ParseOptions::default()).unwrap();
    let ParsedModel::Block(db) = parsed.model else {
        panic!("expected block");
    };
    let merged: Vec<(&str, &str, &str)> = db
        .top_blocks()
        .iter()
        .map(|b| (b.id.as_str(), b.label.as_deref().unwrap_or(""), b.block_type.as_deref().unwrap_or("")))
        .collect();
    assert_eq!(merged, vec![("a", "Named", "square"), ("b", "x", "circle")]);

    let parsed = parse("block\n  root leaf\n  root --> leaf", &ParseOptions::default()).unwrap();
    let ParsedModel::Block(db) = parsed.model else {
        panic!("expected block");
    };
    let root_ids: Vec<&str> = db.top_blocks().iter().map(|b| b.id.as_str()).collect();
    assert_eq!(root_ids, vec!["root", "leaf"]);
    assert_eq!(layout_of("block\n  root leaf").len(), 2);

    let parsed = parse("block\n  a space:2\n  block\n    b\n  end", &ParseOptions::default()).unwrap();
    let ParsedModel::Block(db) = parsed.model else {
        panic!("expected block");
    };
    let gen_ids: Vec<&str> = db.top_blocks().iter().map(|b| b.id.as_str()).collect();
    assert_eq!(gen_ids, vec!["a", "id-1-0", "id-1-1", "id-2"]);
}

#[test]
fn block_renders_full_upstream_corpus_in_css_and_resolved_resvg_modes() {
    let corpus = load_fixture("block-corpus.json");
    assert!(corpus.len() >= 80, "expected >=80 block corpus entries, got {}", corpus.len());
    let mut rendered = 0usize;
    for src in &corpus {
        let Some(svg_css) = try_render_css(src) else {
            continue;
        };
        rendered += 1;
        let where_ctx = preview(src);
        assert_inert(&svg_css, &where_ctx);
        assert!(!svg_css.contains("NaN") && !svg_css.contains("Infinity"), "{where_ctx}");
        assert_eq!(try_render_css(src).as_deref(), Some(svg_css.as_str()), "non-deterministic: {where_ctx}");

        let svg_res = try_render_resolved(src).unwrap_or_else(|| panic!("resolved mode failed where CSS succeeded: {where_ctx}"));
        assert_inert_resolved(&svg_res, &where_ctx);
        assert_resvg_parses(&svg_res, &where_ctx);

        let svg_dark = render(src, &dark_options()).unwrap().svg;
        assert_inert_resolved(&svg_dark, &where_ctx);
        assert_resvg_parses(&svg_dark, &where_ctx);
    }
    assert!(rendered > 60, "expected >60 rendered block corpus diagrams, got {rendered}");
}

#[test]
fn block_grid_columns_spanning_spaces_composites_and_padding() {
    let result = render("block\n  a b c", &css_options()).unwrap();
    assert_eq!(result.diagram_type, DiagramType::Block);
    assert!(result.svg.contains(&format!(r#"viewBox="0 0 {} {}""#, result.width, result.height)));
    assert!(result.svg.starts_with(r#"<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-block""#));
    assert!(result.links.is_empty());
    assert_eq!(render("block-beta\n  a b c", &css_options()).unwrap().svg, result.svg);
    assert_eq!(detect_type("block-beta\n a"), Some(DiagramType::Block));
    assert!(supports("block\n a"));

    // One row without columns
    let at = layout_of("block\n  a b c");
    assert_eq!(at["a"].y, at["b"].y);
    assert_eq!(at["b"].y, at["c"].y);
    assert_close(at["b"].x - at["a"].x, at["c"].x - at["b"].x, 0.01, "equal spacing");

    // Wrap after columns
    let at = layout_of("block\n  columns 3\n  a b c d");
    assert_eq!(at["d"].x, at["a"].x);
    assert!(at["d"].y > at["a"].y);
    let stacked = layout_of("block\n  columns 1\n  a b");
    assert_eq!(stacked["a"].x, stacked["b"].x);

    // Equal widths & heights
    let at = layout_of("block\n  columns 2\n  a[\"A much longer label\"] b\n  c[\"two<br>lines\"] d");
    for id in ["a", "b", "c", "d"] {
        assert_eq!(at[id].w, at["a"].w);
        assert_eq!(at[id].h, at["a"].h);
    }
    assert!(at["a"].h > layout_of("block\n a")["a"].h);

    // Column spanning includes gap
    let at = layout_of("block\n  columns 3\n  a[\"A label\"] b:2 c:2 d");
    assert_eq!(at["b"].w, 2.0 * at["a"].w + 12.0);
    assert_close(at["c"].x, at["a"].x + (at["a"].w + 12.0) / 2.0, 0.1, "c span x");
    assert_close(at["d"].x, at["a"].x + 2.0 * (at["a"].w + 12.0), 0.1, "d x");
    assert_eq!(at["d"].y, at["c"].y);

    // Wider cell rewraps spanning label, keeping fixed shapes and explicit <br>
    let text = "Something long long long long long long";
    let svg = render(
        &format!("block\n  1[\"Something\"]\n  2[\"{text}\"]:2\n  3[\"{text}\"]:5\n  4[\"{text}\"]:2\n  5[\"Something\"]"),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(node_label(&svg, "3"), vec![text]);
    assert_eq!(node_label(&svg, "2").len(), 2);

    let fixed = render(&format!("block\n  a((\"{text}\")) c{{\"{text}\"}} d[\"{text}\"]:5"), &css_options())
        .unwrap()
        .svg;
    assert_eq!(node_label(&fixed, "a").len(), 2);
    assert_eq!(node_label(&fixed, "c").len(), 2);
    assert_eq!(node_label(&fixed, "d"), vec![text]);

    let broken = render(&format!("block\n  a[\"{text}<br>tail\"]:5 b c d e"), &css_options()).unwrap().svg;
    assert_eq!(node_label(&broken, "a"), vec!["Something long long long long long", "long", "tail"]);

    // Clamps over-wide span at last column
    let at = layout_of("block\n  columns 3\n  a b:3 c");
    assert_eq!(at["b"].w, 2.0 * at["a"].w + 12.0);
    assert_eq!(at["c"].x, at["a"].x);
    assert!(at["c"].y > at["a"].y);
    let every = layout_of("block\n  a:0 b");
    assert_eq!(every["a"].w, every["b"].w);

    // Space blocks
    let at = layout_of("block\n  columns 3\n  a space b\n  c d e");
    assert_eq!(at["b"].x, at["e"].x);
    assert_eq!(at["d"].x, (at["a"].x + at["b"].x) / 2.0);
    let wide = layout_of("block\n  ida space:3 idb idc");
    let step = wide["idc"].x - wide["idb"].x;
    assert_close(wide["idb"].x - wide["ida"].x, 4.0 * step, 0.1, "space:3");
    assert_eq!(
        render("block\n  a space b", &css_options())
            .unwrap()
            .svg
            .matches(r#"class="pele-node "#)
            .count(),
        2
    );

    // Composites, stretching, row heights, composite title, block.padding
    let at = layout_of("block\n  columns 1\n  top\n  block:group\n    columns 2\n    a b c d\n  end");
    let g = at["group"];
    for id in ["a", "b", "c", "d"] {
        let b = at[id];
        assert!(b.x - b.w / 2.0 >= g.x - g.w / 2.0 + 12.0 - 1e-6);
        assert!(b.x + b.w / 2.0 <= g.x + g.w / 2.0 - 12.0 + 1e-6);
        assert!(b.y - b.h / 2.0 >= g.y - g.h / 2.0 + 12.0 - 1e-6);
        assert!(b.y + b.h / 2.0 <= g.y + g.h / 2.0 - 12.0 + 1e-6);
    }
    assert_eq!(at["c"].x, at["a"].x);
    assert_eq!(at["top"].w, g.w);

    let at = layout_of("block\n  columns 3\n  a[\"A wide block label here\"]:3\n  block:g:2\n    x y\n  end\n  z");
    assert_close(at["g"].w, (2.0 * (at["a"].w - 24.0)) / 3.0 + 12.0, 0.05, "stretched composite");
    assert_close(2.0 * at["x"].w + 3.0 * 12.0, at["g"].w, 0.05, "stretched child");

    let at = layout_of("block\n  columns 3\n  a:3\n  block:group1:2\n    columns 2\n    h i j k\n  end\n  g\n  block:group2:3\n    l m n o p q r\n  end");
    let plain = layout_of("block\n  l")["l"].h;
    assert_close(at["group1"].h, 2.0 * plain + 3.0 * 12.0, 0.05, "group1 h");
    assert_close(at["a"].h, at["group1"].h, 0.05, "a h");
    assert_close(at["g"].h, at["group1"].h, 0.05, "g h");
    assert_close(at["group2"].h, plain + 2.0 * 12.0, 0.05, "group2 h");
    assert_close(at["l"].h, plain, 0.05, "l h");
    assert_close(at["group2"].w, at["a"].w, 0.05, "group2 w");

    let titled_svg = render("block\n  block:g[\"Group title\"]\n    a b\n  end", &css_options()).unwrap().svg;
    let at_t = boxes(&titled_svg);
    assert!(titled_svg.contains(r#"class="pele-cluster-label""#));
    assert!(titled_svg.contains(">Group title<"));
    let re_ty = Regex::new(r#"class="pele-cluster-label"[^>]* y="([\d.]+)""#).unwrap();
    let title_y: f64 = re_ty.captures(&titled_svg).unwrap()[1].parse().unwrap();
    assert!(title_y < at_t["a"].y - at_t["a"].h / 2.0);
    let plain_g = layout_of("block\n  block:g\n    a b\n  end");
    assert!(at_t["g"].h > plain_g["g"].h);

    let tight = render("---\nconfig:\n  block:\n    padding: 2\n---\nblock\n  a b c", &css_options()).unwrap();
    let loose = render("---\nconfig:\n  block:\n    padding: 40\n---\nblock\n  a b c", &css_options()).unwrap();
    assert_eq!(loose.width - tight.width, 2.0 * 38.0);
}

#[test]
fn block_shapes_arrows_edges_labels_stacking_and_widening() {
    let shapes = [
        ("a", "rect"),
        (r#"a["x"]"#, "rect"),
        (r#"a("x")"#, "rounded"),
        (r#"a(["x"])"#, "stadium"),
        (r#"a[["x"]]"#, "fr-rect"),
        (r#"a[("x")]"#, "cyl"),
        (r#"a(("x"))"#, "circle"),
        (r#"a((("x")))"#, "dbl-circ"),
        (r#"a>"x"]"#, "odd"),
        (r#"a{"x"}"#, "diam"),
        (r#"a{{"x"}}"#, "hex"),
        (r#"a[/"x"/]"#, "lean-r"),
        (r#"a[\"x"\]"#, "lean-l"),
        (r#"a[/"x"\]"#, "trap-b"),
        (r#"a[\"x"/]"#, "trap-t"),
        (r#"a<["x"]>(right)"#, "block-arrow"),
        (r#"a("x"]"#, "rect"),
    ];
    for (src, shape) in shapes {
        let svg = render(&format!("block\n  {src}"), &css_options()).unwrap().svg;
        assert!(svg.contains(&format!(r#"class="pele-node pele-shape-{shape}""#)), "src={src}");
        let res = render(&format!("block\n  {src}"), &resolved_options()).unwrap().svg;
        assert_inert_resolved(&res, src);
        assert_resvg_parses(&res, src);
    }

    // Circles keep fixed size in wider cell
    let circle_svg = render("block\n  columns 1\n  a((\"x\"))\n  b[\"A much wider block than the circle\"]", &css_options())
        .unwrap()
        .svg;
    let re_r = Regex::new(r#"<circle r="([\d.]+)""#).unwrap();
    let r: f64 = re_r.captures(&circle_svg).unwrap()[1].parse().unwrap();
    assert!(r * 2.0 < boxes(&circle_svg)["b"].w / 2.0);

    // Block arrows for every direction
    let poly_points = |dirs: &str| -> usize {
        let svg = render(&format!("block\n  a<[\"Label\"]>({dirs})"), &css_options()).unwrap().svg;
        let re = Regex::new(r#"<polygon points="([^"]*)""#).unwrap();
        re.captures(&svg).unwrap()[1].split(' ').count()
    };
    for dir in ["right", "left", "up", "down"] {
        assert_eq!(poly_points(dir), 7, "dir={dir}");
    }
    assert_eq!(poly_points("x"), 10);
    assert_eq!(poly_points("y"), 10);
    assert_eq!(poly_points("x, down"), 13);
    assert_eq!(poly_points("x, y"), 16);
    assert_eq!(poly_points("up, up"), 7);
    assert_eq!(poly_points(" up "), 7);
    let labelled = render("block\n  a<[\"Label\"]>(right)", &css_options()).unwrap();
    let blank = render("block\n  a<[\"&nbsp;&nbsp;&nbsp;\"]>(right)", &css_options()).unwrap();
    assert!(blank.height < labelled.height);
    assert_ne!(
        render("block\n  a<[\"x\"]>(right)", &css_options()).unwrap().svg,
        render("block\n  a<[\"x\"]>(left)", &css_options()).unwrap().svg
    );

    // Straight lines, bends, diagonals, arrowheads, thick/dotted, spreading
    let row = render("block\n  a space b\n  a --> b", &css_options()).unwrap().svg;
    let at = boxes(&row);
    let re_seg = Regex::new(r"^M([\d.]+),([\d.]+)L([\d.]+),([\d.]+)$").unwrap();
    let p0 = &paths(&row)[0];
    let m = re_seg.captures(p0).unwrap();
    assert_close(m[1].parse().unwrap(), at["a"].x + at["a"].w / 2.0, 0.05, "start x");
    assert_close(m[2].parse().unwrap(), at["a"].y, 0.05, "start y");
    assert_eq!(&m[4], &m[2]);
    assert!(m[3].parse::<f64>().unwrap() < at["b"].x - at["b"].w / 2.0);

    let col = paths(&render("block\n  columns 1\n  a space b\n  b --> a", &css_options()).unwrap().svg);
    let vm = re_seg.captures(&col[0]).unwrap();
    assert_eq!(&vm[1], &vm[3]);
    assert!(vm[4].parse::<f64>().unwrap() < vm[2].parse::<f64>().unwrap());

    let bend = render("block\n  columns 3\n  a space:2\n  space:3\n  space:2 b\n  a --> b", &css_options())
        .unwrap()
        .svg;
    assert!(Regex::new(r"^M[\d.,]+L[\d.,]+Q[\d., ]+L[\d.,]+$").unwrap().is_match(&paths(&bend)[0]));

    let diag = render("block\n  columns 2\n  a b\n  c d\n  a --> d", &css_options()).unwrap().svg;
    assert!(Regex::new(r"^M[\d.,]+L[\d.,]+$").unwrap().is_match(&paths(&diag)[0]));

    let arrows_svg = render(
        "block\n  columns 3\n  a space b\n  c space d\n  a --> b\n  c --o d\n  a --x c\n  b <--> d\n  a == \"thick\" ==> b\n  c -. \"dotted\" .-> d\n  b --- d",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(arrows_svg.matches(r#"class="pele-edge""#).count(), 7);
    assert_eq!(
        Regex::new(r#"<path class="pele-marker" d="M[^"]*Z""#).unwrap().find_iter(&arrows_svg).count(),
        5
    );
    assert_eq!(
        Regex::new(r#"<path class="pele-marker" d="M[^"Z]*""#).unwrap().find_iter(&arrows_svg).count(),
        1
    );
    assert_eq!(arrows_svg.matches(r#"<circle class="pele-marker""#).count(), 1);
    assert!(arrows_svg.contains(r#"stroke-width="2.5""#));
    assert!(arrows_svg.contains(r#"stroke-dasharray="3 4""#));
    assert!(arrows_svg.contains(">thick<"));
    assert!(arrows_svg.contains(">dotted<"));
    assert_eq!(arrows_svg.matches(r#"class="pele-edge-label""#).count(), 2);

    // Parallel spreading & label separation / stacking / widening / maxWidth
    let spread = paths(&render("block\n  a space b\n  a --> b\n  b --> a", &css_options()).unwrap().svg);
    let re_y = Regex::new(r"^M[\d.]+,([\d.]+)").unwrap();
    assert_ne!(re_y.captures(&spread[0]).unwrap()[1], re_y.captures(&spread[1]).unwrap()[1]);

    expect_separate_labels(
        "block\n  columns 1\n  a[\"Upper layer\"]\n  space:3\n  b[\"Lower layer\"]\n  a -- \"12 production conforming\" --> b\n  b -- \"12 production deviation\" --> a",
        2,
    );
    expect_separate_labels(
        "block\n  a[\"Left layer\"] space:3 b[\"Right layer\"]\n  a -- \"12 production<br>conforming\" --> b\n  b -- \"12 production<br>deviation\" --> a",
        2,
    );
    expect_separate_labels(
        "block\n  columns 1\n  a[\"A\"]\n  space\n  b[\"B\"]\n  a -- \"144 production conforming\" --> b\n  b -- \"144 production deviation\" --> a",
        2,
    );
    expect_separate_labels(
        "block\n  columns 1\n  a[\"A\"]\n  space:2\n  b[\"B\"]\n  a -- \"7 production policy\" --> b\n  a -- \"7 test policy\" --> b\n  a -- \"7 production exception\" --> b\n  b -- \"7 production deviation\" --> a",
        4,
    );
    expect_separate_labels("block\n  columns 1\n  a\n  b\n  a -- \"conforming\" --> b\n  b -- \"deviation\" --> a", 2);
    expect_separate_labels(
        "block\n  a[\"Service\"] space b[\"Database\"]\n  a -- \"read\" --> b\n  a -- \"write rows\" --> b\n  b -- \"notify\" --> a",
        3,
    );
    expect_separate_labels(
        "block\n  columns 2\n  block:g\n    columns 1\n    a{\"a\"} b\n  end\n  q[\"Q<br>Q<br>Q<br>Q<br>Q<br>Q\"]\n  a -- \"long label\" --> b\n  a -- \"long label\" --> b",
        2,
    );

    // Leaves labels clear of intermediate blocks & arrowheads
    let clear_svg = render(
        "block\n  columns 1\n  a\n  space\n  c[\"Middle\"]\n  space\n  b\n  a -- \"forward label\" --> b\n  a -- \"second label\" --> b",
        &css_options(),
    )
    .unwrap()
    .svg;
    let c_box = boxes(&clear_svg)["c"];
    for l in label_boxes(&clear_svg) {
        assert!((l.x - c_box.x).abs() >= (l.w + c_box.w) / 2.0 || (l.y - c_box.y).abs() >= (l.h + c_box.h) / 2.0);
    }

    // Does not widen past maxWidth
    let mw_src = "block\n  a[\"Service\"] space b[\"Database\"]\n  a -- \"read\" --> b\n  a -- \"write rows\" --> b\n  b -- \"notify\" --> a";
    for max_width in [380.0, 397.5] {
        let mut opts = css_options();
        opts.max_width = Some(max_width);
        assert!(render(mw_src, &opts).unwrap().width <= max_width);
    }

    // Self-loop arc and parent-child edge
    let loop_svg = render("block\n  a\n  a -- \"again\" --> a", &css_options()).unwrap().svg;
    assert!(Regex::new(r"^M[\d.,]+A10,10 0 1 1 [\d.,]+$").unwrap().is_match(&paths(&loop_svg)[0]));
    assert!(loop_svg.contains(">again<"));
    assert_inert(&loop_svg, "self-loop");

    let parent_svg = render("block\n  block:g\n    a b\n  end\n  a --> g\n  g --> b", &css_options()).unwrap().svg;
    assert_eq!(paths(&parent_svg).len(), 2);
    assert!(!parent_svg.contains("NaN"));
}

#[test]
fn block_styles_contrast_casings_titles_entities_errors_and_deep_nesting() {
    let svg = render(
        "block\n  classDef hot fill:#f96,stroke:#333,color:#400;\n  class a hot\n  style b fill:red;stroke:blue,stroke-width:2px\n  a b c\n  class b, c hot",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(svg.contains(r#"class="pele-node pele-shape-rect hot" data-id="a""#));
    assert!(svg.contains(r#"class="pele-node pele-shape-rect hot" data-id="c""#));
    assert!(svg.contains(r#"style="rx:var(--_r);fill:#f96;stroke:#333;""#));
    assert!(svg.contains(r#"style="rx:var(--_r);fill:red;stroke:blue;stroke-width:2px;""#));
    assert!(svg.contains(r#"style="fill:#400;""#));
    assert_eq!(boxes(&svg).len(), 3);

    let def_svg = render(
        "block\n  a b\n  classDef default stroke:#f00\n  classDef other fill:#0f0\n  class b other",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(def_svg.matches("stroke:#f00").count(), 1);

    let comp_svg = render("block\n  block:g\n    a\n  end\n  style g fill:#fee,stroke:#f00", &css_options())
        .unwrap()
        .svg;
    assert!(
        Regex::new(r#"class="pele-cluster" data-id="g"><rect [^>]*style="rx:var\(--_r\);fill:#fee;stroke:#f00;""#)
            .unwrap()
            .is_match(&comp_svg)
    );

    // Full opacity when author sets fill
    let op_svg = render("block\n  block:g\n    a\n  end\n  block:h\n    b\n  end\n  style g fill:#fee", &css_options())
        .unwrap()
        .svg;
    assert!(Regex::new(r#"data-id="g"><rect [^>]*fill="var\(--_a\)" stroke="#).unwrap().is_match(&op_svg));
    assert!(Regex::new(r#"data-id="h"><rect [^>]*fill-opacity="0.5""#).unwrap().is_match(&op_svg));

    // Contrast ink on fills
    let contrast_svg = render(
        "block\n  block:g[\"Group\"]\n    a[\"Light\"]\n  end\n  b[\"Dark\"] c[\"Own\"] d[\"Plain\"]\n  e<[\"Go\"]>(right)\n  style g fill:#FFF9C4\n  style a fill:#BBDEFB\n  style b fill:#1f3a5f\n  style c fill:#1f3a5f,color:#eee\n  style e fill:black",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(
        Regex::new(r#"data-id="g">.*?<text class="pele-cluster-label" fill="var\(--pele-fg-on-light,#1f1f1f\)"[^>]*>Group<"#)
            .unwrap()
            .is_match(&contrast_svg)
    );
    assert!(
        Regex::new(r#"data-id="a"[^>]*>.*?<text class="pele-label" fill="var\(--pele-fg-on-light,#1f1f1f\)"[^>]*>Light<"#)
            .unwrap()
            .is_match(&contrast_svg)
    );
    assert!(
        Regex::new(r#"data-id="b"[^>]*>.*?<text class="pele-label" fill="var\(--pele-fg-on-dark,#fff\)"[^>]*>Dark<"#)
            .unwrap()
            .is_match(&contrast_svg)
    );
    assert!(
        Regex::new(r#"data-id="c"[^>]*>.*?<text class="pele-label" style="fill:#eee;"[^>]*>Own<"#)
            .unwrap()
            .is_match(&contrast_svg)
    );
    assert!(
        Regex::new(r#"data-id="e"[^>]*>.*?<text class="pele-label" fill="var\(--pele-fg-on-dark,#fff\)"[^>]*>Go<"#)
            .unwrap()
            .is_match(&contrast_svg)
    );

    // Casings & over-fill ink
    let case_src = "block\n  block:g\n    a b\n  end\n  c\n  a --> b\n  b --> c\n  c --> c\n  style g fill:#BBDEFB";
    let case_svg = render(case_src, &css_options()).unwrap().svg;
    let re_case = Regex::new(r#"<g class="pele-casings"[^>]*>(.*?)</g>"#).unwrap();
    let casings = &re_case.captures(&case_svg).unwrap()[1];
    let re_edge = Regex::new(r#"<g class="pele-edge" data-id="[^"]+"([^>]*)><path d="([^"]+)""#).unwrap();
    let edges: Vec<(&str, &str)> = re_edge
        .captures_iter(&case_svg)
        .map(|c| (c.get(1).unwrap().as_str(), c.get(2).unwrap().as_str()))
        .collect();
    assert_eq!(edges.len(), 3);
    assert_eq!(
        edges.iter().map(|(_, d)| casings.contains(&format!(r#"<path d="{d}"/>"#))).collect::<Vec<_>>(),
        vec![false, true, false]
    );
    assert_eq!(
        edges.iter().map(|(a, _)| *a).collect::<Vec<_>>(),
        vec![r#" stroke="var(--pele-fg-on-light,#1f1f1f)""#, "", ""]
    );
    let plain_case = render(&case_src.replace("\n  style g fill:#BBDEFB", ""), &css_options()).unwrap().svg;
    assert!(!plain_case.contains("pele-casings") && !plain_case.contains("--pele-fg-on"));

    // Title & entity decoding
    let plain = render("block\n  a", &css_options()).unwrap();
    let titled = render("---\ntitle: Systems\n---\nblock\n  a", &css_options()).unwrap();
    assert!(titled.svg.contains(r#"class="pele-title" font-weight="var(--_tw)""#));
    assert!(titled.svg.contains(">Systems<"));
    assert!(titled.height > plain.height);

    let ent_svg = render(
        "block\n  a[\"<b>bold</b> & #quot;q#quot; #9829;\"]\n  b[\"<img src=x onerror=alert(1)>\"]",
        &css_options(),
    )
    .unwrap()
    .svg;
    assert!(!ent_svg.contains("<img"));
    assert!(ent_svg.contains("&quot;q&quot; ♥"));
    assert!(ent_svg.contains(r#"font-weight="var(--_w)""#));

    // Rejects columns 0 and grammar errors
    let err = render("block\n  columns 0\n  a b", &css_options()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Semantic);
    assert_eq!(err.message, "Columns must be an integer !== 0.");
    assert_eq!(
        render("block\n  columns auto\n  a b", &css_options()).unwrap().svg,
        render("block\n  a b", &css_options()).unwrap().svg
    );

    for bad in [
        "block",
        "block\n",
        "block\n  a - b",
        "block\n  a[label]",
        "block\n  block\n  a",
        "block\n  a\n  end",
        "block\n  default",
        "block\n  accTitle: t\n  a",
    ] {
        assert!(parse(bad, &ParseOptions::default()).is_err(), "should fail: {bad}");
    }
    assert!(
        parse("block\n  a - b", &ParseOptions::default())
            .unwrap_err()
            .message
            .starts_with("Lexical error on line 2")
    );
    let end_err = parse("block\n  a\n  end", &ParseOptions::default()).unwrap_err().message;
    assert!(end_err.starts_with("Parse error on line 3:") && end_err.contains("got 'end'"), "msg={end_err}");

    // Deep nesting (3,000 nested composites) without stack overflow
    let deep_src = format!("block\n{}a\n{}", "block\n".repeat(3000), "end\n".repeat(3000));
    let mut big_opts = resolved_options();
    big_opts.limit = Some(usize::MAX);
    let deep = render(&deep_src, &big_opts).unwrap();
    assert_eq!(deep.svg.matches(r#"class="pele-cluster""#).count(), 3000);
    assert_inert_resolved(&deep.svg, "deep 3000 composites");
}

#[test]
fn block_security_hostile_payloads_options_zero_size_and_mutated_fuzz() {
    let templates: Vec<fn(&str) -> String> = vec![
        |p| format!("block\n  {p}"),
        |p| format!("block\n  a {p} b"),
        |p| format!("block\n  a[\"{p}\"]"),
        |p| format!("block\n  a(\"{p}\") b([\"{p}\"]) c[[\"{p}\"]] d[(\"{p}\")]"),
        |p| format!("block\n  a((\"{p}\")) b(((\"{p}\"))) c>\"{p}\"] d{{\"{p}\"}} e{{{{\"{p}\"}}}}"),
        |p| format!("block\n  a[/\"{p}\"/] b[\\\"{p}\"\\] c[/\"{p}\"\\] d[\\\"{p}\"/]"),
        |p| format!("block\n  a<[\"{p}\"]>(right) b<[\"{p}\"]>(x, y)"),
        |p| format!("block\n  a<[\"x\"]>({p})"),
        |p| format!("block\n  a[\"`{p}`\"]"),
        |p| format!("block\n  block:g[\"{p}\"]\n    a\n  end"),
        |p| format!("block\n  block:{p}\n    a\n  end"),
        |p| format!("block\n  block:g:{p}\n    a\n  end"),
        |p| format!("block\n  a space b\n  a -- \"{p}\" --> b"),
        |p| format!("block\n  a space b\n  a == \"{p}\" ==> b\n  b -. \"{p}\" .-> a\n  a -- \"{p}\" --> a"),
        |p| format!("block\n  a space b\n  a {p} b"),
        |p| format!("block\n  a:{p} b"),
        |p| format!("block\n  a space:{p} b"),
        |p| format!("block\n  columns {p}\n  a b"),
        |p| format!("block\n  a b\n  class a {p}"),
        |p| format!("block\n  a b\n  class {p} hot"),
        |p| format!("block\n  a b\n  classDef {p} fill:red\n  class a {p}"),
        |p| format!("block\n  a b\n  classDef hot fill:{p}\n  class a hot"),
        |p| format!("block\n  a b\n  classDef hot {p}\n  class a,b hot"),
        |p| format!("block\n  a b\n  classDef hot color:{p},stroke:{p},font-family:{p},font-size:{p}\n  class a hot"),
        |p| format!("block\n  a b\n  classDef default {p}:red,fill:{p}"),
        |p| format!("block\n  a b\n  style a fill:{p}"),
        |p| format!("block\n  a b\n  style a {p}"),
        |p| format!("block\n  a b\n  style a {p}:red;{p}"),
        |p| format!("block\n  a b\n  style a color:{p},stroke:{p},stroke-dasharray:{p}"),
        |p| format!("block\n  a b\n  style {p} fill:red"),
        |p| format!("block\n  block:g\n    a\n  end\n  style g fill:{p},color:{p}\n  class g {p}"),
        |p| format!("block\n  a[\"fa:fa-{p} x\"]"),
        |p| format!("block\n  a\n  accDescr {{\n {p}\n }}"),
        |p| format!("block\n  accTitle: {p}\n  a"),
        |p| format!("block\n  %% {p}\n  a"),
        |p| format!("---\ntitle: \"{p}\"\nconfig:\n  block:\n    padding: \"{p}\"\n---\nblock\n  a b"),
        |p| format!("%%{{init: {{\"block\": {{\"padding\": \"{p}\"}}, \"themeVariables\": {{\"fontFamily\": \"{p}\"}}}}}}%%\nblock\n  a b"),
        |p| format!("block {p}\n  a"),
        |p| format!("block-beta\n  {p}[\"{p}\"] --> {p}"),
    ];

    let check = |src: &str| -> bool {
        let Ok(res) = render(src, &resolved_options()) else {
            return false;
        };
        let ctx = preview(src);
        assert_inert_resolved(&res.svg, &ctx);
        assert!(!res.svg.contains("NaN") && !res.svg.contains("Infinity"), "{ctx}");
        true
    };

    let mut rendered = 0usize;
    for tmpl in &templates {
        for &payload in PAYLOADS {
            if check(&tmpl(payload)) {
                rendered += 1;
            }
        }
    }
    assert!(rendered > 700, "expected >700 rendered hostile block templates, got {rendered}");

    // Hostile option values
    for &payload in PAYLOADS {
        let opts = RenderOptions {
            measurer: Some(&METRICS_MEASURER),
            theme_mode: ThemeMode::light(),
            id_prefix: Some(payload.to_string()),
            font_family: Some(payload.to_string()),
            ..RenderOptions::default()
        };
        let res = render("block\n  a space b\n  a -- \"x\" --> b", &opts).unwrap();
        assert_inert_resolved(&res.svg, payload);
        assert_resvg_parses(&res.svg, payload);
    }

    // Zero-size blocks keep coordinates finite
    let zero = "---\nconfig:\n  block:\n    padding: 0\n---\n";
    for body in [
        "block\n  columns 1\n  block:g\n    classDef x fill:red\n  end\n  a\n  g --> a\n  a --> g\n  g --> g",
        "block\n  block:g\n    space\n  end\n  block:h\n    space\n  end\n  g --> h\n  h -- \"x\" --> g",
        "block\n  columns 1\n  block:g\n    classDef x fill:red\n  end\n  block:h\n    classDef x fill:red\n  end\n  g --> h",
        "block\n  space\n  block:g\n    space:0\n  end\n  g --> g",
    ] {
        assert!(check(&format!("{zero}{body}")), "{body}");
        assert!(check(body), "{body}");
    }

    // Hostile markup kept out
    let clean = render(
        "block\n  a[\"</text><script>alert(1)</script>\"]\n  classDef x fill:url(javascript:alert(1)),stroke:red\n  class a x",
        &resolved_options(),
    )
    .unwrap();
    assert!(!clean.svg.contains("<script") && !clean.svg.contains("url("));
    assert!(clean.svg.contains("stroke:red"));
    assert_resvg_parses(&clean.svg, "hostile markup");

    // Mutated fuzz
    let corpus = load_fixture("block-corpus.json");
    let mut fragments: Vec<&str> = PAYLOADS.to_vec();
    fragments.extend([
        "\"",
        "[\"",
        "\"]",
        "<[\"",
        "\"]>(right)",
        "\n",
        ":",
        " --> ",
        " -- \"",
        "\" --> ",
        "style a fill:",
        "classDef a ",
        "class a ",
        "block:",
        "end",
        "space:9",
        "columns 2",
    ]);
    let mut mutator = Mutator::new(&corpus, fragments, 3);
    let mut fuzz_rendered = 0usize;
    for _ in 0..1000 {
        let sample = mutator.next_sample();
        if sample.len() <= 4000 && check(&sample) {
            fuzz_rendered += 1;
        }
    }
    assert!(fuzz_rendered > 50, "expected >50 fuzz samples rendered, got {fuzz_rendered}");
}

#[test]
fn block_stress_linear_time_limits_and_finite_outputs() {
    // Space count limit
    let err = parse("block\na space:100001 b", &ParseOptions::default()).unwrap_err();
    assert_eq!(err.code, ErrorCode::Limit);
    assert!(err.message.contains("at most 100000 space blocks"));
    assert!(parse(&format!("block\n{}", "space:60000 ".repeat(2)), &ParseOptions::default()).is_err());
    let ok = parse("block\na space:5 b", &ParseOptions::default()).unwrap();
    let ParsedModel::Block(db) = ok.model else {
        panic!("expected block");
    };
    assert_eq!(db.top_blocks().len(), 7);

    // Extreme numbers stay finite
    let big_opts = RenderOptions {
        measurer: Some(&METRICS_MEASURER),
        theme_mode: ThemeMode::light(),
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        ..RenderOptions::default()
    };
    for src in [
        format!("block\ncolumns 3\na:{} b c", "9".repeat(400)),
        format!("block\na:{} b c", "9".repeat(400)),
        "block\na:0 b:00 c".to_string(),
        "block\ncolumns 99999999999999999999\na b".to_string(),
        "block\nblock:g:99999999\na\nend\nb".to_string(),
    ] {
        let res = render(&src, &big_opts).unwrap();
        assert!(res.width.is_finite() && res.height.is_finite());
        assert!(!res.svg.contains("NaN") && !res.svg.contains("Infinity"));
        assert_inert_resolved(&res.svg, "extreme numbers");
    }

    // 400-digit column count rejected cleanly as non-integer
    let huge_cols = format!("block\ncolumns {}\na b", "9".repeat(400));
    assert_eq!(render(&huge_cols, &big_opts).unwrap_err().code, ErrorCode::Semantic);

    // Representative worst-case linear-time checks
    let n = 50_000usize;
    let started = Instant::now();
    let _ = tokenize(&format!("block\nA{}{}{}", "-".repeat(n), ".".repeat(n), "=".repeat(n)));
    let _ = tokenize(&format!("block\nA -{}x", ".".repeat(n)));
    let _ = tokenize(&format!("block\n{}", "(([[{{".repeat(n / 6)));
    let _ = render(&format!("block\n{}", (0..5000).map(|i| format!("b{i} ")).collect::<String>()), &big_opts).unwrap();
    let _ = render(&format!("block\nA<[\"x\"]>({})", "up, down , x,y ".repeat(2500)), &big_opts).unwrap();
    let _ = render(&format!("block\nA\nclass {}A hot\nclassDef hot fill:#f96", "A,".repeat(10_000)), &big_opts).unwrap();
    let _ = render(
        "block\n__proto__ constructor toString\nclassDef __proto__ fill:red\nclass constructor,toString __proto__\nstyle __proto__ fill:blue\n__proto__ --> constructor",
        &big_opts,
    )
    .unwrap();
    assert!(started.elapsed().as_secs() < 5, "block stress took {:?}", started.elapsed());
}
