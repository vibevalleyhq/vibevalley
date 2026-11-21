use vibevalley_genui::{GenUiRuntime, ResolvedChartContent, ResolvedNodeKind, RuntimeEvent, StateValue};

const COMPOUND_INTEREST_JSONL: &str = r##"{"op":"title","title":"复利模拟器 — Compound Interest Simulator","subtitle":"Live pure-Rust reactive calculator"}
{"op":"state_init","state":{"principal":10000,"rate":7,"years":10,"monthly":200,"with_contrib":false}}
{"op":"set_node","root":true,"node":{"id":"root","kind":"stack","direction":"vertical","gap":16,"children":["controls","kpi_grid","growth_chart","schedule_table","summary_callout"]}}
{"op":"set_node","node":{"id":"controls","kind":"card","title":"投资参数 (Inputs)","children":["s_principal","s_rate","s_years","s_monthly","sw_contrib"]}}
{"op":"set_node","node":{"id":"s_principal","kind":"slider","bind":"principal","label":"Initial Principal: ${format(principal, 'currency', 0)}","min":1000,"max":100000,"step":1000,"unit":"USD"}}
{"op":"set_node","node":{"id":"s_rate","kind":"slider","bind":"rate","label":"Annual Rate: ${rate}%","min":0,"max":20,"step":0.5,"unit":"%"}}
{"op":"set_node","node":{"id":"s_years","kind":"slider","bind":"years","label":"Horizon: ${years} yrs","min":1,"max":40,"step":1,"unit":"yrs"}}
{"op":"set_node","node":{"id":"s_monthly","kind":"slider","bind":"monthly","label":"Monthly Contribution: ${format(monthly, 'currency', 0)}","min":0,"max":5000,"step":50,"unit":"USD"}}
{"op":"set_node","node":{"id":"sw_contrib","kind":"switch","bind":"with_contrib","label":"Include Monthly Contributions"}}
{"op":"set_node","node":{"id":"kpi_grid","kind":"grid","columns":3,"gap":12,"children":["m_final","m_gain","p_interest_share"]}}
{"op":"set_node","node":{"id":"m_final","kind":"metric","label":"Final Balance","value":"with_contrib ? (rate == 0 ? principal + monthly * 12 * years : principal * pow(1 + rate / 100, years) + monthly * 12 * ((pow(1 + rate / 100, years) - 1) / (rate / 100))) : principal * pow(1 + rate / 100, years)","delta":"${years} years @ ${rate}%","format":"currency"}}
{"op":"set_node","node":{"id":"m_gain","kind":"metric","label":"Interest Earned","value":"(with_contrib ? (rate == 0 ? principal + monthly * 12 * years : principal * pow(1 + rate / 100, years) + monthly * 12 * ((pow(1 + rate / 100, years) - 1) / (rate / 100))) : principal * pow(1 + rate / 100, years)) - (principal + (with_contrib ? monthly * 12 * years : 0))","format":"currency"}}
{"op":"set_node","node":{"id":"p_interest_share","kind":"progress","label":"Interest share of final balance","value":"(principal * pow(1 + rate / 100, years)) - principal","max":"principal * pow(1 + rate / 100, years)"}}
{"op":"set_node","node":{"id":"growth_chart","kind":"chart","title":"Portfolio Growth (${years} Years)","width":640,"height":320,"source":{"mode":"reactive","chart_kind":"line","x_label":"Year","y_label":"Balance","y_format":"currency","categories":"map(range(0, years + 1, 1), y, concat('Yr ', y))","series":[{"name":"Total Balance","color":"#2563eb","values":"map(range(0, years + 1, 1), y, round(with_contrib ? (rate == 0 ? principal + monthly * 12 * y : principal * pow(1 + rate / 100, y) + monthly * 12 * ((pow(1 + rate / 100, y) - 1) / (rate / 100))) : principal * pow(1 + rate / 100, y), 2))"},{"name":"Contributed Principal","color":"#64748b","values":"map(range(0, years + 1, 1), y, round(principal + (with_contrib ? monthly * 12 * y : 0), 2))"}]}}}
{"op":"set_node","node":{"id":"schedule_table","kind":"table","columns":[{"key":"year","label":"Year","align":"left"},{"key":"balance","label":"Balance","align":"right","format":"currency"},{"key":"gain","label":"Cumulative Gain","align":"right","format":"currency"}],"rows":"map(range(1, years + 1, 1), y, { year: concat('Year ', y), balance: round(principal * pow(1 + rate / 100, y), 2), gain: round(principal * pow(1 + rate / 100, y) - principal, 2) })"}}
{"op":"set_node","node":{"id":"summary_callout","kind":"callout","callout_kind":"tip","title":"Compounding Insight","body":"Starting with ${format(principal, 'currency', 0)} at ${rate}% grows to ${format(principal * pow(1 + rate / 100, years), 'currency')} in ${years} years."}}
{"op":"update_props","id":"m_final","props":{"kind":"metric","delta":"Updated: ${years}y @ ${rate}%"}}
{"op":"done"}
"##;

