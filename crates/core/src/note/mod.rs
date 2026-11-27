//! Unified directory-backed note domain helpers (`<storage>/note/<id>/`):
//! canonical 4-type layouts, safe relative paths, manifest validation,
//! wikilink extraction, starter directories, lightweight content previews,
//! and strict-CSP presence highlight helpers.

pub mod base;
pub mod doc;
pub mod links;
pub mod manifest;
pub mod path;
pub mod preview;
pub mod starter;

pub use links::{dedup_links, extract_markdown_links};
pub use manifest::{
    MANIFEST_SCHEMA_VERSION, NoteManifest, NoteTypeSpec, TITLE_MAX_LEN, all_type_specs, default_manifest, format_directory_summary, parse_manifest,
    serialize_manifest, title_problem, type_spec, validate_manifest,
};
pub use path::{
    ASSET_DIR, ASSET_FILE_MAX_BYTES, FILE_MAX_COUNT, MANIFEST_FILE, NotePathZone, PATH_MAX_LEN, STRUCTURE_DIR, STRUCTURE_FILE_MAX_BYTES,
    apply_json_merge_patch, canonical_json, infer_encoding, infer_mime, is_text_mime, validate_deletable_path, validate_note_path, validate_prefix,
};
pub use preview::{extract_note_preview, preview_frame_asset, set_preview_frame_path};
pub use starter::{StarterDirectory, StarterFile, starter_directory, starter_files_for_type};

use serde::{Deserialize, Serialize};

#[cfg(feature = "collab")]
use crate::collab::PresencePayload;

/// Highlight payload rendered inside a sandboxed note preview frame.
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

/// Outbound command posted into a sandboxed note preview to render
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
