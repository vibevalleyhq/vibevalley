//! Sandboxed HTML viewer renderers, CSP headers, SVG sanitization, and `.dc.html`
//! property rewriting for structured store artifacts (`viewers.ts`).

use std::collections::{BTreeMap, HashMap};
use std::sync::LazyLock;

use lol_html::{RewriteStrSettings, comments, element, rewrite_str};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::artifact::html::{HTML_SANDBOX, HtmlCheck, HtmlRefusal, font_sources, html_check, html_problem, script_sources, style_sources};
use crate::artifact::shell::{motion_recorder_helper, selection_script, shell_theme_of, theme_variables, type_variables};
use crate::artifact::store::{ArtifactEntry, ArtifactEntryKind, ArtifactType};
use crate::artifact::tokens::compile_tokens_css;

pub fn store_view_headers(origin: Option<&str>, print: bool) -> BTreeMap<&'static str, String> {
    let attach = origin.map_or_else(String::new, |o| format!(" {o}/api/v1/attachment/"));
    let limits = [
        "default-src 'none'".to_string(),
        ["script-src 'unsafe-inline'"].into_iter().chain(script_sources()).collect::<Vec<_>>().join(" "),
        ["style-src 'unsafe-inline'"].into_iter().chain(style_sources()).collect::<Vec<_>>().join(" "),
        format!("img-src data: blob:{attach}"),
        [format!("font-src data:{attach}")]
            .into_iter()
            .chain(font_sources().into_iter().map(str::to_string))
            .collect::<Vec<_>>()
            .join(" "),
        format!("media-src data: blob:{attach}"),
        "connect-src 'none'".to_string(),
        "form-action 'none'".to_string(),
        "base-uri 'none'".to_string(),
    ]
    .join("; ");
    let sandbox = if print {
        format!("sandbox {HTML_SANDBOX} allow-modals")
    } else {
        format!("sandbox {HTML_SANDBOX}")
    };
    let mut headers = BTreeMap::new();
    headers.insert("cache-control", "private, no-store".to_string());
    headers.insert("x-content-type-options", "nosniff".to_string());
    headers.insert("referrer-policy", "no-referrer".to_string());
    headers.insert("content-type", "text/html; charset=utf-8".to_string());
    headers.insert("content-security-policy", format!("{sandbox}; {limits}"));
    headers
}

