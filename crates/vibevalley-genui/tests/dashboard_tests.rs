use std::collections::BTreeMap;

use vibevalley_genui::{
    Align, CalloutKind, ChartSource, ExprSource, FormatKind, GenUiNode, GenUiRuntime, GenUiSpec, NodeKind, PatchOp, ResolvedChartContent, ResolvedNodeKind,
    SelectOption, StackDirection, StateValue, TabItem, TableColumn, TableRows, TextAlign, TextExpr, TextSize, Tone, ValueExpr,
};

fn build_dashboard_spec() -> GenUiSpec {
    let deals = StateValue::List(vec![
        StateValue::Record(vec![
            ("account".to_owned(), StateValue::from("Acme Corp")),
            ("region".to_owned(), StateValue::from("NA")),
            ("arr".to_owned(), StateValue::from(120_000)),
            ("stage".to_owned(), StateValue::from("Closed")),
        ]),
        StateValue::Record(vec![
            ("account".to_owned(), StateValue::from("Nordic Labs")),
            ("region".to_owned(), StateValue::from("EMEA")),
            ("arr".to_owned(), StateValue::from(85_000)),
            ("stage".to_owned(), StateValue::from("Negotiation")),
        ]),
        StateValue::Record(vec![
            ("account".to_owned(), StateValue::from("Kanto AI")),
            ("region".to_owned(), StateValue::from("APAC")),
            ("arr".to_owned(), StateValue::from(210_000)),
            ("stage".to_owned(), StateValue::from("Closed")),
        ]),
        StateValue::Record(vec![
            ("account".to_owned(), StateValue::from("Berlin Cloud")),
            ("region".to_owned(), StateValue::from("EMEA")),
            ("arr".to_owned(), StateValue::from(45_000)),
            ("stage".to_owned(), StateValue::from("Discovery")),
        ]),
    ]);

    let mut state = BTreeMap::new();
    state.insert("region".to_owned(), StateValue::from("All"));
    state.insert("active_tab".to_owned(), StateValue::from("overview"));
    state.insert("show_notes".to_owned(), StateValue::from(true));
    state.insert("deals".to_owned(), deals);

    GenUiSpec {
        title: Some("Revenue KPI Dashboard".to_owned()),
        subtitle: Some("Q4 Pipeline".to_owned()),
        root_id: Some("root".to_owned()),
        state,
        nodes: vec![
            GenUiNode::new(
                "root",
                NodeKind::Stack {
                    direction: StackDirection::Vertical,
                    gap: Some(14.0),
                    align: Some(Align::Stretch),
                    children: vec![
                        "toolbar".to_owned(),
                        "kpis".to_owned(),
                        "div".to_owned(),
                        "tabs".to_owned(),
                        "notes_card".to_owned(),
                    ],
                },
            ),
            GenUiNode::new(
                "toolbar",
                NodeKind::Stack {
                    direction: StackDirection::Horizontal,
                    gap: Some(12.0),
                    align: Some(Align::Center),
                    children: vec!["sel_region".to_owned(), "sw_notes".to_owned(), "badge_count".to_owned()],
                },
            ),
            GenUiNode::new(
                "sel_region",
                NodeKind::Select {
                    bind: "region".to_owned(),
                    label: TextExpr::from("Region"),
                    options: vec![
                        SelectOption {
                            value: "All".to_owned(),
                            label: TextExpr::from("All Regions"),
                        },
                        SelectOption {
                            value: "NA".to_owned(),
                            label: TextExpr::from("North America"),
                        },
                        SelectOption {
                            value: "EMEA".to_owned(),
                            label: TextExpr::from("EMEA"),
                        },
                        SelectOption {
                            value: "APAC".to_owned(),
                            label: TextExpr::from("APAC"),
                        },
                    ],
                },
            ),
            GenUiNode::new(
                "sw_notes",
                NodeKind::Switch {
                    bind: "show_notes".to_owned(),
                    label: TextExpr::from("Show Analyst Notes"),
                },
            ),
            GenUiNode::new(
                "badge_count",
                NodeKind::Badge {
                    label: TextExpr::from("${len(filter(deals, d, region == 'All' || d.region == region))} deals"),
                    tone: Tone::Accent,
                },
            ),
            GenUiNode::new(
                "kpis",
                NodeKind::Grid {
                    columns: 3,
                    gap: Some(12.0),
                    children: vec!["kpi_arr".to_owned(), "kpi_avg".to_owned(), "kpi_target".to_owned()],
                },
            ),
            GenUiNode::new(
                "kpi_arr",
                NodeKind::Metric {
                    label: TextExpr::from("Filtered ARR (${region})"),
                    value: ValueExpr::expr("sum(map(filter(deals, d, region == 'All' || d.region == region), d, d.arr))"),
                    delta: None,
                    format: Some(FormatKind::Currency),
                },
            ),
            GenUiNode::new(
                "kpi_avg",
                NodeKind::Metric {
                    label: TextExpr::from("Avg Deal Size"),
                    value: ValueExpr::expr("avg(map(filter(deals, d, region == 'All' || d.region == region), d, d.arr))"),
                    delta: None,
                    format: Some(FormatKind::Compact),
                },
            ),
            GenUiNode::new(
                "kpi_target",
                NodeKind::Progress {
                    value: ValueExpr::expr("sum(map(filter(deals, d, region == 'All' || d.region == region), d, d.arr))"),
                    max: ValueExpr::literal(500_000),
                    label: Some(TextExpr::from("Quarterly Goal")),
                },
            ),
            GenUiNode::new(
                "div",
                NodeKind::Divider {
                    label: Some(TextExpr::from("Views")),
                },
            ),
            GenUiNode::new(
                "tabs",
                NodeKind::Tabs {
                    bind: "active_tab".to_owned(),
                    tabs: vec![
                        TabItem {
                            id: "overview".to_owned(),
                            label: TextExpr::from("Deals Table"),
                            children: vec!["deals_table".to_owned()],
                        },
                        TabItem {
                            id: "visuals".to_owned(),
                            label: TextExpr::from("Diagrams & Specs"),
                            children: vec![
                                "flow_diagram".to_owned(),
                                "tpl_chart".to_owned(),
                                "canvas_board".to_owned(),
                                "sql_block".to_owned(),
                            ],
                        },
                    ],
                },
            ),
            GenUiNode::new(
                "deals_table",
                NodeKind::Table {
                    columns: vec![
                        TableColumn {
                            key: "account".to_owned(),
                            label: TextExpr::from("Account"),
                            align: Some(TextAlign::Left),
                            format: None,
                        },
                        TableColumn {
                            key: "region".to_owned(),
                            label: TextExpr::from("Region"),
                            align: Some(TextAlign::Center),
                            format: None,
                        },
                        TableColumn {
                            key: "arr".to_owned(),
                            label: TextExpr::from("ARR"),
                            align: Some(TextAlign::Right),
                            format: Some(FormatKind::Currency),
                        },
                        TableColumn {
                            key: "stage".to_owned(),
                            label: TextExpr::from("Stage"),
                            align: Some(TextAlign::Left),
                            format: None,
                        },
                    ],
                    rows: TableRows::Expr(ExprSource::new(
                        "sort_by(filter(deals, d, region == 'All' || d.region == region), d, d.arr, 'desc')",
                    )),
                },
            ),
            GenUiNode::new(
                "flow_diagram",
                NodeKind::Diagram {
                    source: TextExpr::from(
                        "flowchart LR\n  Filter[${region}] --> Count[${len(filter(deals, d, region == 'All' || d.region == region))} Deals]",
                    ),
                },
            ),
            GenUiNode::new(
                "tpl_chart",
                NodeKind::Chart {
                    title: Some(TextExpr::from("Template Chart")),
                    subtitle: None,
                    width: Some(400),
                    height: Some(200),
                    source: ChartSource::Template {
                        template: TextExpr::from(
                            "{\"type\":\"sparkline\",\"data\":[${sum(map(filter(deals, d, region == 'All' || d.region == region), d, d.arr))}]}",
                        ),
                    },
                },
            ),
            GenUiNode::new(
                "canvas_board",
                NodeKind::Canvas {
                    data: TextExpr::from("{\"region\":\"${region}\"}"),
                },
            ),
            GenUiNode::new(
                "sql_block",
                NodeKind::CodeBlock {
                    code: TextExpr::from("SELECT * FROM deals WHERE region = '${region}';"),
                    language: Some("sql".to_owned()),
                },
            ),
            GenUiNode::new(
                "notes_card",
                NodeKind::Card {
                    title: Some(TextExpr::from("Analyst Notes")),
                    subtitle: Some(TextExpr::from("Region: ${region}")),
                    children: vec!["notes_md".to_owned(), "notes_text".to_owned(), "notes_callout".to_owned()],
                },
            )
            .with_visible("show_notes"),
            GenUiNode::new(
                "notes_md",
                NodeKind::Markdown {
                    text: TextExpr::from("Filtered ARR formula: $\\sum_{i} \\text{ARR}_i$ for **${region}**."),
                },
            ),
            GenUiNode::new(
                "notes_text",
                NodeKind::Text {
                    value: TextExpr::from("Active tab: ${active_tab}"),
                    tone: Tone::Muted,
                    size: TextSize::Sm,
                },
            ),
            GenUiNode::new(
                "notes_callout",
                NodeKind::Callout {
                    callout_kind: CalloutKind::Info,
                    title: Some(TextExpr::from("Filter Active")),
                    body: TextExpr::from("Showing ${region}"),
                },
            ),
        ],
    }
}

