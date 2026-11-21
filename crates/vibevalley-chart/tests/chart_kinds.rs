mod common;

use common::{assert_valid_css_var_svg, assert_valid_resolved_svg, count_elements_in_role, extract_texts};
use vibevalley_chart::{
    AreaMode, AreaSpec, AxisScale, BarMode, BarOrientation, BarSeries, BarSpec, BoxStats, BoxplotGroup, BoxplotSpec, ChartKind, ChartSpec, ComboLineSeries,
    ComboSpec, HeatmapScale, HeatmapSpec, HistogramMode, HistogramSpec, Interpolation, LegendPosition, LineSeries, LineSpec, NumberFormat, PieLabelFormat,
    PieSlice, PieSpec, RenderOptions, ScatterPoint, ScatterSeries, ScatterSpec, SparklineSpec, SparklineVariant, ThemeMode, ThemePalette, ValueAxisSide,
    compute_box_stats, compute_histogram_bins, render, render_json,
};

fn assert_both_themes(spec: &ChartSpec) {
    let light = render(spec, &RenderOptions::light()).expect("light render");
    assert_valid_resolved_svg(&light);
    let dark = render(spec, &RenderOptions::dark()).expect("dark render");
    assert_valid_resolved_svg(&dark);
    assert_ne!(light.svg, dark.svg, "light and dark themes should differ");

    let css = render(spec, &RenderOptions::default().with_theme(ThemeMode::css_variables())).expect("css vars render");
    assert_valid_css_var_svg(&css);
}

#[test]
fn bar_vertical_grouped_stacked_and_percent_stacked() {
    let grouped_json = r#"{
        "type": "bar",
        "title": "Quarterly Revenue",
        "subtitle": "FY 2026 Breakdown",
        "categories": ["Q1", "Q2", "Q3", "Q4"],
        "series": [
            { "name": "Product", "data": [120000, 155000, 182000, 210000] },
            { "name": "Services", "data": [45000, 52000, 61000, 74000] }
        ],
        "showValues": true,
        "cornerRadius": 4,
        "yAxis": { "label": "Revenue", "format": "currency" }
    }"#;
    let light = render_json(grouped_json, &RenderOptions::light()).expect("grouped bar light");
    let dark = render_json(grouped_json, &RenderOptions::dark()).expect("grouped bar dark");
    assert_valid_resolved_svg(&light);
    assert_valid_resolved_svg(&dark);
    assert_eq!(count_elements_in_role(&light.svg, "series", "path"), 8);
    let texts = extract_texts(&light.svg);
    assert!(texts.iter().any(|t| t == "Quarterly Revenue"));
    assert!(texts.iter().any(|t| t.starts_with('$')));

    // Stacked with positive + negative diverging values.
    let mut stacked = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec!["Jan".into(), "Feb".into(), "Mar".into()],
        series: vec![
            BarSeries {
                name: "Inflow".into(),
                data: vec![Some(40.0), Some(65.0), Some(50.0)],
                color: None,
            },
            BarSeries {
                name: "Bonus".into(),
                data: vec![Some(15.0), None, Some(20.0)],
                color: None,
            },
            BarSeries {
                name: "Outflow".into(),
                data: vec![Some(-25.0), Some(-30.0), Some(-15.0)],
                color: None,
            },
        ],
        orientation: BarOrientation::Vertical,
        mode: BarMode::Stacked,
        show_values: true,
        corner_radius: Some(3.0),
    }));
    stacked.title = Some("Cash Flow".into());
    assert_both_themes(&stacked);

    // 100%-stacked bars.
    let mut pct = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec!["Desktop".into(), "Mobile".into(), "Tablet".into()],
        series: vec![
            BarSeries {
                name: "Free".into(),
                data: vec![Some(60.0), Some(75.0), Some(40.0)],
                color: None,
            },
            BarSeries {
                name: "Pro".into(),
                data: vec![Some(40.0), Some(25.0), Some(60.0)],
                color: None,
            },
        ],
        orientation: BarOrientation::Vertical,
        mode: BarMode::PercentStacked,
        show_values: true,
        corner_radius: Some(2.0),
    }));
    pct.title = Some("Plan Mix".into());
    let rendered_pct = render(&pct, &RenderOptions::light()).expect("100% stacked bar");
    assert_valid_resolved_svg(&rendered_pct);
    let pct_texts = extract_texts(&rendered_pct.svg);
    assert!(pct_texts.iter().any(|t| t == "100%"));
    assert!(pct_texts.iter().any(|t| t == "0%"));
    // Interior labels on dark stacked segments must pick light contrast ink.
    let doc = roxmltree::Document::parse(&rendered_pct.svg).expect("xml");
    let label_fills: Vec<&str> = doc
        .descendants()
        .filter(|n| n.is_element() && n.attribute("data-role") == Some("data-labels"))
        .flat_map(|g| g.descendants())
        .filter(|n| n.is_element() && n.tag_name().name() == "text")
        .filter_map(|t| t.attribute("fill"))
        .collect();
    assert!(
        label_fills.contains(&"#fcfcfb"),
        "stacked dark bar segments should use high-contrast light ink, got {label_fills:?}"
    );
}

