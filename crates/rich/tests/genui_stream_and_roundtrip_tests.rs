use std::collections::BTreeMap;

use vibevalley_rich::engine::genui::{
    Align, CalloutKind, CategoryBinding, ChartKind, ChartSeriesBinding, ChartSource, ExprSource, FieldPatch, FormatKind, GenUiError, GenUiNode, GenUiRuntime,
    GenUiSpec, GenUiStream, NodeKind, PatchOp, PropsPatch, RuntimeLimits, SelectOption, SeriesValuesBinding, StackDirection, StateValue, StreamEvent,
    StreamLimits, TabItem, TableColumn, TableRows, TextAlign, TextExpr, TextSize, Tone, ValueExpr,
};

#[test]
fn stream_recovers_from_malformed_oversized_and_invalid_utf8_chunks() {
    let mut stream = GenUiStream::with_limits(StreamLimits {
        max_line_bytes: 128,
        max_patches: 20,
    });

    let mut events = Vec::new();
    events.extend(stream.push_chunk("\u{feff}{\"op\":\"title\",\"title\":\"Safe\"}\r\n"));
    events.extend(stream.push_chunk("{not valid json}\n"));
    events.extend(stream.push_chunk(&"x".repeat(200)));
    events.extend(stream.push_chunk("tail-of-oversized\n"));
    events.extend(stream.push_chunk("\n   \n"));
    events.extend(stream.push_bytes(&[0xff, 0xfe]));
    events.extend(stream.push_chunk("{\"op\":\"set_node\",\"root\":true,\"node\":{\"id\":\"t1\",\"kind\":\"text\",\"value\":\"recovered\"}}\n"));
    events.extend(stream.push_chunk("{\"op\":\"done\"}\n"));
    events.extend(stream.push_chunk("{\"op\":\"title\",\"title\":\"late\"}\n"));
    events.extend(stream.finish());

    assert!(stream.is_complete());
    assert_eq!(stream.node_generation("t1"), Some(2));

    let mut patch_count = 0usize;
    let mut complete_count = 0usize;
    let mut saw_invalid_json = false;
    let mut saw_line_too_long = false;
    let mut saw_invalid_utf8 = false;
    let mut saw_already_complete = false;

    for ev in events {
        match ev {
            StreamEvent::Patch { .. } => patch_count += 1,
            StreamEvent::Complete { .. } => complete_count += 1,
            StreamEvent::Error { error, .. } => match error {
                GenUiError::InvalidPatchJson { .. } => saw_invalid_json = true,
                GenUiError::LineTooLong { limit: 128 } => saw_line_too_long = true,
                GenUiError::InvalidUtf8 => saw_invalid_utf8 = true,
                GenUiError::StreamAlreadyComplete => saw_already_complete = true,
                other => panic!("unexpected error variant: {other:?}"),
            },
        }
    }

    assert_eq!(patch_count, 3);
    assert_eq!(complete_count, 1);
    assert!(saw_invalid_json);
    assert!(saw_line_too_long);
    assert!(saw_invalid_utf8);
    assert!(saw_already_complete);
}

#[test]
fn stream_finish_flushes_trailing_line_without_newline_and_detects_truncation() {
    let mut ok_stream = GenUiStream::new();
    assert!(ok_stream.push_chunk("{\"op\":\"done\"}").is_empty());
    assert_eq!(ok_stream.pending_bytes(), 13);
    let flushed = ok_stream.finish();
    assert!(ok_stream.is_complete());
    assert_eq!(flushed.len(), 2);

    let mut truncated = GenUiStream::new();
    assert!(truncated.push_chunk("{\"op\":\"title\",\"title\":\"unclosed").is_empty());
    let errs = truncated.finish();
    assert_eq!(errs.len(), 1);
    assert!(matches!(
        errs[0],
        StreamEvent::Error {
            error: GenUiError::InvalidPatchJson { .. },
            ..
        }
    ));
}