#[test]
fn kpi_dashboard_filters_table_switches_tabs_and_toggles_visibility() {
    let mut runtime = GenUiRuntime::from_spec(build_dashboard_spec()).unwrap();
    let initial = runtime.try_resolve_tree().unwrap();
    assert!(initial.find_node("notes_card").is_some());

    if let ResolvedNodeKind::Table { rows, .. } = &initial.find_node("deals_table").unwrap().kind {
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0].cells[0], "Kanto AI");
        assert_eq!(rows[0].cells[2], "$210,000.00");
        assert_eq!(rows[3].cells[0], "Berlin Cloud");
    } else {
        panic!("expected table");
    }

    if let ResolvedNodeKind::Metric { value, .. } = &initial.find_node("kpi_arr").unwrap().kind {
        assert_eq!(value, "$460,000.00");
    } else {
        panic!("expected metric");
    }

    let dirty_region = runtime.set_state("region", StateValue::from("EMEA")).unwrap();
    assert!(dirty_region.contains(&"deals_table".to_owned()));
    assert!(dirty_region.contains(&"kpi_arr".to_owned()));
    assert!(dirty_region.contains(&"kpi_avg".to_owned()));
    assert!(dirty_region.contains(&"kpi_target".to_owned()));
    assert!(dirty_region.contains(&"badge_count".to_owned()));
    assert!(dirty_region.contains(&"flow_diagram".to_owned()));
    assert!(dirty_region.contains(&"sql_block".to_owned()));

    let dirty_tab = runtime.set_state("active_tab", StateValue::from("visuals")).unwrap();
    assert!(dirty_tab.contains(&"tabs".to_owned()));
    assert!(dirty_tab.contains(&"notes_text".to_owned()));

    let filtered = runtime.try_resolve_tree().unwrap();

    if let ResolvedNodeKind::Table { rows, .. } = &filtered.find_node("deals_table").unwrap().kind {
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].cells, vec!["Nordic Labs", "EMEA", "$85,000.00", "Negotiation"]);
        assert_eq!(rows[1].cells, vec!["Berlin Cloud", "EMEA", "$45,000.00", "Discovery"]);
    } else {
        panic!("expected table");
    }

    if let ResolvedNodeKind::Metric { value, .. } = &filtered.find_node("kpi_arr").unwrap().kind {
        assert_eq!(value, "$130,000.00");
    } else {
        panic!("expected metric");
    }

    if let ResolvedNodeKind::Metric { value, .. } = &filtered.find_node("kpi_avg").unwrap().kind {
        assert_eq!(value, "65K");
    } else {
        panic!("expected metric");
    }

    if let ResolvedNodeKind::Progress { ratio, .. } = &filtered.find_node("kpi_target").unwrap().kind {
        assert!((ratio - 0.26).abs() < 1e-9);
    } else {
        panic!("expected progress");
    }

    if let ResolvedNodeKind::Tabs { active_tab, tabs, .. } = &filtered.find_node("tabs").unwrap().kind {
        assert_eq!(active_tab, "visuals");
        assert!(!tabs[0].active);
        assert!(tabs[1].active);
    } else {
        panic!("expected tabs");
    }

    if let ResolvedNodeKind::Diagram { source } = &filtered.find_node("flow_diagram").unwrap().kind {
        assert_eq!(source, "flowchart LR\n  Filter[EMEA] --> Count[2 Deals]");
    } else {
        panic!("expected diagram");
    }

    if let ResolvedNodeKind::Chart(chart) = &filtered.find_node("tpl_chart").unwrap().kind {
        assert_eq!(
            chart.content,
            ResolvedChartContent::SpecJson {
                spec_json: "{\"type\":\"sparkline\",\"data\":[130000]}".to_owned()
            }
        );
        assert_eq!(chart.to_chart_spec_json().unwrap(), "{\"type\":\"sparkline\",\"data\":[130000]}");
    } else {
        panic!("expected chart");
    }

    if let ResolvedNodeKind::CodeBlock { code, language } = &filtered.find_node("sql_block").unwrap().kind {
        assert_eq!(code, "SELECT * FROM deals WHERE region = 'EMEA';");
        assert_eq!(language.as_deref(), Some("sql"));
    } else {
        panic!("expected code block");
    }

    if let ResolvedNodeKind::Markdown { text } = &filtered.find_node("notes_md").unwrap().kind {
        assert_eq!(text, "Filtered ARR formula: $\\sum_{i} \\text{ARR}_i$ for **EMEA**.");
    } else {
        panic!("expected markdown");
    }

    let dirty_vis = runtime.set_state("show_notes", StateValue::from(false)).unwrap();
    assert!(dirty_vis.contains(&"notes_card".to_owned()));
    assert!(dirty_vis.contains(&"sw_notes".to_owned()));
    let hidden = runtime.try_resolve_tree().unwrap();
    assert!(hidden.find_node("notes_card").is_none());

    runtime.set_state("show_notes", StateValue::from(true)).unwrap();
    assert!(runtime.try_resolve_tree().unwrap().find_node("notes_card").is_some());

    runtime
        .apply_patch(PatchOp::RemoveNode {
            id: "notes_card".to_owned(),
            recursive: true,
        })
        .unwrap();
    assert!(runtime.doc().node("notes_card").is_none());
    assert!(runtime.doc().node("notes_md").is_none());
    assert!(!runtime.dependent_nodes("show_notes").contains(&"notes_card".to_owned()));
}

