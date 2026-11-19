mod support;

use std::cell::RefCell;
use std::sync::{Arc, Mutex};

use nsh_core::ViewKind;
use nsh_core::element::Root;
use nsh_core::prelude::*;
use vibevalley_rich_ui::{
    ChartRenderer, ChartRendererContext, GenUiActionSink, GenUiRenderer, GenUiRendererContext, RenderedSvg, VvGenUiActionEvent, clear_chart_renderer,
    clear_genui_renderer, register_chart_renderer, register_genui_renderer, vv_chart, vv_gen_ui, vv_markdown,
};

use support::{TestHarness, assert_inline_svg_image};

static HOOK_TEST_LOCK: Mutex<()> = Mutex::new(());

thread_local! {
    static RECORDED_ACTIONS: RefCell<Vec<VvGenUiActionEvent>> = const { RefCell::new(Vec::new()) };
}

struct MockChartRenderer;

impl ChartRenderer for MockChartRenderer {
    fn render_svg(&self, spec: &str, dark: bool) -> Result<RenderedSvg, String> {
        if spec.contains("INVALID") {
            return Err("invalid chart spec".to_owned());
        }
        let bg = if dark { "#151413" } else { "#fcfcfb" };
        let fg = if dark { "#ecebe8" } else { "#1c1917" };
        let svg = format!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="{bg}"/><text x="16" y="40" fill="{fg}">Chart</text></svg>"#
        );
        Ok(RenderedSvg::new(svg, 320.0, 180.0).with_label("Mock Chart"))
    }
}

struct MockGenUiRenderer;

impl GenUiRenderer for MockGenUiRenderer {
    fn render_element(&self, spec: &str, dark: bool, sink: GenUiActionSink) -> Result<AnyElement, String> {
        if spec.contains("INVALID") {
            return Err("invalid genui spec".to_owned());
        }
        let label = if dark { "Submit Dark" } else { "Submit Light" };
        let payload = spec.to_owned();
        Ok(view()
            .test_id("genui-action-btn")
            .role(AccessibilityRole::Button)
            .on_press(move |_: &PressEvent| {
                sink.emit("submit", payload.clone());
            })
            .child(text(label))
            .into_element())
    }
}

#[derive(Clone, PartialEq, Props)]
struct ChartTestRootProps {
    install_renderer: bool,
    spec: String,
}

#[component]
fn ChartTestRoot(props: ChartTestRootProps) -> impl IntoElement {
    if props.install_renderer {
        provide_context(ChartRendererContext(Arc::new(MockChartRenderer)));
    }
    vv_chart().spec(props.spec.clone()).title(Some(SharedString::from("Sales")))
}

#[test]
fn vv_chart_renders_placeholder_without_hook_and_image_with_hook() {
    let _guard = HOOK_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_chart_renderer();
    // Without a ChartRenderer installed: clean placeholder + readable JSON code block.
    let placeholder = TestHarness::mount(Root::new::<ChartTestRoot>(|| ChartTestRootProps {
        install_renderer: false,
        spec: r#"{"type":"bar","data":[1,2,3]}"#.to_owned(),
    }));
    assert!(placeholder.find_test_id("chart-placeholder").is_some());
    assert!(placeholder.find_test_id("code-block").is_some());

    // With a ChartRenderer installed via context: mounts ViewKind::Image (never element::svg Canvas).
    let mut rendered = TestHarness::mount(Root::new::<ChartTestRoot>(|| ChartTestRootProps {
        install_renderer: true,
        spec: r#"{"type":"bar","data":[1,2,3]}"#.to_owned(),
    }));
    assert!(!rendered.has_view_kind(ViewKind::Canvas));
    assert!(rendered.has_view_kind(ViewKind::Image));
    let img_id = rendered.find_test_id("chart-image").expect("chart image mounted");
    let light_src = rendered.images.get(&img_id).expect("chart src").clone();
    let light_svg = assert_inline_svg_image(&light_src);
    assert!(light_svg.contains("#fcfcfb"));

    rendered.set_dark(true);
    let dark_id = rendered.find_test_id("chart-image").expect("dark chart image");
    let dark_src = rendered.images.get(&dark_id).expect("dark chart src").clone();
    let dark_svg = assert_inline_svg_image(&dark_src);
    assert!(dark_svg.contains("#151413"));
    assert_ne!(light_src.uri, dark_src.uri);

    // Renderer error falls back to code block + chart-error.
    let err_view = TestHarness::mount(Root::new::<ChartTestRoot>(|| ChartTestRootProps {
        install_renderer: true,
        spec: "INVALID".to_owned(),
    }));
    assert!(err_view.find_test_id("chart-image").is_none());
    assert!(err_view.find_test_id("chart-error").is_some());
    assert!(err_view.find_test_id("code-block").is_some());
}