/// Validates HTML fragments/pages in store entries: allows relative `assets/*`
/// and `/api/v1/attachment/*` while blocking unapproved origins.
pub fn store_html_problem(source: &str) -> String {
    let check = html_check(source);
    let filtered: Vec<HtmlRefusal> = check
        .refused
        .into_iter()
        .filter(|r| match r {
            HtmlRefusal::Load { url, .. } => {
                let u = url.trim();
                !(u.starts_with("assets/") || u.starts_with("./assets/") || u.starts_with("../assets/") || u.starts_with("/api/v1/attachment/"))
            }
            _ => true,
        })
        .collect();
    html_problem(&HtmlCheck {
        refused: filtered,
        warned: check.warned,
    })
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct StoreViewQuery {
    pub theme: Option<String>,
    pub seq: Option<i64>,
    pub path: Option<String>,
    pub at: Option<i64>,
    pub still: bool,
    pub print: bool,
    pub element_id: Option<String>,
}

pub fn store_view_url(id: &str, query: &StoreViewQuery) -> String {
    let base = format!("/api/v1/artifact/{id}/view");
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    if let Some(theme) = &query.theme {
        serializer.append_pair("theme", theme);
    }
    if let Some(seq) = query.seq {
        serializer.append_pair("seq", &seq.to_string());
    }
    if let Some(path) = &query.path {
        serializer.append_pair("path", path);
    }
    if let Some(at) = query.at {
        serializer.append_pair("at", &at.to_string());
    }
    if query.still {
        serializer.append_pair("still", "1");
    }
    if query.print {
        serializer.append_pair("print", "1");
    }
    if let Some(element_id) = &query.element_id {
        serializer.append_pair("elementId", element_id);
    }
    let qs = serializer.finish();
    if qs.is_empty() { base } else { format!("{base}?{qs}") }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderStoreOptions {
    pub theme: String,
    pub path: Option<String>,
    pub element_id: Option<String>,
    pub default_tokens_json: Option<String>,
}

impl RenderStoreOptions {
    pub fn new(theme: impl Into<String>) -> Self {
        Self {
            theme: shell_theme_of(Some(&theme.into())).to_string(),
            path: None,
            element_id: None,
            default_tokens_json: None,
        }
    }
}

fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn escape_script_json(json: &str) -> String {
    json.replace("</script", r"<\/script").replace("<!--", r"<\!--")
}

fn percent_encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        let keep = matches!(
            *b,
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
        );
        if keep {
            out.push(*b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

static RE_ASSET_URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:\.\./|\./)?assets/([a-zA-Z0-9._/-]+)").expect("regex"));

fn rewrite_asset_urls(text: &str, entries: &HashMap<&str, &ArtifactEntry>) -> String {
    RE_ASSET_URL
        .replace_all(text, |caps: &regex::Captures<'_>| {
            let rel = &caps[1];
            let k1 = format!("assets/{rel}");
            let k2 = format!("project/assets/{rel}");
            let entry = entries.get(k1.as_str()).or_else(|| entries.get(k2.as_str()));
            if let Some(att) = entry.and_then(|e| e.attachment_id.as_deref()) {
                format!("/api/v1/attachment/{}", percent_encode_component(att))
            } else {
                caps[0].to_string()
            }
        })
        .into_owned()
}

fn collect_design_system_css(entries: &[ArtifactEntry], fallback_tokens_json: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    if let Some(fallback) = fallback_tokens_json
        && !fallback.is_empty()
    {
        let css = compile_tokens_css(fallback);
        if !css.is_empty() {
            parts.push(css);
        }
    }
    for entry in entries {
        if (entry.path == "project/tokens.json" || (entry.path.starts_with("project/ds/") && entry.path.ends_with("/tokens.json")))
            && let Some(val) = entry.value.as_deref()
            && !val.is_empty()
        {
            let css = compile_tokens_css(val);
            if !css.is_empty() {
                parts.push(css);
            }
        }
    }
    parts.join("\n")
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeckManifest {
    aspect_ratio: Option<String>,
    slides: Option<Vec<DeckSlideItem>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeckSlideItem {
    id: String,
    file: Option<String>,
    title: Option<String>,
    notes: Option<String>,
    skip: Option<bool>,
    transition: Option<String>,
}

fn render_slides_store_html(entries_list: &[ArtifactEntry], entries: &HashMap<&str, &ArtifactEntry>, options: &RenderStoreOptions) -> String {
    let theme = shell_theme_of(Some(&options.theme));
    let manifest: DeckManifest = entries
        .get("project/deck.json")
        .and_then(|e| e.value.as_deref())
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    let width: i64 = if manifest.aspect_ratio.as_deref() == Some("4:3") { 1440 } else { 1920 };
    let height: i64 = 1080;
    let deck_css = rewrite_asset_urls(entries.get("project/deck.css").and_then(|e| e.value.as_deref()).unwrap_or(""), entries);
    let ds_css = collect_design_system_css(entries_list, options.default_tokens_json.as_deref());

    let slide_items: Vec<DeckSlideItem> = match manifest.slides {
        Some(slides) if !slides.is_empty() => slides.into_iter().filter(|s| s.skip != Some(true)).collect(),
        _ => {
            let mut paths: Vec<&str> = entries_list
                .iter()
                .map(|e| e.path.as_str())
                .filter(|p| p.starts_with("project/slides/") && p.ends_with(".html"))
                .collect();
            paths.sort_unstable();
            paths
                .into_iter()
                .map(|p| {
                    let rel = &p["project/slides/".len()..];
                    let id = &rel[..rel.len() - ".html".len()];
                    DeckSlideItem {
                        id: id.to_string(),
                        file: Some(rel.to_string()),
                        title: None,
                        notes: None,
                        skip: None,
                        transition: None,
                    }
                })
                .collect()
        }
    };

    let sections: String = slide_items
        .into_iter()
        .map(|item| {
            let rel_file = item.file.unwrap_or_else(|| format!("{}.html", item.id));
            let full_path = if rel_file.starts_with("project/") {
                rel_file
            } else {
                format!("project/slides/{rel_file}")
            };
            let fallback = format!(
                r#"<div class="slide"><h2>{}</h2></div>"#,
                escape_html(item.title.as_deref().unwrap_or(&item.id))
            );
            let raw_html = rewrite_asset_urls(entries.get(full_path.as_str()).and_then(|e| e.value.as_deref()).unwrap_or(&fallback), entries);
            let notes_aside = item
                .notes
                .as_deref()
                .filter(|n| !n.is_empty())
                .map_or_else(String::new, |n| format!(r#"<aside class="notes">{}</aside>"#, escape_html(n)));
            let title_meta = item
                .title
                .as_deref()
                .filter(|t| !t.is_empty())
                .map_or_else(String::new, |t| format!(r#" data-slide-title="{}""#, escape_html(t)));
            let transition_attr = item
                .transition
                .as_deref()
                .filter(|t| !t.is_empty())
                .map_or_else(String::new, |t| format!(r#" data-transition="{}""#, escape_html(t)));
            format!(
                r#"<section class="vv-deck-slide" data-slide-id="{}" data-entry-path="{}"{title_meta}{transition_attr}>{raw_html}{notes_aside}</section>"#,
                escape_html(&item.id),
                escape_html(&full_path)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");

    let runtime = format!(
        r#"(() => {{
    const say = (kind, body) => parent.postMessage(Object.assign({{ vibevalley: kind }}, body), "*");
    const all = Array.from(document.querySelectorAll("section.vv-deck-slide"));
    const asked = new URLSearchParams(location.search);
    const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 500) : "");
    const titles = all.map((s, idx) => s.getAttribute("data-slide-title") || text(s.querySelector("h1, h2, h3")) || ("Slide " + (idx + 1)));
    const notes = all.map((s) => text(s.querySelector("aside.notes, aside[data-notes]")));
    const fragsOf = (s) => Array.from(s.querySelectorAll(".fragment"));
    const fragments = all.map((s) => fragsOf(s).length);
    if (asked.get("print") === "1") {{
      document.documentElement.classList.add("vv-print");
      all.forEach((s) => fragsOf(s).forEach((f) => f.classList.add("visible")));
      addEventListener("load", () => setTimeout(() => print(), 300));
      say("ready", {{ display: "slides", pages: all.length, titles, notes, fragments }});
      return;
    }}
    const W = {width};
    const H = {height};
    const fit = () => {{
      const k = Math.min(innerWidth / W, innerHeight / H);
      for (const s of all) s.style.setProperty("--vv-scale", String(k));
    }};
    let at = -1;
    let frag = 0;
    const show = (n, nextFrag) => {{
      if (all.length === 0) return;
      const next = Math.max(0, Math.min(all.length - 1, n));
      const maxFrag = fragments[next] || 0;
      const targetFrag = typeof nextFrag === "number" ? Math.max(0, Math.min(maxFrag, nextFrag)) : next !== at ? 0 : frag;
      if (next === at && targetFrag === frag) return;
      at = next;
      frag = targetFrag;
      all.forEach((s, i) => {{
        s.classList.toggle("vv-on", i === at);
        if (i === at) fragsOf(s).forEach((el, idx) => el.classList.toggle("visible", idx < frag));
      }});
      say("at", {{ page: at, fragment: frag }});
    }};
    const advance = (dir) => {{
      const maxFrag = fragments[at] || 0;
      if (dir > 0 && frag < maxFrag) return show(at, frag + 1);
      if (dir < 0 && frag > 0) return show(at, frag - 1);
      const nextPage = at + dir;
      if (nextPage < 0 || nextPage >= all.length) return;
      show(nextPage, dir < 0 ? (fragments[nextPage] || 0) : 0);
    }};
    addEventListener("message", (e) => {{
      if (e.source !== parent || !e.data || typeof e.data !== "object") return;
      const d = e.data;
      if (d.vibevalley === "goto" && Number.isInteger(d.page)) show(d.page, Number.isInteger(d.fragment) ? d.fragment : 0);
      if (d.vibevalley === "step" && typeof d.delta === "number") advance(d.delta >= 0 ? 1 : -1);
    }});
    addEventListener("resize", fit);
    fit();
    const first = Number(asked.get("at"));
    show(Number.isInteger(first) ? first : 0, 0);
    if (asked.get("still") !== "1") {{
      addEventListener("keydown", (e) => {{
        if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
        const step = {{ ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }}[e.key];
        if (step) {{ e.preventDefault(); advance(step); }}
        else if (e.key === "Home") show(0, 0);
        else if (e.key === "End") show(all.length - 1, fragments[all.length - 1] || 0);
      }});
      addEventListener("click", (e) => {{
        if (e.target && e.target.closest && e.target.closest("a, button, input, textarea, select, summary, video, audio, [contenteditable]")) return;
        if (getSelection() && !getSelection().isCollapsed) return;
        advance(e.clientX < innerWidth / 4 ? -1 : 1);
      }});
    }}
    say("ready", {{ display: "slides", pages: all.length, titles, notes, fragments }});
  }})();"#
    );

    format!(
        r#"<!doctype html>
<html lang="zh" data-theme="{theme}">
<head>
<meta charset="utf-8" />
<style>
:root{{{tv}{ty}}}
{ds_css}
html,body{{margin:0;height:100%;overflow:hidden;background:var(--vv-side);color:var(--color-ink,var(--vv-ink));font-family:var(--font-sans,var(--vv-font-sans));-webkit-font-smoothing:antialiased}}
section.vv-deck-slide{{position:absolute;left:50%;top:50%;width:{width}px;height:{height}px;box-sizing:border-box;padding:96px 128px;display:none;flex-direction:column;justify-content:center;gap:32px;background:var(--color-surface,var(--vv-page));color:var(--color-ink,var(--vv-ink));transform:translate(-50%,-50%) scale(var(--vv-scale,1));transform-origin:center;overflow:hidden}}
section.vv-deck-slide.vv-on{{display:flex}}
section.vv-deck-slide > .slide{{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:28px}}
section.vv-deck-slide aside.notes,section.vv-deck-slide aside[data-notes]{{display:none}}
section.vv-deck-slide .fragment{{opacity:0;transform:translateY(14px);transition:opacity 180ms ease,transform 180ms ease}}
section.vv-deck-slide .fragment.visible{{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){{section.vv-deck-slide .fragment{{transition:none}}}}
section.vv-deck-slide :where(h1){{margin:0;font-size:84px;line-height:1.08;font-weight:700;letter-spacing:-0.02em}}
section.vv-deck-slide :where(h2){{margin:0;font-size:56px;line-height:1.14;font-weight:650}}
section.vv-deck-slide :where(h3){{margin:0;font-size:36px;line-height:1.25;font-weight:600;color:var(--color-muted,var(--vv-muted))}}
section.vv-deck-slide :where(p,li){{margin:0;font-size:34px;line-height:1.5}}
{deck_css}
@page{{size:{width}px {height}px;margin:0}}
@media print{{
  html,body{{height:auto;overflow:visible;background:none}}
  section.vv-deck-slide{{position:relative;left:auto;top:auto;transform:none;display:flex;break-after:page;page-break-after:always}}
  section.vv-deck-slide .fragment{{opacity:1;transform:none}}
}}
</style>
</head>
<body>
{sections}
<script>{sel}</script>
<script>{runtime}</script>
</body>
</html>"#,
        tv = theme_variables(theme),
        ty = type_variables(),
        sel = selection_script(),
    )
}

fn render_dashboard_store_html(entries_list: &[ArtifactEntry], entries: &HashMap<&str, &ArtifactEntry>, options: &RenderStoreOptions) -> String {
    let theme = shell_theme_of(Some(&options.theme));
    let ds_css = collect_design_system_css(entries_list, options.default_tokens_json.as_deref());
    let mut datasets_obj = serde_json::Map::new();
    for entry in entries_list {
        if let Some(rest) = entry.path.strip_prefix("datasets/")
            && let Some(val) = entry.value.as_deref()
            && !val.is_empty()
        {
            let id = rest.strip_suffix(".json").unwrap_or(rest).to_string();
            let parsed = serde_json::from_str::<Value>(val).unwrap_or_else(|_| Value::Array(vec![]));
            datasets_obj.insert(id, parsed);
        }
    }
    let initial_params = entries
        .get("dash/params")
        .and_then(|e| e.value.as_deref())
        .and_then(|v| serde_json::from_str::<Value>(v).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()));

    let index_html = rewrite_asset_urls(
        entries
            .get("files/index.html")
            .and_then(|e| e.value.as_deref())
            .unwrap_or(r#"<main style="padding:24px"><h2>Dashboard</h2><p>Create <code>datasets/*</code> and <code>files/index.html</code>.</p></main>"#),
        entries,
    );

    let datasets_json = escape_script_json(&serde_json::to_string(&Value::Object(datasets_obj)).unwrap_or_else(|_| "{}".to_string()));
    let params_json = escape_script_json(&serde_json::to_string(&initial_params).unwrap_or_else(|_| "{}".to_string()));

    let dash_runtime = format!(
        r##"(() => {{
    let store = {datasets_json};
    let currentParams = {params_json};
    const dataListeners = [];
    const paramListeners = [];
    const rowsOf = (id) => {{
      const raw = store[id];
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === "object" && Array.isArray(raw.rows)) return raw.rows;
      return [];
    }};
    const numsOf = (rows, field) => rows.map((r) => (r && typeof r === "object" ? Number(r[field]) : Number(r))).filter((n) => Number.isFinite(n));
    const calc = {{
      sum: (rows, field) => numsOf(rows, field).reduce((a, b) => a + b, 0),
      avg: (rows, field) => {{ const ns = numsOf(rows, field); return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0; }},
      min: (rows, field) => {{ const ns = numsOf(rows, field); return ns.length ? Math.min(...ns) : 0; }},
      max: (rows, field) => {{ const ns = numsOf(rows, field); return ns.length ? Math.max(...ns) : 0; }},
      count: (rows) => (Array.isArray(rows) ? rows.length : 0),
      median: (rows, field) => {{
        const ns = numsOf(rows, field).slice().sort((a, b) => a - b);
        if (!ns.length) return 0;
        const m = Math.floor(ns.length / 2);
        return ns.length % 2 ? ns[m] : (ns[m - 1] + ns[m]) / 2;
      }},
      pctChange: (curr, prev) => (prev === 0 ? 0 : ((curr - prev) / Math.abs(prev)) * 100),
      groupBy: (rows, keyField, valField, agg = "sum") => {{
        const buckets = new Map();
        for (const r of rows || []) {{
          if (!r || typeof r !== "object") continue;
          const k = String(r[keyField] ?? "");
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(r);
        }}
        return Array.from(buckets.entries()).map(([key, list]) => ({{
          key,
          value: agg === "count" ? list.length : agg === "avg" ? calc.avg(list, valField) : calc.sum(list, valField),
          rows: list,
        }}));
      }},
      formatNumber: (n, digits = 0) => Number(n || 0).toLocaleString(undefined, {{ maximumFractionDigits: digits }}),
      formatCurrency: (n, currency = "USD", digits = 0) => Number(n || 0).toLocaleString(undefined, {{ style: "currency", currency, maximumFractionDigits: digits }}),
      formatPct: (n, digits = 1) => Number(n || 0).toFixed(digits) + "%",
    }};
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const colors = {{
      accent: isDark ? "#7fae4f" : "#4d7a2a",
      leaf: isDark ? "#8dbb5c" : "#74a046",
      wheat: "#e5a93c",
      berry: isDark ? "#e47d6d" : "#a83a2c",
      water: isDark ? "#6aa6dc" : "#2f6fa8",
      ink: isDark ? "#ecebe8" : "#1c1917",
      muted: isDark ? "#a9a49e" : "#5e5852",
      grid: isDark ? "rgba(236,235,232,0.1)" : "rgba(28,25,23,0.08)",
      series: isDark
        ? ["#7fae4f", "#6aa6dc", "#e5a93c", "#e47d6d", "#8dbb5c", "#b592dc"]
        : ["#4d7a2a", "#2f6fa8", "#e5a93c", "#a83a2c", "#74a046", "#6d4c9c"],
    }};
    window.dash = {{
      data: (id) => structuredClone(store[id] !== undefined ? rowsOf(id) : []),
      raw: (id) => structuredClone(store[id]),
      datasets: () => Object.keys(store),
      calc,
      colors,
      get params() {{ return Object.assign({{}}, currentParams); }},
      setParams(patch) {{
        if (!patch || typeof patch !== "object") return;
        currentParams = Object.assign({{}}, currentParams, patch);
        parent.postMessage({{ vibevalley: "store-params", params: currentParams }}, "*");
        for (const fn of paramListeners) try {{ fn(window.dash.params); }} catch {{}}
        scheduleScan();
      }},
      resetParams(defaults = {{}}) {{
        currentParams = Object.assign({{}}, defaults);
        parent.postMessage({{ vibevalley: "store-params", params: currentParams }}, "*");
        for (const fn of paramListeners) try {{ fn(window.dash.params); }} catch {{}}
        scheduleScan();
      }},
      onData(fn) {{ if (typeof fn === "function") dataListeners.push(fn); }},
      onParams(fn) {{ if (typeof fn === "function") paramListeners.push(fn); }},
      scan: () => scheduleScan(),
    }};

    const parseDisplayedNumber = (s) => {{
      const cleaned = String(s || "").replace(/[,$\xA5\u20AC%\s]/g, "").trim();
      if (!cleaned) return NaN;
      const mult = /k$/i.test(cleaned) ? 1e3 : /m$/i.test(cleaned) ? 1e6 : /b$/i.test(cleaned) ? 1e9 : 1;
      const base = parseFloat(cleaned.replace(/[kmb]$/i, ""));
      return Number.isFinite(base) ? base * mult : NaN;
    }};

    const scanProvenance = () => {{
      const els = Array.from(document.querySelectorAll("[data-source]"));
      const marks = [];
      let verified = 0;
      let mismatches = 0;
      for (const el of els) {{
        const source = el.getAttribute("data-source") || "";
        const field = el.getAttribute("data-field") || "";
        const agg = el.getAttribute("data-agg") || (el.hasAttribute("data-row") ? "row" : field ? "sum" : "source");
        const displayed = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
        const rows = rowsOf(source);
        let matched = store[source] !== undefined;
        let expected = matched ? (rows.length + " rows") : "missing dataset";
        if (matched && field && agg !== "source") {{
          let val = NaN;
          if (agg === "row") {{
            const idx = Number(el.getAttribute("data-row") || 0);
            val = rows[idx] && typeof rows[idx] === "object" ? Number(rows[idx][field]) : NaN;
          }} else if (agg === "sum") val = calc.sum(rows, field);
          else if (agg === "avg") val = calc.avg(rows, field);
          else if (agg === "min") val = calc.min(rows, field);
          else if (agg === "max") val = calc.max(rows, field);
          else if (agg === "count") val = calc.count(rows);
          if (Number.isFinite(val)) {{
            expected = String(Math.round(val * 100) / 100);
            const shownNum = parseDisplayedNumber(displayed);
            if (Number.isFinite(shownNum)) {{
              const tol = Math.max(1, Math.abs(val) * 0.02);
              matched = Math.abs(shownNum - val) <= tol;
            }}
          }}
        }}
        el.setAttribute("data-vv-verified", matched ? "1" : "0");
        if (matched) verified++; else mismatches++;
        marks.push({{ source, field, agg, displayed, expected, matched }});
      }}
      parent.postMessage({{ vibevalley: "store-provenance", marks, verified, mismatches }}, "*");
    }};
    let scanTimer = 0;
    const scheduleScan = () => {{
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scanProvenance, 80);
    }};
    document.addEventListener("click", (e) => {{
      const el = e.target && e.target.closest ? e.target.closest("[data-source]") : null;
      if (!el) return;
      parent.postMessage({{
        vibevalley: "store-mark-click",
        source: el.getAttribute("data-source") || "",
        field: el.getAttribute("data-field") || "",
      }}, "*");
    }});
    addEventListener("message", (e) => {{
      if (e.source !== parent || !e.data || typeof e.data !== "object") return;
      const d = e.data;
      if (d.vibevalley === "dash-highlight") {{
        document.documentElement.classList.toggle("vv-show-marks", Boolean(d.on));
        const targetSource = d.source || "";
        for (const el of document.querySelectorAll("[data-source]")) {{
          el.classList.toggle("vv-mark-focus", Boolean(targetSource) && el.getAttribute("data-source") === targetSource);
        }}
      }} else if (d.vibevalley === "dash-update-data" && d.datasets && typeof d.datasets === "object") {{
        store = d.datasets;
        for (const fn of dataListeners) try {{ fn(); }} catch {{}}
        scheduleScan();
      }} else if (d.vibevalley === "dash-reset-params") {{
        window.dash.resetParams({{}});
      }}
    }});
    addEventListener("load", () => {{
      parent.postMessage({{ vibevalley: "ready", display: "page" }}, "*");
      scheduleScan();
    }});
  }})();"##
    );

    let provenance_styles = "\nhtml.vv-show-marks [data-source]{outline:1.5px dashed var(--vv-accent);outline-offset:3px;border-radius:4px;cursor:pointer}\nhtml.vv-show-marks [data-source][data-vv-verified=\"0\"]{outline-color:var(--vv-berry)}\n[data-source].vv-mark-focus{outline:2px solid var(--vv-wheat)!important;outline-offset:3px;background:rgba(229,169,60,0.14);border-radius:4px}\n";

    format!(
        r#"<!doctype html>
<html lang="zh" data-theme="{theme}">
<head>
<meta charset="utf-8" />
<style>:root{{{tv}{ty}}}{ds_css}{provenance_styles}
body{{margin:0;background:var(--color-surface,var(--vv-page));color:var(--color-ink,var(--vv-ink));font-family:var(--font-sans,var(--vv-font-sans));-webkit-font-smoothing:antialiased}}
</style>
<script>{dash_runtime}</script>
</head>
<body>
{index_html}
<script>{sel}</script>
</body>
</html>"#,
        tv = theme_variables(theme),
        ty = type_variables(),
        sel = selection_script(),
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilmMeta {
    width: Option<i64>,
    height: Option<i64>,
    fps: Option<i64>,
    duration: Option<f64>,
    background: Option<String>,
    chapters: Option<Vec<FilmChapter>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct FilmChapter {
    at: serde_json::Number,
    label: String,
}

fn render_motion_store_html(entries_list: &[ArtifactEntry], entries: &HashMap<&str, &ArtifactEntry>, options: &RenderStoreOptions) -> String {
    let theme = shell_theme_of(Some(&options.theme));
    let ds_css = collect_design_system_css(entries_list, options.default_tokens_json.as_deref());
    let meta: FilmMeta = entries
        .get("film/meta")
        .and_then(|e| e.value.as_deref())
        .and_then(|v| serde_json::from_str(v).ok())
        .unwrap_or_default();

    let width = meta.width.filter(|&w| (160..=3840).contains(&w)).unwrap_or(1920);
    let height = meta.height.filter(|&h| (160..=2160).contains(&h)).unwrap_or(1080);
    let fps = meta.fps.filter(|&f| (1..=120).contains(&f)).unwrap_or(30);
    let fallback_duration = meta.duration.filter(|&d| (0.1..=600.0).contains(&d)).unwrap_or(6.0);
    let bg = meta.background.as_deref().unwrap_or(if theme == "dark" { "#151413" } else { "#fcfcfb" });

    let mut modules_map = serde_json::Map::new();
    let mut js_modules: Vec<String> = Vec::new();
    for entry in entries_list {
        let Some(name) = entry.path.strip_prefix("modules/") else {
            continue;
        };
        let Some(val) = entry.value.as_deref() else {
            continue;
        };
        if val.is_empty() {
            continue;
        }
        if entry.kind == ArtifactEntryKind::Json || name.ends_with(".json") {
            let key = name.strip_suffix(".json").unwrap_or(name).to_string();
            let parsed = serde_json::from_str::<Value>(val).unwrap_or(Value::Null);
            modules_map.insert(key, parsed);
        } else {
            js_modules.push(format!("// module: {name}\n{}", rewrite_asset_urls(val, entries)));
        }
    }

    let fallback_script = format!(
        r#"window.CUT = {{ duration: {fallback_duration}, render(t, stage) {{ stage.innerHTML = '<div style="display:grid;place-items:center;height:100%;font-size:64px;font-weight:700">t = ' + t.toFixed(2) + 's</div>'; }} }};"#
    );
    let film_script = rewrite_asset_urls(entries.get("film/script").and_then(|e| e.value.as_deref()).unwrap_or(&fallback_script), entries);

    let modules_json = escape_script_json(&serde_json::to_string(&Value::Object(modules_map)).unwrap_or_else(|_| "{}".to_string()));
    let chapters_json = escape_script_json(&serde_json::to_string(&meta.chapters.unwrap_or_default()).unwrap_or_else(|_| "[]".to_string()));

    let kit_and_runner = format!(
        r#"(() => {{
    const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
    const lerp = (a, b, p) => a + (b - a) * clamp(p, 0, 1);
    const invLerp = (a, b, v) => (a === b ? 0 : clamp((v - a) / (b - a), 0, 1));
    const ease = {{
      linear: (p) => clamp(p),
      outCubic: (p) => 1 - Math.pow(1 - clamp(p), 3),
      inOutCubic: (p) => {{ const x = clamp(p); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }},
      outQuart: (p) => 1 - Math.pow(1 - clamp(p), 4),
      outBack: (p) => {{ const x = clamp(p); const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); }},
      spring: (p, damping = 0.65) => {{
        const x = clamp(p);
        return 1 - Math.exp(-6 * damping * x) * Math.cos(10 * x);
      }},
    }};
    const remap = (v, in0, in1, out0, out1, fn = ease.outCubic) => lerp(out0, out1, fn(invLerp(in0, in1, v)));
    const stagger = (t, index, start, step, dur, fn = ease.outCubic) => fn(invLerp(start + index * step, start + index * step + dur, t));
    const typist = (text, progress) => String(text || "").slice(0, Math.round(String(text || "").length * clamp(progress)));
    const sceneAt = (scenes, t) => {{
      const list = Array.isArray(scenes) ? scenes : [];
      let acc = 0;
      for (let i = 0; i < list.length; i++) {{
        const d = Number(list[i].duration) || 2;
        if (t < acc + d || i === list.length - 1) {{
          const local = clamp(t - acc, 0, d);
          return {{ index: i, scene: list[i], local, progress: d > 0 ? local / d : 1, start: acc, end: acc + d }};
        }}
        acc += d;
      }}
      return {{ index: 0, scene: null, local: t, progress: 0, start: 0, end: 0 }};
    }};
    const modules = {modules_json};
    window.kit = {{
      width: {width},
      height: {height},
      fps: {fps},
      clamp,
      lerp,
      invLerp,
      remap,
      ease,
      stagger,
      typist,
      sceneAt,
      module: (name) => modules[name],
      modules,
    }};
  }})();"#
    );

    let host_loop = format!(
        r#"(() => {{
    const say = (message) => parent.postMessage(Object.assign({{ vibevalley: message.kind }}, message.body), "*");
    const commands = {{}};
    addEventListener("message", (e) => {{
      if (e.source !== parent || !e.data || typeof e.data !== "object") return;
      const run = Object.prototype.hasOwnProperty.call(commands, e.data.vibevalley) ? commands[e.data.vibevalley] : undefined;
      if (run) run(e.data);
    }});
    {rec}
    const stage = document.getElementById("vv-motion-stage");
    const fit = () => {{
      const k = Math.min(innerWidth / {width}, innerHeight / {height});
      stage.style.transform = "translate(-50%, -50%) scale(" + k + ")";
    }};
    addEventListener("resize", fit);
    fit();
    const cut = window.CUT || {{}};
    const duration = Math.max(0.1, Number(cut.duration) || {fallback_duration});
    const fps = Math.max(1, Number(cut.fps) || {fps});
    const chapters = Array.isArray(cut.chapters) ? cut.chapters : {chapters_json};
    if (typeof cut.setup === "function") cut.setup(stage, window.kit);
    let current = 0;
    let playing = false;
    let raf = 0;
    let lastTs = 0;
    const seekTo = (t, quiet) => {{
      current = Math.max(0, Math.min(duration, Number(t) || 0));
      if (typeof cut.render === "function") cut.render(current, stage, window.kit);
      else if (typeof window.CUT === "function") window.CUT(current, stage, window.kit);
      if (!quiet) say({{ kind: "at", body: {{ time: Math.round(current * 1000) / 1000, playing }} }});
    }};
    const tick = (ts) => {{
      if (!playing) return;
      if (!lastTs) lastTs = ts;
      const dt = Math.min(0.1, (ts - lastTs) / 1000);
      lastTs = ts;
      const next = current + dt;
      if (next >= duration) {{
        playing = false;
        seekTo(duration, false);
        return;
      }}
      seekTo(next, false);
      raf = requestAnimationFrame(tick);
    }};
    commands.seek = (d) => {{ playing = false; cancelAnimationFrame(raf); seekTo(d.time, false); }};
    commands.step = (d) => {{ playing = false; cancelAnimationFrame(raf); seekTo(current + (Number(d.delta) || 0) / fps, false); }};
    commands.play = () => {{
      if (playing) return;
      if (current >= duration) current = 0;
      playing = true;
      lastTs = 0;
      say({{ kind: "at", body: {{ time: Math.round(current * 1000) / 1000, playing: true }} }});
      raf = requestAnimationFrame(tick);
    }};
    commands.pause = () => {{
      playing = false;
      cancelAnimationFrame(raf);
      say({{ kind: "at", body: {{ time: Math.round(current * 1000) / 1000, playing: false }} }});
    }};
    commands.record = async (d) => {{
      playing = false;
      cancelAnimationFrame(raf);
      const recFps = Math.max(10, Math.min(60, Number(d.fps) || fps));
      const scaleDown = {width} > 1280 ? 1280 / {width} : 1;
      await recordTimeline({{
        duration,
        fps: recFps,
        width: Math.round({width} * scaleDown),
        height: Math.round({height} * scaleDown),
        seekTo: (t) => seekTo(t, true),
        stageEl: stage,
        say,
      }});
      seekTo(current, false);
    }};
    const asked = new URLSearchParams(location.search);
    const firstAt = Number(asked.get("at"));
    seekTo(Number.isFinite(firstAt) && firstAt >= 0 ? firstAt : 0, true);
    say({{ kind: "ready", body: {{ display: "motion", duration, fps, chapters }} }});
    say({{ kind: "at", body: {{ time: current, playing: false }} }});
  }})();"#,
        rec = motion_recorder_helper(),
    );

    format!(
        r#"<!doctype html>
<html lang="zh" data-theme="{theme}">
<head>
<meta charset="utf-8" />
<style>
:root{{{tv}{ty}}}
{ds_css}
html,body{{margin:0;height:100%;overflow:hidden;background:var(--vv-side);font-family:var(--font-sans,var(--vv-font-sans));-webkit-font-smoothing:antialiased}}
#vv-motion-stage{{position:absolute;left:50%;top:50%;width:{width}px;height:{height}px;background:{bg_esc};color:var(--color-ink,var(--vv-ink));transform-origin:center;overflow:hidden;box-sizing:border-box}}
</style>
<script>{kit_and_runner}</script>
</head>
<body>
<div id="vv-motion-stage"></div>
<script>{js_mods}</script>
<script>{film_script}</script>
<script>{host_loop}</script>
</body>
</html>"#,
        tv = theme_variables(theme),
        ty = type_variables(),
        bg_esc = escape_html(bg),
        js_mods = js_modules.join("\n"),
    )
}

