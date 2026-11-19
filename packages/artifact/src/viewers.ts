import { type DefaultTreeAdapterTypes as P, parseFragment, serialize } from "parse5";
import { z } from "zod";

import { htmlCheck, htmlProblem, htmlSources } from "./html.ts";
import { motionRecorderHelper, selectionScript, type ShellTheme, themeVariables, typeVariables } from "./shell.ts";
import type { ArtifactEntry, ArtifactType } from "./store.ts";
import { compileTokensCss } from "./tokens.ts";

// Mirrors @vibevalley/protocol artifactViewPath (tighten to protocol import after w1/proto-cli-v2 merges).
const artifactViewPath = (id: string) => `/api/v1/artifact/${id}/view`;

export function storeViewHeaders(origin?: string, print = false, sandboxTokens = ""): Record<string, string> {
  const attach = origin ? ` ${origin}/api/v1/attachment/` : "";
  const limits = [
    "default-src 'none'",
    ["script-src 'unsafe-inline'", ...htmlSources.script].join(" "),
    ["style-src 'unsafe-inline'", ...htmlSources.style].join(" "),
    `img-src data: blob:${attach}`,
    [`font-src data:${attach}`, ...htmlSources.font].join(" "),
    `media-src data: blob:${attach}`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  const tokens = [sandboxTokens.trim(), print ? "allow-modals" : ""].filter(Boolean).join(" ");
  const sandbox = tokens ? `sandbox ${tokens}` : "sandbox";
  return {
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": `${sandbox}; ${limits}`,
  };
}

/** Validates HTML fragments/pages in store entries: allows relative assets/* and /api/v1/attachment/* while blocking unapproved origins. */
export function storeHtmlProblem(source: string): string {
  const check = htmlCheck(source);
  const filtered = check.refused.filter((r) => {
    if (r.kind !== "load") return true;
    const u = r.url.trim();
    if (u.startsWith("assets/") || u.startsWith("./assets/") || u.startsWith("../assets/") || u.startsWith("/api/v1/attachment/")) return false;
    return true;
  });
  return htmlProblem({ refused: filtered, warned: check.warned });
}

export interface StorePropDef {
  readonly name: string;
  readonly label?: string;
  readonly type: "select" | "boolean" | "number" | "text" | "color";
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly value: string | number | boolean;
}

export interface StoreProvenanceMark {
  readonly source: string;
  readonly field: string;
  readonly agg: string;
  readonly displayed: string;
  readonly expected: string;
  readonly matched: boolean;
}

const StorePropDefSchema = z.object({
  name: z.string().max(100),
  label: z.exactOptional(z.string().max(200)),
  type: z.enum(["select", "boolean", "number", "text", "color"]),
  options: z.exactOptional(z.array(z.string().max(200)).max(50)),
  min: z.exactOptional(z.number()),
  max: z.exactOptional(z.number()),
  step: z.exactOptional(z.number()),
  value: z.union([z.string().max(500), z.number(), z.boolean()]),
});

const StoreProvenanceMarkSchema = z.object({
  source: z.string().max(200),
  field: z.string().max(200),
  agg: z.string().max(50),
  displayed: z.string().max(200),
  expected: z.string().max(200),
  matched: z.boolean(),
});

const ParamPrimitive = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]);

export const StoreBridgeMessageSchema = z.discriminatedUnion("vibevalley", [
  z.object({
    vibevalley: z.literal("store-provenance"),
    marks: z.array(StoreProvenanceMarkSchema).max(500),
    verified: z.number().int().min(0),
    mismatches: z.number().int().min(0),
  }),
  z.object({
    vibevalley: z.literal("store-mark-click"),
    source: z.string().max(200),
    field: z.string().max(200),
  }),
  z.object({
    vibevalley: z.literal("store-params"),
    params: z.record(z.string().max(100), ParamPrimitive),
  }),
  z.object({
    vibevalley: z.literal("store-props"),
    path: z.string().max(240),
    props: z.array(StorePropDefSchema).max(100),
  }),
  z.object({
    vibevalley: z.literal("store-embed-save"),
    elementId: z.string().max(200),
    state: z.record(z.string().max(100), ParamPrimitive),
  }),
]);

export type StoreBridgeMessage = z.output<typeof StoreBridgeMessageSchema>;

export function storeMessageOf(data: unknown): StoreBridgeMessage | undefined {
  const got = StoreBridgeMessageSchema.safeParse(data);
  return got.success ? got.data : undefined;
}

export interface StoreViewQuery {
  readonly theme?: ShellTheme;
  readonly seq?: number;
  readonly path?: string;
  readonly at?: number;
  readonly still?: boolean;
  readonly print?: boolean;
  readonly elementId?: string;
}

export function storeViewUrl(id: string, query: StoreViewQuery = {}): string {
  const params = new URLSearchParams();
  if (query.theme) params.set("theme", query.theme);
  if (query.seq !== undefined) params.set("seq", String(query.seq));
  if (query.path) params.set("path", query.path);
  if (query.at !== undefined) params.set("at", String(query.at));
  if (query.still === true) params.set("still", "1");
  if (query.print === true) params.set("print", "1");
  if (query.elementId) params.set("elementId", query.elementId);
  const qs = params.toString();
  return qs ? `${artifactViewPath(id)}?${qs}` : artifactViewPath(id);
}

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const escapeScriptJson = (json: string) => json.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--");

