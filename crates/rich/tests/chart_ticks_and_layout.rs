#[path = "chart_common/mod.rs"]
mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use common::{assert_valid_resolved_svg, extract_texts};
use vibevalley_rich::engine::chart::{
    Annotation, AxisScale, AxisSpec, BarMode, BarOrientation, BarSeries, BarSpec, ChartKind, ChartSpec, DefaultTextMeasurer, Interpolation, LegendPosition,
    LineSeries, LineSpec, NumberFormat, NumericScale, RenderOptions, TextMeasurer, TextMetrics, ValueAxisSide, XRef, format_value, nice_number, render,
    render_json, wrap_text,
};

#[test]
fn nice_number_and_linear_scale_produce_clean_ticks() {
    assert_eq!(nice_number(73.0, false), 100.0);
    assert_eq!(nice_number(18.0, true), 20.0);
    assert_eq!(nice_number(0.037, true), 0.05);

    // Decimal span that commonly triggers 0.30000000000000004 artifacts.
    let axis = AxisSpec::default();
    let dec_scale = NumericScale::build(0.0, 0.3, &axis, true, NumberFormat::Number);
    for lbl in &dec_scale.tick_labels {
        assert!(!lbl.contains("00000"), "floating-point artifact in tick label: {lbl}");
    }
    assert!(dec_scale.ticks.first().copied().unwrap() <= 0.0);
    assert!(dec_scale.ticks.last().copied().unwrap() >= 0.3);

    // Negative to positive span.
    let neg_scale = NumericScale::build(-47.0, 83.0, &axis, false, NumberFormat::Number);
    assert!(neg_scale.domain_min <= -47.0);
    assert!(neg_scale.domain_max >= 83.0);
    assert!(neg_scale.ticks.contains(&0.0));

    // Constant value span does not collapse to zero range.
    let flat_scale = NumericScale::build(42.0, 42.0, &axis, false, NumberFormat::Number);
    assert!(flat_scale.domain_max > flat_scale.domain_min);
    assert!(flat_scale.ticks.len() >= 2);
}

#[test]
fn log_scale_ticks_narrow_and_wide_decades() {
    let log_axis = AxisSpec {
        scale: AxisScale::Log,
        ..AxisSpec::default()
    };

    let narrow = NumericScale::build(3.0, 80.0, &log_axis, false, NumberFormat::Number);
    assert!(narrow.ticks.contains(&10.0));
    assert!(narrow.ticks.contains(&20.0));
    assert!(narrow.ticks.contains(&50.0));

    let wide = NumericScale::build(1.0, 1_000_000.0, &log_axis, false, NumberFormat::Compact);
    assert!(wide.ticks.contains(&1.0));
    assert!(wide.ticks.contains(&1_000.0));
    assert!(wide.ticks.contains(&1_000_000.0));
    assert!(wide.tick_labels.iter().any(|l| l == "1K"));
    assert!(wide.tick_labels.iter().any(|l| l == "1M"));
}

#[test]
fn number_formats_cover_all_five_modes() {
    assert_eq!(format_value(12345.0, NumberFormat::Number, None, None), "12,345");
    assert_eq!(format_value(12.345, NumberFormat::Number, None, Some(1)), "12.3");

    assert_eq!(format_value(950.0, NumberFormat::Compact, None, None), "950");
    assert_eq!(format_value(1_500.0, NumberFormat::Compact, None, None), "1.5K");
    assert_eq!(format_value(3_200_000.0, NumberFormat::Compact, None, None), "3.2M");
    assert_eq!(format_value(-2_500_000_000.0, NumberFormat::Compact, None, None), "-2.5B");

    assert_eq!(format_value(0.42, NumberFormat::Percent, None, None), "42%");
    assert_eq!(format_value(0.125, NumberFormat::Percent, None, None), "12.5%");

    assert_eq!(format_value(420.0, NumberFormat::Currency, None, None), "$420");
    assert_eq!(format_value(25_000.0, NumberFormat::Currency, Some("¥"), None), "¥25K");
    assert_eq!(format_value(-1500.0, NumberFormat::Currency, Some("€"), None), "-€1.5K");

    assert_eq!(format_value(0.0, NumberFormat::Duration, None, None), "0s");
    assert_eq!(format_value(0.25, NumberFormat::Duration, None, None), "250ms");
    assert_eq!(format_value(12.5, NumberFormat::Duration, None, None), "12.5s");
    assert_eq!(format_value(150.0, NumberFormat::Duration, None, None), "2m 30s");
    assert_eq!(format_value(5400.0, NumberFormat::Duration, None, None), "1h 30m");
    assert_eq!(format_value(129_600.0, NumberFormat::Duration, None, None), "1.5d");
}

