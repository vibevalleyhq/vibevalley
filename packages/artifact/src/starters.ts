import type { ArtifactEntryWriteInput, ArtifactType } from "./store.ts";

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export function starterEntriesForType(type: ArtifactType, title: string): ArtifactEntryWriteInput[] {
  switch (type) {
    case "docs":
      return [];
    case "slides":
      return [
        {
          op: "set",
          path: "project/deck.json",
          kind: "json",
          value: JSON.stringify({
            title,
            aspectRatio: "16:9",
            slides: [
              { id: "s01-cover", file: "s01-cover.html", title: "Cover", notes: "Welcome and agenda." },
              { id: "s02-points", file: "s02-points.html", title: "Key Points", notes: "Walk through each fragment." },
            ],
          }),
        },
        {
          op: "set",
          path: "project/deck.css",
          kind: "text",
          value: `.eyebrow{font-size:22px;letter-spacing:0.12em;text-transform:uppercase;color:var(--color-accent,var(--vv-accent));font-weight:600}\n.kpi-row{display:grid;grid-template-columns:repeat(3,1fr);gap:32px;margin-top:24px}\n.kpi-card{padding:36px;border-radius:16px;background:var(--vv-side);border:1px solid var(--vv-line)}`,
        },
        {
          op: "set",
          path: "project/slides/s01-cover.html",
          kind: "text",
          value: `<div class="slide"><span class="eyebrow">Presentation</span><h1>${esc(title)}</h1><p style="color:var(--vv-muted)">Structured multi-file slide deck</p></div>`,
        },
        {
          op: "set",
          path: "project/slides/s02-points.html",
          kind: "text",
          value: `<div class="slide"><h2>Key Highlights</h2><div class="kpi-row"><div class="kpi-card fragment"><h3>01 · Clarity</h3><p>One core takeaway per slide.</p></div><div class="kpi-card fragment"><h3>02 · Modularity</h3><p>Edit individual slides without rewriting the deck.</p></div><div class="kpi-card fragment"><h3>03 · Ready to Present</h3><p>Presenter notes, step fragments, and PDF print.</p></div></div></div>`,
        },
      ];
    case "dashboard":
      return [
        {
          op: "set",
          path: "datasets/metrics",
          kind: "json",
          value: JSON.stringify([
            { segment: "Core", quarter: "Q1", revenue: 128000, users: 1420 },
            { segment: "Core", quarter: "Q2", revenue: 164000, users: 1890 },
            { segment: "Growth", quarter: "Q1", revenue: 62000, users: 810 },
            { segment: "Growth", quarter: "Q2", revenue: 94000, users: 1240 },
          ]),
        },
        {
          op: "set",
          path: "dash/params",
          kind: "json",
          value: JSON.stringify({ quarter: "all" }),
        },
        {
          op: "set",
          path: "files/index.html",
          kind: "text",
          value: `<div style="padding:clamp(16px,3vw,28px) clamp(16px,3vw,32px);max-width:1100px;margin:0 auto;box-sizing:border-box">
  <div style="display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;margin-bottom:20px">
    <div>
      <h1 style="margin:0;font-size:24px">${esc(title)}</h1>
      <p style="margin:4px 0 0;font-size:13px;color:var(--vv-muted)">Every KPI carries data-source provenance</p>
    </div>
    <select id="q-filter" style="padding:6px 12px;border-radius:8px;border:1px solid var(--vv-line);background:var(--vv-side);color:var(--vv-ink)">
      <option value="all">All Quarters</option>
      <option value="Q1">Q1</option>
      <option value="Q2">Q2</option>
    </select>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:14px;margin-bottom:20px">
    <div style="padding:18px;border-radius:12px;background:var(--vv-side);border:1px solid var(--vv-line)">
      <div style="font-size:12px;color:var(--vv-muted)">Total Revenue</div>
      <div id="kpi-rev" data-source="metrics" data-field="revenue" data-agg="sum" style="font-size:28px;font-weight:700;margin-top:6px">0</div>
    </div>
    <div style="padding:18px;border-radius:12px;background:var(--vv-side);border:1px solid var(--vv-line)">
      <div style="font-size:12px;color:var(--vv-muted)">Active Users</div>
      <div id="kpi-users" data-source="metrics" data-field="users" data-agg="sum" style="font-size:28px;font-weight:700;margin-top:6px">0</div>
    </div>
    <div style="padding:18px;border-radius:12px;background:var(--vv-side);border:1px solid var(--vv-line)">
      <div style="font-size:12px;color:var(--vv-muted)">Records</div>
      <div id="kpi-count" data-source="metrics" data-field="revenue" data-agg="count" style="font-size:28px;font-weight:700;margin-top:6px">0</div>
    </div>
  </div>
  <div id="bars" style="display:flex;flex-direction:column;gap:12px;padding:18px;border-radius:12px;background:var(--vv-side);border:1px solid var(--vv-line)"></div>
</div>
<script>
(() => {
  const select = document.getElementById("q-filter");
  const draw = () => {
    const all = dash.data("metrics");
    const q = dash.params.quarter || "all";
    select.value = q;
    const rows = q === "all" ? all : all.filter((r) => r.quarter === q);
    const rev = dash.calc.sum(rows, "revenue");
    const users = dash.calc.sum(rows, "users");
    document.getElementById("kpi-rev").textContent = "$" + dash.calc.formatNumber(rev);
    document.getElementById("kpi-users").textContent = dash.calc.formatNumber(users);
    document.getElementById("kpi-count").textContent = String(rows.length);
    const maxRev = Math.max(1, dash.calc.max(rows, "revenue"));
    document.getElementById("bars").innerHTML = rows.map((r) =>
      '<div style="display:grid;grid-template-columns:minmax(84px,130px) minmax(48px,1fr) auto;align-items:center;gap:10px;font-size:13px">' +
      '<span>' + r.segment + ' · ' + r.quarter + '</span>' +
      '<div style="height:10px;border-radius:5px;background:var(--vv-line);overflow:hidden"><div style="height:100%;width:' + Math.round((r.revenue / maxRev) * 100) + '%;background:' + dash.colors.accent + '"></div></div>' +
      '<span style="text-align:right;font-variant-numeric:tabular-nums">$' + dash.calc.formatNumber(r.revenue) + '</span></div>'
    ).join("");
    dash.scan();
  };
  select.addEventListener("change", () => dash.setParams({ quarter: select.value }));
  dash.onData(draw);
  dash.onParams(draw);
  draw();
})();
</script>`,
        },
      ];
    case "motion":
      return [
        {
          op: "set",
          path: "film/meta",
          kind: "json",
          value: JSON.stringify({
            title,
            width: 1280,
            height: 720,
            fps: 30,
            duration: 4,
            background: "#151413",
            chapters: [
              { at: 0, label: "Intro" },
              { at: 2, label: "Resolve" },
            ],
          }),
        },
        {
          op: "set",
          path: "modules/scenes.json",
          kind: "json",
          value: JSON.stringify([
            { id: "intro", duration: 2, headline: title },
            { id: "resolve", duration: 2, headline: "Pure-time Motion" },
          ]),
        },
        {
          op: "set",
          path: "film/script",
          kind: "text",
          value: `window.CUT = {
  duration: 4,
  fps: 30,
  setup(stage, kit) {
    const canvas = document.createElement("canvas");
    canvas.width = kit.width;
    canvas.height = kit.height;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    stage.innerHTML = "";
    stage.appendChild(canvas);
    this.ctx = canvas.getContext("2d");
  },
  render(t, _stage, kit) {
    const ctx = this.ctx;
    if (!ctx) return;
    const scenes = kit.module("scenes") || [];
    const cur = kit.sceneAt(scenes, t);
    const enter = kit.ease.outCubic(kit.clamp((cur.local + 0.18) / 0.6));
    ctx.fillStyle = "#151413";
    ctx.fillRect(0, 0, kit.width, kit.height);
    ctx.save();
    ctx.translate(kit.width / 2, kit.height / 2 + (1 - enter) * 24);
    ctx.globalAlpha = 0.82 + 0.18 * enter;
    ctx.fillStyle = "#7fae4f";
    ctx.beginPath();
    ctx.arc(0, -84, 28 + 10 * Math.sin(t * Math.PI), 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ecebe8";
    ctx.font = "700 56px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(cur.scene ? cur.scene.headline : "Motion", 0, 12);
    ctx.fillStyle = "#a9a49e";
    ctx.font = "500 22px ui-monospace, monospace";
    ctx.fillText("t = " + t.toFixed(2) + "s", 0, 62);
    ctx.restore();
  }
};`,
        },
      ];
    case "whiteboard":
      return [
        {
          op: "set",
          path: "board/meta",
          kind: "json",
          value: JSON.stringify({ title, mode: "board", grid: true }),
        },
        {
          op: "set",
          path: "elements/node-1",
          kind: "json",
          value: JSON.stringify({
            id: "node-1",
            type: "shape",
            shape: "rect",
            x: 120,
            y: 140,
            w: 200,
            h: 84,
            label: "Input Signal",
            fill: "leaf",
          }),
        },
        {
          op: "set",
          path: "elements/node-2",
          kind: "json",
          value: JSON.stringify({
            id: "node-2",
            type: "shape",
            shape: "rect",
            x: 440,
            y: 140,
            w: 220,
            h: 84,
            label: "Structured Store",
            fill: "water",
          }),
        },
        {
          op: "set",
          path: "elements/edge-1",
          kind: "json",
          value: JSON.stringify({
            id: "edge-1",
            type: "arrow",
            from: { id: "node-1", side: "e" },
            to: { id: "node-2", side: "w" },
            label: "ifRev batch",
            bends: [],
          }),
        },
      ];
    case "design":
      return [
        {
          op: "set",
          path: "project/canvas.json",
          kind: "json",
          value: JSON.stringify({
            title,
            artboards: [
              { id: "desktop", name: "Desktop Overview", file: "project/desktop.dc.html", x: 0, y: 0, w: 960, h: 600 },
              { id: "mobile", name: "Mobile Card", file: "project/mobile.dc.html", x: 1020, y: 0, w: 390, h: 600 },
            ],
          }),
        },
        {
          op: "set",
          path: "project/desktop.dc.html",
          kind: "text",
          value: `<x-dc data-props='[{"name":"density","label":"Density","type":"select","options":["comfortable","compact"],"value":"comfortable"},{"name":"cta","label":"Primary CTA","type":"text","value":"Launch Workspace"}]'>
  <helmet>
    <style>
      .board{padding:40px;display:flex;flex-direction:column;gap:24px}
      html[data-prop-density="compact"] .board{padding:20px;gap:12px}
      .hero{padding:32px;border-radius:16px;background:var(--vv-side);border:1px solid var(--vv-line);display:flex;justify-content:space-between;align-items:center}
      .cta{padding:10px 20px;border-radius:10px;border:none;background:var(--vv-accent);color:#fff;font-weight:600;cursor:pointer}
    </style>
  </helmet>
  <div class="board">
    <div class="hero">
      <div>
        <h1 style="margin:0;font-size:28px">${esc(title)}</h1>
        <p style="margin:6px 0 0;color:var(--vv-muted)">Interactive artboard with live property levers</p>
      </div>
      <button class="cta" data-act="bump"><span data-prop-text="cta">Launch Workspace</span> (<span data-bind="clicks">0</span>)</button>
    </div>
  </div>
  <script>
    window.DCLogic = {
      init: () => ({ clicks: 0 }),
      act: (state, action) => action.type === "bump" ? { clicks: (state.clicks || 0) + 1 } : state,
      derive: (state) => ({ clicks: state.clicks || 0 }),
    };
  </script>
</x-dc>`,
        },
        {
          op: "set",
          path: "project/mobile.dc.html",
          kind: "text",
          value: `<x-dc data-props='[{"name":"badge","label":"Badge","type":"text","value":"LIVE"}]'>
  <div style="padding:24px;display:flex;flex-direction:column;gap:16px">
    <span data-prop-text="badge" style="align-self:flex-start;padding:4px 10px;border-radius:999px;background:var(--vv-accent);color:#fff;font-size:11px;font-weight:700">LIVE</span>
    <h2 style="margin:0;font-size:22px">${esc(title)}</h2>
    <p style="margin:0;color:var(--vv-muted);font-size:14px">Companion mobile artboard on the shared canvas.</p>
  </div>
</x-dc>`,
        },
      ];
    case "design-system":
      return [
        {
          op: "set",
          path: "project/design-system.json",
          kind: "json",
          value: JSON.stringify({
            name: title,
            version: "1.0.0",
            components: [{ id: "Button", title: "Button", preview: "project/components/Button/preview.html" }],
          }),
        },
        {
          op: "set",
          path: "project/tokens.json",
          kind: "json",
          value: JSON.stringify({
            themes: ["light", "dark"],
            defaultTheme: "light",
            color: [
              { id: "surface", group: "surface", value: { light: "#fcfcfb", dark: "#151413" }, note: "Primary page background" },
              { id: "panel", group: "surface", value: { light: "#f6f5f3", dark: "#1b1a18" }, note: "Elevated card surface" },
              { id: "ink", group: "text", value: { light: "#1c1917", dark: "#ecebe8" }, note: "Primary body text" },
              { id: "muted", group: "text", value: { light: "#5e5852", dark: "#a9a49e" }, note: "Secondary supporting copy" },
              { id: "accent", group: "brand", value: { light: "#4d7a2a", dark: "#7fae4f" }, note: "Primary brand action" },
              { id: "warning", group: "status", value: { light: "#b9770e", dark: "#e5a93c" }, note: "Attention state" },
            ],
            type: {
              families: [
                { id: "sans", value: "system-ui, -apple-system, sans-serif", note: "UI & headings" },
                { id: "mono", value: "Menlo, ui-monospace, monospace", note: "Code & figures" },
              ],
              scale: [
                { id: "sm", value: "13px" },
                { id: "md", value: "15px" },
                { id: "xl", value: "28px" },
              ],
              styles: [
                { id: "display", family: "{sans}", size: "{xl}", weight: 700, lineHeight: 1.15, sample: title },
                {
                  id: "body",
                  family: "{sans}",
                  size: "{md}",
                  weight: 400,
                  lineHeight: 1.55,
                  sample: "Tokens compile to CSS custom properties in light and dark themes.",
                },
              ],
            },
            space: [
              { id: "2", value: "8px" },
              { id: "4", value: "16px" },
              { id: "6", value: "24px" },
            ],
            radius: [
              { id: "md", value: "8px" },
              { id: "lg", value: "14px" },
            ],
          }),
        },
        {
          op: "set",
          path: "project/README.md",
          kind: "text",
          value: `# ${title}\n\nStanding design tokens, typography specimens, and reusable component previews. Toggle **Set as default design system** so new Slide Decks, Dashboards, and Design Canvases inherit these tokens automatically.`,
        },
        {
          op: "set",
          path: "project/components/Button/preview.html",
          kind: "text",
          value: `<div style="padding:32px;display:flex;gap:16px;align-items:center;flex-wrap:wrap">
  <button style="padding:10px 18px;border-radius:var(--radius-md,8px);border:none;background:var(--color-accent);color:#fff;font-weight:600">Primary Action</button>
  <button style="padding:10px 18px;border-radius:var(--radius-md,8px);border:1px solid var(--vv-line);background:var(--color-panel);color:var(--color-ink);font-weight:500">Secondary</button>
</div>`,
        },
      ];
  }
}