#[test]
fn runtime_guards_cycles_validation_limits_and_midstream_user_edits() {
    let mut runtime = GenUiRuntime::with_limits(RuntimeLimits {
        max_nodes: 4,
        ..RuntimeLimits::default()
    });

    runtime
        .apply_patch(PatchOp::StateInit {
            state: BTreeMap::from([("rate".to_owned(), StateValue::from(5))]),
            overwrite: false,
        })
        .unwrap();
    runtime.set_state("rate", StateValue::from(9)).unwrap();

    runtime
        .apply_patch(PatchOp::StateInit {
            state: BTreeMap::from([("rate".to_owned(), StateValue::from(5)), ("years".to_owned(), StateValue::from(10))]),
            overwrite: false,
        })
        .unwrap();
    assert_eq!(runtime.state().get("rate"), Some(&StateValue::Number(9.0)));
    assert_eq!(runtime.state().get("years"), Some(&StateValue::Number(10.0)));

    runtime
        .apply_patch(PatchOp::StateInit {
            state: BTreeMap::from([("rate".to_owned(), StateValue::from(6))]),
            overwrite: true,
        })
        .unwrap();
    assert_eq!(runtime.state().get("rate"), Some(&StateValue::Number(6.0)));

    assert!(matches!(
        runtime.set_state("bad", StateValue::Number(f64::NAN)),
        Err(GenUiError::NonFiniteResult { .. })
    ));

    runtime
        .apply_patch(PatchOp::SetNode {
            root: true,
            node: Box::new(GenUiNode::new(
                "a",
                NodeKind::Stack {
                    direction: StackDirection::Vertical,
                    gap: None,
                    align: None,
                    children: vec!["b".to_owned()],
                },
            )),
        })
        .unwrap();

    runtime
        .apply_patch(PatchOp::SetNode {
            root: false,
            node: Box::new(GenUiNode::new(
                "b",
                NodeKind::Card {
                    title: None,
                    subtitle: None,
                    children: vec![],
                },
            )),
        })
        .unwrap();

    assert_eq!(
        runtime.apply_patch(PatchOp::AppendChild {
            parent_id: "b".to_owned(),
            child_id: "a".to_owned(),
            tab_id: None,
            node: None,
        }),
        Err(GenUiError::CycleDetected { node_id: "b".to_owned() })
    );

    runtime
        .apply_patch(PatchOp::AppendChild {
            parent_id: "b".to_owned(),
            child_id: "leaf".to_owned(),
            tab_id: None,
            node: Some(Box::new(GenUiNode::new(
                "leaf",
                NodeKind::Metric {
                    label: TextExpr::from("Ratio"),
                    value: ValueExpr::expr("10 / denom"),
                    delta: None,
                    format: None,
                },
            ))),
        })
        .unwrap();

    assert!(matches!(
        runtime.apply_patch(PatchOp::AppendChild {
            parent_id: "leaf".to_owned(),
            child_id: "x".to_owned(),
            tab_id: None,
            node: None,
        }),
        Err(GenUiError::NotAContainer { .. })
    ));

    assert!(matches!(
        runtime.apply_patch(PatchOp::UpdateProps {
            id: "leaf".to_owned(),
            visible: FieldPatch::Keep,
            props: Box::new(PropsPatch::Text {
                value: Some(TextExpr::from("wrong kind")),
                tone: None,
                size: None,
            }),
        }),
        Err(GenUiError::NodeKindMismatch { .. })
    ));

    assert!(matches!(
        runtime.apply_patch(PatchOp::SetNode {
            root: false,
            node: Box::new(GenUiNode::new(
                "bad_slider",
                NodeKind::Slider {
                    bind: "k".to_owned(),
                    label: TextExpr::from("Bad"),
                    min: 10.0,
                    max: 5.0,
                    step: 1.0,
                    unit: None,
                },
            )),
        }),
        Err(GenUiError::InvalidNodeProp { .. })
    ));

    assert!(matches!(
        runtime.apply_patch(PatchOp::SetNode {
            root: false,
            node: Box::new(GenUiNode::new(
                "bad_grid",
                NodeKind::Grid {
                    columns: 0,
                    gap: None,
                    children: vec![],
                },
            )),
        }),
        Err(GenUiError::InvalidNodeProp { .. })
    ));

    runtime.set_state("denom", StateValue::from(0)).unwrap();
    let resolved = runtime.resolve_tree();
    assert_eq!(resolved.diagnostics.len(), 1);
    assert_eq!(resolved.diagnostics[0].node_id, "leaf");
    assert_eq!(resolved.diagnostics[0].error, GenUiError::DivisionByZero);
    assert_eq!(runtime.try_resolve_tree(), Err(GenUiError::DivisionByZero));

    runtime
        .apply_patch(PatchOp::SetNode {
            root: false,
            node: Box::new(GenUiNode::new("n4", NodeKind::Divider { label: None })),
        })
        .unwrap();
    assert_eq!(
        runtime.apply_patch(PatchOp::SetNode {
            root: false,
            node: Box::new(GenUiNode::new("n5", NodeKind::Divider { label: None })),
        }),
        Err(GenUiError::NodeLimitExceeded { limit: 4 })
    );
}