function rewriteAssetUrls(text: string, entries: ReadonlyMap<string, ArtifactEntry>): string {
  return text.replace(/(?:\.\.\/|\.\/)?assets\/([a-zA-Z0-9._/-]+)/gu, (full, rel: string) => {
    const entry = entries.get(`assets/${rel}`) ?? entries.get(`project/assets/${rel}`);
    if (entry?.attachmentId) return `/api/v1/attachment/${encodeURIComponent(entry.attachmentId)}`;
    return full;
  });
}

function collectDesignSystemCss(entries: ReadonlyMap<string, ArtifactEntry>, fallbackTokensJson?: string): string {
  const parts: string[] = [];
  if (fallbackTokensJson) parts.push(compileTokensCss(fallbackTokensJson));
  for (const [path, entry] of entries) {
    if ((path === "project/tokens.json" || (path.startsWith("project/ds/") && path.endsWith("/tokens.json"))) && entry.value) {
      parts.push(compileTokensCss(entry.value));
    }
  }
  return parts.filter(Boolean).join("\n");
}

const DeckManifestSchema = z.object({
  title: z.exactOptional(z.string()),
  aspectRatio: z.exactOptional(z.enum(["16:9", "4:3"])),
  theme: z.exactOptional(z.string()),
  slides: z.exactOptional(
    z.array(
      z.object({
        id: z.string(),
        file: z.exactOptional(z.string()),
        title: z.exactOptional(z.string()),
        notes: z.exactOptional(z.string()),
        skip: z.exactOptional(z.boolean()),
        transition: z.exactOptional(z.string()),
      }),
    ),
  ),
});

export interface RenderStoreOptions {
  readonly theme: ShellTheme;
  readonly path?: string;
  readonly elementId?: string;
  readonly defaultTokensJson?: string;
}

