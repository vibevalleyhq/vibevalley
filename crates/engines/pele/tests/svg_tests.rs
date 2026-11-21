mod support;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::time::Instant;

use regex::Regex;
use vibevalley_pele::config::DiagramConfig;
use vibevalley_pele::svg::edges::{LEAD, route_path};
use vibevalley_pele::svg::ink::ink;
use vibevalley_pele::svg::theme::{SvgTheme, ThemeMode, ThemePalette, resolve_style};
use vibevalley_pele::text::label::layout_label;
use vibevalley_pele::{METRICS_MEASURER, MathSvg, RenderOptions, TextMeasurer, TextStyle, render};

use support::{assert_inert, assert_inert_resolved, assert_resvg_parses, assert_well_formed, css_options, dark_options, resolved_options};

const ON_LIGHT: &str = "var(--pele-fg-on-light,#1f1f1f)";
const ON_DARK: &str = "var(--pele-fg-on-dark,#fff)";

fn ink_for(decls: &[&str]) -> Option<String> {
    let theme = SvgTheme::new(ThemeMode::CssVariables, None, None);
    let owned: Vec<String> = decls.iter().map(|s| (*s).to_string()).collect();
    let style = resolve_style(&owned);
    ink(&style.shape, &style.text, &theme).map(str::to_string)
}

