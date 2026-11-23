//! The workbench's view of an html version (`shell.ts`): the page with the
//! selection script and the runtime for how it is shown, in the workbench's
//! theme. The words after the page and shared inline helpers are VibeValley's
//! own, generated into `assets/shell.json` by `gen/artifact.ts`.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use vibevalley_protocol::ArtifactDisplay;

#[cfg(feature = "collab")]
use crate::collab::PresencePayload;

static BUNDLE: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| serde_json::from_str(include_str!("../../assets/artifact/shell.json")).expect("the bundled shell"));

static HEAD_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<head\b[^>]*>").expect("regex"));
static DOCTYPE_TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^<!doctype\b[^>]*>").expect("regex"));

/// `shellThemeOf`: dark when asked for, else light.
pub fn shell_theme_of(asked: Option<&str>) -> &'static str {
    if asked == Some("dark") { "dark" } else { "light" }
}

pub(crate) fn theme_variables(theme: &str) -> &'static str {
    let key = if shell_theme_of(Some(theme)) == "dark" { "theme_dark" } else { "theme_light" };
    BUNDLE.get(key).map_or("", String::as_str)
}

pub(crate) fn type_variables() -> &'static str {
    BUNDLE.get("type_variables").map_or("", String::as_str)
}

pub(crate) fn selection_script() -> &'static str {
    BUNDLE.get("selection_script").map_or("", String::as_str)
}

pub fn motion_recorder_helper() -> &'static str {
    BUNDLE.get("motion_recorder_helper").map_or("", String::as_str)
}

fn inject_motion_preload(page: &str) -> String {
    let preload = BUNDLE.get("motion_preload").map_or("", String::as_str);
    if let Some(m) = HEAD_TAG.find(page) {
        return format!("{}{preload}{}", &page[..m.end()], &page[m.end()..]);
    }
    if let Some(m) = DOCTYPE_TAG.find(page) {
        return format!("{}{preload}{}", &page[..m.end()], &page[m.end()..]);
    }
    format!("{preload}{page}")
}

/// One live collaborator highlight rendered inside a sandboxed HTML/slides/design
/// preview without weakening CSP (`default-src 'none'; connect-src 'none'`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceHighlight {
    pub id: String,
    pub name: String,
    pub color: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<f64>,
}

/// Outbound command posted into a sandboxed artifact iframe/WebView to render
/// breathing highlight boxes and author badges for active presence entries.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceHighlightCommand {
    pub vibevalley: &'static str,
    pub items: Vec<PresenceHighlight>,
}

#[cfg(feature = "collab")]
pub fn presence_highlight_from_payloads<'a>(payloads: impl IntoIterator<Item = &'a PresencePayload>) -> PresenceHighlightCommand {
    let items = payloads
        .into_iter()
        .filter(|p| p.selector.is_some() || (p.x.is_some() && p.y.is_some()))
        .map(|p| PresenceHighlight {
            id: p.id.clone(),
            name: p.name.clone(),
            color: p.color.clone(),
            selector: p.selector.clone(),
            status: p.status.clone(),
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
        })
        .collect();
    PresenceHighlightCommand {
        vibevalley: "presence-highlight",
        items,
    }
}

/// Inline strict-CSP-safe sandbox listener that renders breathing highlight boxes
/// and author badges when the host posts `{ vibevalley: "presence-highlight", items }`.
pub fn presence_highlight_script() -> &'static str {
    r##"<style>@keyframes vv-presence-pulse{0%,100%{opacity:.95;box-shadow:0 0 0 2px var(--vv-hl)}50%{opacity:.6;box-shadow:0 0 0 5px color-mix(in srgb,var(--vv-hl) 35%,transparent)}}.vv-presence-layer{position:fixed;inset:0;pointer-events:none;z-index:2147483640}.vv-presence-box{position:fixed;border:2px solid var(--vv-hl);border-radius:6px;animation:vv-presence-pulse 1.8s ease-in-out infinite;box-sizing:border-box}.vv-presence-badge{position:absolute;top:-22px;left:-2px;padding:1px 6px;border-radius:4px;background:var(--vv-hl);color:#fff;font:600 11px/16px system-ui,sans-serif;white-space:nowrap}</style><script>(()=>{let layer=null;const ensure=()=>{if(layer&&layer.isConnected)return layer;layer=document.createElement("div");layer.className="vv-presence-layer";(document.body||document.documentElement).appendChild(layer);return layer};const render=(items)=>{const root=ensure();while(root.firstChild)root.removeChild(root.firstChild);if(!Array.isArray(items))return;for(const it of items){if(!it||typeof it!=="object")continue;let rect=null;if(typeof it.selector==="string"&&it.selector){try{const el=document.querySelector(it.selector);if(el)rect=el.getBoundingClientRect()}catch{}}if(!rect&&typeof it.x==="number"&&typeof it.y==="number"){rect={left:it.x,top:it.y,width:typeof it.w==="number"?it.w:16,height:typeof it.h==="number"?it.h:16}}if(!rect||rect.width<=0||rect.height<=0)continue;const box=document.createElement("div");box.className="vv-presence-box";box.style.setProperty("--vv-hl",typeof it.color==="string"&&it.color?it.color:"#3b82f6");box.style.left=rect.left+"px";box.style.top=rect.top+"px";box.style.width=rect.width+"px";box.style.height=rect.height+"px";const badge=document.createElement("div");badge.className="vv-presence-badge";badge.textContent=it.status?String(it.name||"")+" · "+String(it.status):String(it.name||"");box.appendChild(badge);root.appendChild(box)}};addEventListener("message",(e)=>{const d=e.data;if(d&&typeof d==="object"&&d.vibevalley==="presence-highlight")render(d.items)})})();</script>"##
}

/// `withShell`.
pub fn with_shell(page: &str, display: ArtifactDisplay, theme: &str) -> String {
    let base = if display == ArtifactDisplay::Motion {
        inject_motion_preload(page)
    } else {
        page.to_string()
    };
    let key = format!("{}|{}", display.as_str(), shell_theme_of(Some(theme)));
    format!("{base}{}{}", BUNDLE.get(&key).map_or("", String::as_str), presence_highlight_script())
}