#[test]
fn dashboard_empty_filter_produces_zero_metrics_without_diagnostics() {
    let mut runtime = GenUiRuntime::from_spec(build_dashboard_spec()).unwrap();
    runtime.set_state("region", StateValue::from("LATAM")).unwrap();

    let resolved = runtime.try_resolve_tree().unwrap();
    if let ResolvedNodeKind::Table { rows, .. } = &resolved.find_node("deals_table").unwrap().kind {
        assert!(rows.is_empty());
    } else {
        panic!("expected table");
    }
    if let ResolvedNodeKind::Metric { value, .. } = &resolved.find_node("kpi_arr").unwrap().kind {
        assert_eq!(value, "$0.00");
    } else {
        panic!("expected metric");
    }
    if let ResolvedNodeKind::Metric { value, .. } = &resolved.find_node("kpi_avg").unwrap().kind {
        assert_eq!(value, "0");
    } else {
        panic!("expected metric");
    }
    if let ResolvedNodeKind::Progress { ratio, .. } = &resolved.find_node("kpi_target").unwrap().kind {
        assert_eq!(*ratio, 0.0);
    } else {
        panic!("expected progress");
    }
    if let ResolvedNodeKind::Badge { label, .. } = &resolved.find_node("badge_count").unwrap().kind {
        assert_eq!(label, "0 deals");
    } else {
        panic!("expected badge");
    }
}