fn render_design_artboard_html(entries_list: &[ArtifactEntry], entries: &HashMap<&str, &ArtifactEntry>, options: &RenderStoreOptions) -> String {
    let theme = shell_theme_of(Some(&options.theme));
    let ds_css = collect_design_system_css(entries_list, options.default_tokens_json.as_deref());
    let target_path = options
        .path
        .clone()
        .or_else(|| {
            entries_list
                .iter()
                .map(|e| e.path.as_str())
                .find(|p| p.ends_with(".dc.html") || p.ends_with("/preview.html") || p.ends_with(".html"))
                .map(str::to_string)
        })
        .unwrap_or_else(|| "project/main.dc.html".to_string());

    let fallback = format!(r#"<x-dc><main style="padding:32px"><h2>{}</h2></main></x-dc>"#, escape_html(&target_path));
    let raw_source = rewrite_asset_urls(entries.get(target_path.as_str()).and_then(|e| e.value.as_deref()).unwrap_or(&fallback), entries);
    let target_json = escape_script_json(&serde_json::to_string(&target_path).unwrap_or_else(|_| "\"\"".to_string()));

    let dc_runtime = format!(
        r#"(() => {{
    const path = {target_json};
    const rootDoc = document.documentElement;
    const xdc = document.querySelector("x-dc") || document.body;
    const helmet = document.querySelector("helmet");
    let declaredProps = [];
    const propValues = {{}};

    const readDeclaredProps = () => {{
      const holder = document.querySelector("[data-props]") || helmet || xdc;
      const raw = holder ? holder.getAttribute("data-props") : null;
      if (!raw) return [];
      try {{
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      }} catch {{
        return [];
      }}
    }};

    if (helmet) {{
      const bodyAttrs = helmet.querySelector("body-attrs");
      if (bodyAttrs) {{
        for (const attr of Array.from(bodyAttrs.attributes)) document.body.setAttribute(attr.name, attr.value);
      }}
      for (const node of Array.from(helmet.querySelectorAll("style, link"))) document.head.appendChild(node);
      helmet.style.display = "none";
    }}

    declaredProps = readDeclaredProps();
    for (const p of declaredProps) {{
      if (p && typeof p.name === "string") propValues[p.name] = p.value;
    }}

    let logicState = window.DCLogic && typeof window.DCLogic.init === "function" ? window.DCLogic.init(propValues) : {{}};

    const applyBindings = () => {{
      for (const [k, v] of Object.entries(propValues)) {{
        const str = String(v);
        rootDoc.setAttribute("data-prop-" + k, str);
        rootDoc.style.setProperty("--prop-" + k, str);
        for (const el of document.querySelectorAll('[data-prop-text="' + k + '"]')) el.textContent = str;
        for (const el of document.querySelectorAll('[data-prop-show="' + k + '"]')) {{
          el.style.display = v === false || v === "false" || v === "none" ? "none" : "";
        }}
      }}
      const derived = window.DCLogic && typeof window.DCLogic.derive === "function" ? window.DCLogic.derive(logicState, propValues) : logicState;
      if (derived && typeof derived === "object") {{
        for (const [k, v] of Object.entries(derived)) {{
          for (const el of document.querySelectorAll('[data-bind="' + k + '"]')) el.textContent = String(v ?? "");
          for (const el of document.querySelectorAll('[data-if="' + k + '"]')) el.style.display = v ? "" : "none";
        }}
      }}
    }};

    document.addEventListener("click", (e) => {{
      const btn = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
      if (!btn || !window.DCLogic || typeof window.DCLogic.act !== "function") return;
      const action = btn.getAttribute("data-act") || "";
      const arg = btn.getAttribute("data-arg") || undefined;
      logicState = window.DCLogic.act(logicState, {{ type: action, arg }}, propValues) || logicState;
      applyBindings();
    }});

    addEventListener("message", (e) => {{
      if (e.source !== parent || !e.data || typeof e.data !== "object") return;
      if (e.data.vibevalley === "set-props" && e.data.values && typeof e.data.values === "object") {{
        Object.assign(propValues, e.data.values);
        applyBindings();
      }} else if (e.data.vibevalley === "set-theme" && (e.data.theme === "light" || e.data.theme === "dark")) {{
        rootDoc.setAttribute("data-theme", e.data.theme);
      }}
    }});

    applyBindings();
    parent.postMessage({{ vibevalley: "ready", display: "page" }}, "*");
    parent.postMessage({{ vibevalley: "store-props", path, props: declaredProps }}, "*");
  }})();"#
    );

    format!(
        r#"<!doctype html>
<html lang="zh" data-theme="{theme}">
<head>
<meta charset="utf-8" />
<style>
:root{{{tv}{ty}}}
{ds_css}
html,body{{margin:0;min-height:100%;background:var(--color-surface,var(--vv-page));color:var(--color-ink,var(--vv-ink));font-family:var(--font-sans,var(--vv-font-sans));-webkit-font-smoothing:antialiased}}
x-dc{{display:block;min-height:100%}}
helmet{{display:none}}
</style>
</head>
<body data-entry-path="{path_esc}">
{raw_source}
<script>{sel}</script>
<script>{dc_runtime}</script>
</body>
</html>"#,
        tv = theme_variables(theme),
        ty = type_variables(),
        path_esc = escape_html(&target_path),
        sel = selection_script(),
    )
}

