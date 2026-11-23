use std::sync::Mutex;
use std::time::Duration;

use nsh_core::ViewKind;
use nsh_core::element::Root;
use nsh_core::prelude::*;
use vibevalley_rich::{
    cached_render_diagram_with_max_width, canvas_cache_stats, clear_canvas_cache, clear_diagram_cache, diagram_cache_stats, render_canvas, render_diagram,
    render_diagram_with_max_width, vv_canvas, vv_diagram,
};

use crate::support::{TestHarness, assert_inline_svg_image};

static DIAGRAM_CACHE_TEST_LOCK: Mutex<()> = Mutex::new(());

const SAMPLE_FLOWCHART: &str = "flowchart LR\n  A[Request] --> B{Valid?}\n  B -->|Yes| C[Done]\n  B -->|No| D[Retry]";
const SAMPLE_SEQUENCE: &str = "sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi!";
const SAMPLE_PIE: &str = "pie title Crops\n  \"Wheat\" : 60\n  \"Corn\" : 40";

const SAMPLE_CANVAS: &str = r#"{
  "nodes": [
    { "id": "g1", "type": "group", "x": -20, "y": -20, "width": 560, "height": 220, "label": "Pipeline" },
    { "id": "n1", "type": "text", "x": 0, "y": 20, "width": 200, "height": 120, "text": "Input Spec", "color": "4" },
    { "id": "n2", "type": "text", "x": 300, "y": 20, "width": 200, "height": 120, "text": "Pure Rust SVG", "color": "5" }
  ],
  "edges": [
    { "id": "e1", "fromNode": "n1", "toNode": "n2", "label": "renders" }
  ]
}"#;

fn assert_resvg_safe_svg(svg: &str) {
    let doc = roxmltree::Document::parse(svg).expect("SVG must be well-formed XML");
    assert_eq!(doc.root_element().tag_name().name(), "svg");
    assert!(!svg.contains("var(--"), "resolved SVG must not contain CSS custom properties (`var(--`)");
    assert!(!svg.contains("color-mix("), "resolved SVG must not contain `color-mix()`");
    assert!(!svg.contains("<foreignObject"), "resolved SVG must not contain `<foreignObject>`");
}

#[test]
fn diagram_rendering_produces_resolved_svg_with_text_and_lru_caching() {
    let _guard = DIAGRAM_CACHE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_diagram_cache();

    for source in [SAMPLE_FLOWCHART, SAMPLE_SEQUENCE, SAMPLE_PIE] {
        let light = render_diagram(source, false).expect("light render succeeds");
        let dark = render_diagram(source, true).expect("dark render succeeds");
        assert_resvg_safe_svg(&light.svg);
        assert_resvg_safe_svg(&dark.svg);
        assert!(light.svg.contains("<text"), "diagram SVG must preserve `<text>` labels");
        assert!(light.width > 10.0 && light.height > 10.0);
        assert_ne!(light.svg, dark.svg, "light and dark resolved palettes must differ");
    }

    let before_hit = diagram_cache_stats();
    assert_eq!(before_hit.misses, 6);
    assert_eq!(before_hit.hits, 0);

    let cached = render_diagram(SAMPLE_FLOWCHART, false).expect("cached hit");
    assert_resvg_safe_svg(&cached.svg);
    assert_eq!(diagram_cache_stats().hits, 1);

    // Invalid Mermaid source returns a structured DiagramError.
    let err = render_diagram("not-a-valid-mermaid-diagram !!!", false).expect_err("invalid mermaid must error");
    assert!(!err.message.is_empty());
}

#[test]
fn diagram_lru_cache_evicts_oldest_entries_when_capacity_exceeded() {
    let _guard = DIAGRAM_CACHE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_diagram_cache();
    for i in 0..70 {
        let src = format!("flowchart LR\n  N{i} --> M{i}");
        render_diagram(&src, false).expect("valid flowchart");
    }
    let stats = diagram_cache_stats();
    assert_eq!(stats.entries, stats.capacity);
    assert!(stats.evictions >= 6, "expected evictions beyond 64 capacity, got {stats:?}");
}

#[derive(Clone, PartialEq, Props)]
struct DiagramHarnessProps {
    source: String,
}

