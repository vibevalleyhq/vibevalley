use std::collections::HashSet;

use vibevalley_canvas::{
    BackgroundStyle, Canvas, CanvasColor, Edge, EdgeId, EdgeStrokeStyle, End, FileNode, GroupNode, Node, NodeBounds, NodeId, PresetColor, Side,
    SvgRenderOptions, SvgTheme, render_svg, render_svg_default,
};

const OFFICIAL_SAMPLE_CANVAS: &str = r#"{
	"nodes":[
		{"id":"754a8ef995f366bc","type":"group","x":-300,"y":-460,"width":610,"height":200,"label":"JSON Canvas"},
		{"id":"8132d4d894c80022","type":"file","file":"readme.md","x":-280,"y":-200,"width":570,"height":560,"color":"6"},
		{"id":"7efdbbe0c4742315","type":"file","file":"_site/logo.svg","x":-280,"y":-440,"width":217,"height":80},
		{"id":"59e896bc8da20699","type":"text","text":"Learn more:\n\n- [Apps](/docs/apps.md)\n- [Spec](spec/1.0.md)\n- [Github](https://github.com/obsidianmd/jsoncanvas)","x":40,"y":-440,"width":250,"height":160},
		{"id":"0ba565e7f30e0652","type":"file","file":"spec/1.0.md","x":360,"y":-400,"width":400,"height":400}
	],
	"edges":[
		{"id":"6fa11ab87f90b8af","fromNode":"7efdbbe0c4742315","fromSide":"right","toNode":"59e896bc8da20699","toSide":"left"}
	]
}"#;

fn assert_valid_resvg_svg(svg: &str) -> (u32, u32, usize) {
    let xml = roxmltree::Document::parse(svg).expect("SVG must be well-formed XML");
    assert_eq!(xml.root_element().tag_name().name(), "svg");
    assert!(
        !xml.descendants().any(|n| n.tag_name().name().eq_ignore_ascii_case("foreignObject")),
        "pure SVG renderer must never emit <foreignObject>"
    );

    let opts = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_str(svg, &opts).expect("SVG must parse cleanly in usvg/resvg");
    let size = tree.size().to_int_size();
    let mut pixmap = resvg::tiny_skia::Pixmap::new(size.width(), size.height()).expect("allocate pixmap");
    resvg::render(&tree, resvg::tiny_skia::Transform::default(), &mut pixmap.as_mut());

    let mut distinct = HashSet::new();
    for px in pixmap.pixels() {
        distinct.insert((px.red(), px.green(), px.blue(), px.alpha()));
    }
    (size.width(), size.height(), distinct.len())
}

#[test]
fn official_sample_renders_resvg_safe_in_light_and_dark_themes() {
    let canvas = Canvas::from_json_str(OFFICIAL_SAMPLE_CANVAS).unwrap();

    let light_svg = render_svg(&canvas, &SvgRenderOptions::light());
    let (lw, lh, l_colors) = assert_valid_resvg_svg(&light_svg);
    assert!(lw > 400 && lh > 400);
    assert!(l_colors >= 6, "light theme must render background, grid, cards, borders, edges");
    assert!(light_svg.contains("JSON Canvas"));
    assert!(light_svg.contains("readme.md"));
    assert!(light_svg.contains("<polygon"));

    let dark_svg = render_svg(&canvas, &SvgRenderOptions::dark());
    let (dw, dh, d_colors) = assert_valid_resvg_svg(&dark_svg);
    assert_eq!((dw, dh), (lw, lh));
    assert!(d_colors >= 6);
    assert!(dark_svg.contains("#111113"));
    assert_ne!(light_svg, dark_svg);
}

