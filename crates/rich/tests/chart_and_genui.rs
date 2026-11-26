use std::cell::RefCell;
use std::sync::Mutex;
use std::time::Duration;

use nsh_core::ViewKind;
use nsh_core::element::Root;
use nsh_core::prelude::*;
use vibevalley_rich::{
    ASYNC_CHART_BYTE_THRESHOLD, VvGenUiActionEvent, cached_render_chart, chart_cache_stats, clear_chart_cache, render_chart, vv_chart, vv_gen_ui, vv_markdown,
};

use crate::support::{DIAGRAM_CACHE_TEST_LOCK, TestHarness, assert_inline_svg_image};

static CHART_GENUI_TEST_LOCK: Mutex<()> = Mutex::new(());

thread_local! {
    static STATE_ACTIONS: RefCell<Vec<VvGenUiActionEvent>> = const { RefCell::new(Vec::new()) };
}

const COMPOUND_INTEREST_JSONL: &str = r##"{"op":"title","title":"Compound Interest Simulator","subtitle":"Live pure-Rust reactive calculator"}
{"op":"state_init","state":{"principal":10000,"rate":7,"years":10,"monthly":200,"with_contrib":false}}
{"op":"set_node","root":true,"node":{"id":"root","kind":"stack","direction":"vertical","gap":16,"children":["controls","kpi_grid","growth_chart","schedule_table","summary_callout"]}}
{"op":"set_node","node":{"id":"controls","kind":"card","title":"Inputs","children":["s_principal","s_rate","s_years","s_monthly","sw_contrib"]}}
{"op":"set_node","node":{"id":"s_principal","kind":"slider","bind":"principal","label":"Initial Principal: ${format(principal, 'currency', 0)}","min":1000,"max":100000,"step":1000,"unit":"USD"}}
{"op":"set_node","node":{"id":"s_rate","kind":"slider","bind":"rate","label":"Annual Rate: ${rate}%","min":0,"max":20,"step":0.5,"unit":"%"}}
{"op":"set_node","node":{"id":"s_years","kind":"slider","bind":"years","label":"Horizon: ${years} yrs","min":1,"max":40,"step":1,"unit":"yrs"}}
{"op":"set_node","node":{"id":"s_monthly","kind":"slider","bind":"monthly","label":"Monthly Contribution: ${format(monthly, 'currency', 0)}","min":0,"max":5000,"step":50,"unit":"USD"}}
{"op":"set_node","node":{"id":"sw_contrib","kind":"switch","bind":"with_contrib","label":"Include Monthly Contributions"}}
{"op":"set_node","node":{"id":"kpi_grid","kind":"grid","columns":3,"gap":12,"children":["m_final","m_gain","p_interest_share"]}}
{"op":"set_node","node":{"id":"m_final","kind":"metric","label":"Final Balance","value":"with_contrib ? (rate == 0 ? principal + monthly * 12 * years : principal * pow(1 + rate / 100, years) + monthly * 12 * ((pow(1 + rate / 100, years) - 1) / (rate / 100))) : principal * pow(1 + rate / 100, years)","delta":"${years} years @ ${rate}%","format":"currency"}}
{"op":"set_node","node":{"id":"m_gain","kind":"metric","label":"Interest Earned","value":"(with_contrib ? (rate == 0 ? principal + monthly * 12 * years : principal * pow(1 + rate / 100, years) + monthly * 12 * ((pow(1 + rate / 100, years) - 1) / (rate / 100))) : principal * pow(1 + rate / 100, years)) - (principal + (with_contrib ? monthly * 12 * years : 0))","format":"currency"}}
{"op":"set_node","node":{"id":"p_interest_share","kind":"progress","label":"Interest share","value":"(principal * pow(1 + rate / 100, years)) - principal","max":"principal * pow(1 + rate / 100, years)"}}
{"op":"set_node","node":{"id":"growth_chart","kind":"chart","title":"Portfolio Growth (${years} Years)","width":640,"height":320,"source":{"mode":"reactive","chart_kind":"line","x_label":"Year","y_label":"Balance","y_format":"currency","categories":"map(range(0, years + 1, 1), y, concat('Yr ', y))","series":[{"name":"Total Balance","color":"#4d7a2a","values":"map(range(0, years + 1, 1), y, round(with_contrib ? (rate == 0 ? principal + monthly * 12 * y : principal * pow(1 + rate / 100, y) + monthly * 12 * ((pow(1 + rate / 100, y) - 1) / (rate / 100))) : principal * pow(1 + rate / 100, y), 2))"},{"name":"Contributed Principal","color":"#5e5852","values":"map(range(0, years + 1, 1), y, round(principal + (with_contrib ? monthly * 12 * y : 0), 2))"}]}}}
{"op":"set_node","node":{"id":"schedule_table","kind":"table","columns":[{"key":"year","label":"Year","align":"left"},{"key":"balance","label":"Balance","align":"right","format":"currency"}],"rows":"map(range(1, years + 1, 1), y, { year: concat('Year ', y), balance: round(principal * pow(1 + rate / 100, y), 2) })"}}
{"op":"set_node","node":{"id":"summary_callout","kind":"callout","callout_kind":"tip","title":"Compounding Insight","body":"Starting with ${format(principal, 'currency', 0)} at ${rate}% grows to ${format(principal * pow(1 + rate / 100, years), 'currency')} in ${years} years."}}
{"op":"done"}"##;

