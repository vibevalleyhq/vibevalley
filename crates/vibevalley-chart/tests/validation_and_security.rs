mod common;

use common::assert_valid_resolved_svg;
use vibevalley_chart::{
    Annotation, AreaMode, AreaSpec, AxisScale, BarMode, BarOrientation, BarSeries, BarSpec, BoxStats, BoxplotGroup, BoxplotSpec, ChartError, ChartKind,
    ChartSpec, HeatmapScale, HeatmapSpec, HistogramMode, HistogramSpec, Interpolation, LineSeries, LineSpec, NumberFormat, PieLabelFormat, PieSlice, PieSpec,
    RenderOptions, ScatterPoint, ScatterSeries, ScatterSpec, SparklineSpec, SparklineVariant, ValueAxisSide, XRef, parse_spec, render, render_json,
};

#[test]
fn hostile_xss_and_xml_control_chars_are_safely_escaped() {
    let xss_title = "<script>alert('xss')</script> & <foreignObject><body onload=\"evil()\"></foreignObject>";
    let xss_cat = "Q1\" onmouseover=\"alert(1)\x00\x07\x1b";
    let xss_series = "Sales ]]> ' & \" <img src=x onerror=alert(1)>";

    let mut spec = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec![xss_cat.into(), "Q2 < > &".into()],
        series: vec![BarSeries {
            name: xss_series.into(),
            data: vec![Some(10.0), Some(20.0)],
            color: None,
        }],
        orientation: BarOrientation::Vertical,
        mode: BarMode::Grouped,
        show_values: true,
        corner_radius: None,
    }));
    spec.title = Some(xss_title.into());
    spec.subtitle = Some("Sub <script>x</script>".into());
    spec.annotations = vec![Annotation::HorizontalLine {
        value: 15.0,
        axis: ValueAxisSide::Left,
        label: Some("<iframe src=\"javascript:alert(1)\">".into()),
        color: None,
        dashed: true,
    }];

    let out = render(&spec, &RenderOptions::light()).expect("hostile labels must render safely");
    assert_valid_resolved_svg(&out);
    assert!(!out.svg.contains("<script"));
    assert!(!out.svg.contains("<foreignObject"));
    assert!(!out.svg.contains("<iframe"));
    assert!(!out.svg.contains('\x00'));
    assert!(!out.svg.contains('\x1b'));
}

#[test]
fn hostile_color_payloads_are_rejected() {
    let hostile_colors = [
        "red\" onclick=\"alert(1)",
        "url(javascript:alert(1))",
        "var(--accent)",
        "color-mix(in srgb, red 50%, blue)",
        "#12345",
        "",
        "expression(alert(1))",
    ];
    for bad in hostile_colors {
        let spec = ChartSpec::new(ChartKind::Bar(BarSpec {
            categories: vec!["A".into()],
            series: vec![BarSeries {
                name: "S".into(),
                data: vec![Some(10.0)],
                color: Some(bad.into()),
            }],
            orientation: BarOrientation::Vertical,
            mode: BarMode::Grouped,
            show_values: false,
            corner_radius: None,
        }));
        let err = render(&spec, &RenderOptions::light()).expect_err(&format!("color `{bad}` must be rejected"));
        assert!(matches!(err, ChartError::InvalidColor { .. }), "expected InvalidColor for `{bad}`, got {err:?}");
    }
}

#[test]
fn non_finite_values_are_rejected_everywhere() {
    for bad in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        // Bar value.
        let bar = ChartSpec::new(ChartKind::Bar(BarSpec {
            categories: vec!["A".into()],
            series: vec![BarSeries {
                name: "S".into(),
                data: vec![Some(bad)],
                color: None,
            }],
            orientation: BarOrientation::Vertical,
            mode: BarMode::Grouped,
            show_values: false,
            corner_radius: None,
        }));
        assert!(matches!(render(&bar, &RenderOptions::light()), Err(ChartError::NonFiniteValue { .. })));

        // Scatter coordinate.
        let scatter = ChartSpec::new(ChartKind::Scatter(ScatterSpec {
            series: vec![ScatterSeries {
                name: "S".into(),
                points: vec![ScatterPoint {
                    x: bad,
                    y: 1.0,
                    size: None,
                    label: None,
                }],
                color: None,
            }],
            point_radius: None,
            min_radius: None,
            max_radius: None,
            show_labels: false,
        }));
        assert!(matches!(render(&scatter, &RenderOptions::light()), Err(ChartError::NonFiniteValue { .. })));

        // Dimension.
        let mut bad_dim = ChartSpec::new(ChartKind::Sparkline(SparklineSpec {
            data: vec![Some(1.0), Some(2.0)],
            variant: SparklineVariant::Line,
            interpolation: Interpolation::Linear,
            color: None,
            negative_color: None,
            highlight_last: None,
            highlight_extrema: false,
            baseline: None,
        }));
        bad_dim.width = Some(bad);
        assert!(matches!(render(&bad_dim, &RenderOptions::light()), Err(ChartError::NonFiniteValue { .. })));

        // Annotation value.
        let mut bad_ann = ChartSpec::new(ChartKind::Sparkline(SparklineSpec {
            data: vec![Some(1.0), Some(2.0)],
            variant: SparklineVariant::Line,
            interpolation: Interpolation::Linear,
            color: None,
            negative_color: None,
            highlight_last: None,
            highlight_extrema: false,
            baseline: None,
        }));
        bad_ann.annotations.push(Annotation::VerticalLine {
            value: XRef::Number(bad),
            label: None,
            color: None,
            dashed: true,
        });
        assert!(matches!(render(&bad_ann, &RenderOptions::light()), Err(ChartError::NonFiniteValue { .. })));
    }
}