#[test]
fn renders_all_six_presets_hex_colors_groups_dashed_edges_and_labels() {
    let mut canvas = Canvas::new();

    for (idx, preset) in PresetColor::ALL.iter().enumerate() {
        let x = (idx as i64 % 3) * 260;
        let y = (idx as i64 / 3) * 160;
        canvas.nodes.push(
            Node::text(
                format!("p{}", preset.as_code()),
                NodeBounds::new(x, y, 220, 120),
                format!("# Preset {}\n\n- Item A\n- Item B", preset.as_code()),
            )
            .with_color(CanvasColor::Preset(*preset)),
        );
    }

    canvas.nodes.push(Node::Group(GroupNode {
        id: NodeId::from("g-cover"),
        x: -30,
        y: -40,
        width: 820,
        height: 360,
        color: Some(CanvasColor::hex("#2563EB").unwrap()),
        label: Some("Preset Matrix".into()),
        background: Some("textures/cover.png".into()),
        background_style: Some(BackgroundStyle::Cover),
        extensions: Default::default(),
    }));
    canvas.nodes.push(Node::Group(GroupNode {
        id: NodeId::from("g-ratio"),
        x: 840,
        y: -40,
        width: 240,
        height: 160,
        color: None,
        label: Some("Ratio Group".into()),
        background: Some("textures/ratio.png".into()),
        background_style: Some(BackgroundStyle::Ratio),
        extensions: Default::default(),
    }));
    canvas.nodes.push(Node::Group(GroupNode {
        id: NodeId::from("g-repeat"),
        x: 840,
        y: 160,
        width: 240,
        height: 160,
        color: Some(CanvasColor::Preset(PresetColor::Yellow)),
        label: Some("Repeat Group".into()),
        background: Some("textures/tile.png".into()),
        background_style: Some(BackgroundStyle::Repeat),
        extensions: Default::default(),
    }));
    canvas.nodes.push(Node::File(FileNode {
        id: NodeId::from("f-sub"),
        x: 860,
        y: -10,
        width: 200,
        height: 110,
        color: Some(CanvasColor::hex("#0f8").unwrap()),
        file: "02_Areas/design/architecture.md".into(),
        subpath: Some("#svg-renderer".into()),
        extensions: Default::default(),
    }));
    canvas
        .nodes
        .push(Node::link("l-ext", NodeBounds::new(860, 190, 200, 100), "https://vibevalley.dev/docs/canvas").with_color(CanvasColor::hex("#a855f7").unwrap()));

    canvas.edges.push(
        Edge::new("solid-edge", "p1", "p2")
            .with_sides(Some(Side::Right), Some(Side::Left))
            .with_ends(Some(End::None), Some(End::Arrow))
            .with_label("solid"),
    );
    canvas.edges.push(
        Edge::new("dashed-edge", "p2", "f-sub")
            .with_ends(Some(End::Arrow), Some(End::Arrow))
            .with_color(CanvasColor::Preset(PresetColor::Red))
            .with_label("dashed"),
    );
    canvas.edges.push(Edge::new("no-arrow", "p4", "p5").with_ends(Some(End::None), Some(End::None)));
    canvas.edges.push(Edge::new("self-loop", "l-ext", "l-ext").with_label("loop"));

    let mut opts = SvgRenderOptions::light();
    opts.dashed_edges.insert(EdgeId::from("dashed-edge"));
    let svg = render_svg(&canvas, &opts);
    let (_, _, colors) = assert_valid_resvg_svg(&svg);
    assert!(colors >= 10);
    assert!(svg.contains("stroke-dasharray=\"6.0 4.0\""));
    assert!(svg.contains("#svg-renderer"));
    assert!(svg.contains("vibevalley.dev"));
    assert!(svg.contains("Preset Matrix"));
    assert!(svg.contains(">dashed</text>"));
    assert!(svg.contains(">solid</text>"));

    let mut global_dashed = SvgRenderOptions::dark();
    global_dashed.edge_stroke = EdgeStrokeStyle::Dashed { dash: 8.0, gap: 4.0 };
    let svg_dark = render_svg(&canvas, &global_dashed);
    assert_valid_resvg_svg(&svg_dark);
    assert!(svg_dark.contains("stroke-dasharray=\"8.0 4.0\""));
}

#[test]
fn escapes_xml_special_characters_and_handles_unicode_wrapping() {
    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::text(
        r#"id<"1">&'test'"#,
        NodeBounds::new(0, 0, 180, 140),
        "## <script> & \"quotes\"\n\n中文自动换行测试一段很长的说明文字确保按字符边界安全切分而不出现越界崩溃 [VibeValley](https://vibevalley.dev)",
    ));
    canvas.nodes.push(Node::text("n2", NodeBounds::new(260, 0, 180, 140), "A & B < C > D"));
    canvas.edges.push(Edge::new(r#"e<"1">"#, r#"id<"1">&'test'"#, "n2").with_label("x < y & z > 0"));

    let svg = render_svg_default(&canvas);
    assert_valid_resvg_svg(&svg);
    assert!(!svg.contains("<script>"));
    assert!(svg.contains("&lt;script&gt;"));
    assert!(svg.contains("x &lt; y &amp; z &gt; 0"));
}

#[test]
fn empty_canvas_and_explicit_thumbnail_size_render_cleanly() {
    let empty = Canvas::new();
    let svg = render_svg_default(&empty);
    let (w, h, _) = assert_valid_resvg_svg(&svg);
    assert_eq!((w, h), (400, 300));

    let canvas = Canvas::from_json_str(OFFICIAL_SAMPLE_CANVAS).unwrap();
    let thumb_opts = SvgRenderOptions {
        theme: SvgTheme::Dark,
        explicit_size: Some((320, 180)),
        show_grid: false,
        ..SvgRenderOptions::default()
    };
    let thumb_svg = render_svg(&canvas, &thumb_opts);
    let (tw, th, colors) = assert_valid_resvg_svg(&thumb_svg);
    assert_eq!((tw, th), (320, 180));
    assert!(colors >= 4);
}

#[test]
fn handles_tiny_nodes_empty_text_custom_url_schemes_and_dangling_edges_gracefully() {
    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::text("tiny", NodeBounds::new(0, 0, 12, 12), ""));
    canvas.nodes.push(Node::group("unlabeled", NodeBounds::new(40, 0, 80, 60), None));
    canvas.nodes.push(Node::file("bare", NodeBounds::new(140, 0, 160, 60), "README.md"));
    canvas
        .nodes
        .push(Node::link("mail", NodeBounds::new(320, 0, 200, 60), "mailto:hello@vibevalley.dev"));
    canvas.edges.push(Edge::new("dangling", "tiny", "missing-node"));

    let svg = render_svg_default(&canvas);
    assert_valid_resvg_svg(&svg);
    assert!(svg.contains("README.md"));
    assert!(svg.contains("mailto:hello@vibevalley.dev"));
}