const ALL_19_KINDS_JSONL: &str = r##"{"op":"title","title":"All 19 Node Kinds","subtitle":"Complete native showcase"}
{"op":"state_init","state":{"tab":"overview","env":"prod","budget":50,"alerts":true}}
{"op":"set_node","root":true,"node":{"id":"root","kind":"stack","direction":"vertical","gap":10,"children":["tabs","divider","controls_card","embeds_grid"]}}
{"op":"set_node","node":{"id":"tabs","kind":"tabs","bind":"tab","tabs":[{"id":"overview","label":"Overview","children":["intro_text","intro_md","status_badge","callout_box"]},{"id":"details","label":"Details","children":["detail_table"]}]}}
{"op":"set_node","node":{"id":"intro_text","kind":"text","value":"Environment: ${env}","tone":"accent","size":"lg"}}
{"op":"set_node","node":{"id":"intro_md","kind":"markdown","text":"Markdown with **bold** and `#12`."}}
{"op":"set_node","node":{"id":"status_badge","kind":"badge","label":"Healthy","tone":"positive"}}
{"op":"set_node","node":{"id":"callout_box","kind":"callout","callout_kind":"info","title":"Note","body":"Running on native GPUI."}}
{"op":"set_node","node":{"id":"detail_table","kind":"table","columns":[{"key":"k","label":"Key","align":"left"},{"key":"v","label":"Value","align":"right"}],"rows":[["Env","${env}"],["Budget","${budget}"]]}}
{"op":"set_node","node":{"id":"divider","kind":"divider","label":"Controls"}}
{"op":"set_node","node":{"id":"controls_card","kind":"card","title":"Interactive","subtitle":"Live state","children":["env_select","budget_slider","alerts_switch","kpi","prog"]}}
{"op":"set_node","node":{"id":"env_select","kind":"select","bind":"env","label":"Target","options":[{"value":"dev","label":"Development"},{"value":"prod","label":"Production"}]}}
{"op":"set_node","node":{"id":"budget_slider","kind":"slider","bind":"budget","label":"Budget","min":0,"max":100,"step":10,"unit":"%"}}
{"op":"set_node","node":{"id":"alerts_switch","kind":"switch","bind":"alerts","label":"Alerts Enabled"}}
{"op":"set_node","node":{"id":"kpi","kind":"metric","label":"Budget","value":"budget","delta":"env=${env}"}}
{"op":"set_node","node":{"id":"prog","kind":"progress","label":"Allocation","value":"budget","max":100}}
{"op":"set_node","node":{"id":"embeds_grid","kind":"grid","columns":2,"gap":8,"children":["embed_chart","embed_diagram","embed_canvas","embed_code"]}}
{"op":"set_node","node":{"id":"embed_chart","kind":"chart","title":"Spark","source":{"mode":"template","template":"{\"type\":\"sparkline\",\"data\":[1,3,2,5,4]}"}}}
{"op":"set_node","node":{"id":"embed_diagram","kind":"diagram","source":"flowchart LR\n  A[Start] --> B[End]"}}
{"op":"set_node","node":{"id":"embed_canvas","kind":"canvas","data":"{\"nodes\":[{\"id\":\"n1\",\"type\":\"text\",\"x\":0,\"y\":0,\"width\":160,\"height\":80,\"text\":\"Node\"}],\"edges\":[]}"}}
{"op":"set_node","node":{"id":"embed_code","kind":"code_block","language":"rust","code":"fn main() { println!(\"ok\"); }"}}
{"op":"done"}"##;

