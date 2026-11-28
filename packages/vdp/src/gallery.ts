import type { z } from "zod";

import type { ScenarioManifestSchema } from "./dsl.ts";

type ScenarioManifest = z.infer<typeof ScenarioManifestSchema>;

function escapeHtml(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderScenarioGalleryHtml(manifest: ScenarioManifest): string {
  const shots = manifest.scenarios.flatMap((s) => s.shots);
  const recordings = manifest.scenarios.flatMap((s) => s.recordings ?? []);
  const themeButtons = ["all", ...manifest.themes]
    .map(
      (theme) =>
        `<button type="button" class="filter-btn${theme === "all" ? " active" : ""}" data-filter-theme="${escapeHtml(theme)}">${escapeHtml(theme)}</button>`,
    )
    .join("");

  const cards = shots
    .map((shot) => {
      const kb = Math.max(1, Math.round(shot.bytes / 1024));
      const frame = shot.lastFrameMs != null ? `${shot.lastFrameMs.toFixed(1)}ms` : "n/a";
      const badge = shot.shellErrors.length === 0 ? '<span class="badge ok">CLEAN</span>' : `<span class="badge fail">${shot.shellErrors.length} ERR</span>`;
      const errBlock =
        shot.shellErrors.length > 0 ? `<div class="shot-errors">${shot.shellErrors.map((e) => `<div>${escapeHtml(e)}</div>`).join("")}</div>` : "";
      return `<figure class="shot-card" data-theme="${escapeHtml(shot.theme)}">
        <a href="${escapeHtml(shot.relPath)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(shot.relPath)}" alt="${escapeHtml(`${shot.id} (${shot.theme})`)}" loading="lazy" /></a>
        <figcaption>
          <div class="shot-head"><strong>${escapeHtml(shot.id)}</strong><div class="shot-badges"><span class="badge theme">${escapeHtml(shot.theme)}</span>${badge}</div></div>
          <div class="shot-label">${escapeHtml(shot.label)}</div>
          <div class="shot-route"><code>${escapeHtml(shot.route)}</code></div>
          <div class="shot-meta"><span>${shot.width}×${shot.height}</span><span>${kb} KB</span><span>${shot.durationMs}ms</span><span>${shot.uiNodeCount} nodes</span><span>frame ${escapeHtml(frame)}</span></div>
          ${errBlock}
        </figcaption>
      </figure>`;
    })
    .join("\n");

  const recordingSection =
    recordings.length === 0
      ? ""
      : `<section class="recordings"><h2>Playback Recordings</h2><div class="gallery">${recordings
          .map((rec) => {
            const media =
              rec.videoRelPath !== null
                ? `<video controls loop playsinline preload="metadata" src="${escapeHtml(rec.videoRelPath)}"></video>`
                : rec.framesRelPaths[0] !== undefined
                  ? `<img src="${escapeHtml(rec.framesRelPaths[0])}" alt="${escapeHtml(rec.label)}" loading="lazy" />`
                  : "";
            const sizeLabel = rec.videoBytes !== null ? `${Math.max(1, Math.round(rec.videoBytes / 1024))} KB` : "frames-only";
            return `<figure class="shot-card">${media}<figcaption>
              <div class="shot-head"><strong>${escapeHtml(rec.id)}</strong><span class="badge ok">${rec.frameCount} FRAMES @ ${rec.fps} FPS</span></div>
              <div class="shot-label">${escapeHtml(rec.label)}</div>
              <div class="shot-meta"><span>${rec.durationMs}ms</span><span>${escapeHtml(sizeLabel)}</span></div>
            </figcaption></figure>`;
          })
          .join("\n")}</div></section>`;

  const scenarioFailures = manifest.scenarios
    .filter((s) => s.error !== null)
    .map((s) => `<div class="banner-err"><strong>${escapeHtml(s.id)}</strong>: ${escapeHtml(s.error ?? "")}</div>`)
    .join("\n");

  const totalMb = (manifest.summary.totalBytes / (1024 * 1024)).toFixed(2);
  const totalSec = (manifest.durationMs / 1000).toFixed(1);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VibeValley VDP Scenario Report</title>
  <style>
    :root { --bg: #f6f5f0; --surface: #ffffff; --border: #e5e2da; --ink: #1f1e1a; --muted: #6c685d; --accent: #3d6b2c; --accent-soft: #e7f3e3; --ok-bg: #e7f3e3; --ok-ink: #27581d; --fail-bg: #fde8e8; --fail-ink: #991b1b; }
    @media (prefers-color-scheme: dark) { :root { --bg: #171714; --surface: #201f1b; --border: #34322b; --ink: #ece9df; --muted: #a19c8e; --accent: #74b457; --accent-soft: #1f331b; --ok-bg: #1f331b; --ok-ink: #9be084; --fail-bg: #3b1c1c; --fail-ink: #fca5a5; } }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; background: var(--bg); color: var(--ink); line-height: 1.5; }
    main { max-width: 1480px; margin: 0 auto; padding: 28px 24px 64px; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    h2 { font-size: 16px; margin: 22px 0 12px; }
    .meta { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 18px; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
    .kpi .label { font-size: 12px; color: var(--muted); }
    .kpi .val { font-size: 20px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .banner-err { background: var(--fail-bg); color: var(--fail-ink); padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; font-size: 13px; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 16px; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
    .filter-btn { appearance: none; border: 1px solid var(--border); background: transparent; color: var(--ink); font-size: 12px; padding: 4px 10px; border-radius: 999px; cursor: pointer; font-family: ui-monospace, SFMono-Regular, monospace; }
    .filter-btn.active { background: var(--accent-soft); border-color: var(--accent); color: var(--ok-ink); font-weight: 600; }
    .count { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(420px, 1fr)); gap: 16px; }
    .shot-card { margin: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .shot-card.hidden { display: none; }
    .shot-card img, .shot-card video { width: 100%; display: block; border-bottom: 1px solid var(--border); background: #111; }
    .shot-card figcaption { padding: 10px 12px; font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 5px; }
    .shot-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .shot-head strong { color: var(--ink); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
    .shot-label { color: var(--ink); font-size: 12px; }
    .shot-badges { display: flex; gap: 6px; align-items: center; }
    .shot-route code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; background: rgba(127, 127, 127, 0.12); padding: 1px 5px; border-radius: 4px; color: var(--ink); }
    .shot-meta { display: flex; flex-wrap: wrap; gap: 10px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
    .shot-errors { background: var(--fail-bg); color: var(--fail-ink); padding: 6px 8px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
    .badge.ok { background: var(--ok-bg); color: var(--ok-ink); }
    .badge.fail { background: var(--fail-bg); color: var(--fail-ink); }
    .badge.theme { background: rgba(127, 127, 127, 0.14); color: var(--ink); }
  </style></head><body><main>
    <h1>VibeValley VDP Scenario Report</h1>
    <div class="meta">Generated ${escapeHtml(manifest.generatedAt)} · ${manifest.viewport.width}×${manifest.viewport.height} · ${totalSec}s · <code>${escapeHtml(manifest.outDir)}</code></div>
    ${scenarioFailures}
    <section class="kpis">
      <div class="kpi"><div class="label">Scenarios</div><div class="val">${manifest.summary.passedScenarios} / ${manifest.summary.totalScenarios}</div></div>
      <div class="kpi"><div class="label">Captured Shots</div><div class="val">${manifest.summary.totalShots}</div></div>
      <div class="kpi"><div class="label">Checks</div><div class="val">${manifest.summary.totalChecks - manifest.summary.failedChecks} / ${manifest.summary.totalChecks}</div></div>
      <div class="kpi"><div class="label">Recordings</div><div class="val">${recordings.length}</div></div>
      <div class="kpi"><div class="label">Shell Errors</div><div class="val">${manifest.summary.totalErrors}</div></div>
      <div class="kpi"><div class="label">Total PNG Size</div><div class="val">${totalMb} MB</div></div>
    </section>
    ${recordingSection}
    <div class="toolbar" id="filter-bar">${themeButtons}<span class="count" id="filter-count">Showing ${shots.length} / ${shots.length}</span></div>
    <section class="gallery" id="gallery">${cards}</section>
  </main><script>(() => {
    const buttons = Array.from(document.querySelectorAll("#filter-bar .filter-btn"));
    const cards = Array.from(document.querySelectorAll("#gallery .shot-card"));
    const countEl = document.getElementById("filter-count");
    let active = "all";
    function update() {
      let shown = 0;
      for (const card of cards) {
        const ok = active === "all" || card.getAttribute("data-theme") === active;
        card.classList.toggle("hidden", !ok);
        if (ok) shown++;
      }
      if (countEl) countEl.textContent = "Showing " + shown + " / " + cards.length;
    }
    for (const btn of buttons) {
      btn.addEventListener("click", () => {
        active = btn.getAttribute("data-filter-theme") || "all";
        for (const b of buttons) b.classList.toggle("active", b === btn);
        update();
      });
    }
  })();</script></body></html>`;
}