#[test]
fn bar_horizontal_grouped_and_stacked() {
    for mode in [BarMode::Grouped, BarMode::Stacked, BarMode::PercentStacked] {
        let mut spec = ChartSpec::new(ChartKind::Bar(BarSpec {
            categories: vec!["Rust Core".into(), "Native macOS".into(), "CLI Tools".into(), "Protocol".into()],
            series: vec![
                BarSeries {
                    name: "Completed".into(),
                    data: vec![Some(42.0), Some(28.0), Some(19.0), Some(31.0)],
                    color: None,
                },
                BarSeries {
                    name: "In Progress".into(),
                    data: vec![Some(8.0), Some(12.0), Some(5.0), Some(4.0)],
                    color: None,
                },
            ],
            orientation: BarOrientation::Horizontal,
            mode,
            show_values: true,
            corner_radius: Some(3.0),
        }));
        spec.x_axis.label = Some("Issues".into());
        spec.y_axis.label = Some("Area".into());
        assert_both_themes(&spec);
    }
}

#[test]
fn line_multi_series_null_gaps_and_connect_nulls() {
    let base_series = vec![
        LineSeries {
            name: "Latency p50".into(),
            data: vec![Some(12.0), Some(15.0), None, Some(22.0), None, Some(18.0), Some(14.0)],
            color: None,
            dashed: false,
            stroke_width: Some(2.5),
        },
        LineSeries {
            name: "Latency p99".into(),
            data: vec![Some(45.0), Some(52.0), Some(61.0), Some(58.0), Some(49.0), Some(55.0), Some(47.0)],
            color: None,
            dashed: true,
            stroke_width: None,
        },
    ];
    let cats: Vec<String> = (1..=7).map(|d| format!("Day {d}")).collect();

    // With connect_nulls = false: series 0 splits into 2 paths + 1 isolated point dot!
    let mut gapped = ChartSpec::new(ChartKind::Line(LineSpec {
        categories: cats.clone(),
        x_values: None,
        series: base_series.clone(),
        interpolation: Interpolation::Linear,
        show_points: false,
        show_values: false,
        connect_nulls: false,
    }));
    gapped.title = Some("Latency with Gaps".into());
    let out = render(&gapped, &RenderOptions::light()).expect("gapped line");
    assert_valid_resolved_svg(&out);
    // Series 0 has 2 multi-point runs + series 1 has 1 run => 3 <path> elements.
    assert_eq!(count_elements_in_role(&out.svg, "series", "path"), 3);
    // Isolated middle point in series 0 renders as 1 <circle> even when show_points = false.
    assert_eq!(count_elements_in_role(&out.svg, "series", "circle"), 1);

    // With connect_nulls = true: series 0 joins into 1 single continuous path.
    let connected = ChartSpec::new(ChartKind::Line(LineSpec {
        categories: cats,
        x_values: None,
        series: base_series,
        interpolation: Interpolation::Linear,
        show_points: true,
        show_values: true,
        connect_nulls: true,
    }));
    let out_conn = render(&connected, &RenderOptions::dark()).expect("connected line");
    assert_valid_resolved_svg(&out_conn);
    assert_eq!(count_elements_in_role(&out_conn.svg, "series", "path"), 2);
}