#[derive(Clone, PartialEq, Props)]
struct NativeChartRootProps {
    spec: String,
}

#[component]
fn NativeChartRoot(props: NativeChartRootProps) -> impl IntoElement {
    vv_chart().spec(props.spec.clone())
}

#[derive(Clone, PartialEq, Props)]
struct NativeGenUiRootProps {
    spec: String,
    streaming: bool,
}

#[component]
fn NativeGenUiRoot(props: NativeGenUiRootProps) -> impl IntoElement {
    vv_gen_ui()
        .spec(props.spec.clone())
        .streaming(props.streaming)
        .on_action(|ev: &VvGenUiActionEvent| {
            STATE_ACTIONS.with(|a| a.borrow_mut().push(ev.clone()));
        })
}

#[test]
fn native_vv_chart_renders_resolved_light_and_dark_svgs_with_lru_cache_and_error_fallback() {
    let _guard = CHART_GENUI_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_chart_cache();

    let spec = r#"{"type":"line","title":"Monthly Throughput","categories":["Jan","Feb","Mar"],"series":[{"name":"Issues","data":[14,22,31]}]}"#;

    let light = render_chart(spec, false).expect("light chart svg");
    assert!(light.svg.contains("<svg"));
    assert!(light.svg.contains("<text"));
    assert!(light.svg.contains("Monthly Throughput"));
    assert!(!light.svg.contains("var(--"));
    assert!(light.svg.contains("#fcfcfb"));
    let doc = roxmltree::Document::parse(&light.svg).expect("valid light chart xml");
    assert_eq!(doc.root_element().tag_name().name(), "svg");

    let light_hit = render_chart(spec, false).expect("cached light chart");
    assert_eq!(light, light_hit);
    let stats_after_hit = chart_cache_stats();
    assert_eq!(stats_after_hit.hits, 1);
    assert_eq!(stats_after_hit.misses, 1);

    let dark = render_chart(spec, true).expect("dark chart svg");
    assert!(dark.svg.contains("#151413"));
    assert_ne!(light.svg, dark.svg);

    // Mount in nsh Core: must use ViewKind::Image with ImageSrc::svg_markup, NEVER ViewKind::Canvas.
    let mut harness = TestHarness::mount(Root::new::<NativeChartRoot>(|| NativeChartRootProps { spec: spec.to_owned() }));
    assert!(harness.has_view_kind(ViewKind::Image));
    assert!(!harness.has_view_kind(ViewKind::Canvas));
    let light_id = harness.find_test_id("chart-image").expect("chart-image mounted");
    let light_src = harness.images.get(&light_id).expect("chart image src").clone();
    let mounted_light_svg = assert_inline_svg_image(&light_src);
    assert!(mounted_light_svg.contains("#fcfcfb"));

    harness.set_dark(true);
    let dark_id = harness.find_test_id("chart-image").expect("dark chart-image mounted");
    let dark_src = harness.images.get(&dark_id).expect("dark chart image src").clone();
    let mounted_dark_svg = assert_inline_svg_image(&dark_src);
    assert!(mounted_dark_svg.contains("#151413"));
    assert_ne!(light_src.uri, dark_src.uri);

    // Invalid spec falls back to VvCodeBlock + chart-error cleanly.
    let bad = TestHarness::mount(Root::new::<NativeChartRoot>(|| NativeChartRootProps {
        spec: r#"{"type":"line","series":[]}"#.to_owned(),
    }));
    assert!(bad.find_test_id("chart-image").is_none());
    assert!(bad.find_test_id("chart-error").is_some());
    assert!(bad.find_test_id("code-block").is_some());
}