function renderSlidesStoreHtml(entries: ReadonlyMap<string, ArtifactEntry>, options: RenderStoreOptions): string {
  const deckEntry = entries.get("project/deck.json");
  let manifest: z.output<typeof DeckManifestSchema> = {};
  if (deckEntry?.value) {
    try {
      const parsed = DeckManifestSchema.safeParse(JSON.parse(deckEntry.value));
      if (parsed.success) manifest = parsed.data;
    } catch {
      manifest = {};
    }
  }
  const width = manifest.aspectRatio === "4:3" ? 1440 : 1920;
  const height = 1080;
  const deckCss = rewriteAssetUrls(entries.get("project/deck.css")?.value ?? "", entries);
  const dsCss = collectDesignSystemCss(entries, options.defaultTokensJson);

  const slideItems =
    manifest.slides && manifest.slides.length > 0
      ? manifest.slides.filter((s) => s.skip !== true)
      : [...entries.keys()]
          .filter((p) => p.startsWith("project/slides/") && p.endsWith(".html"))
          .toSorted()
          .map((p) => ({
            id: p.slice("project/slides/".length, -".html".length),
            file: p.slice("project/slides/".length),
            title: undefined,
            notes: undefined,
            transition: undefined,
          }));

  const sections = slideItems
    .map((item) => {
      const relFile = item.file ?? `${item.id}.html`;
      const fullPath = relFile.startsWith("project/") ? relFile : `project/slides/${relFile}`;
      const rawHtml = rewriteAssetUrls(entries.get(fullPath)?.value ?? `<div class="slide"><h2>${escapeHtml(item.title ?? item.id)}</h2></div>`, entries);
      const notesAside = item.notes ? `<aside class="notes">${escapeHtml(item.notes)}</aside>` : "";
      const titleMeta = item.title ? ` data-slide-title="${escapeHtml(item.title)}"` : "";
      const transitionAttr = item.transition ? ` data-transition="${escapeHtml(item.transition)}"` : "";
      return `<section class="vv-deck-slide" data-slide-id="${escapeHtml(item.id)}" data-entry-path="${escapeHtml(fullPath)}"${titleMeta}${transitionAttr}>${rawHtml}${notesAside}</section>`;
    })
    .join("\n");

  const runtime = String.raw`(() => {
    const say = (kind, body) => parent.postMessage(Object.assign({ vibevalley: kind }, body), "*");
    const all = Array.from(document.querySelectorAll("section.vv-deck-slide"));
    const asked = new URLSearchParams(location.search);
    const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim().slice(0, 500) : "");
    const titles = all.map((s, idx) => s.getAttribute("data-slide-title") || text(s.querySelector("h1, h2, h3")) || ("Slide " + (idx + 1)));
    const notes = all.map((s) => text(s.querySelector("aside.notes, aside[data-notes]")));
    const fragsOf = (s) => Array.from(s.querySelectorAll(".fragment"));
    const fragments = all.map((s) => fragsOf(s).length);
    if (asked.get("print") === "1") {
      document.documentElement.classList.add("vv-print");
      all.forEach((s) => fragsOf(s).forEach((f) => f.classList.add("visible")));
      addEventListener("load", () => setTimeout(() => print(), 300));
      say("ready", { display: "slides", pages: all.length, titles, notes, fragments });
      return;
    }
    const W = ${width};
    const H = ${height};
    const fit = () => {
      const k = Math.min(innerWidth / W, innerHeight / H);
      for (const s of all) s.style.setProperty("--vv-scale", String(k));
    };
    let at = -1;
    let frag = 0;
    const show = (n, nextFrag) => {
      if (all.length === 0) return;
      const next = Math.max(0, Math.min(all.length - 1, n));
      const maxFrag = fragments[next] || 0;
      const targetFrag = typeof nextFrag === "number" ? Math.max(0, Math.min(maxFrag, nextFrag)) : next !== at ? 0 : frag;
      if (next === at && targetFrag === frag) return;
      at = next;
      frag = targetFrag;
      all.forEach((s, i) => {
        s.classList.toggle("vv-on", i === at);
        if (i === at) fragsOf(s).forEach((el, idx) => el.classList.toggle("visible", idx < frag));
      });
      say("at", { page: at, fragment: frag });
    };
    const advance = (dir) => {
      const maxFrag = fragments[at] || 0;
      if (dir > 0 && frag < maxFrag) return show(at, frag + 1);
      if (dir < 0 && frag > 0) return show(at, frag - 1);
      const nextPage = at + dir;
      if (nextPage < 0 || nextPage >= all.length) return;
      show(nextPage, dir < 0 ? (fragments[nextPage] || 0) : 0);
    };
    addEventListener("message", (e) => {
      if (e.source !== parent || !e.data || typeof e.data !== "object") return;
      const d = e.data;
      if (d.vibevalley === "goto" && Number.isInteger(d.page)) show(d.page, Number.isInteger(d.fragment) ? d.fragment : 0);
      if (d.vibevalley === "step" && typeof d.delta === "number") advance(d.delta >= 0 ? 1 : -1);
    });
    addEventListener("resize", fit);
    fit();
    const first = Number(asked.get("at"));
    show(Number.isInteger(first) ? first : 0, 0);
    if (asked.get("still") !== "1") {
      addEventListener("keydown", (e) => {
        if (e.target && e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
        const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[e.key];
        if (step) { e.preventDefault(); advance(step); }
        else if (e.key === "Home") show(0, 0);
        else if (e.key === "End") show(all.length - 1, fragments[all.length - 1] || 0);
      });
      addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("a, button, input, textarea, select, summary, video, audio, [contenteditable]")) return;
        if (getSelection() && !getSelection().isCollapsed) return;
        advance(e.clientX < innerWidth / 4 ? -1 : 1);
      });
    }
    say("ready", { display: "slides", pages: all.length, titles, notes, fragments });
  })();`;

  return `<!doctype html>
<html lang="zh" data-theme="${options.theme}">
<head>
<meta charset="utf-8" />
<style>
:root{${themeVariables[options.theme]}${typeVariables}}
${dsCss}
html,body{margin:0;height:100%;overflow:hidden;background:var(--vv-side);color:var(--color-ink,var(--vv-ink));font-family:var(--font-sans,var(--vv-font-sans));-webkit-font-smoothing:antialiased}
section.vv-deck-slide{position:absolute;left:50%;top:50%;width:${width}px;height:${height}px;box-sizing:border-box;padding:96px 128px;display:none;flex-direction:column;justify-content:center;gap:32px;background:var(--color-surface,var(--vv-page));color:var(--color-ink,var(--vv-ink));transform:translate(-50%,-50%) scale(var(--vv-scale,1));transform-origin:center;overflow:hidden}
section.vv-deck-slide.vv-on{display:flex}
section.vv-deck-slide > .slide{width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:28px}
section.vv-deck-slide aside.notes,section.vv-deck-slide aside[data-notes]{display:none}
section.vv-deck-slide .fragment{opacity:0;transform:translateY(14px);transition:opacity 180ms ease,transform 180ms ease}
section.vv-deck-slide .fragment.visible{opacity:1;transform:none}
section.vv-deck-slide :where(h1){margin:0;font-size:84px;line-height:1.08;font-weight:700;letter-spacing:-0.02em}
section.vv-deck-slide :where(h2){margin:0;font-size:56px;line-height:1.14;font-weight:650}
section.vv-deck-slide :where(h3){margin:0;font-size:36px;line-height:1.25;font-weight:600;color:var(--color-muted,var(--vv-muted))}
section.vv-deck-slide :where(p,li){margin:0;font-size:34px;line-height:1.5}
${deckCss}
@page{size:${width}px ${height}px;margin:0}
@media print{
  html,body{height:auto;overflow:visible;background:none}
  section.vv-deck-slide{position:relative;left:auto;top:auto;transform:none;display:flex;break-after:page;page-break-after:always}
  section.vv-deck-slide .fragment{opacity:1;transform:none}
}
</style>
</head>
<body>
${sections}
<script>${selectionScript}</script>
<script>${runtime}</script>
</body>
</html>`;
}