#[test]
fn cjk_text_measurement_wrapping_and_multi_row_legend() {
    let m = DefaultTextMeasurer;
    let cjk = m.measure("季度收入分析", 14.0, false);
    let latin = m.measure("abcdef", 14.0, false);
    assert!(
        cjk.width > latin.width * 1.4,
        "CJK glyphs must measure substantially wider than Latin: cjk={}, latin={}",
        cjk.width,
        latin.width
    );

    let wrapped = wrap_text("这是一段非常长的中文图表标题，需要在有限宽度内自动换行而不会裁剪溢出", 180.0, 15.0, true, &m);
    assert!(wrapped.len() >= 2, "long CJK title should wrap into multiple lines: {wrapped:?}");
    for line in &wrapped {
        assert!(
            !line.starts_with('，') && !line.starts_with('。'),
            "kinsoku punctuation should not start a line: {line}"
        );
    }

    // Full chart with long Chinese title, subtitle, categories, and 6 Chinese series in top legend.
    let mut spec = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec!["第一季度".into(), "第二季度".into(), "第三季度".into(), "第四季度".into()],
        series: vec![
            BarSeries {
                name: "企业订阅收入".into(),
                data: vec![Some(120.0), Some(140.0), Some(165.0), Some(190.0)],
                color: None,
            },
            BarSeries {
                name: "个人工作台授权".into(),
                data: vec![Some(60.0), Some(72.0), Some(88.0), Some(95.0)],
                color: None,
            },
            BarSeries {
                name: "云端同步服务".into(),
                data: vec![Some(40.0), Some(48.0), Some(55.0), Some(62.0)],
                color: None,
            },
            BarSeries {
                name: "私有化部署支持".into(),
                data: vec![Some(30.0), Some(35.0), Some(42.0), Some(50.0)],
                color: None,
            },
            BarSeries {
                name: "插件生态分成".into(),
                data: vec![Some(15.0), Some(18.0), Some(24.0), Some(31.0)],
                color: None,
            },
            BarSeries {
                name: "培训与咨询".into(),
                data: vec![Some(10.0), Some(12.0), Some(14.0), Some(18.0)],
                color: None,
            },
        ],
        orientation: BarOrientation::Vertical,
        mode: BarMode::Stacked,
        show_values: false,
        corner_radius: Some(3.0),
    }));
    spec.width = Some(460.0);
    spec.height = Some(360.0);
    spec.title = Some("二零二六年度各业务线营收结构与季度增长趋势总览报表".into());
    spec.subtitle = Some("单位：万元人民币，含全部直营与渠道口径".into());
    spec.legend = LegendPosition::Top;
    spec.y_axis.label = Some("营收（万元）".into());
    spec.y_axis.format = NumberFormat::Currency;
    spec.y_axis.currency_symbol = Some("¥".into());

    let out = render(&spec, &RenderOptions::light()).expect("CJK bar chart");
    assert_valid_resolved_svg(&out);

    // Verify legend wrapped into >= 2 distinct Y rows.
    let doc = roxmltree::Document::parse(&out.svg).expect("xml");
    let mut legend_ys: Vec<i64> = Vec::new();
    for g in doc.descendants().filter(|n| n.is_element() && n.attribute("data-role") == Some("legend")) {
        for t in g.descendants().filter(|n| n.is_element() && n.tag_name().name() == "text") {
            let y: f64 = t.attribute("y").unwrap().parse().unwrap();
            let rounded = y.round() as i64;
            if !legend_ys.contains(&rounded) {
                legend_ys.push(rounded);
            }
        }
    }
    assert!(
        legend_ys.len() >= 2,
        "6 Chinese legend items in 460px width should wrap across >= 2 rows, got ys={legend_ys:?}"
    );
}

#[test]
fn crowded_x_axis_rotates_and_thins_labels() {
    let categories: Vec<String> = (1..=36).map(|i| format!("2026-01-{i:02}")).collect();
    let data: Vec<Option<f64>> = (1..=36).map(|i| Some((i as f64 * 1.7).sin() * 20.0 + 50.0)).collect();

    let spec = ChartSpec::new(ChartKind::Line(LineSpec {
        categories,
        x_values: None,
        series: vec![LineSeries {
            name: "Daily Active".into(),
            data,
            color: None,
            dashed: false,
            stroke_width: None,
        }],
        interpolation: Interpolation::Linear,
        show_points: false,
        show_values: false,
        connect_nulls: false,
    }));

    let out = render(&spec, &RenderOptions::light()).expect("crowded x axis");
    assert_valid_resolved_svg(&out);

    let doc = roxmltree::Document::parse(&out.svg).expect("xml");
    let x_texts: Vec<_> = doc
        .descendants()
        .filter(|n| n.is_element() && n.attribute("data-role") == Some("x-axis"))
        .flat_map(|g| g.descendants())
        .filter(|n| n.is_element() && n.tag_name().name() == "text")
        .collect();

    assert!(
        x_texts.len() < 36 && x_texts.len() >= 6,
        "expected thinned X labels between 6 and 35, got {}",
        x_texts.len()
    );
    assert!(
        x_texts.iter().any(|t| t.attribute("transform").is_some_and(|tr| tr.contains("rotate("))),
        "crowded X labels should be rotated"
    );
}

