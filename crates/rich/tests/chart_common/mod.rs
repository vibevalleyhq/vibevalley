#![allow(dead_code)]

use vibevalley_rich::engine::chart::RenderedChart;

const ALLOWED_TAGS: &[&str] = &[
    "svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "title",
];

const GEOM_ATTRS: &[&str] = &[
    "x",
    "y",
    "x1",
    "y1",
    "x2",
    "y2",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "width",
    "height",
    "viewBox",
    "d",
    "points",
    "transform",
];

/// Verifies well-formed XML, strict inert-SVG allowlist, zero CSS vars / color-mix,
/// zero NaN/inf coordinates, AND real `usvg::Tree::from_str` parsing with non-empty scene nodes.
pub fn assert_valid_resolved_svg(rendered: &RenderedChart) {
    assert!(!rendered.svg.contains("var(--"), "resolved SVG must not emit CSS variables:\n{}", rendered.svg);
    assert!(
        !rendered.svg.contains("color-mix("),
        "resolved SVG must not emit color-mix():\n{}",
        rendered.svg
    );
    assert_inert_xml(&rendered.svg);

    let opts = usvg::Options::default();
    let tree = usvg::Tree::from_str(&rendered.svg, &opts).unwrap_or_else(|e| panic!("usvg failed to parse SVG: {e}\n{}", rendered.svg));

    let size = tree.size();
    assert!(
        (f64::from(size.width()) - rendered.width).abs() <= 0.5,
        "usvg width {} != expected {}",
        size.width(),
        rendered.width
    );
    assert!(
        (f64::from(size.height()) - rendered.height).abs() <= 0.5,
        "usvg height {} != expected {}",
        size.height(),
        rendered.height
    );

    let nodes = count_usvg_nodes(tree.root());
    assert!(nodes > 0, "usvg tree produced zero renderable nodes for SVG:\n{}", rendered.svg);
}

/// Verifies well-formed XML and strict inert-SVG allowlist for CssVariables mode.
pub fn assert_valid_css_var_svg(rendered: &RenderedChart) {
    assert!(
        rendered.svg.contains("var(--vv-chart-"),
        "CssVariables SVG should reference --vv-chart-* variables"
    );
    assert!(!rendered.svg.contains("color-mix("), "SVG must not emit color-mix()");
    assert_inert_xml(&rendered.svg);
}

pub fn assert_inert_xml(svg: &str) {
    let doc = roxmltree::Document::parse(svg).unwrap_or_else(|e| panic!("roxmltree failed to parse SVG: {e}\n{svg}"));

    let root = doc.root_element();
    assert_eq!(root.tag_name().name(), "svg");

    for node in doc.descendants() {
        if !node.is_element() {
            continue;
        }
        let tag = node.tag_name().name();
        assert!(ALLOWED_TAGS.contains(&tag), "forbidden SVG element <{tag}> found in:\n{svg}");
        for attr in node.attributes() {
            let name = attr.name();
            let lower_name = name.to_ascii_lowercase();
            assert!(!lower_name.starts_with("on"), "forbidden event attribute `{name}` found in:\n{svg}");
            assert!(
                lower_name != "href" && !lower_name.ends_with(":href"),
                "forbidden href attribute `{name}` found in:\n{svg}"
            );

            let val = attr.value();
            let lower_val = val.to_ascii_lowercase();
            assert!(
                !lower_val.contains("javascript:") && !lower_val.contains("data:"),
                "forbidden URI scheme in attribute `{name}=\"{val}\"`"
            );

            if GEOM_ATTRS.contains(&name) {
                assert!(
                    !lower_val.contains("nan") && !lower_val.contains("inf"),
                    "non-finite number in geometry attribute `{name}=\"{val}\"`"
                );
            }
        }
    }
}

pub fn extract_texts(svg: &str) -> Vec<String> {
    let doc = roxmltree::Document::parse(svg).expect("valid XML");
    doc.descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "text")
        .map(|n| n.text().unwrap_or_default().to_string())
        .collect()
}

pub fn count_elements_in_role(svg: &str, role: &str, tag: &str) -> usize {
    let doc = roxmltree::Document::parse(svg).expect("valid XML");
    doc.descendants()
        .filter(|n| n.is_element() && n.attribute("data-role") == Some(role))
        .flat_map(|g| g.descendants())
        .filter(|n| n.is_element() && n.tag_name().name() == tag)
        .count()
}

fn count_usvg_nodes(group: &usvg::Group) -> usize {
    let mut total = 0;
    for child in group.children() {
        match child {
            usvg::Node::Group(g) => total += count_usvg_nodes(g),
            usvg::Node::Path(_) | usvg::Node::Image(_) | usvg::Node::Text(_) => total += 1,
        }
    }
    total
}