#[test]
fn native_vv_genui_compound_interest_simulator_updates_kpis_and_chart_reactively() {
    let _guard = CHART_GENUI_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    STATE_ACTIONS.with(|a| a.borrow_mut().clear());

    let mut harness = TestHarness::mount(Root::new::<NativeGenUiRoot>(|| NativeGenUiRootProps {
        spec: COMPOUND_INTEREST_JSONL.to_owned(),
        streaming: false,
    }));

    assert!(harness.find_test_id("genui-surface").is_some());
    assert!(harness.contains_text("Compound Interest Simulator"));
    assert!(harness.contains_text("$19,671.51"));
    assert!(harness.contains_text("10 years @ 7%"));
    assert!(harness.contains_text("Year 10"));

    // Embedded reactive chart mounts via ImageSrc::svg_markup (never ViewKind::Canvas).
    assert!(harness.has_view_kind(ViewKind::Image));
    assert!(!harness.has_view_kind(ViewKind::Canvas));
    let initial_chart_id = harness.find_test_id("chart-image").expect("embedded growth chart");
    let initial_chart_src = harness.images.get(&initial_chart_id).expect("initial chart src").clone();
    let initial_chart_svg = assert_inline_svg_image(&initial_chart_src);
    assert!(initial_chart_svg.contains("Portfolio Growth (10 Years)"));

    // Toggle the Switch (with_contrib: false -> true) and confirm KPIs + embedded SVG update live!
    let metric_before_id = harness.find_test_id("genui-metric-value-m_final").expect("final balance metric");
    assert_eq!(harness.texts.get(&metric_before_id).map(|t| t.text.as_str()), Some("$19,671.51"));
    let switch_id = harness.find_test_id("genui-switch-sw_contrib").expect("contrib switch");
    assert!(harness.press(switch_id));
    let metric_after_id = harness.find_test_id("genui-metric-value-m_final").expect("updated final balance metric");
    assert_eq!(harness.texts.get(&metric_after_id).map(|t| t.text.as_str()), Some("$52,830.99"));

    let updated_chart_id = harness.find_test_id("chart-image").expect("updated growth chart");
    let updated_chart_src = harness.images.get(&updated_chart_id).expect("updated chart src").clone();
    assert_ne!(initial_chart_src.uri, updated_chart_src.uri);
    assert_inline_svg_image(&updated_chart_src);

    // Step the Annual Rate slider up (+0.5%: 7 -> 7.5) and confirm delta + value re-resolve!
    let inc_rate_id = harness.find_test_id("genui-slider-inc-s_rate").expect("rate increment button");
    assert!(harness.press(inc_rate_id));
    assert!(harness.contains_text("10 years @ 7.5%"));

    STATE_ACTIONS.with(|a| {
        let actions = a.borrow();
        assert_eq!(actions.len(), 2);
        assert_eq!(actions[0].action.as_str(), "state_change");
        assert_eq!(actions[0].payload.as_str(), "with_contrib=true");
        assert_eq!(actions[1].action.as_str(), "state_change");
        assert_eq!(actions[1].payload.as_str(), "rate=7.5");
    });
}