#[component]
fn DiagramHarness(props: DiagramHarnessProps) -> impl IntoElement {
    vv_diagram().source(props.source.clone())
}

#[test]
fn cached_render_diagram_with_max_width_hits_matching_entries_and_normalizes_invalid_widths() {
    let _guard = DIAGRAM_CACHE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_diagram_cache();

    assert!(cached_render_diagram_with_max_width(SAMPLE_FLOWCHART, false, Some(480.0)).is_none());
    assert!(cached_render_diagram_with_max_width(SAMPLE_FLOWCHART, false, None).is_none());

    let rendered = render_diagram_with_max_width(SAMPLE_FLOWCHART, false, Some(480.0)).expect("valid render");
    let hit = cached_render_diagram_with_max_width(SAMPLE_FLOWCHART, false, Some(480.0))
        .expect("cache hit for matching width")
        .expect("cached ok");
    assert_eq!(hit, rendered);

    assert!(cached_render_diagram_with_max_width(SAMPLE_FLOWCHART, false, Some(320.0)).is_none());
    assert!(cached_render_diagram_with_max_width(SAMPLE_FLOWCHART, true, Some(480.0)).is_none());

    let unbounded = render_diagram_with_max_width(SAMPLE_FLOWCHART, false, None).expect("unbounded render");
    for invalid_width in [None, Some(0.0), Some(-12.0), Some(f32::NAN), Some(f32::INFINITY)] {
        let normalized_hit = cached_render_diagram_with_max_width(SAMPLE_FLOWCHART, false, invalid_width)
            .expect("invalid/empty max_width shares None cache entry")
            .expect("cached ok");
        assert_eq!(normalized_hit, unbounded);
    }

    let err_source = "not-a-valid-mermaid-diagram !!!";
    assert!(cached_render_diagram_with_max_width(err_source, false, None).is_none());
    let rendered_err = render_diagram_with_max_width(err_source, false, None).expect_err("invalid source errors");
    let cached_err = cached_render_diagram_with_max_width(err_source, false, None)
        .expect("cached error hit")
        .expect_err("cached Err");
    assert_eq!(cached_err, rendered_err);
}

#[test]
fn vv_diagram_mounts_as_image_svg_markup_never_element_svg_and_falls_back_on_error() {
    let _guard = DIAGRAM_CACHE_TEST_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    clear_diagram_cache();

    let mut harness = TestHarness::mount(Root::new::<DiagramHarness>(|| DiagramHarnessProps {
        source: SAMPLE_FLOWCHART.to_owned(),
    }));

    // Uncached diagrams render a lightweight placeholder immediately without stalling the UI thread.
    assert!(!harness.has_view_kind(ViewKind::Canvas));
    assert!(harness.find_test_id("diagram-loading").is_some());

    assert!(harness.wait_until(Duration::from_secs(5), |h| h.find_test_id("diagram-image").is_some()));

    // CRITICAL Trap 3: must use ViewKind::Image with ImageSrc::svg_markup, NEVER element::svg (ViewKind::Canvas).
    assert!(!harness.has_view_kind(ViewKind::Canvas));
    assert!(harness.has_view_kind(ViewKind::Image));
    assert!(harness.find_test_id("diagram-loading").is_none());

    let img_id = harness.find_test_id("diagram-image").expect("diagram image mounted");
    let light_src = harness.images.get(&img_id).expect("image source set").clone();
    let light_svg = assert_inline_svg_image(&light_src);
    assert_resvg_safe_svg(&light_svg);

    // Flipping dark mode offloads the uncached dark palette render and updates the image URI reactively.
    harness.set_dark(true);
    assert!(harness.wait_until(Duration::from_secs(5), |h| {
        h.find_test_id("diagram-image")
            .is_some_and(|id| h.images.get(&id).is_some_and(|src| src.uri != light_src.uri))
    }));
    let dark_img_id = harness.find_test_id("diagram-image").expect("dark diagram image mounted");
    let dark_src = harness.images.get(&dark_img_id).expect("dark image source").clone();
    let dark_svg = assert_inline_svg_image(&dark_src);
    assert_resvg_safe_svg(&dark_svg);
    assert_ne!(light_src.uri, dark_src.uri);
    assert_ne!(light_svg, dark_svg);

    // Flipping back to cached light mode renders synchronously without waiting for background offload.
    harness.set_dark(false);
    let cached_light_id = harness.find_test_id("diagram-image").expect("cached light diagram image mounted synchronously");
    let cached_light_src = harness.images.get(&cached_light_id).expect("cached light image source");
    assert_eq!(cached_light_src.uri, light_src.uri);

    // Invalid Mermaid falls back to VvCodeBlock + diagram-error without panicking.
    let mut bad = TestHarness::mount(Root::new::<DiagramHarness>(|| DiagramHarnessProps {
        source: "invalid-diagram-kind ???".to_owned(),
    }));
    assert!(bad.wait_until(Duration::from_secs(5), |h| h.find_test_id("diagram-error").is_some()));
    assert!(bad.find_test_id("diagram-image").is_none());
    assert!(bad.find_test_id("code-block").is_some());
    assert!(bad.find_test_id("diagram-error").is_some());
}