#[derive(Debug, Deserialize)]
struct EmbedEntry {
    html: Option<String>,
    state: Option<serde_json::Map<String, Value>>,
}

fn render_whiteboard_embed_html(entries_list: &[ArtifactEntry], entries: &HashMap<&str, &ArtifactEntry>, options: &RenderStoreOptions) -> String {
    let theme = shell_theme_of(Some(&options.theme));
    let ds_css = collect_design_system_css(entries_list, options.default_tokens_json.as_deref());
    let el_id = options.element_id.as_deref().unwrap_or("");
    let key = format!("elements/{el_id}");
    let mut html_body = "<div>Embed</div>".to_string();
    let mut saved_state = serde_json::Map::new();
    if let Some(val) = entries.get(key.as_str()).and_then(|e| e.value.as_deref()) {
        match serde_json::from_str::<EmbedEntry>(val) {
            Ok(parsed) => {
                if let Some(h) = parsed.html {
                    html_body = rewrite_asset_urls(&h, entries);
                }
                if let Some(st) = parsed.state {
                    saved_state = st;
                }
            }
            Err(_) => {
                html_body = "<div>Invalid embed JSON</div>".to_string();
            }
        }
    }

    let id_json = escape_script_json(&serde_json::to_string(el_id).unwrap_or_else(|_| "\"\"".to_string()));
    let state_json = escape_script_json(&serde_json::to_string(&Value::Object(saved_state)).unwrap_or_else(|_| "{}".to_string()));

    let embed_runtime = format!(
        r#"(() => {{
    const elementId = {id_json};
    let state = {state_json};
    window.embed = {{
      load: () => structuredClone(state),
      save: (patch) => {{
        if (!patch || typeof patch !== "object") return;
        state = Object.assign({{}}, state, patch);
        parent.postMessage({{ vibevalley: "store-embed-save", elementId, state }}, "*");
      }},
    }};
  }})();"#
    );

    format!(
        r#"<!doctype html>
<html lang="zh" data-theme="{theme}">
<head>
<meta charset="utf-8" />
<style>:root{{{tv}{ty}}}{ds_css}
html,body{{margin:0;height:100%;overflow:auto;background:var(--vv-page);color:var(--vv-ink);font-family:var(--vv-font-sans)}}
</style>
<script>{embed_runtime}</script>
</head>
<body>
{html_body}
</body>
</html>"#,
        tv = theme_variables(theme),
        ty = type_variables(),
    )
}