#[test]
fn label_ink_reads_hex_rgb_hsl_and_all_148_named_colors() {
    assert_eq!(ink_for(&["fill:#fff"]).as_deref(), Some(ON_LIGHT));
    assert_eq!(ink_for(&["fill:#BBDEFB"]).as_deref(), Some(ON_LIGHT));
    assert_eq!(ink_for(&["fill:#000"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:#1F3A5F"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:#000c"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:#ffffff80"]).as_deref(), Some(ON_LIGHT));

    // Mid-contrast threshold.
    assert_eq!(ink_for(&["fill:#f00"]).as_deref(), Some(ON_LIGHT));
    assert_eq!(ink_for(&["fill:#808000"]).as_deref(), Some(ON_DARK));

    // rgb() / rgba()
    assert_eq!(ink_for(&["fill:rgb(191, 223, 255)"]).as_deref(), Some(ON_LIGHT));
    assert_eq!(ink_for(&["fill:rgba(0,0,0,0.6)"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:RGB(100%, 100%, 100%)"]).as_deref(), Some(ON_LIGHT));
    assert_eq!(ink_for(&["fill:rgb(0% 0% 0% / .9)"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:rgba(255 255 255 / 75%)"]).as_deref(), Some(ON_LIGHT));
    assert_eq!(ink_for(&["fill:rgb(none 0 0)"]).as_deref(), Some(ON_DARK));

    // hsl() / hsla()
    assert_eq!(ink_for(&["fill:hsl(210, 100%, 87%)"]).as_deref(), Some(ON_LIGHT));
    assert_eq!(ink_for(&["fill:hsl(0 0% 10%)"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:hsla(120deg, 50%, 20%, 0.8)"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:hsl(0.5turn 100% 90%)"]).as_deref(), Some(ON_LIGHT));
    assert_eq!(ink_for(&["fill:hsl(-120, 100%, 30%)"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:hsl(0 0 95)"]).as_deref(), Some(ON_LIGHT));
    assert_eq!(ink_for(&["fill:hsl(none 0% 0%)"]).as_deref(), Some(ON_DARK));

    // All 148 CSS named colors in any case.
    let named: &[(&str, &str)] = &[
        ("aliceblue", "f0f8ff"),
        ("antiquewhite", "faebd7"),
        ("aqua", "00ffff"),
        ("aquamarine", "7fffd4"),
        ("azure", "f0ffff"),
        ("beige", "f5f5dc"),
        ("bisque", "ffe4c4"),
        ("black", "000000"),
        ("blanchedalmond", "ffebcd"),
        ("blue", "0000ff"),
        ("blueviolet", "8a2be2"),
        ("brown", "a52a2a"),
        ("burlywood", "deb887"),
        ("cadetblue", "5f9ea0"),
        ("chartreuse", "7fff00"),
        ("chocolate", "d2691e"),
        ("coral", "ff7f50"),
        ("cornflowerblue", "6495ed"),
        ("cornsilk", "fff8dc"),
        ("crimson", "dc143c"),
        ("cyan", "00ffff"),
        ("darkblue", "00008b"),
        ("darkcyan", "008b8b"),
        ("darkgoldenrod", "b8860b"),
        ("darkgray", "a9a9a9"),
        ("darkgreen", "006400"),
        ("darkgrey", "a9a9a9"),
        ("darkkhaki", "bdb76b"),
        ("darkmagenta", "8b008b"),
        ("darkolivegreen", "556b2f"),
        ("darkorange", "ff8c00"),
        ("darkorchid", "9932cc"),
        ("darkred", "8b0000"),
        ("darksalmon", "e9967a"),
        ("darkseagreen", "8fbc8f"),
        ("darkslateblue", "483d8b"),
        ("darkslategray", "2f4f4f"),
        ("darkslategrey", "2f4f4f"),
        ("darkturquoise", "00ced1"),
        ("darkviolet", "9400d3"),
        ("deeppink", "ff1493"),
        ("deepskyblue", "00bfff"),
        ("dimgray", "696969"),
        ("dimgrey", "696969"),
        ("dodgerblue", "1e90ff"),
        ("firebrick", "b22222"),
        ("floralwhite", "fffaf0"),
        ("forestgreen", "228b22"),
        ("fuchsia", "ff00ff"),
        ("gainsboro", "dcdcdc"),
        ("ghostwhite", "f8f8ff"),
        ("gold", "ffd700"),
        ("goldenrod", "daa520"),
        ("gray", "808080"),
        ("green", "008000"),
        ("greenyellow", "adff2f"),
        ("grey", "808080"),
        ("honeydew", "f0fff0"),
        ("hotpink", "ff69b4"),
        ("indianred", "cd5c5c"),
        ("indigo", "4b0082"),
        ("ivory", "fffff0"),
        ("khaki", "f0e68c"),
        ("lavender", "e6e6fa"),
        ("lavenderblush", "fff0f5"),
        ("lawngreen", "7cfc00"),
        ("lemonchiffon", "fffacd"),
        ("lightblue", "add8e6"),
        ("lightcoral", "f08080"),
        ("lightcyan", "e0ffff"),
        ("lightgoldenrodyellow", "fafad2"),
        ("lightgray", "d3d3d3"),
        ("lightgreen", "90ee90"),
        ("lightgrey", "d3d3d3"),
        ("lightpink", "ffb6c1"),
        ("lightsalmon", "ffa07a"),
        ("lightseagreen", "20b2aa"),
        ("lightskyblue", "87cefa"),
        ("lightslategray", "778899"),
        ("lightslategrey", "778899"),
        ("lightsteelblue", "b0c4de"),
        ("lightyellow", "ffffe0"),
        ("lime", "00ff00"),
        ("limegreen", "32cd32"),
        ("linen", "faf0e6"),
        ("magenta", "ff00ff"),
        ("maroon", "800000"),
        ("mediumaquamarine", "66cdaa"),
        ("mediumblue", "0000cd"),
        ("mediumorchid", "ba55d3"),
        ("mediumpurple", "9370db"),
        ("mediumseagreen", "3cb371"),
        ("mediumslateblue", "7b68ee"),
        ("mediumspringgreen", "00fa9a"),
        ("mediumturquoise", "48d1cc"),
        ("mediumvioletred", "c71585"),
        ("midnightblue", "191970"),
        ("mintcream", "f5fffa"),
        ("mistyrose", "ffe4e1"),
        ("moccasin", "ffe4b5"),
        ("navajowhite", "ffdead"),
        ("navy", "000080"),
        ("oldlace", "fdf5e6"),
        ("olive", "808000"),
        ("olivedrab", "6b8e23"),
        ("orange", "ffa500"),
        ("orangered", "ff4500"),
        ("orchid", "da70d6"),
        ("palegoldenrod", "eee8aa"),
        ("palegreen", "98fb98"),
        ("paleturquoise", "afeeee"),
        ("palevioletred", "db7093"),
        ("papayawhip", "ffefd5"),
        ("peachpuff", "ffdab9"),
        ("peru", "cd853f"),
        ("pink", "ffc0cb"),
        ("plum", "dda0dd"),
        ("powderblue", "b0e0e6"),
        ("purple", "800080"),
        ("rebeccapurple", "663399"),
        ("red", "ff0000"),
        ("rosybrown", "bc8f8f"),
        ("royalblue", "4169e1"),
        ("saddlebrown", "8b4513"),
        ("salmon", "fa8072"),
        ("sandybrown", "f4a460"),
        ("seagreen", "2e8b57"),
        ("seashell", "fff5ee"),
        ("sienna", "a0522d"),
        ("silver", "c0c0c0"),
        ("skyblue", "87ceeb"),
        ("slateblue", "6a5acd"),
        ("slategray", "708090"),
        ("slategrey", "708090"),
        ("snow", "fffafa"),
        ("springgreen", "00ff7f"),
        ("steelblue", "4682b4"),
        ("tan", "d2b48c"),
        ("teal", "008080"),
        ("thistle", "d8bfd8"),
        ("tomato", "ff6347"),
        ("turquoise", "40e0d0"),
        ("violet", "ee82ee"),
        ("wheat", "f5deb3"),
        ("white", "ffffff"),
        ("whitesmoke", "f5f5f5"),
        ("yellow", "ffff00"),
        ("yellowgreen", "9acd32"),
    ];
    assert_eq!(named.len(), 148);
    for &(name, hex) in named {
        let expected = ink_for(&[&format!("fill:#{hex}")]);
        assert_eq!(ink_for(&[&format!("fill:{name}")]), expected, "{name}");
        assert_eq!(ink_for(&[&format!("fill:{}", name.to_ascii_uppercase())]), expected, "{name} upper");
    }

    // Unreadable fills, low opacity, and explicit color left alone.
    for bad in [
        "var(--x)",
        "currentColor",
        "none",
        "transparent",
        "blu",
        "#ggg",
        "#12345",
        "rgb(1,2)",
        "rgb(1, 2 3)",
        "rgb(1 2 3 / 4 / 5)",
        "rgb(1, 2, 3 / 1)",
        "rgb(1 2 3 4)",
        "hsl(10%, 50%, 50%)",
        "rgb(10deg, 2, 3)",
        "rgb(0%,0,0)",
        "hsl(0,0,0)",
        "rgb(0. 0 0)",
        "rgb(none,0,0)",
    ] {
        assert_eq!(ink_for(&[&format!("fill:{bad}")]), None, "bad={bad}");
    }
    assert_eq!(ink_for(&["stroke:#000"]), None);
    assert_eq!(ink_for(&["fill:#0007"]), None);
    assert_eq!(ink_for(&["fill:#0000007f"]), None);
    assert_eq!(ink_for(&["fill:rgb(191 223 255 / 40%)"]), None);
    assert_eq!(ink_for(&["fill:#000", "fill-opacity:0.4"]), None);
    assert_eq!(ink_for(&["fill:#000", "fill-opacity:60%"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:#0009", "fill-opacity:0.8"]), None);
    assert_eq!(ink_for(&["fill:#000", "fill-opacity:calc(0.1)"]), None);
    assert_eq!(ink_for(&["fill:#000", "fill-opacity:var(--fade)"]), None);
    assert_eq!(ink_for(&["fill:#000", "opacity:0.4"]), None);
    assert_eq!(ink_for(&["fill:#000", "opacity:0.8", "fill-opacity:0.6"]), None);
    assert_eq!(ink_for(&["fill:#000", "opacity:0.8"]).as_deref(), Some(ON_DARK));
    assert_eq!(ink_for(&["fill:#fff", "color:#fff"]), None);
    assert_eq!(ink_for(&["fill:white"]).as_deref(), Some(ON_LIGHT));
}

fn series_vars(svg: &str) -> BTreeMap<usize, String> {
    let re_root = Regex::new(r#"^<svg[^>]*\bstyle="([^"]*)""#).unwrap();
    let style = &re_root.captures(svg).unwrap()[1];
    let re_var = Regex::new(r"--pele-series-(\d):([^;]*)").unwrap();
    let mut out = BTreeMap::new();
    for cap in re_var.captures_iter(style) {
        out.insert(cap[1].parse().unwrap(), cap[2].to_string());
    }
    out
}

#[test]
fn palette_theme_variables_and_contrast_on_pie() {
    let pie = "pie\n  \"A\": 1\n  \"B\": 2";
    let themed = |vars: &str, body: &str| format!("%%{{init: {{\"themeVariables\": {vars}}}}}%%\n{body}");

    assert_eq!(
        series_vars(&render(&themed(r#"{"pie1":"red","pie2":"blue"}"#, pie), &css_options()).unwrap().svg),
        BTreeMap::from([(1, "red".to_string()), (2, "blue".to_string())])
    );

    // Ignores palettes of other diagrams.
    assert!(series_vars(&render(&themed(r#"{"cScale0":"red","primaryColor":"red"}"#, pie), &css_options()).unwrap().svg).is_empty());
    assert!(series_vars(&render(&themed(r#"{"pie1":"red"}"#, "flowchart LR\n  a --> b"), &css_options()).unwrap().svg).is_empty());

    // Front matter & RenderOptions config.
    let front = format!("---\nconfig:\n  themeVariables:\n    pie1: '#123456'\n---\n{pie}");
    assert_eq!(
        series_vars(&render(&front, &css_options()).unwrap().svg),
        BTreeMap::from([(1, "#123456".to_string())])
    );
    let mut cfg = DiagramConfig::default();
    cfg.theme_variables.values.insert("pie2".to_string(), "oklch(70% 0.1 200)".to_string());
    let from_opt = render(
        pie,
        &RenderOptions {
            config: Some(cfg),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    assert_eq!(series_vars(&from_opt), BTreeMap::from([(2, "oklch(70% 0.1 200)".to_string())]));

    // Theme-aware colors accepted.
    let aware = render(
        &themed(
            r#"{"pie1":"var(--pele-accent)","pie2":"light-dark(#000, #fff)","pie3":"color-mix(in srgb, red 40%, blue)"}"#,
            pie,
        ),
        &css_options(),
    )
    .unwrap()
    .svg;
    assert_eq!(
        series_vars(&aware),
        BTreeMap::from([
            (1, "var(--pele-accent)".to_string()),
            (2, "light-dark(#000, #fff)".to_string()),
            (3, "color-mix(in srgb, red 40%, blue)".to_string()),
        ])
    );

    // Unsafe colors dropped.
    let unsafe_vals = [
        "url(https://example.com/a.svg)",
        "url(//example.com/a.svg)",
        "image-set(a 1x)",
        "red;stroke:blue",
        "\"><script>alert(1)</script>",
        "expression(alert(1))",
        "rgb(0, 0",
        "red)",
        "red}",
        "javascript:alert(1)",
        "/*",
        "reddish",
        "#ff00000",
        "var(--page-color)",
        "color-mix(in srgb, var(--page-color) 50%, red)",
    ];
    for bad in unsafe_vals {
        let json_bad = serde_json::to_string(bad).unwrap();
        let src = themed(&format!(r#"{{"pie1":{json_bad},"pie2":"blue"}}"#), pie);
        let svg = render(&src, &css_options()).unwrap().svg;
        assert_eq!(series_vars(&svg), BTreeMap::from([(2, "blue".to_string())]), "bad={bad}");
        assert!(!svg.contains("<script"));
        assert!(!svg.contains("url("));
    }

    // Contrast label ink on pie slices.
    let pie3 = render(
        &themed(
            r##"{"pie1":"#ffeb3b","pie2":"navy","pie3":"var(--pele-accent)"}"##,
            "pie\n  \"A\": 1\n  \"B\": 1\n  \"C\": 1",
        ),
        &css_options(),
    )
    .unwrap()
    .svg;
    let re_lbl = Regex::new(r"<text [^>]*>\d+%<").unwrap();
    let labels: Vec<&str> = re_lbl.find_iter(&pie3).map(|m| m.as_str()).collect();
    assert!(labels[0].contains(r#"fill="var(--pele-fg-on-light,#1f1f1f)""#));
    assert!(labels[1].contains(r#"fill="var(--pele-fg-on-dark,#fff)""#));
    assert!(!labels[2].contains("fill="));
    assert!(pie3.contains(r#"class="pele-slice-labels""#));

    // Unchanged without palette.
    assert_eq!(
        render(pie, &css_options()).unwrap().svg,
        render(&themed(r#"{"primaryColor":"red"}"#, pie), &css_options()).unwrap().svg
    );
    assert!(!render(pie, &css_options()).unwrap().svg.contains("--pele-series-1:"));
}

fn curve_nums(route: &[f64], curve: Option<&str>, st: f64, et: f64, sr: Option<f64>, er: Option<f64>) -> Vec<f64> {
    let re = Regex::new(r"^M[-\d.,]+(?:L[-\d.,]+)?C[-\d., ]+(?:L[-\d.,]+)?$").unwrap();
    let d = route_path(route, curve, st, et, sr, er).d;
    assert!(re.is_match(&d), "unexpected curve d={d}");
    let after_c = &d[d.find('C').unwrap() + 1..];
    let body = after_c.split('L').next().unwrap();
    body.split([' ', ',']).map(|s| s.parse::<f64>().unwrap()).collect()
}

fn assert_close(a: f64, b: f64, tol: f64) {
    assert!((a - b).abs() <= tol, "expected {a} ≈ {b} (tol={tol})");
}

#[test]
fn edge_paths_curves_leads_and_stepped_routes() {
    let re_mc = Regex::new(r"^M0,0C[-\d., ]+$").unwrap();
    for (across, along) in [(100.0, 48.0), (-100.0, 48.0), (100.0, 200.0), (30.0, 48.0)] {
        let down = route_path(&[0.0, 0.0, 0.0, across, along, 0.0], None, 0.0, 0.0, None, None);
        assert!(re_mc.is_match(&down.d), "d={}", down.d);
        let c = curve_nums(&[0.0, 0.0, 0.0, across, along, 0.0], None, 0.0, 0.0, None, None);
        assert_eq!([c[0], c[2], c[4], c[5]], [0.0, across, across, along]);
        assert!(c[1] > 0.0);
        assert!(c[3] < along);
        assert_eq!([down.sdx + 0.0, down.sdy, down.edx + 0.0, down.edy], [0.0, -1.0, 0.0, 1.0]);
        let sc = curve_nums(&[0.0, 0.0, 1.0, along, across, 1.0], None, 0.0, 0.0, None, None);
        assert_eq!([sc[0], sc[1], sc[2], sc[3]], [c[1], 0.0, c[3], across]);
    }

    // Handle sharpness clamping.
    let even = curve_nums(&[0.0, 0.0, 0.0, 200.0, 48.0, 0.0], None, 0.0, 0.0, None, None);
    assert_close(even[1], 24.0, 1e-4);
    assert_close(even[3], 24.0, 1e-4);
    let wide = curve_nums(&[0.0, 0.0, 0.0, 480.0, 48.0, 0.0], None, 0.0, 0.0, None, None);
    assert_close(wide[1], 19.2, 1e-4);
    assert_close(wide[3], 28.8, 1e-4);
    let far = curve_nums(&[0.0, 0.0, 0.0, -4800.0, 48.0, 0.0], None, 0.0, 0.0, None, None);
    assert_close(far[1], 12.0, 1e-4);
    assert_close(far[3], 36.0, 1e-4);
    let side = curve_nums(&[0.0, 0.0, 1.0, 40.0, 400.0, 1.0], None, 0.0, 0.0, None, None);
    assert_close(side[0], 16.0, 1e-4);
    assert_close(side[2], 24.0, 1e-4);

    // Leads into markers.
    let route = [0.0, 0.0, 0.0, 40.0, 48.0, 0.0];
    let arrow = route_path(&route, None, 0.0, 7.0, None, None);
    assert!(Regex::new(r"C[-\d., ]+ 40,35L40,41$").unwrap().is_match(&arrow.d));
    assert_eq!(&curve_nums(&route, None, 0.0, 7.0, None, None)[4..], &[40.0, 48.0 - 7.0 - LEAD]);
    let leaving = route_path(&route, None, 7.0, 0.0, None, None);
    assert!(leaving.d.starts_with("M0,7L0,13C"));
    assert_eq!(&curve_nums(&route, None, 0.0, 0.0, Some(0.0), Some(7.0 + LEAD))[4..], &[40.0, 35.0]);
    assert_eq!(
        &curve_nums(&route, None, 0.0, 8.0, Some(0.0), Some(8.0 + LEAD))[4..],
        &curve_nums(&route, None, 0.0, 7.0, Some(0.0), Some(8.0 + LEAD))[4..]
    );
    assert_eq!(&curve_nums(&[0.0, 0.0, 0.0, 15.0, 19.0, 0.0], None, 0.0, 7.0, None, None)[4..], &[15.0, 9.0]);
    assert_eq!(route_path(&[0.0, 0.0, 0.0, 0.0, 48.0, 0.0], None, 0.0, 7.0, None, None).d, "M0,0L0,41");

    for across in [40.0, 96.0, -96.0, 900.0] {
        let p = route_path(&[0.0, 0.0, 0.0, across, 48.0, 0.0], None, 0.0, 7.0, None, None);
        assert_eq!([p.sdx + 0.0, p.sdy], [0.0, -1.0]);
        assert_eq!([p.edx + 0.0, p.edy], [0.0, 1.0]);
    }

    // Multi-segment corners: curved, step, linear, straight.
    let multi = [0.0, 0.0, 0.0, 0.0, 20.0, 0.0, 100.0, 20.0, 0.0, 100.0, 48.0, 0.0];
    assert!(
        Regex::new(r"^M0,0C[-\d., ]+ 50,20C[-\d., ]+ 100,48$")
            .unwrap()
            .is_match(&route_path(&multi, None, 0.0, 0.0, None, None).d)
    );
    assert_eq!(
        route_path(&multi, Some("step"), 0.0, 0.0, None, None).d,
        "M0,0L0,8Q0,20 12,20L88,20Q100,20 100,32L100,48"
    );
    assert_eq!(
        route_path(
            &[0.0, 0.0, 0.0, 0.0, 20.0, 0.0, 10.0, 20.0, 0.0, 10.0, 48.0, 0.0],
            Some("step"),
            0.0,
            0.0,
            None,
            None
        )
        .d,
        "M0,0L0,15Q0,20 5,20Q10,20 10,25L10,48"
    );
    assert_eq!(route_path(&multi, Some("linear"), 0.0, 0.0, None, None).d, "M0,0L0,20L100,20L100,48");
    assert_eq!(
        route_path(&[0.0, 0.0, 0.0, 0.0, 20.0, 0.0, 0.0, 48.0, 0.0], None, 0.0, 0.0, None, None).d,
        "M0,0L0,48"
    );

    let step = route_path(&[0.0, 0.0, 0.0, 100.0, 48.0, 0.0], Some("step"), 0.0, 7.0, None, None);
    assert_eq!(step.d, "M0,0L0,12Q0,24 12,24L88,24Q100,24 100,36L100,41");
    assert_eq!([step.edx, step.edy], [0.0, 1.0]);
    assert_eq!(
        route_path(&[0.0, 0.0, 0.0, 100.0, 48.0, 0.0], Some("stepAfter"), 0.0, 0.0, None, None).d,
        "M0,0L0,36Q0,48 12,48L100,48"
    );
    assert_eq!(
        route_path(&[0.0, 0.0, 1.0, 48.0, 100.0, 1.0], Some("stepBefore"), 0.0, 0.0, None, None).d,
        "M0,0L0,88Q0,100 12,100L48,100"
    );
}

fn label_lines(raw: &str, max: f64) -> Vec<String> {
    layout_label(Some(raw), false, &METRICS_MEASURER, 16.0, max, TextStyle::NONE, None, None)
        .lines
        .into_iter()
        .map(|line| line.into_iter().map(|s| s.text).collect::<String>())
        .collect()
}

#[test]
fn cjk_wrapping_and_kinsoku_rules() {
    let ja = "在庫引当の結果を基幹システムへ連携し、出荷指示を倉庫管理システムに送信して完了を確認する";
    let out = label_lines(ja, 200.0);
    assert!(out.len() > 1);
    assert_eq!(out.join(""), ja);
    for w in layout_label(Some(ja), false, &METRICS_MEASURER, 16.0, 200.0, TextStyle::NONE, None, None).widths {
        assert!(w <= 200.0);
    }

    let re_start = Regex::new(r"^[、。，．）」』】]").unwrap();
    let re_end = Regex::new(r"[「『（【]$").unwrap();
    let quoted = format!("「{ja}」（確認済み）。");
    let mut max = 40.0;
    while max <= 240.0 {
        let lines = label_lines(&quoted, max);
        assert_eq!(lines.join(""), quoted);
        for line in &lines {
            assert!(!re_start.is_match(line), "line started with closing punct: {line}");
            assert!(!re_end.is_match(line), "line ended with opening bracket: {line}");
        }
        max += 8.0;
    }

    let mixed = label_lines("AWS Lambda から呼び出されるバッチ処理の完了通知を送信する", 160.0);
    assert!(mixed.len() > 1);
    let compact: String = mixed.join("").chars().filter(|c| !c.is_whitespace()).collect();
    assert_eq!(compact, "AWSLambdaから呼び出されるバッチ処理の完了通知を送信する");
    assert!(mixed.join("|").contains("Lambda"));

    assert_eq!(label_lines("one two three four five six", 80.0), vec!["one two", "three four", "five six"]);
    let ko = label_lines("안녕하세요 반갑습니다 여러분 모두", 90.0);
    assert!(ko.iter().all(|l| !l.ends_with(char::is_whitespace)));
    for word in ["안녕하세요", "반갑습니다", "여러분", "모두"] {
        assert!(ko.iter().any(|l| l.contains(word)), "missing {word}");
    }

    assert_eq!(label_lines("在庫確認", 200.0), vec!["在庫確認"]);
    assert_eq!(
        label_lines("Supercalifragilisticexpialidocious", 60.0),
        vec!["Supercalifragilisticexpialidocious"]
    );

    let long_ja = "在庫引当の結果を基幹システムへ連携し出荷指示を倉庫管理システムに送信する";
    let res = render(&format!("flowchart TD\n  A[{long_ja}] --> B[完了]"), &resolved_options()).unwrap();
    assert!(res.width < METRICS_MEASURER.width(long_ja, 16.0, TextStyle::NONE));
    assert_resvg_parses(&res.svg, "cjk flowchart");
}

#[test]
fn break_hints_zwsp_and_soft_hyphen() {
    let zwsp = '\u{200b}';
    let shy = '\u{00ad}';

    let out = label_lines(&format!("RRCConnection{zwsp}Reconfiguration{zwsp}Complete"), 140.0);
    let cleaned: Vec<String> = out.into_iter().map(|l| l.replace(zwsp, "")).collect();
    assert_eq!(cleaned, vec!["RRCConnection", "Reconfiguration", "Complete"]);

    let src = format!("RRCConnection{shy}Reconfiguration{shy}Complete");
    assert_eq!(label_lines(&src, 140.0), vec!["RRCConnection-", "Reconfiguration-", "Complete"]);
    for w in layout_label(Some(&src), false, &METRICS_MEASURER, 16.0, 140.0, TextStyle::NONE, None, None).widths {
        assert!(w <= 140.0);
    }
    assert_eq!(label_lines(&format!("Re{shy}con{shy}fig"), 200.0), vec![format!("Re{shy}con{shy}fig")]);
    assert_eq!(
        label_lines(&format!("a uni{shy}t test"), 39.2),
        vec![format!("a uni{shy}t"), "test".to_string()]
    );
    for w in layout_label(
        Some(&format!("a uni{shy}t{shy}ed")),
        false,
        &METRICS_MEASURER,
        16.0,
        39.2,
        TextStyle::NONE,
        None,
        None,
    )
    .widths
    {
        assert!(w <= 39.2);
    }
    for w in layout_label(
        Some(&format!("a uni{shy}<b>t</b> test")),
        false,
        &METRICS_MEASURER,
        16.0,
        39.2,
        TextStyle::NONE,
        None,
        None,
    )
    .widths
    {
        assert!(w <= 39.2);
    }

    // Linear time on 24,000 zero-width combining + break hint pieces.
    for hint in [shy, zwsp] {
        let huge = format!("{}{}i xx", "a".repeat(22), format!("\u{0300}{hint}").repeat(24_000));
        let started = Instant::now();
        let _ = layout_label(Some(&huge), false, &METRICS_MEASURER, 16.0, 200.0, TextStyle::NONE, None, None);
        assert!(started.elapsed().as_millis() < 1000, "took {:?}", started.elapsed());
    }

    let spaced = layout_label(
        Some(&format!("a uni{shy} t test")),
        false,
        &METRICS_MEASURER,
        16.0,
        39.2,
        TextStyle::NONE,
        None,
        None,
    );
    for w in &spaced.widths {
        assert!(*w <= 39.2);
    }
    assert!(!label_lines(&format!("a uni{shy} t test"), 39.2).join(" ").contains('-'));
    assert_eq!(label_lines(&format!("ab{shy}<i> cd</i>"), 25.0), vec![format!("ab{shy}"), "cd".to_string()]);
    assert_eq!(
        label_lines("RRCConnection&shy;Reconfiguration&shy;Complete", 140.0),
        vec!["RRCConnection-", "Reconfiguration-", "Complete"]
    );

    // Narrow sequence diagram splits at ZWSP break hints.
    let seq_src = format!(
        "sequenceDiagram\n  participant UE\n  participant gNB\n  participant AMF\n  gNB->>UE: RRCConnection{zwsp}Reconfiguration{zwsp}Complete\n  UE->>gNB: ok"
    );
    let svg = render(
        &seq_src,
        &RenderOptions {
            max_width: Some(360.0),
            ..css_options()
        },
    )
    .unwrap()
    .svg;
    let re_tspan = Regex::new(r"<tspan\b[^>]*>([^<]*)</tspan>").unwrap();
    let tspans: Vec<String> = re_tspan.captures_iter(&svg).map(|c| c[1].replace(zwsp, "")).collect();
    assert_eq!(tspans, vec!["RRCConnectionReconfiguration", "Complete"]);
}

#[test]
fn fonts_weights_and_radius_in_css_variables_mode() {
    let flow = "flowchart LR\n  A --> B";
    let root = |opts: RenderOptions<'_>| -> String {
        let svg = render(flow, &opts).unwrap().svg;
        Regex::new(r"^<svg[^>]*>").unwrap().find(&svg).unwrap().as_str().to_string()
    };

    let def = root(css_options());
    assert!(def.contains(";--_fm:var(--pele-font-mono,monospace);font:16px sans-serif;"));
    assert!(def.contains(";font-family:var(--pele-font,sans-serif)\""));
    assert!(!def.contains(" font-family="));
    for pinned in ["letter-spacing:normal", "word-spacing:normal", "text-transform:none", "direction:ltr"] {
        assert!(def.contains(&format!(";{pinned};")));
    }

    let custom = root(RenderOptions {
        font_family: Some("\"Segoe UI\", system-ui, sans-serif".to_string()),
        font_family_mono: Some("'SF Mono', ui-monospace".to_string()),
        ..css_options()
    });
    assert!(custom.contains("font-family:var(--pele-font,&quot;Segoe UI&quot;, system-ui, sans-serif)\""));
    assert!(custom.contains("--_fm:var(--pele-font-mono,'SF Mono', ui-monospace);"));

    let cjk_font = root(RenderOptions {
        font_family: Some("思源黑体, sans-serif".to_string()),
        ..css_options()
    });
    assert!(cjk_font.contains("var(--pele-font,思源黑体, sans-serif)"));

    let plain = render(flow, &css_options()).unwrap().svg;
    assert!(!plain.contains("font-weight"));
    assert!(!Regex::new(r"--_t?h?w:").unwrap().is_match(&plain));

    let titled = render(&format!("---\ntitle: My title\n---\n{flow}\n  B --> C[\"`**Bold** word`\"]"), &css_options())
        .unwrap()
        .svg;
    assert!(titled.contains(";--_tw:var(--pele-title-weight,bold);--_w:var(--pele-bold-weight,bold);"));
    assert!(!titled.contains("--_hw:"));
    assert!(titled.contains(r#"<tspan x="0" y="5.6" font-weight="var(--_w)">Bold</tspan><tspan> word</tspan>"#));

    // Sequence loop heading uses heading weight.
    let seq = render("sequenceDiagram\n  loop Daily\n    A->>B: x\n  end", &css_options()).unwrap().svg;
    assert!(seq.contains(";--_hw:var(--pele-heading-weight,bold);"));
    assert!(Regex::new(r#"<text[^>]* font-weight="var\(--_hw\)""#).unwrap().is_match(&seq));

    // Radius CSS variable in CssVariables mode, omitted on pie.
    let styled = render("flowchart LR\n  A[One] --> B[Two]\n  style B rx:10,fill:#eee", &css_options())
        .unwrap()
        .svg;
    assert!(styled.contains(";--_r:var(--pele-radius,4px)"));
    assert!(!styled.contains("rx=\"var("));
    assert!(styled.contains(r#"style="rx:var(--_r);rx:10;fill:#eee;""#));
    assert!(!render("pie\n  \"a\": 1", &css_options()).unwrap().svg.contains("--_r"));

    // Unsafe font lists fall back to generics.
    for bad in [
        "x;color:red",
        "x) ; y",
        "url(//evil.example/f)",
        "\"url(x)\"",
        "\"open",
        "it's",
        "a\nb",
        "x{}",
        "<b>",
        "\"a\";\"b\"",
        "a,,b",
        ", a",
        "",
    ] {
        let svg = render(
            flow,
            &RenderOptions {
                font_family: Some(bad.to_string()),
                font_family_mono: Some(bad.to_string()),
                ..css_options()
            },
        )
        .unwrap()
        .svg;
        assert!(svg.contains("font-family:var(--pele-font,sans-serif)\""), "bad={bad:?}");
        assert!(svg.contains("--_fm:var(--pele-font-mono,monospace);"), "bad={bad:?}");
        assert_inert(&svg, bad);
    }
}

#[test]
fn resolved_light_dark_and_custom_palettes_parse_in_resvg() {
    let diagrams = [
        (
            "flowchart",
            "flowchart TD\n  subgraph S[Cluster]\n    A[Start] -->|Yes| B{Check}\n  end\n  B --> C((Done))\n  style S fill:#BBDEFB\n  style C fill:navy",
        ),
        (
            "sequence",
            "sequenceDiagram\n  title Auth Flow\n  autonumber\n  box rgb(34, 56, 0) Backend\n    participant A as API\n    participant D@{ type: database, alias: \"DB\" }\n  end\n  A->>+D: Query\n  Note right of D: Indexed\n  D-->>-A: Rows",
        ),
        ("pie", "pie showData title Pets\n  \"Dogs\" : 386\n  \"Cats\" : 85\n  \"Rats\" : 15"),
    ];

    let mut custom = ThemePalette::dark();
    custom.bg = "#101820".to_string();
    custom.surface = "#1a2634".to_string();
    custom.accent = "#f2aa4c".to_string();
    custom.radius = 6.0;
    let custom_opts = RenderOptions {
        measurer: Some(&METRICS_MEASURER),
        theme_mode: ThemeMode::resolved(custom),
        ..RenderOptions::default()
    };

    for (name, src) in diagrams {
        let light = render(src, &resolved_options()).unwrap();
        let dark = render(src, &dark_options()).unwrap();
        let cust = render(src, &custom_opts).unwrap();

        for (label, res) in [("light", &light), ("dark", &dark), ("custom", &cust)] {
            let ctx = format!("{name}/{label}");
            assert_inert_resolved(&res.svg, &ctx);
            assert_resvg_parses(&res.svg, &ctx);
            assert!(!res.svg.contains("var(--"), "{ctx}: leaked CSS var");
            assert!(!res.svg.contains("color-mix("), "{ctx}: leaked color-mix");
            assert!(!res.svg.contains("<foreignObject"), "{ctx}: leaked foreignObject");
        }
        assert_ne!(light.svg, dark.svg, "{name}: light and dark should differ");
        assert!(dark.svg.contains("#1e1e1e") || dark.svg.contains("#2a2a2a") || dark.svg.contains("#e6e6e6"));
        assert!(cust.svg.contains("#101820") || cust.svg.contains("#1a2634") || cust.svg.contains("#e6e6e6"));
    }
}

#[test]
fn math_svg_resolver_never_emits_foreign_object() {
    let plain = render("flowchart LR\n  A[\"$$x^2$$\"]", &css_options()).unwrap().svg;
    assert!(plain.contains("$$x^2$$"));
    assert!(!plain.contains("pele-math"));

    let asked: RefCell<Vec<(String, f64)>> = RefCell::new(Vec::new());
    let math = |tex: &str, size: f64| -> Option<MathSvg> {
        asked.borrow_mut().push((tex.to_string(), size));
        Some(MathSvg {
            svg: format!(r#"<path d="M0,0H{}"/>"#, tex.len()),
            width: 40.0,
            height: 50.0,
        })
    };
    let res = render(
        "flowchart LR\n  A[\"$$a \\neq b_1 < c * d$$\"] -->|\"$$e^#35;$$\"| B",
        &RenderOptions {
            math: Some(&math),
            ..resolved_options()
        },
    )
    .unwrap();
    assert_eq!(*asked.borrow(), vec![("a \\neq b_1 < c * d".to_string(), 16.0), ("e^#".to_string(), 14.0),]);
    assert!(res.svg.contains(r#"<svg class="pele-math""#));
    assert!(!res.svg.contains("<foreignObject"));
    assert!(!res.svg.contains("$$"));
    assert_well_formed(&res.svg).unwrap();
    assert_resvg_parses(&res.svg, "flowchart math");

    // Sequence math & pie left alone.
    asked.borrow_mut().clear();
    let seq = render(
        "sequenceDiagram\n  participant A as $$\\alpha$$\n  A->>B: Solve $$x^2$$\n  Note over A: $$\\int x$$",
        &RenderOptions {
            math: Some(&math),
            ..resolved_options()
        },
    )
    .unwrap();
    let mut got: Vec<String> = asked.borrow().iter().map(|(t, _)| t.clone()).collect();
    got.sort();
    assert_eq!(got, vec!["\\alpha", "\\int x", "x^2"]);
    assert!(!seq.svg.contains("$$"));
    assert!(!seq.svg.contains("<foreignObject"));
    assert_resvg_parses(&seq.svg, "sequence math");

    asked.borrow_mut().clear();
    let pie_src = "pie\n  \"$$x$$\" : 3";
    let pie_with_math = render(
        pie_src,
        &RenderOptions {
            math: Some(&math),
            ..resolved_options()
        },
    )
    .unwrap()
    .svg;
    assert_eq!(pie_with_math, render(pie_src, &resolved_options()).unwrap().svg);
    assert!(asked.borrow().is_empty());
}
