//! Pluggable renderer traits and registration hooks for `VvChart` (`vibevalley-chart`)
//! and `VvGenUi` (`vibevalley-genui`).
//!
//! Each hook checks an engine-scoped `provide_context(...)` override first and falls back to
//! the process-wide registration so hosts can wire concrete renderers once at startup while
//! tests can override them in isolation.

use std::rc::Rc;
use std::sync::{Arc, OnceLock, RwLock};

use nsh_core::prelude::{AnyElement, SharedString, use_context};

/// Standalone SVG image payload returned by SVG-based renderers such as `vibevalley-chart`.
///
/// Always rasterized through `nsh_core::element::image(ImageSrc::svg_markup(&svg).size(...))`
/// (never `element::svg`, which drops `<text>` nodes).
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedSvg {
    pub svg: String,
    pub width: f32,
    pub height: f32,
    pub label: Option<String>,
}

impl RenderedSvg {
    /// Constructs a new `RenderedSvg` with positive layout dimensions.
    pub fn new(svg: impl Into<String>, width: f32, height: f32) -> Self {
        Self {
            svg: svg.into(),
            width: width.max(1.0),
            height: height.max(1.0),
            label: None,
        }
    }

    /// Attaches an accessibility label to the rendered image.
    pub fn with_label(mut self, label: impl Into<String>) -> Self {
        self.label = Some(label.into());
        self
    }
}

/// Pluggable renderer trait for ` ```chart ` fences and [`crate::VvChart`].
///
/// Once `vibevalley-chart` lands, implement this trait and register it via
/// [`register_chart_renderer`] (or [`ChartRendererContext`]).
pub trait ChartRenderer: Send + Sync + 'static {
    /// Decodes `spec` and renders a concrete, resvg-safe SVG in light or dark mode.
    fn render_svg(&self, spec: &str, dark: bool) -> Result<RenderedSvg, String>;
}

/// Typed user action emitted by an interactive [`crate::VvGenUi`] surface.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct GenUiAction {
    pub action: SharedString,
    pub payload: SharedString,
}

/// Callback handle handed to a [`GenUiRenderer`] so interactive elements can emit typed actions
/// directly on the engine thread.
#[derive(Clone)]
pub struct GenUiActionSink(Rc<dyn Fn(GenUiAction)>);

impl GenUiActionSink {
    pub fn new(f: impl Fn(GenUiAction) + 'static) -> Self {
        Self(Rc::new(f))
    }

    pub fn emit(&self, action: impl Into<SharedString>, payload: impl Into<SharedString>) {
        (self.0)(GenUiAction {
            action: action.into(),
            payload: payload.into(),
        });
    }
}

/// Pluggable renderer trait for ` ```genui ` fences and [`crate::VvGenUi`].
///
/// Runs on the engine thread inside `VvGenUi` so implementations can return native `nsh_core`
/// elements (cards, forms, interactive buttons) or rasterized `ImageSrc::svg_markup` graphics.
pub trait GenUiRenderer: Send + Sync + 'static {
    /// Decodes `spec` and builds a native `nsh_core` element tree for light or dark mode.
    fn render_element(&self, spec: &str, dark: bool, sink: GenUiActionSink) -> Result<AnyElement, String>;
}

/// Per-subtree context override for [`ChartRenderer`] (passed to `nsh_core::prelude::provide_context`).
#[derive(Clone)]
pub struct ChartRendererContext(pub Arc<dyn ChartRenderer>);

/// Per-subtree context override for [`GenUiRenderer`] (passed to `nsh_core::prelude::provide_context`).
#[derive(Clone)]
pub struct GenUiRendererContext(pub Arc<dyn GenUiRenderer>);

fn global_chart_slot() -> &'static RwLock<Option<Arc<dyn ChartRenderer>>> {
    static SLOT: OnceLock<RwLock<Option<Arc<dyn ChartRenderer>>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(None))
}

fn global_genui_slot() -> &'static RwLock<Option<Arc<dyn GenUiRenderer>>> {
    static SLOT: OnceLock<RwLock<Option<Arc<dyn GenUiRenderer>>>> = OnceLock::new();
    SLOT.get_or_init(|| RwLock::new(None))
}

/// Installs a process-wide [`ChartRenderer`] for all [`crate::VvChart`] instances.
pub fn register_chart_renderer(renderer: Arc<dyn ChartRenderer>) {
    *global_chart_slot().write().unwrap_or_else(|p| p.into_inner()) = Some(renderer);
}

/// Removes any process-wide [`ChartRenderer`].
pub fn clear_chart_renderer() {
    *global_chart_slot().write().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Returns the active [`ChartRenderer`], preferring a context override over the global hook.
pub fn active_chart_renderer() -> Option<Arc<dyn ChartRenderer>> {
    if let Some(ctx) = use_context::<ChartRendererContext>() {
        return Some(ctx.0);
    }
    global_chart_slot().read().unwrap_or_else(|p| p.into_inner()).clone()
}

/// Installs a process-wide [`GenUiRenderer`] for all [`crate::VvGenUi`] instances.
pub fn register_genui_renderer(renderer: Arc<dyn GenUiRenderer>) {
    *global_genui_slot().write().unwrap_or_else(|p| p.into_inner()) = Some(renderer);
}

/// Removes any process-wide [`GenUiRenderer`].
pub fn clear_genui_renderer() {
    *global_genui_slot().write().unwrap_or_else(|p| p.into_inner()) = None;
}

/// Returns the active [`GenUiRenderer`], preferring a context override over the global hook.
pub fn active_genui_renderer() -> Option<Arc<dyn GenUiRenderer>> {
    if let Some(ctx) = use_context::<GenUiRendererContext>() {
        return Some(ctx.0);
    }
    global_genui_slot().read().unwrap_or_else(|p| p.into_inner()).clone()
}
