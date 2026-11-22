use std::collections::{HashMap, HashSet};
use std::time::Instant;

use regex::Regex;
use roxmltree::Document;
use vibevalley_pele::detect::DiagramType;
use vibevalley_pele::diagram::gantt::axis::{auto_ticks, interval_ticks, time_format};
use vibevalley_pele::diagram::gantt::dates::{DurationUnit, MAX_DATE_MS, add, format_date, make_date, parse_strict};
use vibevalley_pele::diagram::gantt::db::{GanttDb, parse_duration};
use vibevalley_pele::diagram::gantt::lexer::tokenize;
use vibevalley_pele::{ErrorCode, LinkInfo, ParseOptions, ParsedModel, RenderOptions, parse, render, supports};

use crate::support::{Mutator, PAYLOADS, assert_inert, assert_inert_resolved, assert_resvg_parses, css_options, dark_options, load_fixture, resolved_options};

fn dt(y: i64, m: i64, d: i64) -> i64 {
    make_date(y, m, d, 0, 0, 0, 0).unwrap()
}

fn dt_hms(y: i64, m: i64, d: i64, h: i64, min: i64, s: i64, ms: i64) -> i64 {
    make_date(y, m, d, h, min, s, ms).unwrap()
}

fn now_2014() -> i64 {
    dt_hms(2014, 1, 16, 12, 0, 0, 0)
}

fn gantt_css<'a>() -> RenderOptions<'a> {
    RenderOptions {
        now_ms: Some(now_2014()),
        ..css_options()
    }
}

fn gantt_resolved<'a>() -> RenderOptions<'a> {
    RenderOptions {
        now_ms: Some(now_2014()),
        ..resolved_options()
    }
}

fn gantt_dark<'a>() -> RenderOptions<'a> {
    RenderOptions {
        now_ms: Some(now_2014()),
        ..dark_options()
    }
}

const BASIC: &str = "gantt\n  title A Gantt Diagram\n  dateFormat YYYY-MM-DD\n  section Section\n  A task :a1, 2014-01-01, 30d\n  Another task :after a1, 20d\n  section Another\n  Task in Another :2014-01-12, 12d\n  another task :24d";

fn gantt_model(src: &str) -> GanttDb {
    match parse(src, &ParseOptions::default()).unwrap().model {
        ParsedModel::Gantt(db) => db,
        other => panic!("expected gantt, got {:?}", other.diagram_type()),
    }
}

fn count_class(svg: &str, class_name: &str) -> usize {
    let doc = Document::parse(svg).expect("valid SVG XML");
    doc.descendants()
        .filter(|n| n.is_element() && n.attribute("class").is_some_and(|c| c.split_whitespace().any(|tok| tok == class_name)))
        .count()
}