#[test]
fn exhaustive_serde_roundtrip_for_all_nodes_values_and_patches() {
    let state_values = vec![
        StateValue::Null,
        StateValue::Bool(true),
        StateValue::Bool(false),
        StateValue::Number(0.0),
        StateValue::Number(-42.5),
        StateValue::Text("hello 世界".to_owned()),
        StateValue::List(vec![StateValue::Number(1.0), StateValue::Null, StateValue::from("a")]),
        StateValue::Record(vec![
            ("k1".to_owned(), StateValue::from(10)),
            ("nested".to_owned(), StateValue::List(vec![StateValue::Bool(true)])),
        ]),
    ];
    for val in state_values {
        let json = serde_json::to_string(&val).unwrap();
        let back: StateValue = serde_json::from_str(&json).unwrap();
        assert_eq!(back, val);
    }

    let value_exprs = vec![
        ValueExpr::Literal(StateValue::Null),
        ValueExpr::Literal(StateValue::Bool(true)),
        ValueExpr::Literal(StateValue::Number(99.5)),
        ValueExpr::Literal(StateValue::Text("static text".to_owned())),
        ValueExpr::Expr(ExprSource::new("a + b")),
        ValueExpr::Template(TextExpr::new("Val: ${a}")),
    ];
    for expr in value_exprs {
        let json = serde_json::to_string(&expr).unwrap();
        let back: ValueExpr = serde_json::from_str(&json).unwrap();
        assert_eq!(back, expr);
    }

    let all_nodes = vec![
        GenUiNode::new(
            "n_stack",
            NodeKind::Stack {
                direction: StackDirection::Horizontal,
                gap: Some(8.0),
                align: Some(Align::Center),
                children: vec!["n_grid".to_owned()],
            },
        ),
        GenUiNode::new(
            "n_grid",
            NodeKind::Grid {
                columns: 2,
                gap: Some(12.0),
                children: vec!["n_card".to_owned()],
            },
        ),
        GenUiNode::new(
            "n_card",
            NodeKind::Card {
                title: Some(TextExpr::from("Card")),
                subtitle: Some(TextExpr::from("Sub")),
                children: vec!["n_tabs".to_owned()],
            },
        ),
        GenUiNode::new(
            "n_tabs",
            NodeKind::Tabs {
                bind: "tab".to_owned(),
                tabs: vec![TabItem {
                    id: "t1".to_owned(),
                    label: TextExpr::from("Tab 1"),
                    children: vec!["n_div".to_owned()],
                }],
            },
        ),
        GenUiNode::new(
            "n_div",
            NodeKind::Divider {
                label: Some(TextExpr::from("Section")),
            },
        ),
        GenUiNode::new(
            "n_text",
            NodeKind::Text {
                value: TextExpr::from("Hi ${x}"),
                tone: Tone::Positive,
                size: TextSize::Lg,
            },
        ),
        GenUiNode::new(
            "n_md",
            NodeKind::Markdown {
                text: TextExpr::from("**Bold**"),
            },
        ),
        GenUiNode::new(
            "n_metric",
            NodeKind::Metric {
                label: TextExpr::from("Total"),
                value: ValueExpr::expr("x * 2"),
                delta: Some(TextExpr::from("+5%")),
                format: Some(FormatKind::Currency),
            },
        ),
        GenUiNode::new(
            "n_badge",
            NodeKind::Badge {
                label: TextExpr::from("Live"),
                tone: Tone::Warning,
            },
        ),
        GenUiNode::new(
            "n_progress",
            NodeKind::Progress {
                value: ValueExpr::expr("x"),
                max: ValueExpr::literal(100),
                label: Some(TextExpr::from("${x}%")),
            },
        ),
        GenUiNode::new(
            "n_callout",
            NodeKind::Callout {
                callout_kind: CalloutKind::Success,
                title: Some(TextExpr::from("Done")),
                body: TextExpr::from("All good"),
            },
        ),
        GenUiNode::new(
            "n_table_static",
            NodeKind::Table {
                columns: vec![TableColumn {
                    key: "c".to_owned(),
                    label: TextExpr::from("Col"),
                    align: Some(TextAlign::Right),
                    format: Some(FormatKind::Number),
                }],
                rows: TableRows::Static(vec![vec![TextExpr::from("${x}")]]),
            },
        ),
        GenUiNode::new(
            "n_table_bound",
            NodeKind::Table {
                columns: vec![TableColumn {
                    key: "c".to_owned(),
                    label: TextExpr::from("Col"),
                    align: None,
                    format: None,
                }],
                rows: TableRows::Expr(ExprSource::new("rows")),
            },
        ),
        GenUiNode::new(
            "n_slider",
            NodeKind::Slider {
                bind: "x".to_owned(),
                label: TextExpr::from("X"),
                min: 0.0,
                max: 100.0,
                step: 1.0,
                unit: Some("%".to_owned()),
            },
        ),
        GenUiNode::new(
            "n_switch",
            NodeKind::Switch {
                bind: "flag".to_owned(),
                label: TextExpr::from("Flag"),
            },
        ),
        GenUiNode::new(
            "n_select",
            NodeKind::Select {
                bind: "choice".to_owned(),
                label: TextExpr::from("Choice"),
                options: vec![SelectOption {
                    value: "a".to_owned(),
                    label: TextExpr::from("Option A"),
                }],
            },
        ),
        GenUiNode::new(
            "n_chart_reactive",
            NodeKind::Chart {
                title: Some(TextExpr::from("Chart")),
                subtitle: None,
                width: Some(500),
                height: Some(300),
                source: ChartSource::Reactive {
                    chart_kind: ChartKind::Area,
                    x_label: Some(TextExpr::from("X")),
                    y_label: Some(TextExpr::from("Y")),
                    y_format: Some(FormatKind::Compact),
                    categories: CategoryBinding::Static(vec![TextExpr::from("A"), TextExpr::from("B")]),
                    series: vec![ChartSeriesBinding {
                        name: TextExpr::from("S1"),
                        values: SeriesValuesBinding::Static(vec![Some(1.5), None]),
                        color: Some("#0ea5e9".to_owned()),
                    }],
                },
            },
        ),
        GenUiNode::new(
            "n_chart_tpl",
            NodeKind::Chart {
                title: None,
                subtitle: None,
                width: None,
                height: None,
                source: ChartSource::Template {
                    template: TextExpr::from("{\"type\":\"bar\"}"),
                },
            },
        ),
        GenUiNode::new(
            "n_diagram",
            NodeKind::Diagram {
                source: TextExpr::from("graph TD; A-->B"),
            },
        ),
        GenUiNode::new(
            "n_canvas",
            NodeKind::Canvas {
                data: TextExpr::from("{\"nodes\":[]}"),
            },
        ),
        GenUiNode::new(
            "n_code",
            NodeKind::CodeBlock {
                code: TextExpr::from("fn main() {}"),
                language: Some("rust".to_owned()),
            },
        )
        .with_visible("flag"),
    ];

    for node in &all_nodes {
        let json = serde_json::to_string(node).unwrap();
        let back: GenUiNode = serde_json::from_str(&json).unwrap();
        assert_eq!(&back, node, "round-trip mismatch for node {}", node.id);
    }

    let patches = vec![
        PatchOp::Title {
            title: "T".to_owned(),
            subtitle: Some("S".to_owned()),
        },
        PatchOp::StateInit {
            state: BTreeMap::from([("x".to_owned(), StateValue::from(42))]),
            overwrite: false,
        },
        PatchOp::SetNode {
            node: Box::new(all_nodes[0].clone()),
            root: true,
        },
        PatchOp::AppendChild {
            parent_id: "n_stack".to_owned(),
            child_id: "n_text".to_owned(),
            tab_id: None,
            node: Some(Box::new(all_nodes[5].clone())),
        },
        PatchOp::UpdateProps {
            id: "n_metric".to_owned(),
            visible: FieldPatch::Clear,
            props: Box::new(PropsPatch::Metric {
                label: Some(TextExpr::from("New")),
                value: None,
                delta: FieldPatch::Clear,
                format: FieldPatch::Set(FormatKind::Compact),
            }),
        },
        PatchOp::RemoveNode {
            id: "n_code".to_owned(),
            recursive: true,
        },
        PatchOp::Done,
    ];

    for patch in patches {
        let json = serde_json::to_string(&patch).unwrap();
        let back: PatchOp = serde_json::from_str(&json).unwrap();
        assert_eq!(back, patch);
    }

    let spec = GenUiSpec {
        title: Some("Full".to_owned()),
        subtitle: None,
        root_id: Some("n_stack".to_owned()),
        state: BTreeMap::from([
            ("x".to_owned(), StateValue::from(25)),
            ("flag".to_owned(), StateValue::from(true)),
            ("tab".to_owned(), StateValue::from("t1")),
            ("choice".to_owned(), StateValue::from("a")),
            ("rows".to_owned(), StateValue::List(vec![])),
        ]),
        nodes: all_nodes,
    };
    let spec_json = serde_json::to_string(&spec).unwrap();
    let spec_back: GenUiSpec = serde_json::from_str(&spec_json).unwrap();
    assert_eq!(spec_back, spec);

    let runtime = GenUiRuntime::from_spec(spec_back).unwrap();
    let resolved = runtime.try_resolve_tree().unwrap();
    let resolved_json = serde_json::to_string(&resolved).unwrap();
    let resolved_back = serde_json::from_str(&resolved_json).unwrap();
    assert_eq!(resolved, resolved_back);
}