#[derive(Clone, PartialEq, Props)]
struct GenUiTestRootProps {
    install_renderer: bool,
    inside_markdown: bool,
    spec: String,
}

#[component]
fn GenUiTestRoot(props: GenUiTestRootProps) -> impl IntoElement {
    if props.install_renderer {
        provide_context(GenUiRendererContext(Arc::new(MockGenUiRenderer)));
    }
    if props.inside_markdown {
        let md = format!("```genui\n{}\n```", props.spec);
        vv_markdown()
            .text(md)
            .on_gen_ui_action(|ev: &VvGenUiActionEvent| {
                RECORDED_ACTIONS.with(|a| a.borrow_mut().push(ev.clone()));
            })
            .into_element()
    } else {
        vv_gen_ui()
            .spec(props.spec.clone())
            .on_action(|ev: &VvGenUiActionEvent| {
                RECORDED_ACTIONS.with(|a| a.borrow_mut().push(ev.clone()));
            })
            .into_element()
    }
}

#[test]
fn vv_genui_renders_placeholder_custom_surface_error_and_forwards_actions_through_markdown() {
    let _guard = HOOK_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_genui_renderer();
    RECORDED_ACTIONS.with(|a| a.borrow_mut().clear());
    let placeholder = TestHarness::mount(Root::new::<GenUiTestRoot>(|| GenUiTestRootProps {
        install_renderer: false,
        inside_markdown: false,
        spec: r#"{"widget":"poll"}"#.to_owned(),
    }));
    assert!(placeholder.find_test_id("genui-placeholder").is_some());

    // Mounted directly with GenUiRenderer: reacts to dark() and dispatches typed Action event.
    let mut direct = TestHarness::mount(Root::new::<GenUiTestRoot>(|| GenUiTestRootProps {
        install_renderer: true,
        inside_markdown: false,
        spec: r#"{"widget":"confirm"}"#.to_owned(),
    }));
    assert!(direct.contains_text("Submit Light"));
    direct.set_dark(true);
    assert!(direct.contains_text("Submit Dark"));
    let btn = direct.find_test_id("genui-action-btn").expect("genui button");
    assert!(direct.press(btn));

    // Mounted via ` ```genui ` inside VvMarkdown: forwards Action into VvMarkdownEvent::GenUiAction.
    let mut embedded = TestHarness::mount(Root::new::<GenUiTestRoot>(|| GenUiTestRootProps {
        install_renderer: true,
        inside_markdown: true,
        spec: r#"{"widget":"form"}"#.to_owned(),
    }));
    let embedded_btn = embedded.find_test_id("genui-action-btn").expect("embedded genui button");
    assert!(embedded.press(embedded_btn));

    RECORDED_ACTIONS.with(|a| {
        let recorded = a.borrow();
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[0].action.as_str(), "submit");
        assert_eq!(recorded[0].payload.as_str(), r#"{"widget":"confirm"}"#);
        assert_eq!(recorded[1].action.as_str(), "submit");
        assert_eq!(recorded[1].payload.as_str(), r#"{"widget":"form"}"#);
    });

    // Invalid spec falls back cleanly to code block + genui-error.
    let err_view = TestHarness::mount(Root::new::<GenUiTestRoot>(|| GenUiTestRootProps {
        install_renderer: true,
        inside_markdown: false,
        spec: "INVALID".to_owned(),
    }));
    assert!(err_view.find_test_id("genui-error").is_some());
    assert!(err_view.find_test_id("code-block").is_some());
}

#[test]
fn global_chart_and_genui_renderer_registration_works_without_context_override() {
    let _guard = HOOK_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    register_chart_renderer(Arc::new(MockChartRenderer));
    register_genui_renderer(Arc::new(MockGenUiRenderer));

    let chart = TestHarness::mount(Root::new::<ChartTestRoot>(|| ChartTestRootProps {
        install_renderer: false,
        spec: r#"{"type":"line","data":[1,4,2]}"#.to_owned(),
    }));
    let img_id = chart.find_test_id("chart-image").expect("global chart renderer active");
    assert_inline_svg_image(chart.images.get(&img_id).expect("global chart svg"));

    let genui = TestHarness::mount(Root::new::<GenUiTestRoot>(|| GenUiTestRootProps {
        install_renderer: false,
        inside_markdown: false,
        spec: r#"{"widget":"global"}"#.to_owned(),
    }));
    assert!(genui.find_test_id("genui-action-btn").is_some());

    clear_chart_renderer();
    clear_genui_renderer();
}