#[test]
fn line_smooth_monotone_cubic_never_overshoots_and_step_variants() {
    // Sharp step-plateau data: standard Catmull-Rom would wildly overshoot;
    // Fritsch-Carlson monotone cubic must keep every Bezier control point within [min, max].
    let mut smooth = ChartSpec::new(ChartKind::Line(LineSpec {
        categories: vec!["A".into(), "B".into(), "C".into(), "D".into(), "E".into(), "F".into()],
        x_values: None,
        series: vec![LineSeries {
            name: "Step Plateau".into(),
            data: vec![Some(0.0), Some(0.0), Some(100.0), Some(100.0), Some(0.0), Some(0.0)],
            color: None,
            dashed: false,
            stroke_width: None,
        }],
        interpolation: Interpolation::Smooth,
        show_points: true,
        show_values: false,
        connect_nulls: false,
    }));
    smooth.y_axis.min = Some(0.0);
    smooth.y_axis.max = Some(100.0);
    let rendered = render(&smooth, &RenderOptions::light()).expect("smooth line");
    assert_valid_resolved_svg(&rendered);

    let doc = roxmltree::Document::parse(&rendered.svg).expect("xml");
    let path_d = doc
        .descendants()
        .find(|n| n.is_element() && n.tag_name().name() == "path")
        .and_then(|n| n.attribute("d"))
        .expect("curve path");
    assert!(path_d.contains('C'), "smooth curve must emit cubic Bezier C commands");

    // Extract all Y coordinates from M/C commands and confirm zero overshoot beyond endpoints.
    let nums: Vec<f64> = path_d
        .split(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<f64>().expect("coord"))
        .collect();
    let ys: Vec<f64> = nums.iter().skip(1).step_by(2).copied().collect();
    let endpoint_min = ys[0].min(ys[ys.len() - 1]);
    let min_y = ys.iter().copied().fold(f64::INFINITY, f64::min);
    let max_y = ys.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    // In SVG Y-down coordinates, y=0.0 is max_y (bottom) and y=100.0 is min_y (top).
    assert!(
        (max_y - endpoint_min).abs() < 0.05,
        "monotone spline overshot bottom plateau: max_y={max_y}, plateau_y={endpoint_min}"
    );
    assert!(min_y > 0.0 && max_y < rendered.height);

    // Also exercise Step, StepBefore, StepMiddle + numeric xValues + log Y axis.
    for interp in [Interpolation::Step, Interpolation::StepBefore, Interpolation::StepMiddle] {
        let mut step_spec = ChartSpec::new(ChartKind::Line(LineSpec {
            categories: Vec::new(),
            x_values: Some(vec![1.0, 2.0, 4.0, 8.0, 16.0]),
            series: vec![LineSeries {
                name: "Throughput".into(),
                data: vec![Some(10.0), Some(45.0), Some(210.0), Some(950.0), Some(4200.0)],
                color: None,
                dashed: false,
                stroke_width: None,
            }],
            interpolation: interp,
            show_points: true,
            show_values: false,
            connect_nulls: false,
        }));
        step_spec.y_axis.scale = AxisScale::Log;
        assert_both_themes(&step_spec);
    }
}