const ALLOWED_SVG_TAGS: [&str; 22] = [
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "defs",
    "lineargradient",
    "radialgradient",
    "stop",
    "clippath",
    "mask",
    "pattern",
    "marker",
    "title",
    "desc",
    "use",
];

static RE_URL_CALL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)url\s*\(").expect("regex"));
static RE_URL_HASH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)url\(\s*#").expect("regex"));

/// Only fragment-local `#refs` are kept on `href` and `style`; external loads
/// and event handlers are stripped.
pub fn sanitize_whiteboard_svg(raw_svg: &str) -> String {
    let settings = RewriteStrSettings::new()
        .append_element_content_handler(element!("*", |el| {
            let tag = el.tag_name().to_ascii_lowercase();
            if !ALLOWED_SVG_TAGS.contains(&tag.as_str()) || tag == "use" {
                el.remove();
                return Ok(());
            }
            let drop_attrs: Vec<String> = el
                .attributes()
                .iter()
                .filter_map(|a| {
                    let name = a.name().to_ascii_lowercase();
                    let val = a.value();
                    if name.starts_with("on") {
                        return Some(a.name());
                    }
                    if (name == "href" || name == "xlink:href") && !val.trim().starts_with('#') {
                        return Some(a.name());
                    }
                    if name == "style" && RE_URL_CALL.is_match(&val) && !RE_URL_HASH.is_match(&val) {
                        return Some(a.name());
                    }
                    None
                })
                .collect();
            for name in drop_attrs {
                el.remove_attribute(&name);
            }
            Ok(())
        }))
        .append_element_content_handler(comments!("*", |c| {
            c.remove();
            Ok(())
        }));
    rewrite_str(raw_svg, settings).unwrap_or_default()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StorePropDef {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    options: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    step: Option<f64>,
    value: Value,
}

static RE_DATA_PROPS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"(?s)(\bdata-props\s*=\s*)(?:'([^']*)'|"([^"]*)")"#).expect("regex"));

pub fn write_props_into_dc_html(source: &str, updated_values: &BTreeMap<String, Value>) -> String {
    RE_DATA_PROPS
        .replace(source, |caps: &regex::Captures<'_>| {
            let prefix = &caps[1];
            let json_attr = caps.get(2).or_else(|| caps.get(3)).map_or("", |m| m.as_str());
            let unescaped = json_attr
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">");
            let Ok(mut items) = serde_json::from_str::<Vec<StorePropDef>>(&unescaped) else {
                return caps[0].to_string();
            };
            for item in &mut items {
                if !matches!(item.r#type.as_str(), "select" | "boolean" | "number" | "text" | "color") {
                    return caps[0].to_string();
                }
                if let Some(replacement) = updated_values.get(&item.name) {
                    item.value = replacement.clone();
                }
            }
            let Ok(serialized) = serde_json::to_string(&items) else {
                return caps[0].to_string();
            };
            format!("{prefix}'{}'", serialized.replace('\'', "&#39;"))
        })
        .into_owned()
}

pub fn render_store_artifact_html(artifact_type: Option<ArtifactType>, entries_list: &[ArtifactEntry], options: &RenderStoreOptions) -> String {
    let map: HashMap<&str, &ArtifactEntry> = entries_list.iter().map(|e| (e.path.as_str(), e)).collect();
    if options.element_id.as_deref().is_some_and(|s| !s.is_empty()) {
        return render_whiteboard_embed_html(entries_list, &map, options);
    }
    match artifact_type {
        Some(ArtifactType::Slides) => render_slides_store_html(entries_list, &map, options),
        Some(ArtifactType::Dashboard) => render_dashboard_store_html(entries_list, &map, options),
        Some(ArtifactType::Motion) => render_motion_store_html(entries_list, &map, options),
        Some(ArtifactType::Design | ArtifactType::DesignSystem | ArtifactType::Docs | ArtifactType::Whiteboard) | None => {
            render_design_artboard_html(entries_list, &map, options)
        }
    }
}
