#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use nsh_core::canvas::Drawing;
use nsh_core::element::{Registry, Root};
use nsh_core::platform::Appearance;
use nsh_core::prelude::*;
use nsh_core::{ApproxTextEngine, AttributedText, Command, Core, EventKind, EventPayload, ImageSource, MountBatch, MountItem, NodeId, ViewKind};

/// Captures mounted shadow-tree state across `Core::commit` frames with a real Tokio runtime
/// and event-driven task wakeup (no polling sleeps).
pub struct TestHarness {
    _runtime: tokio::runtime::Runtime,
    wake_state: Arc<(Mutex<u64>, Condvar)>,
    pub core: Core<ApproxTextEngine>,
    pub kinds: HashMap<NodeId, ViewKind>,
    pub test_ids: HashMap<NodeId, String>,
    pub labels: HashMap<NodeId, String>,
    pub texts: HashMap<NodeId, Arc<AttributedText>>,
    pub images: HashMap<NodeId, ImageSource>,
    pub canvases: HashMap<NodeId, Arc<Drawing>>,
    pub frames: HashMap<NodeId, Bounds<Points>>,
    pub clipboard_writes: Vec<String>,
}

impl TestHarness {
    pub fn mount(root: Root) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("test tokio runtime");
        let wake_state = Arc::new((Mutex::new(0u64), Condvar::new()));
        let notify_state = Arc::clone(&wake_state);

        let mut core = Core::new(ApproxTextEngine, Size::new(px(900.0), px(700.0)));
        core.set_task_runtime(runtime.handle().clone());
        core.set_task_notify(Arc::new(move || {
            let (lock, cvar) = &*notify_state;
            let mut seq = lock.lock().unwrap_or_else(|p| p.into_inner());
            *seq += 1;
            cvar.notify_all();
        }));
        let merged = Registry::merged(&[nsh_base::registry(), vibevalley_rich::registry()]);
        core.set_components(merged);
        {
            let _enter = runtime.enter();
            core.mount_root(&root);
        }

