use std::path::{Path, PathBuf};
use std::time::Duration;

use gpui::{AppContext as _, ClipboardItem, Context, FocusHandle, Window};
use nsh_platform_gpui::Bundle;

use crate::host::EditorOption;

pub(super) const HTML_PREVIEW_CAPABILITIES: &str = r#"{"webview":{"hosts":[]}}"#;
const HTML_PREVIEW_JS: &str = r#"import { host, mount, signal, WebView } from "nsh";
import { component } from "nsh:rt";

const html = signal(typeof host.params.html === "string" ? host.params.html : "");
const covered = signal(Boolean(host.params.covered));
host.on("html", (next) => {
  if (typeof next === "string") html.set(next);
});
host.on("covered", (next) => {
  covered.set(Boolean(next));
});

mount(() =>
  component(WebView, {
    get html() {
      return html();
    },
    incognito: true,
    get style() {
      return covered()
        ? { flexGrow: 1, flexShrink: 1, flexBasis: 0, width: "100%", height: "100%", opacity: 0 }
        : { flexGrow: 1, flexShrink: 1, flexBasis: 0, width: "100%", height: "100%" };
    },
  }),
);
"#;

pub(crate) struct EditorToolbarState {
    pub(crate) copied: bool,
    copy_gen: u64,
    pub(crate) editor_menu_open: bool,
    pub(crate) editor_options: Vec<EditorOption>,
}

impl EditorToolbarState {
    pub(crate) fn new() -> Self {
        Self {
            copied: false,
            copy_gen: 0,
            editor_menu_open: false,
            editor_options: crate::host::cached_editor_options(),
        }
    }

    pub(crate) fn refresh_editors<V: 'static>(cx: &mut Context<V>, field: fn(&mut V) -> &mut Self) {
        let task = cx.background_spawn(async { crate::host::detect_editors_blocking() });
        cx.spawn(async move |this, cx| {
            let options = task.await;
            let _ = this.update(cx, |v, cx| {
                let state = field(v);
                if state.editor_options != options {
                    state.editor_options = options;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(crate) fn copy_path<V: 'static>(&mut self, path: &Path, cx: &mut Context<V>, field: fn(&mut V) -> &mut Self) {
        cx.write_to_clipboard(ClipboardItem::new_string(path.to_string_lossy().into_owned()));
        self.copied = true;
        self.copy_gen = self.copy_gen.wrapping_add(1);
        let generation = self.copy_gen;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            let _ = this.update(cx, |v, cx| {
                let state = field(v);
                if state.copy_gen == generation && state.copied {
                    state.copied = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }

    pub(crate) fn toggle_editor_menu<V: 'static>(
        &mut self,
        was_open: bool,
        focus: &FocusHandle,
        window: &mut Window,
        cx: &mut Context<V>,
        field: fn(&mut V) -> &mut Self,
    ) {
        // Use render-time `was_open`: `on_mouse_down_out` already cleared
        // `editor_menu_open` during capture when clicking the trigger to close.
        self.editor_menu_open = !was_open;
        if self.editor_menu_open {
            window.focus(focus, cx);
            Self::refresh_editors(cx, field);
        }
        cx.notify();
    }
}

pub(crate) fn is_html_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm"))
}

pub(crate) fn build_html_preview_document(raw_html: &str) -> String {
    crate::host_types::with_policy(raw_html)
}

pub(super) fn build_html_preview_bundle() -> Result<Bundle, String> {
    Bundle::source(HTML_PREVIEW_JS.to_owned())
        .with_app_id(Some("dev.vibevalley.html-preview"))
        .with_capabilities_json(Some(HTML_PREVIEW_CAPABILITIES))
}

pub(super) fn html_mode_labels() -> (String, String) {
    (
        vibevalley_i18n::t("web.note.page.previewTab", &[]),
        vibevalley_i18n::t("web.base.rich.viewSource", &[]),
    )
}

pub(super) fn format_bytes(bytes: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{bytes} B")
    }
}

pub(crate) fn split_display_path(path: &Path) -> (String, Option<String>) {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let parent = path.parent().filter(|p| !p.as_os_str().is_empty()).map(|p| match &home {
        Some(h) if p == h => "~".to_string(),
        Some(h) => match p.strip_prefix(h) {
            Ok(rel) => format!("~/{}", rel.display()),
            Err(_) => p.to_string_lossy().into_owned(),
        },
        None => p.to_string_lossy().into_owned(),
    });
    (name, parent)
}