function renderDashboardStoreHtml(entries: ReadonlyMap<string, ArtifactEntry>, options: RenderStoreOptions): string {
  const dsCss = collectDesignSystemCss(entries, options.defaultTokensJson);
  const datasetsObj: Record<string, unknown> = {};
  for (const [path, entry] of entries) {
    if (path.startsWith("datasets/") && entry.value) {
      const id = path.slice("datasets/".length).replace(/\.json$/u, "");
      try {
        datasetsObj[id] = JSON.parse(entry.value);
      } catch {
        datasetsObj[id] = [];
      }
    }
  }
  let initialParams: Record<string, unknown> = {};
  const paramsEntry = entries.get("dash/params");
  if (paramsEntry?.value) {
    try {
      const parsed: unknown = JSON.parse(paramsEntry.value);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) initialParams = { ...parsed };
    } catch {
      initialParams = {};
    }
  }
  const indexHtml = rewriteAssetUrls(
    entries.get("files/index.html")?.value ??
      `<main style="padding:24px"><h2>Dashboard</h2><p>Create <code>datasets/*</code> and <code>files/index.html</code>.</p></main>`,
    entries,
  );

  const dashRuntime = String.raw`(() => {
    let store = ${escapeScriptJson(JSON.stringify(datasetsObj))};
    let currentParams = ${escapeScriptJson(JSON.stringify(initialParams))};
    const dataListeners = [];
    const paramListeners = [];
    const rowsOf = (id) => {
      const raw = store[id];
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === "object" && Array.isArray(raw.rows)) return raw.rows;
      return [];
    };
    const numsOf = (rows, field) => rows.map((r) => (r && typeof r === "object" ? Number(r[field]) : Number(r))).filter((n) => Number.isFinite(n));
    const calc = {
      sum: (rows, field) => numsOf(rows, field).reduce((a, b) => a + b, 0),
      avg: (rows, field) => { const ns = numsOf(rows, field); return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0; },
      min: (rows, field) => { const ns = numsOf(rows, field); return ns.length ? Math.min(...ns) : 0; },
      max: (rows, field) => { const ns = numsOf(rows, field); return ns.length ? Math.max(...ns) : 0; },
      count: (rows) => (Array.isArray(rows) ? rows.length : 0),
      median: (rows, field) => {
        const ns = numsOf(rows, field).slice().sort((a, b) => a - b);
        if (!ns.length) return 0;
        const m = Math.floor(ns.length / 2);
        return ns.length % 2 ? ns[m] : (ns[m - 1] + ns[m]) / 2;
      },
      pctChange: (curr, prev) => (prev === 0 ? 0 : ((curr - prev) / Math.abs(prev)) * 100),
      groupBy: (rows, keyField, valField, agg = "sum") => {
        const buckets = new Map();
        for (const r of rows || []) {
          if (!r || typeof r !== "object") continue;
          const k = String(r[keyField] ?? "");
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(r);
        }
        return Array.from(buckets.entries()).map(([key, list]) => ({
          key,
          value: agg === "count" ? list.length : agg === "avg" ? calc.avg(list, valField) : calc.sum(list, valField),
          rows: list,
        }));
      },
      formatNumber: (n, digits = 0) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: digits }),
      formatCurrency: (n, currency = "USD", digits = 0) => Number(n || 0).toLocaleString(undefined, { style: "currency", currency, maximumFractionDigits: digits }),
      formatPct: (n, digits = 1) => Number(n || 0).toFixed(digits) + "%",
    };
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const colors = {
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
    };
    window.dash = {
      data: (id) => structuredClone(store[id] !== undefined ? rowsOf(id) : []),
      raw: (id) => structuredClone(store[id]),
      datasets: () => Object.keys(store),
      calc,
      colors,
      get params() { return Object.assign({}, currentParams); },
      setParams(patch) {
        if (!patch || typeof patch !== "object") return;
        currentParams = Object.assign({}, currentParams, patch);
        parent.postMessage({ vibevalley: "store-params", params: currentParams }, "*");
        for (const fn of paramListeners) try { fn(window.dash.params); } catch {}
        scheduleScan();
      },
      resetParams(defaults = {}) {
        currentParams = Object.assign({}, defaults);
        parent.postMessage({ vibevalley: "store-params", params: currentParams }, "*");
        for (const fn of paramListeners) try { fn(window.dash.params); } catch {}
        scheduleScan();
      },
      onData(fn) { if (typeof fn === "function") dataListeners.push(fn); },
      onParams(fn) { if (typeof fn === "function") paramListeners.push(fn); },
      scan: () => scheduleScan(),
    };

    const parseDisplayedNumber = (s) => {
      const cleaned = String(s || "").replace(/[,$\xA5\u20AC%\s]/g, "").trim();
      if (!cleaned) return NaN;
      const mult = /k$/i.test(cleaned) ? 1e3 : /m$/i.test(cleaned) ? 1e6 : /b$/i.test(cleaned) ? 1e9 : 1;
      const base = parseFloat(cleaned.replace(/[kmb]$/i, ""));
      return Number.isFinite(base) ? base * mult : NaN;
    };

    const scanProvenance = () => {
      const els = Array.from(document.querySelectorAll("[data-source]"));
      const marks = [];
      let verified = 0;
      let mismatches = 0;
      for (const el of els) {
        const source = el.getAttribute("data-source") || "";
        const field = el.getAttribute("data-field") || "";
        const agg = el.getAttribute("data-agg") || (el.hasAttribute("data-row") ? "row" : field ? "sum" : "source");
        const displayed = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
        const rows = rowsOf(source);
        let matched = store[source] !== undefined;
        let expected = matched ? (rows.length + " rows") : "missing dataset";
        if (matched && field && agg !== "source") {
          let val = NaN;
          if (agg === "row") {
            const idx = Number(el.getAttribute("data-row") || 0);
            val = rows[idx] && typeof rows[idx] === "object" ? Number(rows[idx][field]) : NaN;
          } else if (agg === "sum") val = calc.sum(rows, field);
          else if (agg === "avg") val = calc.avg(rows, field);
          else if (agg === "min") val = calc.min(rows, field);
          else if (agg === "max") val = calc.max(rows, field);
          else if (agg === "count") val = calc.count(rows);
          if (Number.isFinite(val)) {
            expected = String(Math.round(val * 100) / 100);
            const shownNum = parseDisplayedNumber(displayed);
            if (Number.isFinite(shownNum)) {
              const tol = Math.max(1, Math.abs(val) * 0.02);
              matched = Math.abs(shownNum - val) <= tol;
            }
          }
        }
        el.setAttribute("data-vv-verified", matched ? "1" : "0");
        if (matched) verified++; else mismatches++;
        marks.push({ source, field, agg, displayed, expected, matched });
      }
      parent.postMessage({ vibevalley: "store-provenance", marks, verified, mismatches }, "*");
    };
    let scanTimer = 0;
    const scheduleScan = () => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(scanProvenance, 80);
    };
    document.addEventListener("click", (e) => {
      const el = e.target && e.target.closest ? e.target.closest("[data-source]") : null;
      if (!el) return;
      parent.postMessage({
        vibevalley: "store-mark-click",
        source: el.getAttribute("data-source") || "",
        field: el.getAttribute("data-field") || "",
      }, "*");
    });
    addEventListener("message", (e) => {
      if (e.source !== parent || !e.data || typeof e.data !== "object") return;
      const d = e.data;
      if (d.vibevalley === "dash-highlight") {
        document.documentElement.classList.toggle("vv-show-marks", Boolean(d.on));
        const targetSource = d.source || "";
        for (const el of document.querySelectorAll("[data-source]")) {
          el.classList.toggle("vv-mark-focus", Boolean(targetSource) && el.getAttribute("data-source") === targetSource);
        }
      } else if (d.vibevalley === "dash-update-data" && d.datasets && typeof d.datasets === "object") {
        store = d.datasets;
        for (const fn of dataListeners) try { fn(); } catch {}
        scheduleScan();
      } else if (d.vibevalley === "dash-reset-params") {
        window.dash.resetParams({});
      }
    });
    addEventListener("load", () => {
      parent.postMessage({ vibevalley: "ready", display: "page" }, "*");
      scheduleScan();
    });
  })();`;

  const provenanceStyles = String.raw`
html.vv-show-marks [data-source]{outline:1.5px dashed var(--vv-accent);outline-offset:3px;border-radius:4px;cursor:pointer}
html.vv-show-marks [data-source][data-vv-verified="0"]{outline-color:var(--vv-berry)}
[data-source].vv-mark-focus{outline:2px solid var(--vv-wheat)!important;outline-offset:3px;background:rgba(229,169,60,0.14);border-radius:4px}
`;

  return `<!doctype html>
<html lang="zh" data-theme="${options.theme}">
<head>
<meta charset="utf-8" />
<style>:root{${themeVariables[options.theme]}${typeVariables}}${dsCss}${provenanceStyles}
body{margin:0;background:var(--color-surface,var(--vv-page));color:var(--color-ink,var(--vv-ink));font-family:var(--font-sans,var(--vv-font-sans));-webkit-font-smoothing:antialiased}
</style>
<script>${dashRuntime}</script>
</head>
<body>
${indexHtml}
<script>${selectionScript}</script>
</body>
</html>`;
}