#[test]
fn area_standard_stacked_and_percent_stacked() {
    for mode in [AreaMode::Standard, AreaMode::Stacked, AreaMode::PercentStacked] {
        let mut spec = ChartSpec::new(ChartKind::Area(AreaSpec {
            categories: vec!["Mon".into(), "Tue".into(), "Wed".into(), "Thu".into(), "Fri".into()],
            x_values: None,
            series: vec![
                LineSeries {
                    name: "CPU".into(),
                    data: vec![Some(25.0), Some(38.0), Some(42.0), Some(31.0), Some(48.0)],
                    color: None,
                    dashed: false,
                    stroke_width: None,
                },
                LineSeries {
                    name: "Memory".into(),
                    data: vec![Some(18.0), Some(22.0), Some(26.0), Some(24.0), Some(29.0)],
                    color: None,
                    dashed: false,
                    stroke_width: None,
                },
                LineSeries {
                    name: "I/O".into(),
                    data: vec![Some(10.0), Some(14.0), Some(11.0), Some(16.0), Some(12.0)],
                    color: None,
                    dashed: false,
                    stroke_width: None,
                },
            ],
            mode,
            interpolation: Interpolation::Smooth,
            show_points: true,
            fill_opacity: None,
            connect_nulls: false,
        }));
        spec.title = Some(format!("Area {:?}", mode));
        assert_both_themes(&spec);
    }
}

#[test]
fn scatter_and_bubble_size_encoding() {
    let mut scatter = ChartSpec::new(ChartKind::Scatter(ScatterSpec {
        series: vec![
            ScatterSeries {
                name: "Cluster A".into(),
                points: vec![
                    ScatterPoint {
                        x: -12.0,
                        y: 4.5,
                        size: None,
                        label: Some("A1".into()),
                    },
                    ScatterPoint {
                        x: -4.0,
                        y: 12.0,
                        size: None,
                        label: Some("A2".into()),
                    },
                    ScatterPoint {
                        x: 2.5,
                        y: 9.0,
                        size: None,
                        label: None,
                    },
                ],
                color: None,
            },
            ScatterSeries {
                name: "Cluster B".into(),
                points: vec![
                    ScatterPoint {
                        x: 14.0,
                        y: -6.0,
                        size: None,
                        label: Some("B1".into()),
                    },
                    ScatterPoint {
                        x: 22.0,
                        y: -15.0,
                        size: None,
                        label: None,
                    },
                ],
                color: None,
            },
        ],
        point_radius: Some(5.5),
        min_radius: None,
        max_radius: None,
        show_labels: true,
    }));
    scatter.x_axis.label = Some("Delta X".into());
    scatter.y_axis.label = Some("Delta Y".into());
    assert_both_themes(&scatter);

    let bubble = ChartSpec::new(ChartKind::Bubble(ScatterSpec {
        series: vec![ScatterSeries {
            name: "Crates".into(),
            points: vec![
                ScatterPoint {
                    x: 10.0,
                    y: 20.0,
                    size: Some(100.0),
                    label: Some("Small".into()),
                },
                ScatterPoint {
                    x: 40.0,
                    y: 55.0,
                    size: Some(400.0),
                    label: Some("Medium".into()),
                },
                ScatterPoint {
                    x: 80.0,
                    y: 90.0,
                    size: Some(1600.0),
                    label: Some("Large".into()),
                },
            ],
            color: None,
        }],
        point_radius: None,
        min_radius: Some(6.0),
        max_radius: Some(24.0),
        show_labels: true,
    }));
    let out = render(&bubble, &RenderOptions::light()).expect("bubble render");
    assert_valid_resolved_svg(&out);
    assert_both_themes(&bubble);

    let doc = roxmltree::Document::parse(&out.svg).expect("xml");
    let radii: Vec<f64> = doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "circle")
        .filter_map(|n| n.attribute("r").and_then(|v| v.parse::<f64>().ok()))
        .collect();
    assert_eq!(radii.len(), 3);
    assert!(radii[0] < radii[1] && radii[1] < radii[2], "radii must scale with size: {radii:?}");
    // Verify sqrt area proportionality: sqrt(400)=20 is 1/3 of [sqrt(100)=10 .. sqrt(1600)=40].
    let expected_mid = 6.0 + (24.0 - 6.0) * (10.0 / 30.0);
    assert!(
        (radii[1] - expected_mid).abs() < 0.25,
        "expected sqrt-scaled radius ~{expected_mid}, got {}",
        radii[1]
    );
}