#[test]
fn update_props_reindexes_dependencies_and_stream_enforces_patch_and_nesting_limits() {
    let mut runtime = GenUiRuntime::new();
    runtime
        .apply_patch(PatchOp::StateInit {
            state: BTreeMap::from([("a".to_owned(), StateValue::from(10)), ("b".to_owned(), StateValue::from(20))]),
            overwrite: true,
        })
        .unwrap();
    runtime
        .apply_patch(PatchOp::SetNode {
            root: true,
            node: Box::new(GenUiNode::new(
                "m1",
                NodeKind::Metric {
                    label: TextExpr::from("Val"),
                    value: ValueExpr::expr("a * 2"),
                    delta: Some(TextExpr::from("old")),
                    format: None,
                },
            )),
        })
        .unwrap();

    assert_eq!(runtime.dependent_nodes("a"), vec!["m1".to_owned()]);
    assert!(runtime.dependent_nodes("b").is_empty());

    let prev_gen = runtime.doc().node_generation("m1").unwrap();
    runtime
        .apply_patch(PatchOp::UpdateProps {
            id: "m1".to_owned(),
            visible: FieldPatch::Keep,
            props: Box::new(PropsPatch::Metric {
                label: None,
                value: Some(ValueExpr::expr("b * 3")),
                delta: FieldPatch::Clear,
                format: FieldPatch::Set(FormatKind::Currency),
            }),
        })
        .unwrap();

    assert!(runtime.doc().node_generation("m1").unwrap() > prev_gen);
    assert!(runtime.dependent_nodes("a").is_empty());
    assert_eq!(runtime.dependent_nodes("b"), vec!["m1".to_owned()]);

    let mut limited = GenUiStream::with_limits(StreamLimits {
        max_line_bytes: 4096,
        max_patches: 2,
    });
    let evs = limited.push_chunk("{\"op\":\"title\",\"title\":\"1\"}\n{\"op\":\"title\",\"title\":\"2\"}\n{\"op\":\"title\",\"title\":\"3\"}\n");
    assert!(matches!(evs[0], StreamEvent::Patch { .. }));
    assert!(matches!(evs[1], StreamEvent::Patch { .. }));
    assert!(matches!(
        evs[2],
        StreamEvent::Error {
            error: GenUiError::PatchLimitExceeded { limit: 2 },
            ..
        }
    ));

    let deeply_nested = format!("{{\"op\":\"state_init\",\"state\":{{\"x\":{}0{}}}}}\n", "[".repeat(200), "]".repeat(200));
    let mut nest_stream = GenUiStream::new();
    let nest_evs = nest_stream.push_chunk(&deeply_nested);
    assert!(matches!(
        nest_evs[0],
        StreamEvent::Error {
            error: GenUiError::InvalidPatchJson { .. },
            ..
        }
    ));
}