#[test]
fn native_vv_genui_renders_all_19_node_kinds_supports_tabs_and_select_and_handles_invalid_spec() {
    let _guard = CHART_GENUI_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let _diagram_guard = DIAGRAM_CACHE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());

    let mut harness = TestHarness::mount(Root::new::<NativeGenUiRoot>(|| NativeGenUiRootProps {
        spec: ALL_19_KINDS_JSONL.to_owned(),
        streaming: false,
    }));

    assert!(harness.find_test_id("genui-surface").is_some());
    assert!(harness.contains_text("All 19 Node Kinds"));
    assert!(harness.contains_text("Environment: prod"));
    assert!(harness.contains_text("Healthy"));
    assert!(harness.contains_text("Running on native GPUI."));
    assert!(harness.contains_text("Controls"));
    // Embedded chart, diagram, canvas, and code block all mount cleanly without ViewKind::Canvas.
    assert!(!harness.has_view_kind(ViewKind::Canvas));
    assert!(harness.wait_until(std::time::Duration::from_secs(5), |h| h.find_test_id("diagram-image").is_some()));
    assert!(harness.find_test_id("chart-image").is_some());
    assert!(harness.find_test_id("diagram-image").is_some());
    assert!(harness.find_test_id("canvas-image").is_some());
    assert!(harness.find_test_id("code-block").is_some());

    // Select changes `env` from `prod` to `dev` and updates dependent text + metric delta.
    let dev_opt = harness.find_test_id("genui-select-env_select-dev").expect("dev select pill");
    assert!(harness.press(dev_opt));
    assert!(harness.contains_text("Environment: dev"));
    assert!(harness.contains_text("env=dev"));

    // Tabs switches from `overview` to `details` and mounts the detail table with updated `dev` state.
    let details_tab = harness.find_test_id("genui-tab-tabs-details").expect("details tab");
    assert!(harness.press(details_tab));
    assert!(harness.find_test_id("genui-table-detail_table").is_some());
    assert!(harness.contains_text("Budget"));

    // Invalid spec falls back cleanly to VvCodeBlock + genui-error.
    let invalid = TestHarness::mount(Root::new::<NativeGenUiRoot>(|| NativeGenUiRootProps {
        spec: "not valid jsonl".to_owned(),
        streaming: false,
    }));
    assert!(invalid.find_test_id("genui-error").is_some());
    assert!(invalid.find_test_id("code-block").is_some());
}

#[component]
fn MarkdownGenUiForwardRoot() -> impl IntoElement {
    let md = concat!(
        "```genui\n",
        "{\"op\":\"state_init\",\"state\":{\"enabled\":false}}\n",
        "{\"op\":\"set_node\",\"root\":true,\"node\":{\"id\":\"root\",\"kind\":\"switch\",\"bind\":\"enabled\",\"label\":\"Enable\"}}\n",
        "{\"op\":\"done\"}\n",
        "```",
    );
    vv_markdown().text(md).on_gen_ui_action(|ev: &VvGenUiActionEvent| {
        STATE_ACTIONS.with(|a| a.borrow_mut().push(ev.clone()));
    })
}

#[test]
fn native_vv_markdown_forwards_genui_actions() {
    let _guard = CHART_GENUI_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    STATE_ACTIONS.with(|a| a.borrow_mut().clear());

    let mut harness = TestHarness::mount(Root::of::<MarkdownGenUiForwardRoot>());
    let switch_id = harness.find_test_id("genui-switch-root").expect("embedded genui switch");
    assert!(harness.press(switch_id));

    STATE_ACTIONS.with(|a| {
        let actions = a.borrow();
        assert_eq!(actions.len(), 1);
        assert_eq!(actions[0].action.as_str(), "state_change");
        assert_eq!(actions[0].payload.as_str(), "enabled=true");
    });
}

#[component]
fn StreamingChartAndGenUiRoot() -> impl IntoElement {
    let chart_spec = signal(SharedString::from("{\"type\":\"bar\",\"series\":"));
    let chart_streaming = signal(true);
    let genui_spec = signal(SharedString::from(concat!(
        "{\"op\":\"state_init\",\"state\":{\"count\":1}}\n",
        "{\"op\":\"set_node\",\"root\":true,\"node\":{\"id\":\"root\",\"kind\":\"text\",\"value\":\"Count: ${count}\"}}\n",
        "{\"op\":\"set_node\",\"node\":{\"id\":\"part",
    )));
    let genui_streaming = signal(true);

    let c_spec = chart_spec;
    let c_stream = chart_streaming;
    let g_spec = genui_spec;
    let g_stream = genui_streaming;

    view()
        .child(vv_chart().spec(move || chart_spec.get()).streaming(move || chart_streaming.get()))
        .child(vv_gen_ui().spec(move || genui_spec.get()).streaming(move || genui_streaming.get()))
        .child(view().test_id("append-partial").on_press(move |_: &nsh_core::prelude::PressEvent| {
            g_spec.set(SharedString::from(concat!(
                "{\"op\":\"state_init\",\"state\":{\"count\":1}}\n",
                "{\"op\":\"set_node\",\"root\":true,\"node\":{\"id\":\"root\",\"kind\":\"text\",\"value\":\"Count: ${count}\"}}\n",
                "{\"op\":\"set_node\",\"node\":{\"id\":\"partial\",\"kind\":\"text\",\"value\":\"More",
            )));
        }))
        .child(view().test_id("finish-all").on_press(move |_: &nsh_core::prelude::PressEvent| {
            c_spec.set(SharedString::from(
                r#"{"type":"bar","categories":["A","B"],"series":[{"name":"S","data":[1,2]}]}"#,
            ));
            c_stream.set(false);
            g_spec.set(SharedString::from(concat!(
                "{\"op\":\"state_init\",\"state\":{\"count\":1}}\n",
                "{\"op\":\"set_node\",\"root\":true,\"node\":{\"id\":\"root\",\"kind\":\"stack\",\"direction\":\"vertical\",\"gap\":4,\"children\":[\"h\",\"partial\"]}}\n",
                "{\"op\":\"set_node\",\"node\":{\"id\":\"h\",\"kind\":\"text\",\"value\":\"Count: ${count}\"}}\n",
                "{\"op\":\"set_node\",\"node\":{\"id\":\"partial\",\"kind\":\"text\",\"value\":\"Complete\"}}\n",
                "{\"op\":\"done\"}",
            )));
            g_stream.set(false);
        }))
}