struct CountingMeasurer {
    calls: AtomicUsize,
}

impl TextMeasurer for CountingMeasurer {
    fn measure(&self, text: &str, font_size: f64, bold: bool) -> TextMetrics {
        self.calls.fetch_add(1, Ordering::Relaxed);
        DefaultTextMeasurer.measure(text, font_size, bold)
    }
}

#[test]
fn custom_text_measurer_hook_drives_layout() {
    let counter = Arc::new(CountingMeasurer { calls: AtomicUsize::new(0) });
    let mut spec = ChartSpec::new(ChartKind::Bar(BarSpec {
        categories: vec!["Alpha".into(), "Beta".into(), "Gamma".into()],
        series: vec![BarSeries {
            name: "Score".into(),
            data: vec![Some(10.0), Some(20.0), Some(30.0)],
            color: None,
        }],
        orientation: BarOrientation::Vertical,
        mode: BarMode::Grouped,
        show_values: false,
        corner_radius: None,
    }));
    spec.title = Some("Custom Measurer".into());

    let opts = RenderOptions::light().with_measurer(counter.clone());
    let out = render(&spec, &opts).expect("custom measurer render");
    assert_valid_resolved_svg(&out);
    assert!(counter.calls.load(Ordering::Relaxed) >= 5, "custom TextMeasurer should be called during layout");
}

#[test]
fn annotations_lines_and_bands_render_with_labels() {
    let mut spec = ChartSpec::new(ChartKind::Line(LineSpec {
        categories: vec!["Jan".into(), "Feb".into(), "Mar".into(), "Apr".into(), "May".into()],
        x_values: None,
        series: vec![LineSeries {
            name: "Error Rate".into(),
            data: vec![Some(0.012), Some(0.018), Some(0.045), Some(0.022), Some(0.015)],
            color: None,
            dashed: false,
            stroke_width: None,
        }],
        interpolation: Interpolation::Smooth,
        show_points: true,
        show_values: false,
        connect_nulls: false,
    }));
    spec.title = Some("SLO Monitoring".into());
    spec.y_axis.format = NumberFormat::Percent;
    spec.y_axis.min = Some(0.0);
    spec.y_axis.max = Some(0.06);
    spec.annotations = vec![
        Annotation::HorizontalBand {
            from: 0.0,
            to: 0.02,
            axis: ValueAxisSide::Left,
            label: Some("Healthy Zone".into()),
            color: Some("#4d7a2a".into()),
            opacity: Some(0.10),
        },
        Annotation::HorizontalLine {
            value: 0.03,
            axis: ValueAxisSide::Left,
            label: Some("SLO Alert 3%".into()),
            color: Some("#a83a2c".into()),
            dashed: true,
        },
        Annotation::VerticalLine {
            value: XRef::Category("Mar".into()),
            label: Some("v2.4 Deploy".into()),
            color: Some("#2c6aa3".into()),
            dashed: true,
        },
        Annotation::VerticalBand {
            from: XRef::Category("Mar".into()),
            to: XRef::Category("Apr".into()),
            label: Some("Canary".into()),
            color: Some("#d99226".into()),
            opacity: Some(0.12),
        },
    ];

    let out = render(&spec, &RenderOptions::light()).expect("annotated line");
    assert_valid_resolved_svg(&out);

    let texts = extract_texts(&out.svg);
    for expected in ["Healthy Zone", "SLO Alert 3%", "v2.4 Deploy", "Canary"] {
        assert!(texts.iter().any(|t| t == expected), "missing annotation label `{expected}` in {texts:?}");
    }
}

#[test]
fn jsonc_comments_and_trailing_commas_parse_cleanly() {
    let jsonc = r#"
    // Leading line comment
    {
        /* Multi-line
           block comment */
        "type": "line",
        "title": "API Traffic // https://vibevalley.dev /* literal */",
        "categories": ["Mon", "Tue", "Wed",],
        "series": [
            {
                "name": "Requests",
                "data": [120, 180, 160,], // trailing comma + inline comment
            },
        ],
        "yAxis": {
            "format": "compact",
        },
    }
    "#;
    let out = render_json(jsonc, &RenderOptions::light()).expect("jsonc render");
    assert_valid_resolved_svg(&out);
    let texts = extract_texts(&out.svg);
    assert!(
        texts.iter().any(|t| t == "API Traffic // https://vibevalley.dev /* literal */"),
        "comment tokens inside strings must be preserved intact: {texts:?}"
    );
}