#[test]
fn reactive_chart_handles_null_gaps_and_all_props_patches_apply_cleanly() {
    let mut runtime = GenUiRuntime::new();
    runtime
        .apply_patch(PatchOp::StateInit {
            state: BTreeMap::from([(
                "series_data".to_owned(),
                StateValue::List(vec![StateValue::Number(100.0), StateValue::Null, StateValue::Number(150.5)]),
            )]),
            overwrite: true,
        })
        .unwrap();

    runtime
        .apply_patch(PatchOp::SetNode {
            root: true,
            node: Box::new(GenUiNode::new(
                "root",
                NodeKind::Stack {
                    direction: StackDirection::Vertical,
                    gap: Some(8.0),
                    align: Some(Align::Start),
                    children: vec![
                        "grid".to_owned(),
                        "card".to_owned(),
                        "tabs".to_owned(),
                        "div".to_owned(),
                        "txt".to_owned(),
                        "md".to_owned(),
                        "badge".to_owned(),
                        "prog".to_owned(),
                        "call".to_owned(),
                        "tbl".to_owned(),
                        "sld".to_owned(),
                        "sw".to_owned(),
                        "sel".to_owned(),
                        "ch".to_owned(),
                        "diag".to_owned(),
                        "canv".to_owned(),
                        "code".to_owned(),
                    ],
                },
            )),
        })
        .unwrap();

    let extra_nodes = vec![
        GenUiNode::new(
            "grid",
            NodeKind::Grid {
                columns: 2,
                gap: Some(4.0),
                children: vec![],
            },
        ),
        GenUiNode::new(
            "card",
            NodeKind::Card {
                title: Some(TextExpr::from("T")),
                subtitle: Some(TextExpr::from("S")),
                children: vec![],
            },
        ),
        GenUiNode::new(
            "tabs",
            NodeKind::Tabs {
                bind: "t".to_owned(),
                tabs: vec![TabItem {
                    id: "t1".to_owned(),
                    label: TextExpr::from("One"),
                    children: vec![],
                }],
            },
        ),
        GenUiNode::new("div", NodeKind::Divider { label: None }),
        GenUiNode::new(
            "txt",
            NodeKind::Text {
                value: TextExpr::from("a"),
                tone: Tone::Default,
                size: TextSize::Md,
            },
        ),
        GenUiNode::new("md", NodeKind::Markdown { text: TextExpr::from("a") }),
        GenUiNode::new(
            "badge",
            NodeKind::Badge {
                label: TextExpr::from("a"),
                tone: Tone::Default,
            },
        ),
        GenUiNode::new(
            "prog",
            NodeKind::Progress {
                value: ValueExpr::literal(10),
                max: ValueExpr::literal(100),
                label: None,
            },
        ),
        GenUiNode::new(
            "call",
            NodeKind::Callout {
                callout_kind: CalloutKind::Info,
                title: None,
                body: TextExpr::from("a"),
            },
        ),
        GenUiNode::new(
            "tbl",
            NodeKind::Table {
                columns: vec![],
                rows: TableRows::Static(vec![]),
            },
        ),
        GenUiNode::new(
            "sld",
            NodeKind::Slider {
                bind: "v".to_owned(),
                label: TextExpr::from("v"),
                min: 0.0,
                max: 10.0,
                step: 1.0,
                unit: None,
            },
        ),
        GenUiNode::new(
            "sw",
            NodeKind::Switch {
                bind: "b".to_owned(),
                label: TextExpr::from("b"),
            },
        ),
        GenUiNode::new(
            "sel",
            NodeKind::Select {
                bind: "s".to_owned(),
                label: TextExpr::from("s"),
                options: vec![],
            },
        ),
        GenUiNode::new(
            "ch",
            NodeKind::Chart {
                title: Some(TextExpr::from("Sparse")),
                subtitle: None,
                width: None,
                height: None,
                source: ChartSource::Reactive {
                    chart_kind: ChartKind::Line,
                    x_label: None,
                    y_label: None,
                    y_format: None,
                    categories: CategoryBinding::Static(vec![TextExpr::from("Jan"), TextExpr::from("Feb"), TextExpr::from("Mar")]),
                    series: vec![ChartSeriesBinding {
                        name: TextExpr::from("Metrics"),
                        values: SeriesValuesBinding::Expr(ExprSource::new("series_data")),
                        color: None,
                    }],
                },
            },
        ),
        GenUiNode::new(
            "diag",
            NodeKind::Diagram {
                source: TextExpr::from("graph LR; A-->B"),
            },
        ),
        GenUiNode::new("canv", NodeKind::Canvas { data: TextExpr::from("{}") }),
        GenUiNode::new(
            "code",
            NodeKind::CodeBlock {
                code: TextExpr::from("let x = 1;"),
                language: None,
            },
        ),
    ];

    for node in extra_nodes {
        runtime
            .apply_patch(PatchOp::SetNode {
                root: false,
                node: Box::new(node),
            })
            .unwrap();
    }

    let updates: Vec<(&str, PropsPatch)> = vec![
        (
            "root",
            PropsPatch::Stack {
                direction: Some(StackDirection::Horizontal),
                gap: FieldPatch::Set(16.0),
                align: FieldPatch::Clear,
                children: None,
            },
        ),
        (
            "grid",
            PropsPatch::Grid {
                columns: Some(3),
                gap: FieldPatch::Clear,
                children: None,
            },
        ),
        (
            "card",
            PropsPatch::Card {
                title: FieldPatch::Set(TextExpr::from("Updated")),
                subtitle: FieldPatch::Clear,
                children: None,
            },
        ),
        (
            "tabs",
            PropsPatch::Tabs {
                bind: Some("t2".to_owned()),
                tabs: None,
            },
        ),
        (
            "div",
            PropsPatch::Divider {
                label: FieldPatch::Set(TextExpr::from("Sep")),
            },
        ),
        (
            "txt",
            PropsPatch::Text {
                value: Some(TextExpr::from("b")),
                tone: Some(Tone::Danger),
                size: Some(TextSize::Xl),
            },
        ),
        (
            "md",
            PropsPatch::Markdown {
                text: Some(TextExpr::from("# Heading")),
            },
        ),
        (
            "badge",
            PropsPatch::Badge {
                label: Some(TextExpr::from("OK")),
                tone: Some(Tone::Positive),
            },
        ),
        (
            "prog",
            PropsPatch::Progress {
                value: Some(ValueExpr::literal(50)),
                max: Some(ValueExpr::literal(200)),
                label: FieldPatch::Set(TextExpr::from("25%")),
            },
        ),
        (
            "call",
            PropsPatch::Callout {
                callout_kind: Some(CalloutKind::Warning),
                title: FieldPatch::Set(TextExpr::from("Warn")),
                body: Some(TextExpr::from("Check")),
            },
        ),
        (
            "tbl",
            PropsPatch::Table {
                columns: Some(vec![TableColumn {
                    key: "k".to_owned(),
                    label: TextExpr::from("K"),
                    align: None,
                    format: None,
                }]),
                rows: Some(TableRows::Static(vec![vec![TextExpr::from("v")]])),
            },
        ),
        (
            "sld",
            PropsPatch::Slider {
                bind: None,
                label: Some(TextExpr::from("V2")),
                min: Some(1.0),
                max: Some(20.0),
                step: Some(0.5),
                unit: FieldPatch::Set("ms".to_owned()),
            },
        ),
        (
            "sw",
            PropsPatch::Switch {
                bind: None,
                label: Some(TextExpr::from("B2")),
            },
        ),
        (
            "sel",
            PropsPatch::Select {
                bind: None,
                label: Some(TextExpr::from("S2")),
                options: Some(vec![SelectOption {
                    value: "x".to_owned(),
                    label: TextExpr::from("X"),
                }]),
            },
        ),
        (
            "ch",
            PropsPatch::Chart {
                title: FieldPatch::Set(TextExpr::from("Sparse Updated")),
                subtitle: FieldPatch::Keep,
                width: FieldPatch::Set(480),
                height: FieldPatch::Set(240),
                source: None,
            },
        ),
        (
            "diag",
            PropsPatch::Diagram {
                source: Some(TextExpr::from("graph TD; X-->Y")),
            },
        ),
        (
            "canv",
            PropsPatch::Canvas {
                data: Some(TextExpr::from("{\"v\":2}")),
            },
        ),
        (
            "code",
            PropsPatch::CodeBlock {
                code: Some(TextExpr::from("let y = 2;")),
                language: FieldPatch::Set("rust".to_owned()),
            },
        ),
    ];

    for (id, patch) in updates {
        runtime
            .apply_patch(PatchOp::UpdateProps {
                id: id.to_owned(),
                visible: FieldPatch::Keep,
                props: Box::new(patch),
            })
            .unwrap();
    }

    let resolved = runtime.try_resolve_tree().unwrap();
    let ch = resolved.find_node("ch").unwrap();
    if let vibevalley_rich::engine::genui::ResolvedNodeKind::Chart(chart) = &ch.kind {
        assert_eq!(chart.title.as_deref(), Some("Sparse Updated"));
        let json = chart.to_chart_spec_json().unwrap();
        assert!(json.contains("\"type\":\"line\""));
        assert!(json.contains("\"categories\":[\"Jan\",\"Feb\",\"Mar\"]"));
        assert!(json.contains("[100.0,null,150.5]"));
        assert!(!json.contains("\"xAxis\""));
        assert!(!json.contains("\"yAxis\""));
    } else {
        panic!("expected Chart");
    }
}