#[test]
fn canvas_rendering_produces_resolved_light_and_dark_svgs_with_lru_cache() {
    clear_canvas_cache();

    let light = render_canvas(SAMPLE_CANVAS, false, true, 32.0).expect("light canvas render");
    let dark = render_canvas(SAMPLE_CANVAS, true, true, 32.0).expect("dark canvas render");

    assert_resvg_safe_svg(&light.svg);
    assert_resvg_safe_svg(&dark.svg);
    assert_eq!(light.node_count, 3);
    assert_eq!(light.edge_count, 1);
    assert!(light.width > 100.0 && light.height > 100.0);
    assert_ne!(light.svg, dark.svg);
    assert!(light.svg.contains("Input Spec"));
    assert!(light.svg.contains("Pure Rust SVG"));

    let hit = render_canvas(SAMPLE_CANVAS, false, true, 32.0).expect("cached canvas render");
    assert_eq!(hit, light);
    assert_eq!(canvas_cache_stats().hits, 1);

    // Malformed JSON and dangling edge spec violations fail cleanly.
    assert!(render_canvas("{not-json", false, true, 32.0).is_err());
    let dangling_edge = r#"{"nodes":[],"edges":[{"id":"e1","fromNode":"missing","toNode":"also-missing"}]}"#;
    assert!(render_canvas(dangling_edge, false, true, 32.0).is_err());
}

#[derive(Clone, PartialEq, Props)]
struct CanvasHarnessProps {
    data: String,
}

#[component]
fn CanvasHarness(props: CanvasHarnessProps) -> impl IntoElement {
    vv_canvas().data(props.data.clone())
}

#[test]
fn vv_canvas_mounts_as_image_svg_markup_and_falls_back_on_invalid_json() {
    let mut harness = TestHarness::mount(Root::new::<CanvasHarness>(|| CanvasHarnessProps {
        data: SAMPLE_CANVAS.to_owned(),
    }));

    assert!(!harness.has_view_kind(ViewKind::Canvas));
    assert!(harness.has_view_kind(ViewKind::Image));
    let img_id = harness.find_test_id("canvas-image").expect("canvas image mounted");
    let light_src = harness.images.get(&img_id).expect("canvas image src").clone();
    let light_svg = assert_inline_svg_image(&light_src);
    assert_resvg_safe_svg(&light_svg);

    harness.set_dark(true);
    let dark_id = harness.find_test_id("canvas-image").expect("dark canvas image");
    let dark_src = harness.images.get(&dark_id).expect("dark canvas image src").clone();
    let dark_svg = assert_inline_svg_image(&dark_src);
    assert_resvg_safe_svg(&dark_svg);
    assert_ne!(light_src.uri, dark_src.uri);
    assert_ne!(light_svg, dark_svg);

    let bad = TestHarness::mount(Root::new::<CanvasHarness>(|| CanvasHarnessProps { data: "{bad json".to_owned() }));
    assert!(bad.find_test_id("canvas-image").is_none());
    assert!(bad.find_test_id("code-block").is_some());
    assert!(bad.find_test_id("canvas-error").is_some());
}
