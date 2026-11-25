//! Native `VvMarkdown` component wrapping `nsh_base::text_view()`.
//!
//! Strictly avoids `MarkdownPlugin` and `MarkdownExtension::container` so `nsh-base`'s
//! incremental streaming parser (`incremental.rs`) remains active for every streamed token.
//! Handles inline `#12` issue references and `@mention` via `MarkdownExtension::pattern`, and
//! fenced `mermaid`, `canvas`, `chart`, and `genui` blocks via `MarkdownExtension::language`.

use std::sync::{Arc, Mutex};

use nsh_core::element::{AnyValue, Children, Component, NoEvent, PropError, PropSpec, Props, Root, Slot, TsTypes};
use nsh_core::prelude::*;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::genui::{VvGenUiActionEvent, vv_gen_ui};
use crate::markdown_base::{BaseMarkdownEvent, VvCodeCopyEvent, VvDiagramPressEvent, render_markdown_view};
pub use crate::markdown_base::{
    CustomNodeKind, PATTERN_ISSUE, PATTERN_MENTION, ResolvedMarkdownImage, VvIssuePressEvent, VvLinkPressEvent, VvMarkdownProps, VvMarkdownSize,
    VvMentionPressEvent, VvTaskPressEvent, is_incremental_streaming_safe, parse_vv_markdown, read_local_image_dimensions, resolve_markdown_image_src,
    vv_markdown_extensions, vv_markdown_options,
};
use crate::theme::AdaptiveUi;

/// Typed events emitted by [`VvMarkdown`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum VvMarkdownEvent {
    /// Fired when a standard Markdown link is pressed.
    #[args(event)]
    LinkPress(VvLinkPressEvent),
    /// Fired when an inline `#12` issue reference is pressed.
    #[args(event)]
    IssuePress(VvIssuePressEvent),
    /// Fired when an inline `@mention` is pressed.
    #[args(event)]
    MentionPress(VvMentionPressEvent),
    /// Fired when a GFM task list checkbox is toggled.
    #[args(event)]
    TaskPress(VvTaskPressEvent),
    /// Fired when a fenced code block inside the Markdown is copied.
    #[args(event)]
    CodeCopy(VvCodeCopyEvent),
    /// Fired when an embedded ` ```genui ` block emits an action.
    #[args(event)]
    GenUiAction(VvGenUiActionEvent),
    /// Fired when an embedded ` ```mermaid ` diagram preview is pressed.
    #[args(event)]
    DiagramPress(VvDiagramPressEvent),
}

/// VibeValley's native Markdown renderer wrapping `nsh_base::text_view()`.
///
/// Supports GitHub Flavored Markdown, `ratex` math, GitHub alerts, incremental streaming,
/// `#12` issue references, `@mentions`, pure-Rust Shiki code blocks, Mermaid diagrams,
/// JSON Canvas, native SVG Charts, and reactive GenUI surfaces with zero JS string-splicing.
#[component]
pub fn VvMarkdown(props: VvMarkdownProps, cx: Scope<VvMarkdownEvent>) -> impl IntoElement {
    render_markdown_view(
        props,
        true,
        move |event| match event {
            BaseMarkdownEvent::LinkPress(ev) => cx.emit(VvMarkdownEvent::LinkPress(ev)),
            BaseMarkdownEvent::IssuePress(ev) => cx.emit(VvMarkdownEvent::IssuePress(ev)),
            BaseMarkdownEvent::MentionPress(ev) => cx.emit(VvMarkdownEvent::MentionPress(ev)),
            BaseMarkdownEvent::TaskPress(ev) => cx.emit(VvMarkdownEvent::TaskPress(ev)),
            BaseMarkdownEvent::CodeCopy(ev) => cx.emit(VvMarkdownEvent::CodeCopy(ev)),
            BaseMarkdownEvent::DiagramPress(ev) => cx.emit(VvMarkdownEvent::DiagramPress(ev)),
        },
        move |spec, streaming| {
            vv_gen_ui()
                .spec(spec.to_owned())
                .streaming(streaming)
                .on_action(move |ev: &VvGenUiActionEvent| {
                    cx.emit(VvMarkdownEvent::GenUiAction(ev.clone()));
                })
                .into_element()
        },
    )
}

/// Document payload pushed into a pure-Rust [`NativeMarkdownRoot`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NativeMarkdownDoc {
    pub text: String,
    pub base_dir: Option<String>,
}

/// User interactions emitted by a pure-Rust [`NativeMarkdownRoot`] back to its GPUI host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeMarkdownEvent {
    LinkPress(String),
    IssuePress(u32),
    GenUiAction { action: String, payload: String },
    CodeCopy(String),
}

/// Pure-Rust `nsh_core` root surface hosting [`VvMarkdown`] without spawning a QuickJS VM.
pub struct NativeMarkdownRoot {
    pub root: Root,
    pub doc_tx: UnboundedSender<NativeMarkdownDoc>,
    pub event_rx: UnboundedReceiver<NativeMarkdownEvent>,
}

struct NativeMarkdownBridge {
    initial: NativeMarkdownDoc,
    doc_rx: Mutex<Option<UnboundedReceiver<NativeMarkdownDoc>>>,
    event_tx: UnboundedSender<NativeMarkdownEvent>,
}