const FilmMetaSchema = z.object({
  title: z.exactOptional(z.string()),
  width: z.exactOptional(z.number().int().min(160).max(3840)),
  height: z.exactOptional(z.number().int().min(160).max(2160)),
  fps: z.exactOptional(z.number().int().min(1).max(120)),
  duration: z.exactOptional(z.number().min(0.1).max(600)),
  background: z.exactOptional(z.string()),
  chapters: z.exactOptional(z.array(z.object({ at: z.number().min(0), label: z.string() }))),
});

function renderMotionStoreHtml(entries: ReadonlyMap<string, ArtifactEntry>, options: RenderStoreOptions): string {
  const dsCss = collectDesignSystemCss(entries, options.defaultTokensJson);
  let meta: z.output<typeof FilmMetaSchema> = {};
  const metaEntry = entries.get("film/meta");
  if (metaEntry?.value) {
    try {
      const parsed = FilmMetaSchema.safeParse(JSON.parse(metaEntry.value));
      if (parsed.success) meta = parsed.data;
    } catch {
      meta = {};
    }
  }
  const width = meta.width ?? 1920;
  const height = meta.height ?? 1080;
  const fps = meta.fps ?? 30;
  const fallbackDuration = meta.duration ?? 6;
  const bg = meta.background ?? (options.theme === "dark" ? "#151413" : "#fcfcfb");

  const modulesMap: Record<string, unknown> = {};
  const jsModules: string[] = [];
  for (const [path, entry] of entries) {
    if (!path.startsWith("modules/") || !entry.value) continue;
    const name = path.slice("modules/".length);
    if (entry.kind === "json" || name.endsWith(".json")) {
      try {
        modulesMap[name.replace(/\.json$/u, "")] = JSON.parse(entry.value);
      } catch {
        modulesMap[name] = null;
      }
    } else {
      jsModules.push(`// module: ${name}\n${rewriteAssetUrls(entry.value, entries)}`);
    }
  }

  const filmScript = rewriteAssetUrls(
    entries.get("film/script")?.value ??
      `window.CUT = { duration: ${fallbackDuration}, render(t, stage) { stage.innerHTML = '<div style="display:grid;place-items:center;height:100%;font-size:64px;font-weight:700">t = ' + t.toFixed(2) + 's</div>'; } };`,
    entries,
  );

  const kitAndRunner = String.raw`(() => {
    const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
    const lerp = (a, b, p) => a + (b - a) * clamp(p, 0, 1);
    const invLerp = (a, b, v) => (a === b ? 0 : clamp((v - a) / (b - a), 0, 1));
    const ease = {
      linear: (p) => clamp(p),
      outCubic: (p) => 1 - Math.pow(1 - clamp(p), 3),
      inOutCubic: (p) => { const x = clamp(p); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; },
      outQuart: (p) => 1 - Math.pow(1 - clamp(p), 4),
      outBack: (p) => { const x = clamp(p); const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); },
      spring: (p, damping = 0.65) => {
        const x = clamp(p);
        return 1 - Math.exp(-6 * damping * x) * Math.cos(10 * x);
      },
    };
    const remap = (v, in0, in1, out0, out1, fn = ease.outCubic) => lerp(out0, out1, fn(invLerp(in0, in1, v)));
    const stagger = (t, index, start, step, dur, fn = ease.outCubic) => fn(invLerp(start + index * step, start + index * step + dur, t));
    const typist = (text, progress) => String(text || "").slice(0, Math.round(String(text || "").length * clamp(progress)));
    const sceneAt = (scenes, t) => {
      const list = Array.isArray(scenes) ? scenes : [];
      let acc = 0;
      for (let i = 0; i < list.length; i++) {
        const d = Number(list[i].duration) || 2;
        if (t < acc + d || i === list.length - 1) {
          const local = clamp(t - acc, 0, d);
          return { index: i, scene: list[i], local, progress: d > 0 ? local / d : 1, start: acc, end: acc + d };
        }
        acc += d;
      }
      return { index: 0, scene: null, local: t, progress: 0, start: 0, end: 0 };
    };
    const modules = ${escapeScriptJson(JSON.stringify(modulesMap))};
    window.kit = {
      width: ${width},
      height: ${height},
      fps: ${fps},
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
    };
  })();`;

  const hostLoop = String.raw`(() => {
    const say = (message) => parent.postMessage(Object.assign({ vibevalley: message.kind }, message.body), "*");
    const commands = {};
    addEventListener("message", (e) => {
      if (e.source !== parent || !e.data || typeof e.data !== "object") return;
      const run = Object.prototype.hasOwnProperty.call(commands, e.data.vibevalley) ? commands[e.data.vibevalley] : undefined;
      if (run) run(e.data);
    });
    ${motionRecorderHelper}
    const stage = document.getElementById("vv-motion-stage");
    const fit = () => {
      const k = Math.min(innerWidth / ${width}, innerHeight / ${height});
      stage.style.transform = "translate(-50%, -50%) scale(" + k + ")";
    };
    addEventListener("resize", fit);
    fit();
    const cut = window.CUT || {};
    const duration = Math.max(0.1, Number(cut.duration) || ${fallbackDuration});
    const fps = Math.max(1, Number(cut.fps) || ${fps});
    const chapters = Array.isArray(cut.chapters) ? cut.chapters : ${escapeScriptJson(JSON.stringify(meta.chapters ?? []))};
    if (typeof cut.setup === "function") cut.setup(stage, window.kit);
    let current = 0;
    let playing = false;
    let raf = 0;
    let lastTs = 0;
    const seekTo = (t, quiet) => {
      current = Math.max(0, Math.min(duration, Number(t) || 0));
      if (typeof cut.render === "function") cut.render(current, stage, window.kit);
      else if (typeof window.CUT === "function") window.CUT(current, stage, window.kit);
      if (!quiet) say({ kind: "at", body: { time: Math.round(current * 1000) / 1000, playing } });
    };
    const tick = (ts) => {
      if (!playing) return;
      if (!lastTs) lastTs = ts;
      const dt = Math.min(0.1, (ts - lastTs) / 1000);
      lastTs = ts;
      const next = current + dt;
      if (next >= duration) {
        playing = false;
        seekTo(duration, false);
        return;
      }
      seekTo(next, false);
      raf = requestAnimationFrame(tick);
    };
    commands.seek = (d) => { playing = false; cancelAnimationFrame(raf); seekTo(d.time, false); };
    commands.step = (d) => { playing = false; cancelAnimationFrame(raf); seekTo(current + (Number(d.delta) || 0) / fps, false); };
    commands.play = () => {
      if (playing) return;
      if (current >= duration) current = 0;
      playing = true;
      lastTs = 0;
      say({ kind: "at", body: { time: Math.round(current * 1000) / 1000, playing: true } });
      raf = requestAnimationFrame(tick);
    };
    commands.pause = () => {
      playing = false;
      cancelAnimationFrame(raf);
      say({ kind: "at", body: { time: Math.round(current * 1000) / 1000, playing: false } });
    };
    commands.record = async (d) => {
      playing = false;
      cancelAnimationFrame(raf);
      const recFps = Math.max(10, Math.min(60, Number(d.fps) || fps));
      const scaleDown = ${width} > 1280 ? 1280 / ${width} : 1;
      await recordTimeline({
        duration,
        fps: recFps,
        width: Math.round(${width} * scaleDown),
        height: Math.round(${height} * scaleDown),
        seekTo: (t) => seekTo(t, true),
        stageEl: stage,
        say,
      });
      seekTo(current, false);
    };
    const asked = new URLSearchParams(location.search);
    const firstAt = Number(asked.get("at"));
    seekTo(Number.isFinite(firstAt) && firstAt >= 0 ? firstAt : 0, true);
    say({ kind: "ready", body: { display: "motion", duration, fps, chapters } });
    say({ kind: "at", body: { time: current, playing: false } });
  })();`;

  return `<!doctype html>
<html lang="zh" data-theme="${options.theme}">
<head>
<meta charset="utf-8" />
<style>
:root{${themeVariables[options.theme]}${typeVariables}}
${dsCss}
html,body{margin:0;height:100%;overflow:hidden;background:var(--vv-side);font-family:var(--font-sans,var(--vv-font-sans));-webkit-font-smoothing:antialiased}
#vv-motion-stage{position:absolute;left:50%;top:50%;width:${width}px;height:${height}px;background:${escapeHtml(bg)};color:var(--color-ink,var(--vv-ink));transform-origin:center;overflow:hidden;box-sizing:border-box}
</style>
<script>${kitAndRunner}</script>
</head>
<body>
<div id="vv-motion-stage"></div>
<script>${jsModules.join("\n")}</script>
<script>${filmScript}</script>
<script>${hostLoop}</script>
</body>
</html>`;
}