fn expected_balance(principal: f64, rate: f64, years: usize, monthly: f64, with_contrib: bool) -> f64 {
    let y = years as f64;
    let raw = if with_contrib {
        if rate == 0.0 {
            principal + monthly * 12.0 * y
        } else {
            let growth = (1.0 + rate / 100.0).powf(y);
            principal * growth + monthly * 12.0 * ((growth - 1.0) / (rate / 100.0))
        }
    } else {
        principal * (1.0 + rate / 100.0).powf(y)
    };
    (raw * 100.0).round() / 100.0
}

fn assert_simulator_behavior(runtime: &mut GenUiRuntime) {
    assert!(runtime.is_complete());

    let doc = runtime.try_resolve_tree().unwrap();
    assert_eq!(doc.title.as_deref(), Some("复利模拟器 — Compound Interest Simulator"));
    assert!(doc.is_complete);
    assert!(doc.diagnostics.is_empty());

    let m_final = doc.find_node("m_final").unwrap();
    let expected_initial = expected_balance(10_000.0, 7.0, 10, 200.0, false);
    if let ResolvedNodeKind::Metric { value, raw_value, delta, .. } = &m_final.kind {
        assert_eq!(value, "$19,671.51");
        assert!((raw_value.as_f64().unwrap() - expected_initial).abs() < 0.01);
        assert_eq!(delta.as_deref(), Some("Updated: 10y @ 7%"));
    } else {
        panic!("expected Metric node, got {:?}", m_final.kind);
    }

    let chart_node = doc.find_node("growth_chart").unwrap();
    if let ResolvedNodeKind::Chart(chart) = &chart_node.kind {
        if let ResolvedChartContent::Reactive(reactive) = &chart.content {
            assert_eq!(reactive.categories.len(), 11);
            assert_eq!(reactive.categories[0], "Yr 0");
            assert_eq!(reactive.categories[10], "Yr 10");
            assert_eq!(reactive.series.len(), 2);
            assert_eq!(reactive.series[0].values.len(), 11);
            for y in 0..=10 {
                let want = expected_balance(10_000.0, 7.0, y, 200.0, false);
                assert!((reactive.series[0].values[y].unwrap() - want).abs() < 1e-6);
                assert_eq!(reactive.series[1].values[y], Some(10_000.0));
            }
        } else {
            panic!("expected reactive chart");
        }
        let spec_json = chart.to_chart_spec_json().unwrap();
        assert!(spec_json.contains("\"type\":\"line\""));
        assert!(spec_json.contains("\"categories\":[\"Yr 0\""));
        assert!(spec_json.contains("\"xAxis\":{\"label\":\"Year\"}"));
        assert!(spec_json.contains("\"yAxis\":{\"label\":\"Balance\",\"format\":\"currency\"}"));
        assert!(spec_json.contains("\"Yr 10\""));
        assert!(spec_json.contains("19671.51"));
    } else {
        panic!("expected Chart node");
    }

    let unchanged_dirty = runtime.set_state("rate", StateValue::from(7)).unwrap();
    assert!(unchanged_dirty.is_empty());
    let rev_before = runtime.state_revision();

    let dirty_rate = runtime.set_state("rate", StateValue::from(10)).unwrap();
    assert_eq!(runtime.state_revision(), rev_before + 1);
    assert!(dirty_rate.contains(&"m_final".to_owned()));
    assert!(dirty_rate.contains(&"m_gain".to_owned()));
    assert!(dirty_rate.contains(&"growth_chart".to_owned()));
    assert!(dirty_rate.contains(&"schedule_table".to_owned()));
    assert!(dirty_rate.contains(&"s_rate".to_owned()));
    assert!(!dirty_rate.contains(&"s_principal".to_owned()));
    assert!(!dirty_rate.contains(&"controls".to_owned()));

    let dirty_years = runtime.set_state("years", StateValue::from(5)).unwrap();
    assert!(dirty_years.contains(&"growth_chart".to_owned()));
    assert!(dirty_years.contains(&"schedule_table".to_owned()));

    let dirty_contrib = runtime.set_state("with_contrib", StateValue::from(true)).unwrap();
    assert!(dirty_contrib.contains(&"m_final".to_owned()));
    assert!(dirty_contrib.contains(&"growth_chart".to_owned()));

    let updated = runtime.try_resolve_tree().unwrap();

    let updated_final = updated.find_node("m_final").unwrap();
    let want_final = expected_balance(10_000.0, 10.0, 5, 200.0, true);
    if let ResolvedNodeKind::Metric { value, raw_value, delta, .. } = &updated_final.kind {
        assert!((raw_value.as_f64().unwrap() - want_final).abs() < 0.01);
        assert_eq!(value, "$30,757.34");
        assert_eq!(delta.as_deref(), Some("Updated: 5y @ 10%"));
    } else {
        panic!("expected Metric");
    }

    let updated_chart = updated.find_node("growth_chart").unwrap();
    if let ResolvedNodeKind::Chart(chart) = &updated_chart.kind {
        assert_eq!(chart.title.as_deref(), Some("Portfolio Growth (5 Years)"));
        if let ResolvedChartContent::Reactive(reactive) = &chart.content {
            assert_eq!(reactive.categories, vec!["Yr 0", "Yr 1", "Yr 2", "Yr 3", "Yr 4", "Yr 5"]);
            for y in 0..=5 {
                let want = expected_balance(10_000.0, 10.0, y, 200.0, true);
                assert!((reactive.series[0].values[y].unwrap() - want).abs() < 1e-6);
                assert_eq!(reactive.series[1].values[y], Some(10_000.0 + 2_400.0 * y as f64));
            }
        } else {
            panic!("expected Reactive chart");
        }
    } else {
        panic!("expected Chart");
    }

    let updated_table = updated.find_node("schedule_table").unwrap();
    if let ResolvedNodeKind::Table { rows, .. } = &updated_table.kind {
        assert_eq!(rows.len(), 5);
        assert_eq!(rows[0].cells, vec!["Year 1", "$11,000.00", "$1,000.00"]);
        assert_eq!(rows[4].cells, vec!["Year 5", "$16,105.10", "$6,105.10"]);
    } else {
        panic!("expected Table");
    }
}

