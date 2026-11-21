use serde::{Deserialize, Serialize};
use vibevalley_rich::engine::canvas::{
    BackgroundStyle, Canvas, CanvasColor, CanvasError, Edge, EdgeId, End, ExtensionFields, FileNode, GroupNode, LinkNode, Node, NodeBounds, NodeId,
    PresetColor, Side, TextNode, ValidationIssue, parse_hex_rgba, validate,
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

#[test]
fn official_sample_canvas_round_trips_and_preserves_z_order() {
    let canvas = Canvas::from_json_str(OFFICIAL_SAMPLE_CANVAS).expect("official sample.canvas must parse and validate");
    assert_eq!(canvas.nodes.len(), 5);
    assert_eq!(canvas.edges.len(), 1);

    let ids: Vec<&str> = canvas.nodes.iter().map(|n| n.id().as_str()).collect();
    assert_eq!(
        ids,
        vec![
            "754a8ef995f366bc",
            "8132d4d894c80022",
            "7efdbbe0c4742315",
            "59e896bc8da20699",
            "0ba565e7f30e0652",
        ]
    );

    let group = canvas.nodes[0].as_group().expect("first node is group");
    assert_eq!(group.x, -300);
    assert_eq!(group.y, -460);
    assert_eq!(group.width, 610);
    assert_eq!(group.height, 200);
    assert_eq!(group.label.as_deref(), Some("JSON Canvas"));

    let colored_file = canvas.nodes[1].as_file().expect("second node is file");
    assert_eq!(colored_file.color, Some(CanvasColor::Preset(PresetColor::Purple)));
    assert_eq!(colored_file.file, "readme.md");

    let edge = &canvas.edges[0];
    assert_eq!(edge.id, "6fa11ab87f90b8af");
    assert_eq!(edge.from_side, Some(Side::Right));
    assert_eq!(edge.to_side, Some(Side::Left));
    assert_eq!(edge.from_end, None);
    assert_eq!(edge.to_end, None);
    assert_eq!(edge.effective_from_end(), End::None);
    assert_eq!(edge.effective_to_end(), End::Arrow);

    let encoded = canvas.to_json_string_pretty().expect("serialize");
    let decoded = Canvas::from_json_str(&encoded).expect("re-parse");
    assert_eq!(decoded, canvas);
    assert!(!encoded.contains("\"fromEnd\""));
    assert!(!encoded.contains("\"toEnd\""));
}

#[test]
fn top_level_arrays_are_optional() {
    assert_eq!(Canvas::from_json_str("{}").expect("empty object"), Canvas::new());
    assert_eq!(Canvas::from_json_str(r#"{"nodes":[]}"#).expect("nodes only"), Canvas::new());
    assert_eq!(Canvas::from_json_str(r#"{"edges":[]}"#).expect("edges only"), Canvas::new());
    assert_eq!(Canvas::from_json_str(r#"{"nodes":[],"edges":[]}"#).expect("both empty"), Canvas::new());
}

#[test]
fn all_node_types_edges_and_colors_round_trip() {
    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::Text(TextNode {
        id: NodeId::from("t1"),
        x: -100,
        y: -50,
        width: 240,
        height: 120,
        color: Some(CanvasColor::Preset(PresetColor::Red)),
        text: "# Title\n\nBody with 中文 and *Markdown*.".into(),
        extensions: ExtensionFields::new(),
    }));
    canvas.nodes.push(Node::File(FileNode {
        id: NodeId::from("f1"),
        x: 200,
        y: 0,
        width: 300,
        height: 180,
        color: Some(CanvasColor::hex("#3366FF").unwrap()),
        file: "01_Projects/plan.md".into(),
        subpath: Some("#milestones".into()),
        extensions: ExtensionFields::new(),
    }));
    canvas.nodes.push(Node::Link(LinkNode {
        id: NodeId::from("l1"),
        x: 560,
        y: 20,
        width: 260,
        height: 100,
        color: Some(CanvasColor::hex("#0f8").unwrap()),
        url: "https://jsoncanvas.org/spec/1.0/".into(),
        extensions: ExtensionFields::new(),
    }));
    canvas.nodes.push(Node::Group(GroupNode {
        id: NodeId::from("g1"),
        x: -140,
        y: -100,
        width: 1000,
        height: 400,
        color: Some(CanvasColor::hex("#FF00AA80").unwrap()),
        label: Some("Architecture".into()),
        background: Some("assets/bg.png".into()),
        background_style: Some(BackgroundStyle::Repeat),
        extensions: ExtensionFields::new(),
    }));

    canvas.edges.push(Edge {
        id: EdgeId::from("e1"),
        from_node: NodeId::from("t1"),
        from_side: Some(Side::Right),
        from_end: Some(End::Arrow),
        to_node: NodeId::from("f1"),
        to_side: Some(Side::Left),
        to_end: Some(End::None),
        color: Some(CanvasColor::Preset(PresetColor::Cyan)),
        label: Some("depends on".into()),
        extensions: ExtensionFields::new(),
    });
    canvas.edges.push(Edge::new("e2", "l1", "l1").with_sides(Some(Side::Top), Some(Side::Right)));

    validate(&canvas).expect("valid canvas");
    let json = canvas.to_json_string().expect("serialize");
    let parsed = Canvas::from_json_str(&json).expect("re-parse");
    assert_eq!(parsed, canvas);
}

#[test]
fn preset_and_hex_colors_parse_and_reject_invalid() {
    let expected = [
        ("1", PresetColor::Red),
        ("2", PresetColor::Orange),
        ("3", PresetColor::Yellow),
        ("4", PresetColor::Green),
        ("5", PresetColor::Cyan),
        ("6", PresetColor::Purple),
    ];
    for (code, preset) in expected {
        let parsed: CanvasColor = code.parse().expect("valid preset");
        assert_eq!(parsed, CanvasColor::Preset(preset));
        assert_eq!(parsed.as_str(), code);
    }

    assert_eq!(parse_hex_rgba("#f0a").map(|c| (c.r, c.g, c.b, c.a)), Some((255, 0, 170, 255)));
    assert_eq!(parse_hex_rgba("#f0a8").map(|c| (c.r, c.g, c.b, c.a)), Some((255, 0, 170, 136)));
    assert_eq!(parse_hex_rgba("#123456").map(|c| (c.r, c.g, c.b, c.a)), Some((0x12, 0x34, 0x56, 255)));
    assert_eq!(parse_hex_rgba("#12345678").map(|c| (c.r, c.g, c.b, c.a)), Some((0x12, 0x34, 0x56, 0x78)));

    for bad in ["0", "7", "red", "FF0000", "#12", "#12345", "#1234567", "#123456789", "#GGGGGG", ""] {
        assert!(bad.parse::<CanvasColor>().is_err(), "{bad:?} must be rejected");
        let raw = format!(r#"{{"nodes":[{{"id":"n1","type":"text","x":0,"y":0,"width":100,"height":50,"color":"{bad}","text":"x"}}]}}"#);
        assert!(Canvas::from_json_str(&raw).is_err(), "JSON color {bad:?} must fail");
    }
}

#[test]
fn rejects_non_integer_node_coordinates_and_unknown_node_types() {
    let float_x = r#"{"nodes":[{"id":"n1","type":"text","x":10.5,"y":0,"width":100,"height":50,"text":"x"}]}"#;
    assert!(matches!(Canvas::from_json_str(float_x), Err(CanvasError::Json(_))));

    let float_width = r#"{"nodes":[{"id":"n1","type":"text","x":0,"y":0,"width":100.25,"height":50,"text":"x"}]}"#;
    assert!(matches!(Canvas::from_json_str(float_width), Err(CanvasError::Json(_))));

    let bad_type = r#"{"nodes":[{"id":"n1","type":"sticky","x":0,"y":0,"width":100,"height":50}]}"#;
    assert!(matches!(Canvas::from_json_str(bad_type), Err(CanvasError::Json(_))));

    let bad_side = r#"{"nodes":[{"id":"a","type":"text","x":0,"y":0,"width":10,"height":10,"text":""}],"edges":[{"id":"e","fromNode":"a","fromSide":"center","toNode":"a"}]}"#;
    assert!(matches!(Canvas::from_json_str(bad_side), Err(CanvasError::Json(_))));

    let bad_bg_style = r#"{"nodes":[{"id":"g","type":"group","x":0,"y":0,"width":10,"height":10,"backgroundStyle":"stretch"}]}"#;
    assert!(matches!(Canvas::from_json_str(bad_bg_style), Err(CanvasError::Json(_))));
}

#[test]
fn validator_catches_every_spec_violation() {
    let mut canvas = Canvas::new();
    canvas.nodes.push(Node::text("", NodeBounds::new(0, 0, 100, 100), "missing id"));
    canvas.nodes.push(Node::text("dup", NodeBounds::new(0, 0, 0, -5), "bad size"));
    canvas.nodes.push(Node::Text(TextNode {
        id: NodeId::from("dup"),
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        color: Some(CanvasColor::Hex("not-a-hex".into())),
        text: "duplicate + bad hex".into(),
        extensions: ExtensionFields::new(),
    }));
    canvas.nodes.push(Node::File(FileNode {
        id: NodeId::from("bad-file"),
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        color: None,
        file: String::new(),
        subpath: Some("heading-without-hash".into()),
        extensions: ExtensionFields::new(),
    }));
    canvas.nodes.push(Node::File(FileNode {
        id: NodeId::from("bare-hash"),
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        color: None,
        file: "note.md".into(),
        subpath: Some("#".into()),
        extensions: ExtensionFields::new(),
    }));
    canvas.nodes.push(Node::link("bad-link", NodeBounds::new(0, 0, 100, 50), "not a url"));
    canvas.nodes.push(Node::Group(GroupNode {
        id: NodeId::from("bad-group"),
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        color: None,
        label: None,
        background: Some(String::new()),
        background_style: Some(BackgroundStyle::Cover),
        extensions: ExtensionFields::new(),
    }));

    canvas.edges.push(Edge::new("", "dup", "bad-link"));
    canvas.edges.push(Edge::new("e1", "ghost-src", "ghost-dst"));
    canvas.edges.push(Edge {
        id: EdgeId::from("e1"),
        from_node: NodeId::from("dup"),
        from_side: None,
        from_end: None,
        to_node: NodeId::from("bad-link"),
        to_side: None,
        to_end: None,
        color: Some(CanvasColor::Hex("#12345".into())),
        label: None,
        extensions: ExtensionFields::new(),
    });

    let report = validate(&canvas).expect_err("must report all violations");
    let issues = report.issues();
    assert!(issues.iter().any(|i| matches!(i, ValidationIssue::EmptyNodeId { index: 0 })));
    assert!(issues.iter().any(|i| matches!(
        i,
        ValidationIssue::NonPositiveNodeDimensions { id, width: 0, height: -5 } if id == "dup"
    )));
    assert!(issues.iter().any(|i| matches!(
        i,
        ValidationIssue::DuplicateNodeId { id, first_index: 1, duplicate_index: 2 } if id == "dup"
    )));
    assert!(issues.iter().any(|i| matches!(i, ValidationIssue::InvalidNodeColor { id, .. } if id == "dup")));
    assert!(issues.iter().any(|i| matches!(i, ValidationIssue::EmptyFilePath { id } if id == "bad-file")));
    assert!(
        issues
            .iter()
            .any(|i| matches!(i, ValidationIssue::InvalidFileSubpath { id, .. } if id == "bad-file"))
    );
    assert!(
        issues
            .iter()
            .any(|i| matches!(i, ValidationIssue::InvalidFileSubpath { id, .. } if id == "bare-hash"))
    );
    assert!(
        issues
            .iter()
            .any(|i| matches!(i, ValidationIssue::InvalidLinkUrl { id, .. } if id == "bad-link"))
    );
    assert!(
        issues
            .iter()
            .any(|i| matches!(i, ValidationIssue::EmptyGroupBackground { id } if id == "bad-group"))
    );
    assert!(issues.iter().any(|i| matches!(i, ValidationIssue::EmptyEdgeId { index: 0 })));
    assert!(issues.iter().any(|i| matches!(
        i,
        ValidationIssue::DanglingEdgeSource { edge_id, missing_node } if edge_id == "e1" && missing_node == "ghost-src"
    )));
    assert!(issues.iter().any(|i| matches!(
        i,
        ValidationIssue::DanglingEdgeTarget { edge_id, missing_node } if edge_id == "e1" && missing_node == "ghost-dst"
    )));
    assert!(issues.iter().any(|i| matches!(
        i,
        ValidationIssue::DuplicateEdgeId { id, first_index: 1, duplicate_index: 2 } if id == "e1"
    )));
    assert!(issues.iter().any(|i| matches!(i, ValidationIssue::InvalidEdgeColor { id, .. } if id == "e1")));
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct PluginStyleExt {
    border: String,
    opacity: f64,
    locked: bool,
    tags: Vec<String>,
}

#[test]
fn preserves_unknown_extension_fields_losslessly_and_typed() {
    let raw = r#"{
        "nodes": [
            {
                "id": "n1",
                "type": "text",
                "x": 10,
                "y": 20,
                "width": 200,
                "height": 100,
                "text": "Hello",
                "styleAttributes": {"border": "dashed", "opacity": 0.75, "locked": true, "tags": ["a", "b"]},
                "customNull": null
            }
        ],
        "edges": [
            {
                "id": "e1",
                "fromNode": "n1",
                "toNode": "n1",
                "edgeMeta": {"weight": 42}
            }
        ],
        "canvasMeta": {"app": "obsidian", "version": 2}
    }"#;

    let mut canvas = Canvas::from_json_str(raw).expect("parse with extensions");
    assert!(canvas.extensions.contains_key("canvasMeta"));
    assert!(canvas.nodes[0].extensions().contains_key("styleAttributes"));
    assert!(canvas.nodes[0].extensions().contains_key("customNull"));
    assert!(canvas.edges[0].extensions.contains_key("edgeMeta"));

    let style: PluginStyleExt = canvas.nodes[0].extensions().get_as("styleAttributes").expect("typed decode").expect("present");
    assert_eq!(
        style,
        PluginStyleExt {
            border: "dashed".into(),
            opacity: 0.75,
            locked: true,
            tags: vec!["a".into(), "b".into()],
        }
    );

    let reserialized = canvas.to_json_string().expect("serialize");
    let reparsed = Canvas::from_json_str(&reserialized).expect("reparse");
    assert_eq!(reparsed, canvas);

    canvas.strip_extensions();
    assert!(canvas.extensions.is_empty());
    assert!(canvas.nodes[0].extensions().is_empty());
    assert!(canvas.edges[0].extensions.is_empty());
}

#[test]
fn group_background_styles_all_decode() {
    for (wire, expected) in [
        ("cover", BackgroundStyle::Cover),
        ("ratio", BackgroundStyle::Ratio),
        ("repeat", BackgroundStyle::Repeat),
    ] {
        let json =
            format!(r#"{{"nodes":[{{"id":"g","type":"group","x":0,"y":0,"width":200,"height":200,"background":"img.png","backgroundStyle":"{wire}"}}]}}"#);
        let canvas = Canvas::from_json_str(&json).expect("valid group");
        assert_eq!(canvas.nodes[0].as_group().unwrap().background_style, Some(expected));
    }
}

#[test]
fn extension_fields_api_and_numeric_edge_cases() {
    let mut ext = ExtensionFields::new();
    assert!(ext.is_empty());
    assert!(ext.insert_as("", &123).is_err());
    ext.insert_as("negZero", &-0.0_f64).unwrap();
    ext.insert_as("posZero", &0.0_f64).unwrap();
    ext.insert_as("u64Max", &u64::MAX).unwrap();
    ext.insert_as("i64Min", &i64::MIN).unwrap();
    assert_eq!(ext.len(), 4);
    assert_eq!(ext.get_as::<u64>("u64Max").unwrap(), Some(u64::MAX));
    assert_eq!(ext.get_as::<i64>("i64Min").unwrap(), Some(i64::MIN));
    assert_eq!(ext.get_as::<String>("missing").unwrap(), None);
    assert!(ext.get_as::<String>("u64Max").is_err());

    let mut a = ExtensionFields::new();
    let mut b = ExtensionFields::new();
    a.insert_as("z", &-0.0_f64).unwrap();
    b.insert_as("z", &0.0_f64).unwrap();
    assert_eq!(a, b);

    assert!(ext.remove("negZero"));
    assert!(!ext.remove("negZero"));
    let keys: Vec<&str> = ext.keys().collect();
    assert_eq!(keys, vec!["i64Min", "posZero", "u64Max"]);
}

#[test]
fn url_validation_accepts_schemes_and_rejects_malformed() {
    for valid in [
        "https://obsidian.md",
        "http://127.0.0.1:8787/api/v1",
        "obsidian://open?vault=notes",
        "vv://issue/42",
        "mailto:team@vibevalley.dev",
    ] {
        let json = format!(r#"{{"nodes":[{{"id":"l","type":"link","x":0,"y":0,"width":100,"height":50,"url":"{valid}"}}]}}"#);
        assert!(Canvas::from_json_str(&json).is_ok(), "{valid:?} should be valid");
    }

    for invalid in ["", "example.com", "https://", "://no-scheme", "123://digit-scheme", "https://has space"] {
        let json = format!(r#"{{"nodes":[{{"id":"l","type":"link","x":0,"y":0,"width":100,"height":50,"url":"{invalid}"}}]}}"#);
        assert!(Canvas::from_json_str(&json).is_err(), "{invalid:?} should be rejected");
    }
}