#[test]
fn empty_mismatched_and_out_of_range_inputs_return_actionable_errors() {
    // Empty series.
    let err = render_json(r#"{"type":"bar","categories":["A"],"series":[]}"#, &RenderOptions::light()).unwrap_err();
    assert!(matches!(err, ChartError::EmptyData { .. }));

    // Mismatched series data length.
    let err = render_json(
        r#"{"type":"bar","categories":["A","B"],"series":[{"name":"S","data":[1]}]}"#,
        &RenderOptions::light(),
    )
    .unwrap_err();
    assert!(matches!(err, ChartError::LengthMismatch { expected: 2, actual: 1, .. }));

    // All-null line chart.
    let err = render_json(
        r#"{"type":"line","categories":["A","B"],"series":[{"name":"S","data":[null,null]}]}"#,
        &RenderOptions::light(),
    )
    .unwrap_err();
    assert!(matches!(err, ChartError::EmptyData { .. }));

    // Negative value in 100%-stacked bar.
    let bad_pct_bar = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec!["A".into()],
        series: vec![BarSeries {
            name: "S".into(),
            data: vec![Some(-5.0)],
            color: None,
        }],
        orientation: BarOrientation::Vertical,
        mode: BarMode::PercentStacked,
        show_values: false,
        corner_radius: None,
    }));
    assert!(matches!(render(&bad_pct_bar, &RenderOptions::light()), Err(ChartError::OutOfRange { .. })));

    // Negative value in stacked area.
    let bad_area = ChartSpec::new(ChartKind::Area(AreaSpec {
        categories: vec!["A".into(), "B".into()],
        x_values: None,
        series: vec![LineSeries {
            name: "S".into(),
            data: vec![Some(10.0), Some(-2.0)],
            color: None,
            dashed: false,
            stroke_width: None,
        }],
        mode: AreaMode::Stacked,
        interpolation: Interpolation::Linear,
        show_points: false,
        fill_opacity: None,
        connect_nulls: false,
    }));
    assert!(matches!(render(&bad_area, &RenderOptions::light()), Err(ChartError::OutOfRange { .. })));

    // Non-positive value on log Y axis.
    let mut bad_log = ChartSpec::new(ChartKind::Line(LineSpec {
        categories: vec!["A".into(), "B".into()],
        x_values: None,
        series: vec![LineSeries {
            name: "S".into(),
            data: vec![Some(0.0), Some(10.0)],
            color: None,
            dashed: false,
            stroke_width: None,
        }],
        interpolation: Interpolation::Linear,
        show_points: false,
        show_values: false,
        connect_nulls: false,
    }));
    bad_log.y_axis.scale = AxisScale::Log;
    assert!(matches!(render(&bad_log, &RenderOptions::light()), Err(ChartError::OutOfRange { .. })));

    // Zero-sum pie and negative pie slice.
    let zero_pie = ChartSpec::new(ChartKind::Pie(PieSpec {
        slices: vec![PieSlice {
            label: "A".into(),
            value: 0.0,
            color: None,
        }],
        inner_radius_ratio: None,
        center_label: None,
        center_sublabel: None,
        show_labels: None,
        label_format: PieLabelFormat::Auto,
    }));
    assert!(matches!(render(&zero_pie, &RenderOptions::light()), Err(ChartError::EmptyData { .. })));

    // Bubble missing size.
    let bad_bubble = ChartSpec::new(ChartKind::Bubble(ScatterSpec {
        series: vec![ScatterSeries {
            name: "B".into(),
            points: vec![ScatterPoint {
                x: 1.0,
                y: 2.0,
                size: None,
                label: None,
            }],
            color: None,
        }],
        point_radius: None,
        min_radius: None,
        max_radius: None,
        show_labels: false,
    }));
    assert!(matches!(render(&bad_bubble, &RenderOptions::light()), Err(ChartError::OutOfRange { .. })));

    // Invalid BoxStats ordering (q1 > median).
    let bad_box = ChartSpec::new(ChartKind::Boxplot(BoxplotSpec {
        groups: vec![BoxplotGroup {
            label: "Bad".into(),
            samples: None,
            stats: Some(BoxStats {
                min: 1.0,
                q1: 20.0,
                median: 10.0,
                q3: 25.0,
                max: 30.0,
                outliers: Vec::new(),
                mean: None,
            }),
            color: None,
        }],
        orientation: BarOrientation::Vertical,
        show_mean: false,
    }));
    assert!(matches!(render(&bad_box, &RenderOptions::light()), Err(ChartError::OutOfRange { .. })));

    // Unsorted histogram bin edges.
    let bad_hist = ChartSpec::new(ChartKind::Histogram(HistogramSpec {
        values: vec![1.0, 2.0, 3.0],
        bins: None,
        bin_edges: Some(vec![0.0, 5.0, 3.0]),
        normalize: HistogramMode::Count,
        color: None,
        show_values: false,
        show_mean: false,
    }));
    assert!(matches!(render(&bad_hist, &RenderOptions::light()), Err(ChartError::OutOfRange { .. })));

    // Axis min >= max.
    let mut bad_axis = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec!["A".into()],
        series: vec![BarSeries {
            name: "S".into(),
            data: vec![Some(5.0)],
            color: None,
        }],
        orientation: BarOrientation::Vertical,
        mode: BarMode::Grouped,
        show_values: false,
        corner_radius: None,
    }));
    bad_axis.y_axis.min = Some(100.0);
    bad_axis.y_axis.max = Some(50.0);
    assert!(matches!(render(&bad_axis, &RenderOptions::light()), Err(ChartError::InvalidAxis { .. })));
}