struct BridgeHandle(Arc<NativeMarkdownBridge>);

impl Clone for BridgeHandle {
    fn clone(&self) -> Self {
        Self(Arc::clone(&self.0))
    }
}

impl PartialEq for BridgeHandle {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

#[derive(Clone, PartialEq)]
struct NativeMarkdownSurfaceProps {
    bridge: Option<BridgeHandle>,
}

impl Props for NativeMarkdownSurfaceProps {
    fn spec(_: &mut TsTypes) -> Vec<PropSpec> {
        Vec::new()
    }

    fn initial() -> Self {
        Self { bridge: None }
    }

    fn set(&mut self, name: &str, _: Option<AnyValue>) -> Result<bool, PropError> {
        Err(PropError(format!("unknown prop `{name}`")))
    }

    fn set_slot(&mut self, _: &str, _: Option<Slot>) -> bool {
        false
    }

    fn set_children(&mut self, _: Children) -> bool {
        false
    }
}

struct NativeMarkdownSurface;

impl Component for NativeMarkdownSurface {
    type Props = NativeMarkdownSurfaceProps;
    type Event = NoEvent;

    fn view(props: Self::Props, _cx: Scope<Self::Event>) -> impl IntoElement {
        let bridge = props.bridge.as_ref().map(|handle| Arc::clone(&handle.0));
        let initial = bridge.as_ref().map(|b| b.initial.clone()).unwrap_or_default();
        let text_sig = signal(SharedString::from(initial.text));
        let base_dir_sig = signal(initial.base_dir.map(SharedString::from));

        if let Some(ref bridge) = bridge
            && let Some(mut rx) = bridge.doc_rx.lock().ok().and_then(|mut guard| guard.take())
        {
            spawn(async move {
                while let Some(doc) = rx.recv().await {
                    if text_sig.with_untracked(|cur| cur.as_str() != doc.text) {
                        text_sig.set(SharedString::from(doc.text));
                    }
                    if base_dir_sig.with_untracked(|cur| cur.as_deref() != doc.base_dir.as_deref()) {
                        base_dir_sig.set(doc.base_dir.map(SharedString::from));
                    }
                }
            });
        }

        let link_tx = bridge.as_ref().map(|b| b.event_tx.clone());
        let issue_tx = bridge.as_ref().map(|b| b.event_tx.clone());
        let genui_tx = bridge.as_ref().map(|b| b.event_tx.clone());
        let copy_tx = bridge.as_ref().map(|b| b.event_tx.clone());

        scroll().flex_1().min_h(px(0.0)).bg(AdaptiveUi::PAGE).child(
            view().w_full().items_center().child(
                view().w_full().max_w(px(820.0)).px(px(40.0)).py(px(32.0)).child(
                    vv_markdown()
                        .text(move || text_sig.get())
                        .size(VvMarkdownSize::Doc)
                        .base_dir(move || base_dir_sig.get())
                        .selectable(true)
                        .on_link_press(move |ev: &VvLinkPressEvent| {
                            if let Some(ref tx) = link_tx {
                                let _ = tx.send(NativeMarkdownEvent::LinkPress(ev.url.to_string()));
                            }
                        })
                        .on_issue_press(move |ev: &VvIssuePressEvent| {
                            if let Some(ref tx) = issue_tx {
                                let _ = tx.send(NativeMarkdownEvent::IssuePress(ev.number));
                            }
                        })
                        .on_gen_ui_action(move |ev: &VvGenUiActionEvent| {
                            if let Some(ref tx) = genui_tx {
                                let _ = tx.send(NativeMarkdownEvent::GenUiAction {
                                    action: ev.action.to_string(),
                                    payload: ev.payload.to_string(),
                                });
                            }
                        })
                        .on_code_copy(move |ev: &VvCodeCopyEvent| {
                            if let Some(ref tx) = copy_tx {
                                let _ = tx.send(NativeMarkdownEvent::CodeCopy(ev.code.to_string()));
                            }
                        }),
                ),
            ),
        )
    }
}

/// Builds a pure-Rust [`Root`] rendering a scrollable, centered editorial [`VvMarkdown`]
/// document so GPUI panes can preview Markdown files with zero QuickJS VMs.
pub fn native_markdown_root(initial: NativeMarkdownDoc, capabilities_json: Option<&str>) -> NativeMarkdownRoot {
    let (doc_tx, doc_rx) = unbounded_channel();
    let (event_tx, event_rx) = unbounded_channel();
    let bridge = Arc::new(NativeMarkdownBridge {
        initial,
        doc_rx: Mutex::new(Some(doc_rx)),
        event_tx,
    });
    let mut root = Root::new::<NativeMarkdownSurface>(move || NativeMarkdownSurfaceProps {
        bridge: Some(BridgeHandle(Arc::clone(&bridge))),
    })
    .app_id("dev.vibevalley.markdown");
    if let Some(caps) = capabilities_json {
        root = root.capabilities_json(caps);
    }
    NativeMarkdownRoot { root, doc_tx, event_rx }
}