#[test]
fn pie_and_donut_with_thin_slice_callout_spreading_and_full_circle() {
    // Many thin slices that would collide without collision relaxation.
    let mut pie = ChartSpec::new(ChartKind::Pie(PieSpec {
        slices: vec![
            PieSlice {
                label: "Rust".into(),
                value: 48.0,
                color: None,
            },
            PieSlice {
                label: "TypeScript".into(),
                value: 27.0,
                color: None,
            },
            PieSlice {
                label: "SQL".into(),
                value: 10.0,
                color: None,
            },
            PieSlice {
                label: "Swift".into(),
                value: 4.0,
                color: None,
            },
            PieSlice {
                label: "Python".into(),
                value: 3.5,
                color: None,
            },
            PieSlice {
                label: "Shell".into(),
                value: 3.0,
                color: None,
            },
            PieSlice {
                label: "TOML".into(),
                value: 2.5,
                color: None,
            },
            PieSlice {
                label: "JSON".into(),
                value: 2.0,
                color: None,
            },
        ],
        inner_radius_ratio: None,
        center_label: None,
        center_sublabel: None,
        show_labels: Some(true),
        label_format: PieLabelFormat::LabelAndPercent,
    }));
    pie.title = Some("Language Share".into());
    pie.legend = LegendPosition::None;
    let rendered = render(&pie, &RenderOptions::light()).expect("pie render");
    assert_valid_resolved_svg(&rendered);
    assert_both_themes(&pie);

    // Check that right/left callout labels on the same side do not collide vertically.
    let doc = roxmltree::Document::parse(&rendered.svg).expect("xml");
    let mut left_ys = Vec::new();
    let mut right_ys = Vec::new();
    for g in doc.descendants().filter(|n| n.is_element() && n.attribute("data-role") == Some("data-labels")) {
        for txt in g.descendants().filter(|n| n.is_element() && n.tag_name().name() == "text") {
            let y: f64 = txt.attribute("y").unwrap().parse().unwrap();
            match txt.attribute("text-anchor") {
                Some("start") => right_ys.push(y),
                Some("end") => left_ys.push(y),
                _ => {}
            }
        }
    }
    for side in [&mut left_ys, &mut right_ys] {
        side.sort_by(f64::total_cmp);
        for pair in side.windows(2) {
            assert!(pair[1] - pair[0] >= 12.0, "pie callout labels overlapped: {side:?}");
        }
    }

    // Donut with center label & sublabel across all legend placements.
    for legend in [LegendPosition::Top, LegendPosition::Bottom, LegendPosition::Right, LegendPosition::None] {
        let mut donut = ChartSpec::new(ChartKind::Donut(PieSpec {
            slices: vec![
                PieSlice {
                    label: "Done".into(),
                    value: 64.0,
                    color: None,
                },
                PieSlice {
                    label: "Active".into(),
                    value: 24.0,
                    color: None,
                },
                PieSlice {
                    label: "Blocked".into(),
                    value: 12.0,
                    color: None,
                },
            ],
            inner_radius_ratio: Some(0.58),
            center_label: Some("100".into()),
            center_sublabel: Some("Total Tasks".into()),
            show_labels: Some(true),
            label_format: PieLabelFormat::Auto,
        }));
        donut.legend = legend;
        let out = render(&donut, &RenderOptions::dark()).expect("donut render");
        assert_valid_resolved_svg(&out);
        let texts = extract_texts(&out.svg);
        assert!(texts.iter().any(|t| t == "100"));
        assert!(texts.iter().any(|t| t == "Total Tasks"));
    }

    // Single 100% slice (must not degenerate SVG arc to empty).
    let single_pie = ChartSpec::new(ChartKind::Donut(PieSpec {
        slices: vec![PieSlice {
            label: "All".into(),
            value: 100.0,
            color: None,
        }],
        inner_radius_ratio: Some(0.5),
        center_label: Some("100%".into()),
        center_sublabel: None,
        show_labels: Some(true),
        label_format: PieLabelFormat::Percent,
    }));
    assert_both_themes(&single_pie);
}