function renderDesignArtboardHtml(entries: ReadonlyMap<string, ArtifactEntry>, options: RenderStoreOptions): string {
  const dsCss = collectDesignSystemCss(entries, options.defaultTokensJson);
  const targetPath =
    options.path ?? [...entries.keys()].find((p) => p.endsWith(".dc.html") || p.endsWith("/preview.html") || p.endsWith(".html")) ?? "project/main.dc.html";
  const rawSource = rewriteAssetUrls(
    entries.get(targetPath)?.value ?? `<x-dc><main style="padding:32px"><h2>${escapeHtml(targetPath)}</h2></main></x-dc>`,
    entries,
  );

  const dcRuntime = String.raw`(() => {
    const path = ${escapeScriptJson(JSON.stringify(targetPath))};
    const rootDoc = document.documentElement;
    const xdc = document.querySelector("x-dc") || document.body;
    const helmet = document.querySelector("helmet");
    let declaredProps = [];
    const propValues = {};

    const readDeclaredProps = () => {
      const holder = document.querySelector("[data-props]") || helmet || xdc;
      const raw = holder ? holder.getAttribute("data-props") : null;
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    if (helmet) {
      const bodyAttrs = helmet.querySelector("body-attrs");
      if (bodyAttrs) {
        for (const attr of Array.from(bodyAttrs.attributes)) document.body.setAttribute(attr.name, attr.value);
      }
      for (const node of Array.from(helmet.querySelectorAll("style, link"))) document.head.appendChild(node);
      helmet.style.display = "none";
    }

    declaredProps = readDeclaredProps();
    for (const p of declaredProps) {
      if (p && typeof p.name === "string") propValues[p.name] = p.value;
    }

    let logicState = window.DCLogic && typeof window.DCLogic.init === "function" ? window.DCLogic.init(propValues) : {};

    const applyBindings = () => {
      for (const [k, v] of Object.entries(propValues)) {
        const str = String(v);
        rootDoc.setAttribute("data-prop-" + k, str);
        rootDoc.style.setProperty("--prop-" + k, str);
        for (const el of document.querySelectorAll('[data-prop-text="' + k + '"]')) el.textContent = str;
        for (const el of document.querySelectorAll('[data-prop-show="' + k + '"]')) {
          el.style.display = v === false || v === "false" || v === "none" ? "none" : "";
        }
      }
      const derived = window.DCLogic && typeof window.DCLogic.derive === "function" ? window.DCLogic.derive(logicState, propValues) : logicState;
      if (derived && typeof derived === "object") {
        for (const [k, v] of Object.entries(derived)) {
          for (const el of document.querySelectorAll('[data-bind="' + k + '"]')) el.textContent = String(v ?? "");
          for (const el of document.querySelectorAll('[data-if="' + k + '"]')) el.style.display = v ? "" : "none";
        }
      }
    };

    document.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest ? e.target.closest("[data-act]") : null;
      if (!btn || !window.DCLogic || typeof window.DCLogic.act !== "function") return;
      const action = btn.getAttribute("data-act") || "";
      const arg = btn.getAttribute("data-arg") || undefined;
      logicState = window.DCLogic.act(logicState, { type: action, arg }, propValues) || logicState;
      applyBindings();
    });

    addEventListener("message", (e) => {
      if (e.source !== parent || !e.data || typeof e.data !== "object") return;
      if (e.data.vibevalley === "set-props" && e.data.values && typeof e.data.values === "object") {
        Object.assign(propValues, e.data.values);
        applyBindings();
      } else if (e.data.vibevalley === "set-theme" && (e.data.theme === "light" || e.data.theme === "dark")) {
        rootDoc.setAttribute("data-theme", e.data.theme);
      }
    });

    applyBindings();
    parent.postMessage({ vibevalley: "ready", display: "page" }, "*");
    parent.postMessage({ vibevalley: "store-props", path, props: declaredProps }, "*");
  })();`;

  return `<!doctype html>
<html lang="zh" data-theme="${options.theme}">
<head>
<meta charset="utf-8" />
<style>
:root{${themeVariables[options.theme]}${typeVariables}}
${dsCss}
html,body{margin:0;min-height:100%;background:var(--color-surface,var(--vv-page));color:var(--color-ink,var(--vv-ink));font-family:var(--font-sans,var(--vv-font-sans));-webkit-font-smoothing:antialiased}
x-dc{display:block;min-height:100%}
helmet{display:none}
</style>
</head>
<body data-entry-path="${escapeHtml(targetPath)}">
${rawSource}
<script>${selectionScript}</script>
<script>${dcRuntime}</script>
</body>
</html>`;
}