#[test]
fn vv_chart_streaming_and_large_offload_plus_genui_incremental_streaming_work_cleanly() {
    let _guard = CHART_GENUI_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_chart_cache();

    let mut harness = TestHarness::mount(Root::of::<StreamingChartAndGenUiRoot>());
    assert!(harness.find_test_id("chart-loading").is_some());
    assert!(harness.find_test_id("chart-error").is_none());
    assert!(harness.contains_text("Count: 1"));

    let partial_btn = harness.find_test_id("append-partial").expect("append-partial");
    assert!(harness.press(partial_btn));
    assert!(harness.contains_text("Count: 1"));

    let finish_btn = harness.find_test_id("finish-all").expect("finish-all");
    assert!(harness.press(finish_btn));
    assert!(harness.find_test_id("chart-image").is_some());
    assert!(harness.contains_text("Complete"));

    clear_chart_cache();
    let cats: Vec<String> = (0..300).map(|i| format!("\"Category-{i:03}\"")).collect();
    let vals: Vec<String> = (0..300).map(|i| (i % 40 + 1).to_string()).collect();
    let large_spec = format!(
        r#"{{"type":"bar","title":"Large","categories":[{}],"series":[{{"name":"S","data":[{}]}}]}}"#,
        cats.join(","),
        vals.join(",")
    );
    assert!(large_spec.len() >= ASYNC_CHART_BYTE_THRESHOLD);
    assert!(cached_render_chart(&large_spec, false).is_none());

    let mut large_harness = TestHarness::mount(Root::new::<NativeChartRoot>(move || NativeChartRootProps { spec: large_spec.clone() }));
    assert!(large_harness.find_test_id("chart-loading").is_some());
    assert!(large_harness.wait_until(Duration::from_secs(5), |h| h.find_test_id("chart-image").is_some()));
}

#[test]
fn regression_genui_nested_markdown_does_not_recursively_mount_genui_blocks() {
    let _guard = CHART_GENUI_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let spec = concat!(
        "{\"op\":\"set_node\",\"root\":true,\"node\":{\"id\":\"root\",\"kind\":\"markdown\",\"text\":\"Outer **bold**\\n\\n```genui\\n{\\\"op\\\":\\\"set_node\\\",\\\"root\\\":true,\\\"node\\\":{\\\"id\\\":\\\"inner\\\",\\\"kind\\\":\\\"text\\\",\\\"value\\\":\\\"nested\\\"}}\\n```\"}}\n",
        "{\"op\":\"done\"}",
    );

    let harness = TestHarness::mount(Root::new::<NativeGenUiRoot>(move || NativeGenUiRootProps {
        spec: spec.to_owned(),
        streaming: false,
    }));

    assert!(harness.find_test_id("genui-surface").is_some());
    assert!(harness.contains_text("Outer"));
    assert!(harness.contains_text("bold"));
    assert!(harness.find_test_id("code-block").is_some());
    assert!(harness.find_test_id("genui-node-inner").is_none());
}