#[test]
fn compound_interest_streams_byte_by_byte_across_utf8_boundaries() {
    let mut runtime = GenUiRuntime::new();
    let mut completed = false;
    let mut errors = Vec::new();
    let mut seen_partial_frame = false;

    for &byte in COMPOUND_INTEREST_JSONL.as_bytes() {
        for event in runtime.push_bytes(&[byte]) {
            match event {
                RuntimeEvent::PatchApplied { .. } => {
                    if !runtime.is_complete() && runtime.doc().nodes.len() == 3 {
                        let partial = runtime.resolve_tree();
                        assert!(!partial.is_complete);
                        assert!(partial.root.is_some());
                        seen_partial_frame = true;
                    }
                }
                RuntimeEvent::Complete { .. } => completed = true,
                RuntimeEvent::Error { error, .. } => errors.push(error),
            }
        }
    }
    assert!(runtime.finish_stream().is_empty());
    assert!(errors.is_empty(), "unexpected stream errors: {errors:?}");
    assert!(completed);
    assert!(seen_partial_frame);

    let root_gen = runtime.doc().node_generation("root").unwrap();
    let chart_gen = runtime.doc().node_generation("growth_chart").unwrap();
    let final_gen = runtime.doc().node_generation("m_final").unwrap();
    assert!(root_gen < chart_gen);
    assert!(chart_gen < final_gen);

    assert_simulator_behavior(&mut runtime);
}

#[test]
fn compound_interest_streams_with_pseudo_random_chunk_splits() {
    let bytes = COMPOUND_INTEREST_JSONL.as_bytes();
    let mut runtime = GenUiRuntime::new();
    let mut seed: u64 = 0x5eed_cafe_1234_5678;
    let mut offset = 0;

    while offset < bytes.len() {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let chunk_len = ((seed >> 32) as usize % 37) + 1;
        let end = (offset + chunk_len).min(bytes.len());
        let events = runtime.push_bytes(&bytes[offset..end]);
        for event in events {
            if let RuntimeEvent::Error { line, error } = event {
                panic!("unexpected error on line {line}: {error}");
            }
        }
        offset = end;
    }

    assert!(runtime.finish_stream().is_empty());
    assert_simulator_behavior(&mut runtime);

    let snapshot = runtime.doc().to_spec(runtime.state());
    let reloaded = GenUiRuntime::from_spec(snapshot).unwrap();
    let live_doc = runtime.try_resolve_tree().unwrap();
    let reloaded_doc = reloaded.try_resolve_tree().unwrap();
    assert_eq!(live_doc.title, reloaded_doc.title);
    assert_eq!(
        live_doc.find_node("growth_chart").unwrap().kind,
        reloaded_doc.find_node("growth_chart").unwrap().kind
    );
    assert_eq!(live_doc.find_node("m_final").unwrap().kind, reloaded_doc.find_node("m_final").unwrap().kind);
}