#[test]
fn combo_dual_y_axis_independent_scales() {
    let mut combo = ChartSpec::new(ChartKind::Combo(ComboSpec {
        categories: vec!["Q1".into(), "Q2".into(), "Q3".into(), "Q4".into()],
        bars: vec![
            BarSeries {
                name: "Revenue".into(),
                data: vec![Some(120_000.0), Some(165_000.0), Some(195_000.0), Some(240_000.0)],
                color: None,
            },
            BarSeries {
                name: "Cost".into(),
                data: vec![Some(80_000.0), Some(95_000.0), Some(105_000.0), Some(125_000.0)],
                color: None,
            },
        ],
        lines: vec![ComboLineSeries {
            name: "Gross Margin".into(),
            data: vec![Some(0.33), Some(0.42), Some(0.46), Some(0.48)],
            axis: ValueAxisSide::Right,
            color: None,
            dashed: false,
            stroke_width: Some(2.6),
        }],
        bar_mode: BarMode::Grouped,
        interpolation: Interpolation::Smooth,
        show_points: true,
        show_values: true,
        bar_corner_radius: Some(3.0),
    }));
    combo.title = Some("Revenue vs Gross Margin".into());
    combo.y_axis.label = Some("USD".into());
    combo.y_axis.format = NumberFormat::Currency;
    combo.y2_axis.label = Some("Margin %".into());
    combo.y2_axis.format = NumberFormat::Percent;
    combo.y2_axis.min = Some(0.0);
    combo.y2_axis.max = Some(0.6);
    combo.annotations = vec![
        vibevalley_chart::Annotation::HorizontalLine {
            value: 0.40,
            axis: ValueAxisSide::Right,
            label: Some("40% Target".into()),
            color: None,
            dashed: true,
        },
        vibevalley_chart::Annotation::HorizontalBand {
            from: 100_000.0,
            to: 200_000.0,
            axis: ValueAxisSide::Left,
            label: Some("Target Band".into()),
            color: None,
            opacity: Some(0.08),
        },
    ];

    let out = render(&combo, &RenderOptions::light()).expect("combo render");
    assert_valid_resolved_svg(&out);
    assert_both_themes(&combo);

    assert!(count_elements_in_role(&out.svg, "y-axis", "text") >= 3);
    assert!(count_elements_in_role(&out.svg, "y2-axis", "text") >= 3);
    let texts = extract_texts(&out.svg);
    assert!(texts.iter().any(|t| t == "USD"));
    assert!(texts.iter().any(|t| t == "Margin %"));
    assert!(texts.iter().any(|t| t == "40% Target"));
    assert!(texts.iter().any(|t| t == "Target Band"));
    assert!(texts.iter().any(|t| t.ends_with('%')));
    assert!(texts.iter().any(|t| t.starts_with('$')));
}