const EmbedEntrySchema = z.object({
  html: z.exactOptional(z.string()),
  state: z.exactOptional(z.record(z.string(), z.unknown())),
});

function renderWhiteboardEmbedHtml(entries: ReadonlyMap<string, ArtifactEntry>, options: RenderStoreOptions): string {
  const dsCss = collectDesignSystemCss(entries, options.defaultTokensJson);
  const elId = options.elementId ?? "";
  const entry = entries.get(`elements/${elId}`);
  let htmlBody = "<div>Embed</div>";
  let savedState: Record<string, unknown> = {};
  if (entry?.value) {
    try {
      const parsed = EmbedEntrySchema.safeParse(JSON.parse(entry.value));
      if (parsed.success) {
        if (parsed.data.html) htmlBody = rewriteAssetUrls(parsed.data.html, entries);
        if (parsed.data.state) savedState = { ...parsed.data.state };
      }
    } catch {
      htmlBody = "<div>Invalid embed JSON</div>";
    }
  }

  const embedRuntime = String.raw`(() => {
    const elementId = ${escapeScriptJson(JSON.stringify(elId))};
    let state = ${escapeScriptJson(JSON.stringify(savedState))};
    window.embed = {
      load: () => structuredClone(state),
      save: (patch) => {
        if (!patch || typeof patch !== "object") return;
        state = Object.assign({}, state, patch);
        parent.postMessage({ vibevalley: "store-embed-save", elementId, state }, "*");
      },
    };
  })();`;

  return `<!doctype html>
<html lang="zh" data-theme="${options.theme}">
<head>
<meta charset="utf-8" />
<style>:root{${themeVariables[options.theme]}${typeVariables}}${dsCss}
html,body{margin:0;height:100%;overflow:auto;background:var(--vv-page);color:var(--vv-ink);font-family:var(--vv-font-sans)}
</style>
<script>${embedRuntime}</script>
</head>
<body>
${htmlBody}
</body>
</html>`;
}