fn bars_of(svg: &str) -> HashMap<String, (f64, f64)> {
    let re = Regex::new(r#"<g class="pele-task[^"]*" data-id="([^"]*)">(?:<a [^>]*>)?<rect x="([-\d.]+)" y="[-\d.]+" width="([-\d.]+)""#).unwrap();
    let mut out = HashMap::new();
    for cap in re.captures_iter(svg) {
        out.insert(cap[1].to_string(), (cap[2].parse().unwrap(), cap[3].parse().unwrap()));
    }
    out
}

fn check_both_modes(src: &str, extra_css: &RenderOptions<'_>, extra_res: &RenderOptions<'_>) -> bool {
    let css = match render(src, extra_css) {
        Ok(r) => r.svg,
        Err(_) => return false,
    };
    let ctx: String = src.chars().take(160).collect();
    assert_inert(&css, &ctx);
    assert!(!css.contains("NaN") && !css.contains("Infinity"), "non-finite coord in {ctx}");

    let resolved = render(src, extra_res).expect("resolved render should succeed when css succeeded");
    assert_inert_resolved(&resolved.svg, &ctx);
    assert_resvg_parses(&resolved.svg, &ctx);
    true
}

#[test]
fn gantt_dates_parsing_formatting_arithmetic_and_axis() {
    let now = dt_hms(2031, 5, 6, 9, 30, 15, 250);
    let p = |input: &str, tpl: &str| parse_strict(input, tpl, now);

    // Strict date parsing accepted cases
    let ok_cases: &[(&str, &str, i64)] = &[
        ("2014-01-06", "YYYY-MM-DD", dt(2014, 1, 6)),
        ("06-01-2014", "DD-MM-YYYY", dt(2014, 1, 6)),
        ("14/1/6", "YY/M/D", dt(2014, 1, 6)),
        ("70/12/31", "YY/M/D", dt(1970, 12, 31)),
        ("2014-01-06 17:49", "YYYY-MM-DD HH:mm", dt_hms(2014, 1, 6, 17, 49, 0, 0)),
        ("2014-01-06 7:5:9", "YYYY-MM-DD H:m:s", dt_hms(2014, 1, 6, 7, 5, 9, 0)),
        ("2014-01-06T07:05:09.123", "YYYY-MM-DDTHH:mm:ss.SSS", dt_hms(2014, 1, 6, 7, 5, 9, 123)),
        ("9:30 PM", "h:mm A", dt_hms(2031, 5, 6, 21, 30, 0, 0)),
        ("12:05 am", "hh:mm a", dt_hms(2031, 5, 6, 0, 5, 0, 0)),
        ("12:05 pm", "hh:mm a", dt_hms(2031, 5, 6, 12, 5, 0, 0)),
        ("Jan 5, 2024", "MMM D, YYYY", dt(2024, 1, 5)),
        ("5th January 2024", "Do MMMM YYYY", dt(2024, 1, 5)),
        ("22nd December 2024", "Do MMMM YYYY", dt(2024, 12, 22)),
        ("on 2024-03-01", "[on] YYYY-MM-DD", dt(2024, 3, 1)),
        ("17:49", "HH:mm", dt_hms(2031, 5, 6, 17, 49, 0, 0)),
        ("2024", "YYYY", dt(2024, 1, 1)),
        ("03", "MM", dt(2031, 3, 1)),
        ("7", "D", dt(2031, 5, 7)),
        ("20", "ss", dt_hms(2031, 5, 6, 0, 0, 20, 0)),
        ("2 2024", "Q YYYY", dt(2024, 4, 1)),
        ("Monday 2024", "dddd YYYY", dt(2024, 1, 1)),
    ];
    for &(input, tpl, expected) in ok_cases {
        assert_eq!(p(input, tpl), Some(expected), "input={input} tpl={tpl}");
    }

    // Strict date parsing rejected cases
    let bad_cases: &[(&str, &str)] = &[
        ("2014-1-6", "YYYY-MM-DD"),
        ("2014-01-06 7:05:09", "YYYY-MM-DD H:m:s"),
        ("2014-13-01", "YYYY-MM-DD"),
        ("2014-02-30", "YYYY-MM-DD"),
        ("202-12-01", "YYYY-MM-DD"),
        ("202304", "YYYYMMDD"),
        ("2014-01-06 ", "YYYY-MM-DD"),
        (" 2014-01-06", "YYYY-MM-DD"),
        ("2014-01-06x", "YYYY-MM-DD"),
        ("0", "ss"),
        ("25:00", "HH:mm"),
        ("5 January 2024", "Do MMMM YYYY"),
        ("5th january 2024", "Do MMMM YYYY"),
        ("Tuesday 2024", "dddd YYYY"),
        ("2014-01-06", ""),
        ("2014-01-06", "q"),
        ("12/25/2020", "L"),
        ("2020-01", "YYYY-ww"),
        ("Invalid Date", ""),
        ("", "YYYY-MM-DD"),
    ];
    for &(input, tpl) in bad_cases {
        assert_eq!(p(input, tpl), None, "expected reject input={input} tpl={tpl}");
    }

    // Unix timestamps & UTC offset (+00:00 / +0000)
    assert_eq!(p("1410715640", "X"), Some(1_410_715_640_000));
    assert_eq!(p("1410715640579", "x"), Some(1_410_715_640_579));
    assert_eq!(p("-5", "x"), Some(-5));
    assert_eq!(p("1410715640.579", "X"), None);
    assert_eq!(p("1e3", "x"), None);
    assert_eq!(p("", "x"), None);
    let local = dt_hms(2024, 1, 5, 10, 0, 0, 0);
    assert_eq!(p("2024-01-05T10:00:00+00:00", "YYYY-MM-DDTHH:mm:ssZ"), Some(local));
    assert_eq!(p("2024-01-05T10:00:00+0000", "YYYY-MM-DDTHH:mm:ssZZ"), Some(local));
    assert_eq!(p("2024-01-05T10:00:00+05:45", "YYYY-MM-DDTHH:mm:ssZ"), None);

    // Date formatting
    let d = dt_hms(2024, 2, 3, 15, 4, 5, 67);
    let fmt_cases: &[(&str, &str)] = &[
        ("YYYY-MM-DD", "2024-02-03"),
        ("YY M D", "24 2 3"),
        ("MMM MMMM", "Feb February"),
        ("d dd ddd dddd", "6 Sa Sat Saturday"),
        ("H HH h hh", "15 15 3 03"),
        ("m mm s ss SSS", "4 04 5 05 067"),
        ("a A", "pm PM"),
        ("Do [of] MMMM", "3rd of February"),
        ("Q", "1"),
        ("k kk", "15 15"),
        ("W WW GGGG", "5 05 2024"),
        ("[YYYY] YYYY", "YYYY 2024"),
        ("Y YYY", "Y 24Y"),
        ("S SS", "S SS"),
        ("Z", "+00:00"),
        ("ZZ", "+0000"),
        ("", "2024-02-03T15:04:05+00:00"),
    ];
    for &(tpl, exp) in fmt_cases {
        assert_eq!(format_date(Some(d), tpl).as_deref(), Some(exp), "tpl={tpl}");
    }
    assert_eq!(format_date(Some(d), "x").as_deref(), Some(d.to_string().as_str()));
    assert_eq!(format_date(Some(d), "X").as_deref(), Some(d.div_euclid(1000).to_string().as_str()));
    let ords: Vec<String> = [1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31]
        .iter()
        .map(|&day| format_date(Some(dt(2024, 1, day)), "Do").unwrap())
        .collect();
    assert_eq!(ords, vec!["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "31st"]);
    assert_eq!(format_date(Some(dt_hms(2024, 1, 1, 0, 30, 0, 0)), "k h a").as_deref(), Some("24 12 am"));
    assert_eq!(format_date(Some(dt(2021, 1, 3)), "GGGG-[W]WW").as_deref(), Some("2020-W53"));
    assert_eq!(format_date(Some(dt(2024, 12, 30)), "GGGG-[W]WW").as_deref(), Some("2025-W01"));
    assert_eq!(format_date(Some(dt(2026, 1, 1)), "W").as_deref(), Some("1"));
    for unsupported in ["w", "ww", "wo", "gggg", "z", "zzz", "YYYY-ww"] {
        assert_eq!(format_date(Some(d), unsupported), None);
    }
    assert_eq!(format_date(Some(d), "[w] YYYY").as_deref(), Some("w 2024"));
    assert_eq!(format_date(None, "YYYY").as_deref(), Some("Invalid Date"));

    // Date arithmetic & durations
    assert_eq!(add(dt(2020, 11, 1), 1.0, DurationUnit::D), Some(dt(2020, 11, 2)));
    assert_eq!(add(dt(2024, 3, 9), 2.0, DurationUnit::D), Some(dt(2024, 3, 11)));
    assert_eq!(add(dt(2013, 1, 1), 2.0, DurationUnit::W), Some(dt(2013, 1, 15)));
    assert_eq!(add(dt(2013, 1, 1), 1.5, DurationUnit::D), Some(dt(2013, 1, 3)));
    assert_eq!(add(dt(2013, 1, 1), 0.4, DurationUnit::D), Some(dt(2013, 1, 1)));
    assert_eq!(add(dt(2013, 1, 1), 0.5, DurationUnit::W), Some(dt(2013, 1, 5)));
    let s13 = dt(2013, 1, 1);
    assert_eq!(add(s13, 2.0, DurationUnit::H).unwrap() - s13, 7_200_000);
    assert_eq!(add(s13, 2.0, DurationUnit::M).unwrap() - s13, 120_000);
    assert_eq!(add(s13, 0.005, DurationUnit::S).unwrap() - s13, 5);
    assert_eq!(add(s13, 20.0, DurationUnit::Ms).unwrap() - s13, 20);
    assert_eq!(add(dt(2024, 1, 31), 1.0, DurationUnit::Month), Some(dt(2024, 2, 29)));
    assert_eq!(add(dt(2023, 12, 31), 2.0, DurationUnit::Month), Some(dt(2024, 2, 29)));
    assert_eq!(add(dt(2024, 3, 30), 11.0, DurationUnit::Month), Some(dt(2025, 2, 28)));
    assert_eq!(add(dt(2024, 2, 29), 1.0, DurationUnit::Y), Some(dt(2025, 2, 28)));
    assert_eq!(add(dt(2024, 1, 15), 1.5, DurationUnit::Month), Some(dt(2024, 2, 15)));
    assert_eq!(add(dt(2024, 1, 1), 99_999_999.0, DurationUnit::Y), None);

    assert_eq!(parse_duration("1.5d"), Some((1.5, DurationUnit::D)));
    assert_eq!(parse_duration(" 3M "), Some((3.0, DurationUnit::Month)));
    assert_eq!(parse_duration("500ms"), Some((500.0, DurationUnit::Ms)));
    assert_eq!(parse_duration("3dX"), None);
    assert_eq!(parse_duration("-1d"), None);

    // Axis time_format
    let ax_cases: &[(&str, &str)] = &[
        ("%Y-%m-%d", "2024-02-03"),
        ("%a %A %b %B", "Sat Saturday Feb February"),
        ("%H:%M:%S.%L", "15:04:05.067"),
        ("%I %p", "03 PM"),
        ("%e|%-d|%_d|%0e", " 3|3| 3|03"),
        ("%j", "034"),
        ("%U %W %V", "04 05 05"),
        ("%u %w", "6 6"),
        ("%y %G %g", "24 2024 24"),
        ("%q", "1"),
        ("%x", "2/3/2024"),
        ("%X", "3:04:05 PM"),
        ("%c", "2/3/2024, 3:04:05 PM"),
        ("%f", "067000"),
        ("%%Y %k %", "%Y k "),
    ];
    for &(spec, exp) in ax_cases {
        assert_eq!(time_format(spec, d), exp, "spec={spec}");
    }
    assert_eq!(time_format("%s", d), d.div_euclid(1000).to_string());
    assert_eq!(time_format("%Q", d), d.to_string());
    assert_eq!(time_format("%U %W %V %G", dt(2023, 1, 1)), "01 00 52 2022");
    assert_eq!(time_format("%U %W %V %G", dt(2024, 12, 30)), "52 53 01 2025");
    assert_eq!(time_format("%U %W %V", dt(2024, 1, 1)), "00 01 01");

    // auto_ticks & interval_ticks & overflow
    assert_eq!(
        auto_ticks(dt(2014, 1, 1), dt(2014, 2, 20), 10),
        (0..7).map(|k| dt(2014, 1, 5 + 7 * k)).collect::<Vec<_>>()
    );
    assert_eq!(
        auto_ticks(dt_hms(2024, 1, 10, 9, 0, 0, 0), dt_hms(2024, 1, 10, 18, 0, 0, 0), 10),
        (9..=18).map(|h| dt_hms(2024, 1, 10, h, 0, 0, 0)).collect::<Vec<_>>()
    );
    assert_eq!(
        auto_ticks(dt(1900, 1, 1), dt(2020, 1, 1), 10),
        (0..13).map(|k| dt(1900 + 10 * k, 1, 1)).collect::<Vec<_>>()
    );
    assert_eq!(
        auto_ticks(dt(2024, 1, 1), dt(2024, 7, 31), 7),
        (1..=7).map(|m| dt(2024, m, 1)).collect::<Vec<_>>()
    );
    assert_eq!(auto_ticks(0, 71_000, 10), (0..15).map(|k| k * 5_000).collect::<Vec<_>>());
    assert_eq!(auto_ticks(0, 30, 10), vec![0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30]);

    let s = dt(2024, 1, 1);
    let e = dt(2024, 1, 31);
    assert_eq!(
        interval_ticks("1week", "monday", s, e, 100),
        Some([1, 8, 15, 22, 29].map(|d| dt(2024, 1, d)).to_vec())
    );
    assert_eq!(
        interval_ticks("1week", "sunday", s, e, 100),
        Some([7, 14, 21, 28].map(|d| dt(2024, 1, d)).to_vec())
    );
    assert_eq!(
        interval_ticks("1week", "thursday", s, e, 100),
        Some([4, 11, 18, 25].map(|d| dt(2024, 1, d)).to_vec())
    );
    assert_eq!(
        interval_ticks("10day", "sunday", s, e, 100),
        Some([1, 11, 21, 31].map(|d| dt(2024, 1, d)).to_vec())
    );
    assert_eq!(
        interval_ticks("1month", "sunday", s, dt(2024, 4, 2), 100),
        Some([1, 2, 3, 4].map(|m| dt(2024, m, 1)).to_vec())
    );
    assert_eq!(
        interval_ticks("6hour", "sunday", s, dt(2024, 1, 2), 100),
        Some([0, 6, 12, 18, 24].map(|h| dt_hms(2024, 1, 1, h, 0, 0, 0)).to_vec())
    );
    assert_eq!(
        interval_ticks("15minute", "sunday", dt_hms(2024, 1, 1, 9, 5, 0, 0), dt_hms(2024, 1, 1, 10, 0, 0, 0), 100),
        Some([15, 30, 45, 60].map(|m| dt_hms(2024, 1, 1, 9, m, 0, 0)).to_vec())
    );
    assert!(interval_ticks("2week", "monday", s, e, 100).unwrap().len() <= 3);

    for bad in ["", "1decade", "1year", "0day", "01day", "1 day", "1days", "day", "1.5day", "-1day"] {
        assert_eq!(interval_ticks(bad, "sunday", s, e, 100), None);
    }
    assert_eq!(interval_ticks("1second", "sunday", s, e, 1000), None);
    assert_eq!(interval_ticks("99999999second", "sunday", s, e, 1000), None);
    assert_eq!(interval_ticks("1day", "nonsense", s, e, 100).unwrap().len(), 31);

    assert_eq!(auto_ticks(-MAX_DATE_MS, -MAX_DATE_MS + 120_000, 4), Vec::<i64>::new());
    assert_eq!(
        interval_ticks("2second", "sunday", MAX_DATE_MS - 1000, MAX_DATE_MS, 10),
        Some(vec![MAX_DATE_MS])
    );
}

#[test]
fn gantt_rendering_bars_today_states_milestones_verts_excludes_axis_and_config() {
    let res = render(BASIC, &gantt_css()).unwrap();
    assert_eq!(res.diagram_type, DiagramType::Gantt);
    assert!(supports(BASIC));
    assert_eq!(count_class(&res.svg, "pele-task"), 4);
    assert_eq!(count_class(&res.svg, "pele-section"), 2);
    assert_eq!(count_class(&res.svg, "pele-section-label"), 2);
    assert!(res.svg.contains(">A Gantt Diagram<"));
    assert!(res.svg.contains(">Task in Another<"));
    assert!(res.svg.contains(">2014-01-12<"));
    assert!(res.svg.contains(r#"class="pele-grid""#));
    assert_eq!(res.width, 800.0);
    assert!(res.height > 150.0);
    assert_eq!(res.svg, render(BASIC, &gantt_css()).unwrap().svg);

    // Light + dark resolved + resvg
    let light = render(BASIC, &gantt_resolved()).unwrap();
    assert_inert_resolved(&light.svg, "gantt light");
    assert_resvg_parses(&light.svg, "gantt light");
    let dark = render(BASIC, &gantt_dark()).unwrap();
    assert_inert_resolved(&dark.svg, "gantt dark");
    assert_resvg_parses(&dark.svg, "gantt dark");

    // Proportional bars
    let prop = bars_of(
        &render(
            "gantt\n dateFormat YYYY-MM-DD\n A :a, 2024-01-01, 10d\n B :b, 2024-01-06, 5d\n C :c, 2024-01-11, 10d",
            &gantt_css(),
        )
        .unwrap()
        .svg,
    );
    let a = prop["a"];
    assert!((prop["b"].0 - (a.0 + a.1 / 2.0)).abs() < 1.0);
    assert!((prop["b"].1 - a.1 / 2.0).abs() < 1.0);
    assert!((prop["c"].0 - (a.0 + a.1)).abs() < 1.0);

    // Today marker presence, movement, style filtering
    assert!(res.svg.contains(r#"class="pele-today""#));
    let mut o2020 = gantt_css();
    o2020.now_ms = Some(dt(2020, 1, 1));
    assert!(!render(BASIC, &o2020).unwrap().svg.contains("pele-today"));
    assert!(
        !render(&BASIC.replace("dateFormat", "todayMarker off\n  dateFormat"), &gantt_css())
            .unwrap()
            .svg
            .contains("pele-today")
    );
    let today_x = |ms: i64| -> f64 {
        let mut o = gantt_css();
        o.now_ms = Some(ms);
        let svg = render(BASIC, &o).unwrap().svg;
        Regex::new(r#"class="pele-today"><path d="M([\d.]+),"#).unwrap().captures(&svg).unwrap()[1]
            .parse()
            .unwrap()
    };
    assert!(today_x(dt(2014, 1, 20)) > today_x(dt(2014, 1, 10)));
    let styled_today = render(
        &BASIC.replace(
            "dateFormat",
            "todayMarker stroke-width:5px,stroke:#0f0,opacity:0.5,background:url(x)\n  dateFormat",
        ),
        &gantt_css(),
    )
    .unwrap()
    .svg;
    assert!(styled_today.contains(r#"style="stroke-width:5px;stroke:#0f0;opacity:0.5;""#));
    assert!(!styled_today.contains("url("));

    // Done / active / critical task styles
    let states = render(
        "gantt\n dateFormat YYYY-MM-DD\n P :p, 2024-01-01, 9d\n A :active, a, 2024-01-01, 9d\n D :done, d, 2024-01-01, 9d\n C :crit, c, 2024-01-01, 9d\n CD :crit, done, cd, 2024-01-01, 9d\n CA :crit, active, ca, 2024-01-01, 9d",
        &gantt_css(),
    )
    .unwrap()
    .svg;
    let paint = |id: &str| -> String {
        Regex::new(&format!(r#"data-id="{id}"><rect [^>]*?(fill="[^/]*)/>"#))
            .unwrap()
            .captures(&states)
            .unwrap()[1]
            .to_string()
    };
    let all_paints: HashSet<String> = ["p", "a", "d", "c", "cd", "ca"].into_iter().map(paint).collect();
    assert_eq!(all_paints.len(), 6);
    assert_eq!(paint("p"), r#"fill="var(--_c)" stroke="var(--_c)" style="rx:var(--_r)""#);
    assert!(paint("a").contains(r#"fill-opacity="0.25""#));
    assert!(paint("d").contains(r#"fill="var(--_a)""#));
    let red = "var(--pele-critical,#e45756)";
    assert_eq!(paint("c"), format!(r#"fill="{red}" stroke="{red}" style="rx:var(--_r)""#));
    assert_eq!(paint("cd"), format!(r#"fill="var(--_a)" stroke="{red}" style="rx:var(--_r)""#));
    assert_eq!(paint("ca"), format!(r#"fill="{red}" fill-opacity="0.25" stroke="{red}" style="rx:var(--_r)""#));
    assert!(states.contains(r#"class="pele-task pele-done pele-crit""#));
    assert!(states.contains(r#"class="pele-task pele-active""#));

    // Milestone diamond + vertical marker
    let ms = render(
        "gantt\n dateFormat HH:mm\n axisFormat %H:%M\n M : milestone, m1, 17:49, 2m\n Task A : 10m",
        &gantt_css(),
    )
    .unwrap()
    .svg;
    assert!(
        Regex::new(r#"class="pele-task pele-milestone" data-id="m1"><path d="M[\d.,]+L[\d.,]+L[\d.,]+L[\d.,]+Z""#)
            .unwrap()
            .is_match(&ms)
    );
    assert_eq!(count_class(&ms, "pele-task"), 2);
    assert!(ms.contains(">17:50<"));

    let with_vert = render(
        "gantt\n dateFormat YYYY-MM-DD\n A :a, 2024-01-01, 9d\n Deadline :vert, v, 2024-01-05, 0d",
        &gantt_css(),
    )
    .unwrap();
    let without = render("gantt\n dateFormat YYYY-MM-DD\n A :a, 2024-01-01, 9d", &gantt_css()).unwrap();
    assert_eq!(count_class(&with_vert.svg, "pele-vert"), 1);
    assert_eq!(count_class(&with_vert.svg, "pele-task"), 1);
    assert!(with_vert.svg.contains(">Deadline<"));
    assert!(with_vert.height - without.height < 30.0);

    // Label placement inside vs beside + growing width
    let lbl_svg = render(
        "gantt\n dateFormat YYYY-MM-DD\n Short :a, 2024-01-01, 30d\n A label far too long for its bar :b, 2024-01-02, 1d",
        &gantt_css(),
    )
    .unwrap()
    .svg;
    let lb = bars_of(&lbl_svg);
    let label_x = |txt: &str| -> f64 {
        Regex::new(&format!(r#"x="([\d.]+)" y="[\d.]+" text-anchor="middle">{txt}<"#))
            .unwrap()
            .captures(&lbl_svg)
            .unwrap()[1]
            .parse()
            .unwrap()
    };
    assert!((label_x("Short") - (lb["a"].0 + lb["a"].1 / 2.0)).abs() < 1.0);
    assert!(label_x("A label far too long for its bar") > lb["b"].0 + lb["b"].1);
    assert!(
        Regex::new(r#"fill="var\(--_bg\)" x="[\d.]+" y="[\d.]+" text-anchor="middle">Short<"#)
            .unwrap()
            .is_match(&lbl_svg)
    );

    let long_lbl = "A label that is much longer than anything the plot leaves room for on either side of the bar, so the chart has to grow";
    let grown = render(
        &format!("gantt\n dateFormat YYYY-MM-DD\n {long_lbl} :a, 2024-01-01, 1d\n B :b, 2024-01-01, 2d"),
        &gantt_css(),
    )
    .unwrap();
    assert!(grown.width > 800.0);
    assert!(grown.svg.contains(&format!(r#"viewBox="0 0 {} "#, grown.width)));

    // Excluded days shading & stretching
    let plain_ex = render("gantt\n dateFormat YYYY-MM-DD\n A :a, 2024-01-05, 3d\n B :b, 2024-01-01, 14d", &gantt_css()).unwrap();
    let excl = render(
        "gantt\n dateFormat YYYY-MM-DD\n excludes weekends\n A :a, 2024-01-05, 3d\n B :b, 2024-01-01, 2024-01-15",
        &gantt_css(),
    )
    .unwrap();
    assert!(!plain_ex.svg.contains("pele-excluded"));
    assert!(excl.svg.contains(r#"class="pele-excluded""#));
    let ex_group = &Regex::new(r#"<g class="pele-excluded"[^>]*>(.*?)</g>"#).unwrap().captures(&excl.svg).unwrap()[1];
    assert_eq!(ex_group.matches("<rect").count(), 2);
    assert!(bars_of(&excl.svg)["a"].1 > bars_of(&plain_ex.svg)["a"].1 * 1.5);

    // axisFormat, tickInterval, weekday, topAxis, D format
    let ax_src = |extra: &str| format!("gantt\n dateFormat YYYY-MM-DD\n{extra} A :a, 2024-01-01, 30d\n");
    let weekly = render(&ax_src(" tickInterval 1week\n weekday monday\n axisFormat %a %e %b\n"), &gantt_css())
        .unwrap()
        .svg;
    assert!(weekly.contains(">Mon  1 Jan<") && weekly.contains(">Mon  8 Jan<") && !weekly.contains(">Sun"));
    let sundays = render(&ax_src(" tickInterval 1week\n axisFormat %a %d\n"), &gantt_css()).unwrap().svg;
    assert!(sundays.contains(">Sun 07<"));
    let plain_ax = render(&ax_src(""), &gantt_css()).unwrap();
    let top_ax = render(&ax_src(" topAxis\n"), &gantt_css()).unwrap();
    assert!(top_ax.height > plain_ax.height);
    let re_day = Regex::new(r">2024-01-0\d<").unwrap();
    assert_eq!(re_day.find_iter(&top_ax.svg).count(), 2 * re_day.find_iter(&plain_ax.svg).count());
    assert_eq!(render(&ax_src(" tickInterval 1decade\n"), &gantt_css()).unwrap().svg, plain_ax.svg);

    let fallback = render("gantt\n dateFormat YYYY-MM-DD\n tickInterval 1second\n A :a, 2024-01-01, 300d\n", &gantt_css())
        .unwrap()
        .svg;
    assert!(
        Regex::new(r#"<text [^>]*text-anchor="middle">\d{4}-\d\d-\d\d<"#)
            .unwrap()
            .find_iter(&fallback)
            .count()
            < 20
    );
    assert!(
        Regex::new(r">0[5-9]<")
            .unwrap()
            .is_match(&render("gantt\n dateFormat D\n A :a, 5, 9\n", &gantt_css()).unwrap().svg)
    );

    // Config settings & numberSectionStyles & compact mode
    let csrc = "gantt\n dateFormat YYYY-MM-DD\n section S\n A :a, 2024-01-01, 30d\n B :b, 2024-01-10, 30d\n";
    let cfg = |y: &str| format!("---\nconfig:\n  gantt:\n{y}---\n{csrc}");
    let cplain = render(csrc, &gantt_css()).unwrap();
    assert!(render(&cfg("    barHeight: 60\n"), &gantt_css()).unwrap().height > cplain.height + 60.0);
    assert!(render(&cfg("    barGap: 40\n"), &gantt_css()).unwrap().height > cplain.height + 60.0);
    assert_eq!(render(&cfg("    useWidth: 1200\n"), &gantt_css()).unwrap().width, 1200.0);
    assert!(render(&cfg("    topAxis: true\n"), &gantt_css()).unwrap().height > cplain.height);
    assert!(render(&cfg("    topPadding: 120\n"), &gantt_css()).unwrap().height > cplain.height + 80.0);
    assert!(render(&cfg("    axisFormat: \"%d/%m\"\n"), &gantt_css()).unwrap().svg.contains(">07/01<"));
    assert!(
        render(&cfg("    tickInterval: 1week\n    weekday: wednesday\n    axisFormat: \"%a\"\n"), &gantt_css())
            .unwrap()
            .svg
            .contains(">Wed<")
    );
    assert!(
        render(&cfg("    fontSize: 20\n"), &gantt_css())
            .unwrap()
            .svg
            .contains(r#"class="pele-tasks" font-size="20""#)
    );
    assert!(
        render(&cfg("    sectionFontSize: 22\n"), &gantt_css())
            .unwrap()
            .svg
            .contains(r#"class="pele-section-labels" font-size="22""#)
    );
    assert!(bars_of(&render(&cfg("    leftPadding: 300\n"), &gantt_css()).unwrap().svg)["a"].0 > 300.0);
    assert!(
        !render(&cfg("    barHeight: \"tall\"\n    fontSize: -5\n    useWidth: .inf\n"), &gantt_css())
            .unwrap()
            .svg
            .contains("NaN")
    );

    let ssrc = "gantt\n dateFormat YYYY-MM-DD\n section A\n a :2024-01-01, 3d\n section B\n b :2d\n section C\n c :2d\n";
    let four = render(ssrc, &gantt_css()).unwrap().svg;
    assert!(four.contains("pele-section-0") && four.contains("pele-section-2"));
    let two = render(&format!("---\nconfig:\n  gantt:\n    numberSectionStyles: 2\n---\n{ssrc}"), &gantt_css())
        .unwrap()
        .svg;
    assert!(!two.contains("pele-section-2") && two.matches("pele-section-0").count() == 2);

    let cmp_src = "gantt\n dateFormat YYYY-MM-DD\n section Section\n A :a1, 2014-01-01, 30d\n B :a2, 2014-01-20, 25d\n C :a3, 2014-02-10, 20d\n";
    let cmp_plain = render(cmp_src, &gantt_css()).unwrap();
    let cmp = render(&format!("---\ndisplayMode: compact\n---\n{cmp_src}"), &gantt_css()).unwrap();
    let cmp_cfg = render(&format!("---\nconfig:\n  gantt:\n    displayMode: compact\n---\n{cmp_src}"), &gantt_css()).unwrap();
    assert!(cmp.height < cmp_plain.height);
    assert_eq!(cmp_cfg.height, cmp.height);
    assert_eq!(count_class(&cmp.svg, "pele-task"), 3);
    assert_eq!(gantt_model(&format!("---\ndisplayMode: compact\n---\n{cmp_src}")).display_mode, "compact");
}

#[test]
fn gantt_links_titles_icons_empty_scheduling_and_errors() {
    // Links & click callbacks
    let lres = render(
        "gantt\n dateFormat YYYY-MM-DD\n A :cl1, 2014-01-07, 3d\n B :cl2, after cl1, 3d\n click cl1 href \"https://mermaidjs.github.io/\"\n click cl2 call printArguments(\"test1\", test3)\n",
        &gantt_css(),
    )
    .unwrap();
    assert_eq!(
        lres.links,
        vec![LinkInfo {
            id: "cl1".to_string(),
            href: "https://mermaidjs.github.io/".to_string(),
            internal: false
        }]
    );
    assert!(lres.svg.contains(r#"<a href="https://mermaidjs.github.io/" rel="noopener">"#));
    assert!(!lres.svg.contains("printArguments"));
    assert_eq!(lres.svg.matches("pele-clickable").count(), 2);
    assert!(
        render(
            "gantt\n dateFormat YYYY-MM-DD\n click a href \"https://example.com\"\n A :a, 2014-01-07, 3d\n",
            &gantt_css()
        )
        .unwrap()
        .links
        .is_empty()
    );

    // Titles, bare title, accessibility, <br>, icons, empty & zero-length charts
    let tsrc = "gantt\n dateFormat YYYY-MM-DD\n A :a, 2014-01-07, 3d\n";
    assert!(
        render(&format!("---\ntitle: From front matter\n---\n{tsrc}"), &gantt_css())
            .unwrap()
            .svg
            .contains(">From front matter<")
    );
    assert!(
        render(
            &format!("---\ntitle: From front matter\n---\n{}", tsrc.replace("gantt\n", "gantt\n title Own\n")),
            &gantt_css()
        )
        .unwrap()
        .svg
        .contains(">Own<")
    );
    let bare = gantt_model("gantt\ntitle\nsection Work\nTask :2026-01-01, 1d");
    assert_eq!(bare.title, None);
    let btasks = bare.get_tasks(Some(now_2014())).unwrap();
    assert_eq!(btasks[0].task, "Task ");
    assert_eq!(btasks[0].section, "Work");
    assert_eq!(gantt_model("gantt\ntitle\tPlan\n").title.as_deref(), Some("Plan"));

    let acc = render(
        "gantt\n accTitle: Plan\n accDescr: Tasks for Q4\n dateFormat YYYY-MM-DD\n A :a, 2014-01-07, 3d\n",
        &gantt_css(),
    )
    .unwrap()
    .svg;
    assert!(acc.contains(r#"<title id="pele-title">Plan</title>"#));
    assert!(acc.contains(r#"<desc id="pele-desc">Tasks for Q4</desc>"#));

    let br_svg = render(
        "gantt\n dateFormat YYYY-MM-DD\n section One<br>Two\n First<br/>second :a, 2014-01-07, 30d\n",
        &gantt_css(),
    )
    .unwrap()
    .svg;
    assert!(Regex::new(r"<tspan[^>]*>One</tspan><tspan[^>]*>Two</tspan>").unwrap().is_match(&br_svg));
    assert!(br_svg.contains(">First second<"));

    let resolver = |name: &str| (name == "fa:fa-flag").then(|| r#"<path d="M4 12l5 5L20 6"/>"#.to_string());
    let mut icon_opts = gantt_css();
    icon_opts.icons = Some(&resolver);
    let icon_svg = render(
        "gantt\n dateFormat YYYY-MM-DD\n section fa:fa-flag Launch\n Done :a, 2014-01-07, 30d\n",
        &icon_opts,
    )
    .unwrap()
    .svg;
    assert!(icon_svg.contains(r#"data-icon="fa:fa-flag""#) && icon_svg.contains(r#"<path d="M4 12l5 5L20 6"/>"#));

    assert!(render("gantt", &gantt_css()).unwrap().svg.contains("<svg"));
    assert!(
        render("gantt\n title Empty\n tickInterval 1week\n weekday monday", &gantt_css())
            .unwrap()
            .svg
            .contains(">Empty<")
    );
    for zsrc in [
        "gantt\n dateFormat YYYY-MM-DD\n M :milestone, m, 2014-01-07, 0d\n",
        "gantt\n dateFormat YYYY-MM-DD\n A :a, 2014-01-07, 0d\n B :b, 2014-01-07, bogus\n",
        "gantt\n dateFormat x\n A :a, 0, 0ms\n",
    ] {
        let r = render(zsrc, &gantt_css()).unwrap();
        assert!(!r.svg.contains("NaN") && !r.svg.contains("Infinity") && !r.svg.contains("undefined"));
        assert!(count_class(&r.svg, "pele-task") > 0);
        let rr = render(zsrc, &gantt_resolved()).unwrap();
        assert_inert_resolved(&rr.svg, zsrc);
        assert_resvg_parses(&rr.svg, zsrc);
    }

    // Scheduling semantics
    let t_today = gantt_model("gantt\n dateFormat YYYY-MM-DD\n A :3d\n").get_tasks(Some(now_2014())).unwrap();
    assert_eq!(t_today[0].start_time, Some(dt(2014, 1, 16)));
    assert_eq!(t_today[0].end_time, Some(dt(2014, 1, 19)));

    let t_inj = gantt_model("gantt\n dateFormat HH:mm\n A :a, 17:49, 2m\n B :b, after nothing, 1h\n")
        .get_tasks(Some(dt_hms(2031, 5, 6, 9, 30, 0, 0)))
        .unwrap();
    assert_eq!(t_inj[0].start_time, Some(dt_hms(2031, 5, 6, 17, 49, 0, 0)));
    assert_eq!(t_inj[1].start_time, Some(dt(2031, 5, 6)));

    // Repeatable get_tasks without mutation + after resolution parity
    let m_rep = gantt_model("gantt\n dateFormat YYYY-MM-DD\n B :b, 2024-01-01, 2d\n X :x, after b a, 1d\n A :a, 2024-01-10, 5d\n");
    let first: Vec<_> = m_rep
        .get_tasks(Some(now_2014()))
        .unwrap()
        .into_iter()
        .map(|t| (t.start_time, t.end_time))
        .collect();
    let second: Vec<_> = m_rep
        .get_tasks(Some(now_2014()))
        .unwrap()
        .into_iter()
        .map(|t| (t.start_time, t.end_time))
        .collect();
    assert_eq!(first, second);
    assert_eq!(first[1].0, Some(dt(2024, 1, 3)));

    // Circular after references -> unscheduled tasks still drawn safely
    let cyc_src = "gantt\n dateFormat YYYY-MM-DD\n A :a, after b, 1d\n B :b, after a, 1d\n C :c, 2024-01-01, 3d\n";
    let cyc_tasks = gantt_model(cyc_src).get_tasks(Some(now_2014())).unwrap();
    assert_eq!(cyc_tasks[0].start_time, None);
    assert_eq!(cyc_tasks[2].end_time, Some(dt(2024, 1, 4)));
    let cyc_svg = render(cyc_src, &gantt_css()).unwrap().svg;
    assert_eq!(count_class(&cyc_svg, "pele-unscheduled"), 2);
    assert!(!cyc_svg.contains("NaN") && !cyc_svg.contains("undefined"));

    // Mermaid errors verbatim
    assert!(
        render("gantt\n dateFormat YYYYMMDD\n A :id1, 202304, 1d\n", &gantt_css())
            .unwrap_err()
            .message
            .contains("Invalid date:202304")
    );
    assert!(
        render(
            "gantt\n dateFormat YYYY-MM-DD\n excludes weekends monday tuesday wednesday thursday friday\n A :a, 2019-02-01, 7d\n",
            &gantt_css()
        )
        .unwrap_err()
        .message
        .contains("Failed to find a valid date")
    );
    assert!(render("gantt\n dateFormat YYYY-MM-DD\n A :a, not a date, 7d\n", &gantt_css()).is_err());
    assert!(
        parse("gantt\n A :crit\n", &ParseOptions::default())
            .unwrap_err()
            .message
            .contains("needs a duration or an end date")
    );
    assert!(
        parse("gantt\n A :a, 2024-01-01, 3d, extra\n", &ParseOptions::default())
            .unwrap_err()
            .message
            .contains("too many fields")
    );
    assert!(gantt_model("gantt\n topAxis\n").top_axis);

    // Model inspection + %% in task name + __proto__ ids
    let m_full = gantt_model(
        "gantt\n dateFormat DD-MM-YYYY\n axisFormat %d\n tickInterval 1day\n excludes weekends 10-02-2025\n includes 15-02-2025\n weekend friday\n weekday tuesday\n inclusiveEndDates\n todayMarker off\n section S\n A :crit, done, a, 03-02-2025, 2d\n B :milestone, 0d\n V :vert, v, 04-02-2025, 0d\n",
    );
    assert_eq!(m_full.date_format, "DD-MM-YYYY");
    assert_eq!(m_full.axis_format, "%d");
    assert_eq!(m_full.tick_interval.as_deref(), Some("1day"));
    assert_eq!(m_full.excludes, vec!["weekends", "10-02-2025"]);
    assert_eq!(m_full.includes, vec!["15-02-2025"]);
    assert_eq!(m_full.weekend, "friday");
    assert_eq!(m_full.weekday.as_deref(), Some("tuesday"));
    assert!(m_full.inclusive_end_dates);
    assert_eq!(m_full.today_marker, "off");
    assert_eq!(m_full.sections, vec!["S"]);
    let tasks = m_full.get_tasks(Some(now_2014())).unwrap();
    assert_eq!(
        (tasks[0].id.as_str(), tasks[0].task.as_str(), tasks[0].crit, tasks[0].done, tasks[0].order),
        ("a", "A ", true, true, 0)
    );
    assert_eq!((tasks[1].id.as_str(), tasks[1].milestone, tasks[1].order), ("task1", true, 1));
    assert_eq!((tasks[2].id.as_str(), tasks[2].vert, tasks[2].order), ("v", true, -1));

    let cmt_tasks = gantt_model("gantt\ndateFormat YYYY-MM-DD\nA%% label : 2026-10-24, 1d")
        .get_tasks(Some(now_2014()))
        .unwrap();
    assert_eq!(cmt_tasks[0].task, "A%% label ");

    let proto = render(
        "gantt\n dateFormat YYYY-MM-DD\n A :__proto__, 2024-10-01, 3d\n B :constructor, after __proto__, 2d\n click __proto__ href \"https://mermaid.js.org/\"\n",
        &gantt_css(),
    )
    .unwrap();
    assert_eq!(
        proto.links,
        vec![LinkInfo {
            id: "__proto__".to_string(),
            href: "https://mermaid.js.org/".to_string(),
            internal: false
        }]
    );
    let pt = gantt_model("gantt\n dateFormat YYYY-MM-DD\n A :__proto__, 2024-10-01, 3d\n B :constructor, after __proto__, 2d\n")
        .get_tasks(Some(now_2014()))
        .unwrap();
    assert_eq!(pt[1].start_time, Some(dt(2024, 10, 4)));
}

#[test]
fn gantt_security_corpus_payloads_hostile_times_and_mutated_fuzz() {
    let corpus = load_fixture("gantt-corpus.json");
    let css = gantt_css();
    let res = gantt_resolved();

    let mut rendered = 0;
    for src in &corpus {
        if check_both_modes(src, &css, &res) {
            rendered += 1;
            let dark = render(src, &gantt_dark()).expect("dark mode");
            assert_inert_resolved(&dark.svg, src);
            assert_resvg_parses(&dark.svg, src);
        }
    }
    assert!(rendered > 20, "expected >20 gantt corpus renders, got {rendered}");

    let head = "gantt\n  dateFormat YYYY-MM-DD\n";
    let tasks = "  section S\n  A task :a1, 2014-01-01, 30d\n  Another :after a1, 20d\n";
    type TemplateFn = Box<dyn Fn(&str) -> String>;
    let templates: Vec<TemplateFn> = vec![
        Box::new(move |p| format!("{head}  title {p}\n{tasks}")),
        Box::new(move |p| format!("{head}  section {p}\n  A task :a1, 2014-01-01, 30d\n")),
        Box::new(move |p| format!("{head}  {p} :a1, 2014-01-01, 30d\n")),
        Box::new(move |p| format!("{head}  {p} :a1, 2014-01-01, 1h\n  B :b, 2014-01-01, 30d\n")),
        Box::new(move |p| format!("{head}  A task :{p}, 2014-01-01, 30d\n")),
        Box::new(move |p| format!("{head}  A task :a1, {p}, 30d\n")),
        Box::new(move |p| format!("{head}  A task :a1, 2014-01-01, {p}\n")),
        Box::new(move |p| format!("{head}  A task :{p}\n")),
        Box::new(move |p| format!("{head}  A task :a1, after {p}, 3d\n  B :b, 2014-01-01, until {p}\n")),
        Box::new(move |p| format!("{head}  {p} :milestone, m1, 2014-01-01, 0d\n  B :b, 2014-01-01, 30d\n")),
        Box::new(move |p| format!("{head}  {p} :vert, v1, 2014-01-05, 0d\n  B :b, 2014-01-01, 30d\n")),
        Box::new(move |p| format!("gantt\n  dateFormat {p}\n{tasks}")),
        Box::new(move |p| format!("{head}  axisFormat {p}\n{tasks}")),
        Box::new(move |p| format!("{head}  axisFormat %Y {p} %c %%\n{tasks}")),
        Box::new(move |p| format!("{head}  tickInterval {p}\n{tasks}")),
        Box::new(move |p| format!("{head}  excludes {p}\n{tasks}")),
        Box::new(move |p| format!("{head}  excludes weekends\n  includes {p}\n{tasks}")),
        Box::new(move |p| format!("{head}  todayMarker {p}\n{tasks}")),
        Box::new(move |p| format!("{head}  todayMarker stroke:{p},stroke-width:{p},opacity:{p}\n{tasks}")),
        Box::new(move |p| format!("{head}{tasks}  click a1 href \"{p}\"\n")),
        Box::new(move |p| format!("{head}{tasks}  click a1 call {p}()\n")),
        Box::new(move |p| format!("{head}  accTitle: {p}\n  accDescr: {p}\n{tasks}")),
        Box::new(move |p| format!("{head}  accDescr {{\n {p}\n }}\n{tasks}")),
        Box::new(move |p| format!("---\ntitle: \"{p}\"\ndisplayMode: \"{p}\"\n---\n{head}{tasks}")),
        Box::new(move |p| {
            format!(
                "---\nconfig:\n  gantt:\n    axisFormat: \"{p}\"\n    tickInterval: \"{p}\"\n    weekday: \"{p}\"\n    displayMode: \"{p}\"\n---\n{head}{tasks}"
            )
        }),
    ];

    let mut payload_rendered = 0;
    for tmpl in &templates {
        for &payload in PAYLOADS {
            if check_both_modes(&tmpl(payload), &css, &res) {
                payload_rendered += 1;
            }
        }
    }
    assert!(payload_rendered > 500, "expected >500 gantt payload renders, got {payload_rendered}");

    // Hostile options
    for &payload in PAYLOADS {
        let mut c = gantt_css();
        c.id_prefix = Some(payload.to_string());
        c.font_family = Some(payload.to_string());
        let mut r = gantt_resolved();
        r.id_prefix = Some(payload.to_string());
        r.font_family = Some(payload.to_string());
        assert!(check_both_modes(&format!("{head}  accTitle: t\n{tasks}"), &c, &r));
    }

    // Hostile extreme times
    for extreme_ms in [MAX_DATE_MS, -MAX_DATE_MS, 0, i64::MAX, i64::MIN] {
        let mut c = gantt_css();
        c.now_ms = Some(extreme_ms);
        let mut r = gantt_resolved();
        r.now_ms = Some(extreme_ms);
        check_both_modes(&format!("{head}{tasks}"), &c, &r);
        check_both_modes(
            "gantt\n  dateFormat HH:mm\n  A :a, 17:49, 2m\n  B :after nothing, 3m\n  C :until nothing\n",
            &c,
            &r,
        );
        check_both_modes("gantt\n  A :3d\n", &c, &r);
    }

    // Never links to a script URL
    let re_anchor = Regex::new(r"<a\b").unwrap();
    for url in [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        " javascript:alert(1)",
        "data:text/html,x",
        "vbscript:x",
    ] {
        let r = render(&format!("{head}{tasks}  click a1 href \"{url}\"\n"), &css).unwrap();
        assert!(!re_anchor.is_match(&r.svg));
        assert!(r.links.is_empty());
    }

    // Mutated inputs fuzzing
    let mut frags: Vec<&str> = PAYLOADS.to_vec();
    frags.extend([
        "\"",
        ":",
        ",",
        ";",
        "#",
        "\n",
        "%",
        " :a, 2014-01-01, 3d\n",
        "click a1 href \"",
        "click a1 call ",
        "todayMarker ",
        "axisFormat ",
        "dateFormat ",
        "excludes ",
        "section ",
        "title ",
        "after ",
        "until ",
        "milestone, ",
        "vert, ",
        "crit, ",
        "99999999d",
        "0001-01-01",
        "275760-09-13",
        "-1",
        "1e400",
        "tickInterval 1millisecond\n",
        "topAxis\n",
        "x",
        "X",
    ]);
    let mut mutator = Mutator::new(&corpus, frags, 3);
    for _ in 0..800 {
        let src = mutator.next_sample();
        if src.len() <= 4000 {
            check_both_modes(&src, &css, &res);
        }
    }
}

#[test]
fn gantt_stress_worst_cases_and_work_limit() {
    const N: usize = 50_000;
    let big = RenderOptions {
        limit: Some(usize::MAX),
        output_limit: Some(usize::MAX),
        now_ms: Some(dt(2024, 1, 15)),
        ..css_options()
    };
    let big = &big;
    let head = "gantt\ndateFormat YYYY-MM-DD\n";

    let mut s_8k = String::from(head);
    for i in 0..8000 {
        s_8k.push_str(&format!("T{i} :2024-01-01, {}d\n", 1 + (i % 30)));
    }
    let mut s_chain = format!("{head}A :t0, 2024-01-01, 1d\n");
    for i in 0..5000 {
        s_chain.push_str(&format!("T :t{}, after t{i}, 1d\n", i + 1));
    }
    let mut s_rev = String::from(head);
    for i in 0..3000 {
        s_rev.push_str(&format!("T :t{i}, after t{}, 1d\n", i + 1));
    }
    s_rev.push_str("Z :t3000, 2024-01-01, 1d\n");
    let mut s_compact = format!("---\ndisplayMode: compact\n---\n{head}");
    for i in 0..6000 {
        s_compact.push_str(&format!("T :2024-01-01, {}d\n", i + 1));
    }

    type StressCase<'a> = (&'a str, Box<dyn Fn() + 'a>);
    let cases: Vec<StressCase<'_>> = vec![
        (
            "weekday spaces",
            Box::new(move || {
                let _ = tokenize(&format!("gantt\nweekday{}x", " ".repeat(N)));
            }),
        ),
        (
            "unclosed accDescr",
            Box::new(move || {
                let _ = tokenize(&format!("gantt\naccDescr {{{}", " x\n".repeat(N / 3)));
            }),
        ),
        (
            "8,000 tasks",
            Box::new(move || {
                let _ = render(&s_8k, big);
            }),
        ),
        (
            "5,000 chain",
            Box::new(move || {
                let _ = render(&s_chain, big);
            }),
        ),
        (
            "3,000 reverse chain",
            Box::new(move || {
                let _ = render(&s_rev, big);
            }),
        ),
        (
            "compact 6,000 overlapping",
            Box::new(move || {
                let _ = render(&s_compact, big);
            }),
        ),
        (
            "every weekday excluded",
            Box::new(move || {
                let _ = render(
                    &format!(
                        "{head}excludes weekends monday tuesday wednesday thursday friday\n{}",
                        "T :2024-01-01, 7d\n".repeat(2000)
                    ),
                    big,
                );
            }),
        ),
        (
            "task lasting max dates",
            Box::new(move || {
                let _ = render(&format!("{head}excludes weekends\nT :2024-01-01, 99999999d\n"), big);
            }),
        ),
        (
            "year 1 to last date",
            Box::new(move || {
                let _ = render(&format!("{head}A :0001-01-01, 1d\nB :2024-01-01, 99990000d\n"), big);
            }),
        ),
        (
            "1ms tick over century",
            Box::new(move || {
                let _ = render(&format!("{head}tickInterval 1millisecond\nA :1950-01-01, 36500d\n"), big);
            }),
        ),
        (
            "99999999s tick interval",
            Box::new(move || {
                let _ = render(&format!("{head}tickInterval 99999999second\nA :1950-01-01, 36500d\n"), big);
            }),
        ),
        (
            "12k axis directives",
            Box::new(move || {
                let _ = render(&format!("{head}axisFormat {}\nA :2024-01-01, 30d\n", "%c%j%U%V".repeat(3000)), big);
            }),
        ),
        (
            "25k todayMarker decls",
            Box::new(move || {
                let _ = render(&format!("{head}todayMarker {}\nA :2024-01-01, 30d\n", "stroke:red,".repeat(4500)), big);
            }),
        ),
    ];
    for (name, run) in cases {
        let start = Instant::now();
        run();
        let elapsed = start.elapsed().as_millis();
        assert!(elapsed < 5000, "gantt stress '{name}' took {elapsed}ms");
    }

    // Refuses a schedule that would take too long, as ErrorCode::Limit
    let limit_src = format!("{head}excludes weekends\n{}", "T :2024-01-01, 10950d\n".repeat(400));
    let err = render(&limit_src, big).unwrap_err();
    assert_eq!(err.code, ErrorCode::Limit, "expected Limit error, got {err:?}");
}