#[test]
fn heatmap_sequential_diverging_custom_and_auto_contrast() {
    let mut seq = ChartSpec::new(ChartKind::Heatmap(HeatmapSpec {
        x_labels: vec!["Mon".into(), "Tue".into(), "Wed".into(), "Thu".into()],
        y_labels: vec!["Morning".into(), "Afternoon".into(), "Evening".into()],
        values: vec![
            vec![Some(2.0), Some(18.0), Some(45.0), Some(95.0)],
            vec![Some(10.0), None, Some(62.0), Some(88.0)],
            vec![Some(5.0), Some(30.0), Some(74.0), Some(100.0)],
        ],
        color_scale: HeatmapScale::Sequential,
        min: Some(0.0),
        max: Some(100.0),
        midpoint: None,
        show_values: Some(true),
        value_format: NumberFormat::Number,
        show_color_bar: Some(true),
        cell_radius: Some(3.0),
        cell_gap: Some(3.0),
    }));
    seq.title = Some("Activity Intensity".into());
    seq.x_axis.label = Some("Day".into());
    seq.y_axis.label = Some("Window".into());

    let out = render(&seq, &RenderOptions::light()).expect("heatmap sequential");
    assert_valid_resolved_svg(&out);
    assert_both_themes(&seq);

    // Verify auto-contrast picks BOTH dark ink (on pale low cells) AND light ink (on deep high cells).
    let doc = roxmltree::Document::parse(&out.svg).expect("xml");
    let mut cell_inks: Vec<&str> = Vec::new();
    for g in doc.descendants().filter(|n| n.is_element() && n.attribute("data-role") == Some("data-labels")) {
        for t in g.descendants().filter(|n| n.is_element() && n.tag_name().name() == "text") {
            if let Some(fill) = t.attribute("fill") {
                cell_inks.push(fill);
            }
        }
    }
    assert!(cell_inks.contains(&"#1c1917"), "expected dark ink on pale cells, got {cell_inks:?}");
    assert!(cell_inks.contains(&"#fcfcfb"), "expected light ink on deep cells, got {cell_inks:?}");

    // Diverging and custom color scales.
    for scale in [
        HeatmapScale::Diverging,
        HeatmapScale::Custom {
            low: "#2c6aa3".into(),
            mid: Some("#f6f5f3".into()),
            high: "#a83a2c".into(),
        },
    ] {
        let div = ChartSpec::new(ChartKind::Heatmap(HeatmapSpec {
            x_labels: vec!["A".into(), "B".into(), "C".into()],
            y_labels: vec!["R1".into(), "R2".into()],
            values: vec![vec![Some(-1.0), Some(0.0), Some(1.0)], vec![Some(-0.4), Some(0.25), Some(0.85)]],
            color_scale: scale,
            min: None,
            max: None,
            midpoint: Some(0.0),
            show_values: Some(true),
            value_format: NumberFormat::Percent,
            show_color_bar: Some(true),
            cell_radius: None,
            cell_gap: None,
        }));
        assert_both_themes(&div);
    }
}