const allowedSvgTags = new Set([
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
]);

const blockedAttrPrefix = /^on/iu;

// Only fragment-local #refs are kept on href and style; external loads and event handlers are stripped.
export function sanitizeWhiteboardSvg(rawSvg: string): string {
  const fragment = parseFragment(rawSvg);
  const cleanNodes = (nodes: P.ChildNode[]): P.ChildNode[] => {
    const kept: P.ChildNode[] = [];
    for (const n of nodes) {
      if ("tagName" in n) {
        const tag = n.tagName.toLowerCase();
        if (!allowedSvgTags.has(tag)) continue;
        n.attrs = n.attrs.filter((a) => {
          const name = a.name.toLowerCase();
          if (blockedAttrPrefix.test(name)) return false;
          if ((name === "href" || name === "xlink:href") && !a.value.trim().startsWith("#")) return false;
          if (name === "style" && /url\s*\(/iu.test(a.value) && !/url\(\s*#/iu.test(a.value)) return false;
          return true;
        });
        n.childNodes = cleanNodes(n.childNodes);
        kept.push(n);
      } else if (n.nodeName === "#text") {
        kept.push(n);
      }
    }
    return kept;
  };
  fragment.childNodes = cleanNodes(fragment.childNodes);
  return serialize(fragment);
}

export function writePropsIntoDcHtml(source: string, updatedValues: Readonly<Record<string, string | number | boolean>>): string {
  return source.replace(/(\bdata-props\s*=\s*)(['"])([\s\S]*?)\2/u, (full, prefix: string, _quote: string, jsonAttr: string) => {
    const unescaped = jsonAttr.replaceAll("&quot;", '"').replaceAll("&#39;", "'").replaceAll("&amp;", "&").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    try {
      const parsed = z.array(StorePropDefSchema).safeParse(JSON.parse(unescaped));
      if (!parsed.success) return full;
      const next = parsed.data.map((item) => {
        const replacement = Object.hasOwn(updatedValues, item.name) ? updatedValues[item.name] : undefined;
        return replacement !== undefined ? { ...item, value: replacement } : item;
      });
      return `${prefix}'${JSON.stringify(next).replaceAll("'", "&#39;")}'`;
    } catch {
      return full;
    }
  });
}

export function renderStoreArtifactHtml(artifactType: ArtifactType | undefined, entriesList: readonly ArtifactEntry[], options: RenderStoreOptions): string {
  const map = new Map(entriesList.map((e) => [e.path, e]));
  if (options.elementId) return renderWhiteboardEmbedHtml(map, options);
  switch (artifactType) {
    case "slides":
      return renderSlidesStoreHtml(map, options);
    case "dashboard":
      return renderDashboardStoreHtml(map, options);
    case "motion":
      return renderMotionStoreHtml(map, options);
    case "design":
    case "design-system":
      return renderDesignArtboardHtml(map, options);
    default:
      return renderDesignArtboardHtml(map, options);
  }
}