#[test]
fn guardrails_reject_oversized_inputs_and_unterminated_jsonc() {
    // Unterminated block comment.
    let err = parse_spec("/* unterminated {\"type\":\"bar\"}").unwrap_err();
    assert!(matches!(err, ChartError::JsoncSyntax { .. }));

    // Oversized JSON (> 1 MiB).
    let huge = format!("{{\"type\":\"bar\",\"title\":\"{}\"}}", "a".repeat(1_100_000));
    assert!(matches!(parse_spec(&huge), Err(ChartError::InputTooLarge { .. })));

    // Too many series (> 32).
    let too_many_series = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec!["Q1".into()],
        series: (0..40)
            .map(|i| BarSeries {
                name: format!("S{i}"),
                data: vec![Some(1.0)],
                color: None,
            })
            .collect(),
        orientation: BarOrientation::Vertical,
        mode: BarMode::Grouped,
        show_values: false,
        corner_radius: None,
    }));
    assert!(matches!(
        render(&too_many_series, &RenderOptions::light()),
        Err(ChartError::LimitExceeded { field: "series", .. })
    ));

    // Too many heatmap cells (> 2500).
    let huge_hm = ChartSpec::new(ChartKind::Heatmap(HeatmapSpec {
        x_labels: (0..60).map(|i| format!("C{i}")).collect(),
        y_labels: (0..60).map(|i| format!("R{i}")).collect(),
        values: vec![vec![Some(1.0); 60]; 60],
        color_scale: HeatmapScale::Sequential,
        min: None,
        max: None,
        midpoint: None,
        show_values: None,
        value_format: NumberFormat::Number,
        show_color_bar: None,
        cell_radius: None,
        cell_gap: None,
    }));
    assert!(matches!(
        render(&huge_hm, &RenderOptions::light()),
        Err(ChartError::LimitExceeded { field: "values", .. })
    ));

    // Oversized canvas dimension (> 4096px).
    let mut huge_dim = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec!["A".into()],
        series: vec![BarSeries {
            name: "S".into(),
            data: vec![Some(1.0)],
            color: None,
        }],
        orientation: BarOrientation::Vertical,
        mode: BarMode::Grouped,
        show_values: false,
        corner_radius: None,
    }));
    huge_dim.width = Some(10_000.0);
    assert!(matches!(
        render(&huge_dim, &RenderOptions::light()),
        Err(ChartError::InvalidDimension { field: "width", .. })
    ));
}