#[test]
fn boxplot_statistics_and_histogram_binning() {
    // Verify exact Tukey quartile & outlier calculation.
    let samples = vec![10.0, 12.0, 13.0, 14.0, 15.0, 16.0, 18.0, 19.0, 42.0];
    let st = compute_box_stats(&samples);
    assert_eq!(st.q1, 13.0);
    assert_eq!(st.median, 15.0);
    assert_eq!(st.q3, 18.0);
    assert_eq!(st.min, 10.0);
    assert_eq!(st.max, 19.0);
    assert_eq!(st.outliers, vec![42.0]);

    for orient in [BarOrientation::Vertical, BarOrientation::Horizontal] {
        let mut bp = ChartSpec::new(ChartKind::Boxplot(BoxplotSpec {
            groups: vec![
                BoxplotGroup {
                    label: "Build A".into(),
                    samples: Some(samples.clone()),
                    stats: None,
                    color: None,
                },
                BoxplotGroup {
                    label: "Build B".into(),
                    samples: None,
                    stats: Some(BoxStats {
                        min: 8.0,
                        q1: 11.0,
                        median: 14.5,
                        q3: 17.0,
                        max: 22.0,
                        outliers: vec![3.0, 31.0],
                        mean: Some(15.2),
                    }),
                    color: None,
                },
            ],
            orientation: orient,
            show_mean: true,
        }));
        bp.title = Some("Latency Distribution".into());
        assert_both_themes(&bp);
    }

    // Histogram auto-binning, explicit bins, explicit edges, and all normalization modes.
    let values: Vec<f64> = (0..60).map(|i| 10.0 + (i % 12) as f64 * 2.5 + (i / 12) as f64 * 1.1).collect();
    let auto_bins = compute_histogram_bins(&values, None, None, HistogramMode::Count);
    assert!(!auto_bins.is_empty());
    let total_count: usize = auto_bins.iter().map(|b| b.count).sum();
    assert_eq!(total_count, values.len());

    let pct_bins = compute_histogram_bins(&values, Some(6), None, HistogramMode::Percent);
    assert_eq!(pct_bins.len(), 6);
    let pct_sum: f64 = pct_bins.iter().map(|b| b.height).sum();
    assert!((pct_sum - 1.0).abs() < 1e-9);

    // Floating-point upper-edge boundary and constant/single-element datasets must not drop samples.
    let fp_bins = compute_histogram_bins(&[0.1, 0.2, 0.3], Some(3), None, HistogramMode::Count);
    assert_eq!(fp_bins.iter().map(|b| b.count).sum::<usize>(), 3);
    let const_bins = compute_histogram_bins(&[5.0, 5.0, 5.0, 5.0], None, None, HistogramMode::Count);
    assert_eq!(const_bins.iter().map(|b| b.count).sum::<usize>(), 4);
    let single_bins = compute_histogram_bins(&[42.0], None, None, HistogramMode::Count);
    assert_eq!(single_bins.iter().map(|b| b.count).sum::<usize>(), 1);

    for (bins, edges, mode) in [
        (None, None, HistogramMode::Count),
        (Some(8), None, HistogramMode::Percent),
        (None, Some(vec![10.0, 20.0, 30.0, 45.0]), HistogramMode::Density),
    ] {
        let mut hist = ChartSpec::new(ChartKind::Histogram(HistogramSpec {
            values: values.clone(),
            bins,
            bin_edges: edges,
            normalize: mode,
            color: None,
            show_values: true,
            show_mean: true,
        }));
        hist.title = Some("Response Time Histogram".into());
        hist.x_axis.label = Some("ms".into());
        hist.y_axis.label = Some("Freq".into());
        assert_both_themes(&hist);
    }
}

#[test]
fn sparkline_variants_and_custom_theme_palette() {
    for variant in [SparklineVariant::Line, SparklineVariant::Area, SparklineVariant::Bar] {
        let mut spark = ChartSpec::new(ChartKind::Sparkline(SparklineSpec {
            data: vec![Some(4.0), Some(-2.0), Some(6.0), None, Some(3.0), Some(9.0), Some(7.5)],
            variant,
            interpolation: Interpolation::Smooth,
            color: None,
            negative_color: None,
            highlight_last: Some(true),
            highlight_extrema: true,
            baseline: Some(0.0),
        }));
        let out = render(&spark, &RenderOptions::light()).expect("sparkline");
        assert_eq!(out.width, 160.0);
        assert_eq!(out.height, 40.0);
        assert_valid_resolved_svg(&out);

        spark.title = Some("7d Trend".into());
        assert_both_themes(&spark);
    }

    // Custom ThemePalette override.
    let mut custom_palette = ThemePalette::light();
    custom_palette.background = "#fffaf0".to_string();
    custom_palette.series = vec!["#1f5c3e".to_string(), "#c84a3a".to_string()];
    let spec = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec!["A".into(), "B".into()],
        series: vec![BarSeries {
            name: "S1".into(),
            data: vec![Some(10.0), Some(20.0)],
            color: None,
        }],
        orientation: BarOrientation::Vertical,
        mode: BarMode::Grouped,
        show_values: false,
        corner_radius: None,
    }));
    let out = render(&spec, &RenderOptions::default().with_theme(ThemeMode::resolved(custom_palette))).expect("custom palette");
    assert_valid_resolved_svg(&out);
    assert!(out.svg.contains("#fffaf0"));
    assert!(out.svg.contains("#1f5c3e"));
}