#[test]
fn to_chart_spec_json_matches_vibevalley_chart_for_all_eight_chart_kinds() {
    use vibevalley_rich::engine::genui::{ResolvedChart, ResolvedChartContent, ResolvedChartSeries, ResolvedReactiveChart};

    let make_chart = |chart_kind: ChartKind,
                      x_label: Option<&str>,
                      y_label: Option<&str>,
                      y_format: Option<FormatKind>,
                      categories: Vec<&str>,
                      series: Vec<ResolvedChartSeries>| {
        ResolvedChart {
            title: Some("Sample".to_owned()),
            subtitle: None,
            width: Some(500),
            height: Some(300),
            content: ResolvedChartContent::Reactive(ResolvedReactiveChart {
                chart_kind,
                x_label: x_label.map(str::to_owned),
                y_label: y_label.map(str::to_owned),
                y_format,
                categories: categories.into_iter().map(str::to_owned).collect(),
                series,
            }),
        }
    };

    for (kind, expected_type) in [(ChartKind::Line, "line"), (ChartKind::Area, "area"), (ChartKind::Bar, "bar")] {
        let chart = make_chart(
            kind,
            Some("Quarter"),
            Some("Revenue"),
            Some(FormatKind::Currency),
            vec!["Q1", "Q2"],
            vec![ResolvedChartSeries {
                name: "ARR".to_owned(),
                values: vec![Some(10.0), Some(20.0)],
                color: Some("#2563eb".to_owned()),
            }],
        );
        let json = chart.to_chart_spec_json().unwrap();
        assert_eq!(
            json,
            format!(
                "{{\"type\":\"{expected_type}\",\"title\":\"Sample\",\"width\":500,\"height\":300,\"categories\":[\"Q1\",\"Q2\"],\"xAxis\":{{\"label\":\"Quarter\"}},\"yAxis\":{{\"label\":\"Revenue\",\"format\":\"currency\"}},\"series\":[{{\"name\":\"ARR\",\"data\":[10.0,20.0],\"color\":\"#2563eb\"}}]}}"
            )
        );
    }

    let stacked = make_chart(
        ChartKind::StackedBar,
        None,
        None,
        None,
        vec!["Q1", "Q2"],
        vec![ResolvedChartSeries {
            name: "A".to_owned(),
            values: vec![Some(5.0), Some(15.0)],
            color: None,
        }],
    );
    assert_eq!(
        stacked.to_chart_spec_json().unwrap(),
        "{\"type\":\"bar\",\"mode\":\"stacked\",\"title\":\"Sample\",\"width\":500,\"height\":300,\"categories\":[\"Q1\",\"Q2\"],\"series\":[{\"name\":\"A\",\"data\":[5.0,15.0]}]}"
    );

    let pie = make_chart(
        ChartKind::Pie,
        None,
        None,
        None,
        vec!["Stocks", "Bonds", "Skip"],
        vec![ResolvedChartSeries {
            name: "Allocation".to_owned(),
            values: vec![Some(60.0), Some(40.0), None],
            color: None,
        }],
    );
    assert_eq!(
        pie.to_chart_spec_json().unwrap(),
        "{\"type\":\"pie\",\"title\":\"Sample\",\"width\":500,\"height\":300,\"slices\":[{\"label\":\"Stocks\",\"value\":60.0},{\"label\":\"Bonds\",\"value\":40.0}]}"
    );

    let donut_series_fallback = make_chart(
        ChartKind::Donut,
        None,
        None,
        None,
        vec![],
        vec![
            ResolvedChartSeries {
                name: "NA".to_owned(),
                values: vec![Some(70.0)],
                color: Some("#10b981".to_owned()),
            },
            ResolvedChartSeries {
                name: "EMEA".to_owned(),
                values: vec![Some(30.0)],
                color: Some("#f59e0b".to_owned()),
            },
        ],
    );
    assert_eq!(
        donut_series_fallback.to_chart_spec_json().unwrap(),
        "{\"type\":\"donut\",\"title\":\"Sample\",\"width\":500,\"height\":300,\"slices\":[{\"label\":\"NA\",\"value\":70.0,\"color\":\"#10b981\"},{\"label\":\"EMEA\",\"value\":30.0,\"color\":\"#f59e0b\"}]}"
    );

    let sparkline = make_chart(
        ChartKind::Sparkline,
        None,
        None,
        None,
        vec![],
        vec![ResolvedChartSeries {
            name: "Trend".to_owned(),
            values: vec![Some(1.0), None, Some(3.5)],
            color: Some("#0ea5e9".to_owned()),
        }],
    );
    assert_eq!(
        sparkline.to_chart_spec_json().unwrap(),
        "{\"type\":\"sparkline\",\"title\":\"Sample\",\"width\":500,\"height\":300,\"data\":[1.0,null,3.5],\"color\":\"#0ea5e9\"}"
    );

    let scatter = make_chart(
        ChartKind::Scatter,
        Some("Latency"),
        Some("Throughput"),
        Some(FormatKind::Number),
        vec!["1.5", "not-a-num", "4.0"],
        vec![ResolvedChartSeries {
            name: "Runs".to_owned(),
            values: vec![Some(100.0), Some(150.0), None],
            color: Some("#8b5cf6".to_owned()),
        }],
    );
    assert_eq!(
        scatter.to_chart_spec_json().unwrap(),
        "{\"type\":\"scatter\",\"title\":\"Sample\",\"width\":500,\"height\":300,\"xAxis\":{\"label\":\"Latency\"},\"yAxis\":{\"label\":\"Throughput\",\"format\":\"number\"},\"series\":[{\"name\":\"Runs\",\"points\":[{\"x\":1.5,\"y\":100.0},{\"x\":1.0,\"y\":150.0}],\"color\":\"#8b5cf6\"}]}"
    );
}