        let mut harness = Self {
            _runtime: runtime,
            wake_state,
            core,
            kinds: HashMap::new(),
            test_ids: HashMap::new(),
            labels: HashMap::new(),
            texts: HashMap::new(),
            images: HashMap::new(),
            canvases: HashMap::new(),
            frames: HashMap::new(),
            clipboard_writes: Vec::new(),
        };
        harness.commit();
        harness
    }

    pub fn commit(&mut self) {
        let _enter = self._runtime.enter();
        if let Some(batch) = self.core.commit() {
            self.record_batch(&batch);
        }
    }

    pub fn run_tasks(&mut self) {
        let _enter = self._runtime.enter();
        self.core.run_component_tasks();
        if let Some(batch) = self.core.commit() {
            self.record_batch(&batch);
        }
    }

    /// Drives component tasks woken by background workers until `pred` returns `true` or timeout.
    pub fn wait_until(&mut self, timeout: Duration, mut pred: impl FnMut(&Self) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let seen = *self.wake_state.0.lock().unwrap_or_else(|p| p.into_inner());
            self.run_tasks();
            if pred(self) {
                return true;
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            let (lock, cvar) = &*self.wake_state;
            let guard = lock.lock().unwrap_or_else(|p| p.into_inner());
            if *guard != seen {
                continue;
            }
            let remaining = deadline.saturating_duration_since(now);
            let _ = cvar.wait_timeout(guard, remaining);
        }
    }

    pub fn set_dark(&mut self, dark: bool) {
        self.core.set_appearance(if dark { Appearance::Dark } else { Appearance::Light });
        self.commit();
    }

    pub fn press(&mut self, id: NodeId) -> bool {
        let _enter = self._runtime.enter();
        let handled = self.core.component_event(id, EventKind::Press, &EventPayload::None);
        if let Some(batch) = self.core.commit() {
            self.record_batch(&batch);
        }
        handled
    }

    /// Finds a mounted view OR an inline pressable text span by `testID`.
    pub fn find_test_id(&self, target: &str) -> Option<NodeId> {
        self.find_all_test_ids(target).into_iter().next()
    }

    /// Finds all mounted views and inline pressable text spans with `testID == target`.
    pub fn find_all_test_ids(&self, target: &str) -> Vec<NodeId> {
        let mut ids: Vec<NodeId> = self.test_ids.iter().filter_map(|(&id, name)| (name == target).then_some(id)).collect();
        for attr_text in self.texts.values() {
            for span_tid in &attr_text.test_ids {
                if span_tid.test_id.as_ref() == target
                    && let Some(link) = attr_text.links.iter().find(|l| l.start == span_tid.start && l.end == span_tid.end)
                {
                    ids.push(link.node);
                }
            }
        }
        ids.sort_unstable();
        ids.dedup();
        ids
    }

    pub fn find_label(&self, target: &str) -> Option<NodeId> {
        self.labels.iter().find_map(|(&id, label)| (label == target).then_some(id))
    }

    pub fn find_inline_link_with_text(&self, needle: &str) -> Option<NodeId> {
        for attr_text in self.texts.values() {
            for link in &attr_text.links {
                let start = link.start as usize;
                let end = link.end as usize;
                if attr_text.text.get(start..end) == Some(needle) {
                    return Some(link.node);
                }
            }
        }
        None
    }

    pub fn has_view_kind(&self, target: ViewKind) -> bool {
        self.kinds.values().any(|&k| k == target)
    }

    pub fn all_text_strings(&self) -> Vec<String> {
        self.texts.values().map(|t| t.text.clone()).collect()
    }

    pub fn contains_text(&self, needle: &str) -> bool {
        self.texts.values().any(|t| t.text.contains(needle))
    }

    fn record_batch(&mut self, batch: &MountBatch) {
        for item in &batch.items {
            match item {
                MountItem::Create { id, kind } => {
                    self.kinds.insert(*id, *kind);
                }
                MountItem::Delete { id } => {
                    self.kinds.remove(id);
                    self.test_ids.remove(id);
                    self.labels.remove(id);
                    self.texts.remove(id);
                    self.images.remove(id);
                    self.canvases.remove(id);
                    self.frames.remove(id);
                }
                MountItem::Frame { id, frame } => {
                    self.frames.insert(*id, *frame);
                }
                MountItem::ViewProps { id, props } => {
                    if let Some(tid) = &props.test_id {
                        self.test_ids.insert(*id, tid.to_string());
                    } else {
                        self.test_ids.remove(id);
                    }
                    if let Some(label) = &props.accessibility.label {
                        self.labels.insert(*id, label.to_string());
                    }
                }
                MountItem::AccessibilityLabel { id, label } => {
                    if let Some(l) = label {
                        self.labels.insert(*id, l.to_string());
                    } else {
                        self.labels.remove(id);
                    }
                }
                MountItem::Text { id, text, .. } => {
                    self.texts.insert(*id, Arc::clone(text));
                }
                MountItem::Image { id, source, .. } => {
                    if let Some(src) = source {
                        self.images.insert(*id, src.clone());
                    } else {
                        self.images.remove(id);
                    }
                }
                MountItem::Canvas { id, drawing } => {
                    self.canvases.insert(*id, Arc::clone(drawing));
                }
                MountItem::Command {
                    command: Command::SetClipboard(s),
                    ..
                } => {
                    self.clipboard_writes.push(s.clone());
                }
                _ => {}
            }
        }
    }
}

/// Asserts that an `ImageSource` came from `ImageSrc::svg_markup(...).size(...)` and carries
/// decoded resvg-safe `<svg>` markup bytes under `nsh_core`'s inline data key.
pub fn assert_inline_svg_image(src: &ImageSource) -> String {
    assert!(
        src.uri.starts_with("data:image/svg+xml;nsh-key=") || src.uri.starts_with("data:image/svg+xml,"),
        "expected inline SVG image URI, got {:?}",
        src.uri
    );
    assert!(src.size.is_some(), "ImageSrc::size must be set for intrinsic layout");
    let data = src.data.as_ref().expect("nsh_core decodes data:image/svg+xml into ImageData");
    let svg = std::str::from_utf8(data.bytes()).expect("SVG bytes must be valid UTF-8");
    assert!(svg.trim_start().starts_with("<svg"), "expected `<svg` markup, got {svg:?}");
    svg.to_owned()
}