#[test]
fn tabs_append_child_controls_clamping_and_list_table_rows() {
    let mut runtime = GenUiRuntime::new();
    runtime
        .apply_patch(PatchOp::StateInit {
            state: BTreeMap::from([
                ("pct".to_owned(), StateValue::from(150)),
                (
                    "matrix".to_owned(),
                    StateValue::List(vec![
                        StateValue::List(vec![StateValue::from("Q1"), StateValue::from(12_000)]),
                        StateValue::List(vec![StateValue::from("Q2"), StateValue::from(18_500)]),
                    ]),
                ),
            ]),
            overwrite: true,
        })
        .unwrap();

    runtime
        .apply_patch(PatchOp::SetNode {
            root: true,
            node: Box::new(GenUiNode::new(
                "tabs",
                NodeKind::Tabs {
                    bind: "tab".to_owned(),
                    tabs: vec![
                        TabItem {
                            id: "a".to_owned(),
                            label: TextExpr::from("Alpha"),
                            children: vec![],
                        },
                        TabItem {
                            id: "b".to_owned(),
                            label: TextExpr::from("Beta"),
                            children: vec![],
                        },
                    ],
                },
            )),
        })
        .unwrap();

    runtime
        .apply_patch(PatchOp::AppendChild {
            parent_id: "tabs".to_owned(),
            child_id: "slider_pct".to_owned(),
            tab_id: Some("a".to_owned()),
            node: Some(Box::new(GenUiNode::new(
                "slider_pct",
                NodeKind::Slider {
                    bind: "pct".to_owned(),
                    label: TextExpr::from("Pct"),
                    min: 0.0,
                    max: 100.0,
                    step: 5.0,
                    unit: Some("%".to_owned()),
                },
            ))),
        })
        .unwrap();

    runtime
        .apply_patch(PatchOp::AppendChild {
            parent_id: "tabs".to_owned(),
            child_id: "tbl_matrix".to_owned(),
            tab_id: Some("b".to_owned()),
            node: Some(Box::new(GenUiNode::new(
                "tbl_matrix",
                NodeKind::Table {
                    columns: vec![
                        TableColumn {
                            key: "q".to_owned(),
                            label: TextExpr::from("Quarter"),
                            align: None,
                            format: None,
                        },
                        TableColumn {
                            key: "rev".to_owned(),
                            label: TextExpr::from("Rev"),
                            align: Some(TextAlign::Right),
                            format: Some(FormatKind::Currency),
                        },
                    ],
                    rows: TableRows::Expr(ExprSource::new("matrix")),
                },
            ))),
        })
        .unwrap();

    runtime
        .apply_patch(PatchOp::AppendChild {
            parent_id: "tabs".to_owned(),
            child_id: "zero_progress".to_owned(),
            tab_id: Some("a".to_owned()),
            node: Some(Box::new(GenUiNode::new(
                "zero_progress",
                NodeKind::Progress {
                    value: ValueExpr::literal(50),
                    max: ValueExpr::literal(0),
                    label: None,
                },
            ))),
        })
        .unwrap();

    let resolved = runtime.try_resolve_tree().unwrap();
    if let ResolvedNodeKind::Tabs { active_tab, tabs, .. } = &resolved.find_node("tabs").unwrap().kind {
        assert_eq!(active_tab, "a");
        assert!(tabs[0].active);
        assert!(!tabs[1].active);
        assert_eq!(tabs[0].children.len(), 2);
        assert_eq!(tabs[1].children.len(), 1);
    } else {
        panic!("expected tabs");
    }
    if let ResolvedNodeKind::Slider { value, .. } = &resolved.find_node("slider_pct").unwrap().kind {
        assert_eq!(*value, 100.0);
    } else {
        panic!("expected slider");
    }
    if let ResolvedNodeKind::Progress { ratio, .. } = &resolved.find_node("zero_progress").unwrap().kind {
        assert_eq!(*ratio, 0.0);
    } else {
        panic!("expected progress");
    }
    if let ResolvedNodeKind::Table { rows, .. } = &resolved.find_node("tbl_matrix").unwrap().kind {
        assert_eq!(rows[0].cells, vec!["Q1", "$12,000.00"]);
        assert_eq!(rows[1].cells, vec!["Q2", "$18,500.00"]);
    } else {
        panic!("expected table");
    }
}
