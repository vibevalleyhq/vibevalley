import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import {
  captureVdpScreenshot,
  CreatedEntitySchema,
  countUiTreeNodes,
  ensureVdpArtifactsBuilt,
  extractShellErrors,
  isReviewTheme,
  parseJsonOutput,
  parsePositiveInt,
  REVIEW_THEMES,
  resolveVdpWorkspacePaths,
  runChecked,
  runSoft,
  type ReviewTheme,
  withVdpSandbox,
  writeTempPayload,
} from "./vdp-client.ts";

export { countUiTreeNodes, extractShellErrors, isReviewTheme, REVIEW_THEMES, type ReviewTheme };

export interface ReviewOptions {
  readonly outDir: string;
  readonly themes: readonly ReviewTheme[];
  readonly width: number;
  readonly height: number;
  readonly skipBuild: boolean;
  readonly keepSandbox: boolean;
  readonly help: boolean;
}

export interface SeededWorkspaceIds {
  readonly firstIssueId: string;
  readonly issueIds: readonly string[];
  readonly agentIds: readonly string[];
  readonly channelIds: readonly string[];
  readonly notes: {
    readonly doc: string;
    readonly base: string;
    readonly canvas: string;
    readonly media: string;
  };
}

export interface ScreenSpec {
  readonly id: string;
  readonly label: string;
  readonly route: string;
  readonly target?: "shell" | "webview";
  readonly waitTestId?: string;
  readonly settleMs: number;
}

export interface ScreenPlanEntry extends ScreenSpec {
  readonly theme: ReviewTheme;
  readonly fileName: string;
}

export const ScreenCaptureSchema = z.object({
  id: z.string(),
  label: z.string(),
  route: z.string(),
  theme: z.enum(REVIEW_THEMES),
  pngPath: z.string(),
  relPath: z.string(),
  bytes: z.number().int().nonnegative(),
  imageWidth: z.number().int().nonnegative(),
  imageHeight: z.number().int().nonnegative(),
  metrics: z
    .object({
      width: z.number(),
      height: z.number(),
      scaleFactor: z.number(),
      themeDark: z.boolean(),
      lastFrameMs: z.number().nullable(),
    })
    .nullable(),
  uiNodeCount: z.number().int().nonnegative(),
  uiRoute: z.string().nullable(),
  shellRoute: z.string().nullable(),
  shellErrors: z.array(z.string()),
});

export type ScreenCapture = z.infer<typeof ScreenCaptureSchema>;

export const ReviewManifestSchema = z.object({
  generatedAt: z.string(),
  outDir: z.string(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  themes: z.array(z.enum(REVIEW_THEMES)),
  seeded: z.object({
    firstIssueId: z.string(),
    issueIds: z.array(z.string()),
    agentIds: z.array(z.string()),
    channelIds: z.array(z.string()),
    notes: z.object({
      doc: z.string(),
      base: z.string(),
      canvas: z.string(),
      media: z.string(),
    }),
  }),
  screens: z.array(ScreenCaptureSchema),
  summary: z.object({
    totalScreens: z.number().int().nonnegative(),
    totalErrors: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
  }),
});

export type ReviewManifest = z.infer<typeof ReviewManifestSchema>;

function parseThemeList(raw: string): ReviewTheme[] {
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`--themes requires at least one theme (${REVIEW_THEMES.join(", ")})`);
  }
  const themes: ReviewTheme[] = [];
  for (const part of parts) {
    if (!isReviewTheme(part)) {
      throw new Error(`unsupported theme "${part}" (supported: ${REVIEW_THEMES.join(", ")})`);
    }
    if (!themes.includes(part)) themes.push(part);
  }
  return themes;
}

export function parseReviewArgs(argv: readonly string[], cwd = process.cwd()): ReviewOptions {
  let outDir = "/tmp/vv-ux-review";
  let themes: ReviewTheme[] = [...REVIEW_THEMES];
  let width = 1280;
  let height = 840;
  let skipBuild = false;
  let keepSandbox = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--skip-build") {
      skipBuild = true;
    } else if (arg === "--keep-sandbox") {
      keepSandbox = true;
    } else if (arg === "--out") {
      const next = argv[++i];
      if (!next) throw new Error("--out requires a directory path");
      outDir = resolve(cwd, next);
    } else if (arg.startsWith("--out=")) {
      const val = arg.slice("--out=".length);
      if (!val) throw new Error("--out requires a directory path");
      outDir = resolve(cwd, val);
    } else if (arg === "--themes") {
      const next = argv[++i];
      if (!next) throw new Error("--themes requires a comma-separated list");
      themes = parseThemeList(next);
    } else if (arg.startsWith("--themes=")) {
      themes = parseThemeList(arg.slice("--themes=".length));
    } else if (arg === "--width") {
      const next = argv[++i];
      if (!next) throw new Error("--width requires a pixel value");
      width = parsePositiveInt("--width", next);
    } else if (arg.startsWith("--width=")) {
      width = parsePositiveInt("--width", arg.slice("--width=".length));
    } else if (arg === "--height") {
      const next = argv[++i];
      if (!next) throw new Error("--height requires a pixel value");
      height = parsePositiveInt("--height", next);
    } else if (arg.startsWith("--height=")) {
      height = parsePositiveInt("--height", arg.slice("--height=".length));
    } else {
      throw new Error(`unknown option "${arg}" (run with --help for usage)`);
    }
  }

  return { outDir, themes, width, height, skipBuild, keepSandbox, help };
}

export function buildScreenMatrix(ids: SeededWorkspaceIds, themes: readonly ReviewTheme[]): ScreenPlanEntry[] {
  const baseScreens: readonly ScreenSpec[] = [
    { id: "issues", label: "Issues Board", route: "/issues", settleMs: 550 },
    { id: "issue-detail", label: "Issue Detail", route: `/issues/${ids.firstIssueId}`, settleMs: 550 },
    { id: "chat", label: "Chat Channels", route: "/chat", settleMs: 550 },
    { id: "runs", label: "Runs & Trajectories", route: "/runs", waitTestId: "runs-page", settleMs: 500 },
    { id: "agents", label: "Agents Roster", route: "/agents", settleMs: 500 },
    { id: "runtimes", label: "Runtimes & Engines", route: "/runtimes", waitTestId: "runtimes-page", settleMs: 500 },
    { id: "library", label: "Library & Notes", route: "/library", waitTestId: "library-page", settleMs: 650 },
    { id: "note-doc", label: "Note · Block Doc", route: `/notes/${ids.notes.doc}`, waitTestId: "note-block-doc-view", settleMs: 700 },
    { id: "note-base", label: "Note · Base", route: `/notes/${ids.notes.base}`, waitTestId: "note-base-view", settleMs: 700 },
    { id: "note-canvas", label: "Note · Canvas", route: `/notes/${ids.notes.canvas}`, waitTestId: "note-canvas-view", settleMs: 1200 },
    { id: "note-media", label: "Note · Media", route: `/notes/${ids.notes.media}`, waitTestId: "note-media-view", settleMs: 700 },
    { id: "settings", label: "Settings", route: "/settings", settleMs: 550 },
    { id: "farm", label: "Papertrails Farm", route: "/farm", settleMs: 900 },
  ];

  const entries: ScreenPlanEntry[] = [];
  for (const theme of themes) {
    for (const screen of baseScreens) {
      entries.push({ ...screen, theme, fileName: `${screen.id}-${theme}.png` });
    }
  }
  return entries;
}

function escapeHtml(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderContactSheetHtml(manifest: ReviewManifest): string {
  const themeButtons = ["all", ...manifest.themes]
    .map(
      (theme) =>
        `<button type="button" class="filter-btn${theme === "all" ? " active" : ""}" data-filter-theme="${escapeHtml(theme)}">${escapeHtml(theme)}</button>`,
    )
    .join("");

  const cards = manifest.screens
    .map((screen) => {
      const kb = Math.max(1, Math.round(screen.bytes / 1024));
      const frame = screen.metrics?.lastFrameMs != null ? `${screen.metrics.lastFrameMs.toFixed(1)}ms` : "n/a";
      const statusBadge =
        screen.shellErrors.length === 0 ? '<span class="badge ok">CLEAN</span>' : `<span class="badge fail">${screen.shellErrors.length} ERR</span>`;
      const errBlock =
        screen.shellErrors.length > 0 ? `<div class="shot-errors">${screen.shellErrors.map((e) => `<div>${escapeHtml(e)}</div>`).join("")}</div>` : "";
      return `<figure class="shot-card" data-theme="${escapeHtml(screen.theme)}" data-screen="${escapeHtml(screen.id)}">
        <a href="${escapeHtml(screen.relPath)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(screen.relPath)}" alt="${escapeHtml(`${screen.label} (${screen.theme})`)}" loading="lazy" /></a>
        <figcaption>
          <div class="shot-head"><strong>${escapeHtml(screen.id)}</strong><div class="shot-badges"><span class="badge theme">${escapeHtml(screen.theme)}</span>${statusBadge}</div></div>
          <div class="shot-route"><code>${escapeHtml(screen.route)}</code></div>
          <div class="shot-meta"><span>${screen.imageWidth}×${screen.imageHeight}</span><span>${kb} KB</span><span>${screen.uiNodeCount} UI nodes</span><span>frame ${escapeHtml(frame)}</span></div>
          ${errBlock}
        </figcaption>
      </figure>`;
    })
    .join("\n");

  const totalMb = (manifest.summary.totalBytes / (1024 * 1024)).toFixed(2);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VibeValley VDP UX Review Contact Sheet</title>
  <style>
    :root { --bg: #f6f5f0; --surface: #ffffff; --border: #e5e2da; --ink: #1f1e1a; --muted: #6c685d; --accent: #3d6b2c; --accent-soft: #e7f3e3; --ok-bg: #e7f3e3; --ok-ink: #27581d; --fail-bg: #fde8e8; --fail-ink: #991b1b; }
    @media (prefers-color-scheme: dark) { :root { --bg: #171714; --surface: #201f1b; --border: #34322b; --ink: #ece9df; --muted: #a19c8e; --accent: #74b457; --accent-soft: #1f331b; --ok-bg: #1f331b; --ok-ink: #9be084; --fail-bg: #3b1c1c; --fail-ink: #fca5a5; } }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif; background: var(--bg); color: var(--ink); line-height: 1.5; }
    main { max-width: 1440px; margin: 0 auto; padding: 28px 24px 64px; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    .meta { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; }
    .kpi .label { font-size: 12px; color: var(--muted); }
    .kpi .val { font-size: 20px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 16px; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
    .filter-btn { appearance: none; border: 1px solid var(--border); background: transparent; color: var(--ink); font-size: 12px; padding: 4px 10px; border-radius: 999px; cursor: pointer; font-family: ui-monospace, SFMono-Regular, monospace; }
    .filter-btn.active { background: var(--accent-soft); border-color: var(--accent); color: var(--ok-ink); font-weight: 600; }
    .count { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 16px; }
    .shot-card { margin: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .shot-card.hidden { display: none; }
    .shot-card img { width: 100%; display: block; border-bottom: 1px solid var(--border); background: #111; }
    .shot-card figcaption { padding: 10px 12px; font-size: 12px; color: var(--muted); display: flex; flex-direction: column; gap: 6px; }
    .shot-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .shot-head strong { color: var(--ink); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 13px; }
    .shot-badges { display: flex; gap: 6px; align-items: center; }
    .shot-route code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; background: rgba(127, 127, 127, 0.12); padding: 1px 5px; border-radius: 4px; color: var(--ink); }
    .shot-meta { display: flex; flex-wrap: wrap; gap: 10px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; font-variant-numeric: tabular-nums; }
    .shot-errors { background: var(--fail-bg); color: var(--fail-ink); padding: 6px 8px; border-radius: 6px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 11px; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10px; font-weight: 600; text-transform: uppercase; }
    .badge.ok { background: var(--ok-bg); color: var(--ok-ink); }
    .badge.fail { background: var(--fail-bg); color: var(--fail-ink); }
    .badge.theme { background: rgba(127, 127, 127, 0.14); color: var(--ink); }
  </style></head><body><main>
    <h1>VibeValley Live VDP UX Review</h1>
    <div class="meta">Generated ${escapeHtml(manifest.generatedAt)} · Viewport ${manifest.viewport.width}×${manifest.viewport.height} · Output <code>${escapeHtml(manifest.outDir)}</code></div>
    <section class="kpis">
      <div class="kpi"><div class="label">Captured Screens</div><div class="val">${manifest.summary.totalScreens}</div></div>
      <div class="kpi"><div class="label">Themes</div><div class="val">${escapeHtml(manifest.themes.join(" / "))}</div></div>
      <div class="kpi"><div class="label">Shell / View Errors</div><div class="val">${manifest.summary.totalErrors}</div></div>
      <div class="kpi"><div class="label">Total PNG Size</div><div class="val">${totalMb} MB</div></div>
    </section>
    <div class="toolbar" id="filter-bar">${themeButtons}<span class="count" id="filter-count">Showing ${manifest.screens.length} / ${manifest.screens.length}</span></div>
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

function seedRealisticWorkspace(cliBin: string, root: string, cliEnv: NodeJS.ProcessEnv, payloadDir: string): SeededWorkspaceIds {
  const vv = (args: readonly string[]): string => runChecked(cliBin, args, { cwd: root, env: cliEnv, capture: true, timeoutMs: 30_000 });
  const vvJson = <T>(args: readonly string[], schema: z.ZodType<T>, label: string): T => parseJsonOutput(vv([...args, "--json"]), schema, label);

  const agentSpecs = [
    { name: "Ada", runtime: "vibevalley", role: "worker", duty: "Core Rust architecture, VDP transport, and state projections" },
    { name: "Milo", runtime: "claude", role: "worker", duty: "Desktop GPUI & nsh UI polish, Papertrails design tokens, and interaction tests" },
    { name: "Sora", runtime: "codex", role: "worker", duty: "Collaborative notes, traceable SLO dashboards, and interactive previews" },
  ] as const;

  const agentIds = agentSpecs.map(
    (s) => vvJson(["agent", "create", s.name, "--runtime", s.runtime, "--role", s.role, "--duty", s.duty], CreatedEntitySchema, `agent create ${s.name}`).id,
  );
  const [adaId, miloId, soraId] = agentIds;

  const repoName = "vibevalley";
  runSoft(cliBin, ["repo", "create", repoName], { cwd: root, env: cliEnv, timeoutMs: 20_000 });

  const uploadAsset = (relPath: string, name: string): string | undefined => {
    const absPath = resolve(root, relPath);
    if (!existsSync(absPath)) return undefined;
    const res = runSoft(cliBin, ["attachment", "upload", absPath, "--name", name, "--json"], { cwd: root, env: cliEnv, timeoutMs: 20_000 });
    if (!res.ok) return undefined;
    try {
      return parseJsonOutput(res.stdout, CreatedEntitySchema, `attachment upload ${name}`).id;
    } catch {
      return undefined;
    }
  };
  const beforeImgId = uploadAsset("assets/site/hero-morning-960.webp", "issues-board-before.webp");
  const afterImgId = uploadAsset("assets/site/hero-day-960.webp", "issues-board-after.webp");
  const previewImgId = uploadAsset("assets/site/hero-evening-960.webp", "papertrails-tokens-preview.webp");

  const compareBlock =
    beforeImgId && afterImgId
      ? `\n\`\`\`compare\n${JSON.stringify(
          {
            title: "Issues Board & Preview-First Detail Polish",
            before: { attachment: beforeImgId, label: "Before (Raw Form)" },
            after: { attachment: afterImgId, label: "After (Preview-First)" },
            annotations: [
              { n: 1, side: "after", rect: [0.08, 0.14, 0.42, 0.24], tone: "fixed", note: "Kanban cards render crisp image thumbnails with compare badge" },
              { n: 2, side: "after", rect: [0.54, 0.22, 0.36, 0.28], tone: "note", note: "Preview-first markdown + visual criteria checklist" },
            ],
          },
          null,
          2,
        )}\n\`\`\``
      : "";

  const issueSpecs: readonly {
    readonly title: string;
    readonly priority: "urgent" | "high" | "medium" | "low";
    readonly status: "backlog" | "todo" | "in_progress" | "in_review" | "done" | "canceled";
    readonly agent?: string | undefined;
    readonly attachments?: readonly string[] | undefined;
    readonly description: string;
    readonly criteria: readonly string[];
  }[] = [
    {
      title: "Polish Kanban card thumbnails, Quick-Peek modal, and preview-first issue detail",
      priority: "high",
      status: "backlog",
      agent: miloId,
      attachments: [beforeImgId, afterImgId].filter((id): id is string => id !== undefined),
      description: [
        "## Overview",
        "Upgrade the Issues board so reviewers scan thumbnails at a glance, inspect drafts in a centered **Quick-Peek** modal, and read formatted `<Markdown>` + `<Compare>` blocks before entering edit mode.",
        compareBlock,
        "\n## UX Highlights",
        "- Card thumbnails extract the first `compare` or image attachment cleanly",
        "- Draft detail renders Markdown, criteria checklist, and a calm action bar by default",
      ].join("\n"),
      criteria: [
        "Board cards with images or compare blocks display restrained rounded thumbnails",
        "Clicking a card opens Quick-Peek with an Open full screen button",
        "Draft issues render Markdown and interactive Compare sliders without empty textarea walls",
      ],
    },
    {
      title: "Unify Papertrails light and dark surface contrast tokens across 3+1 Note views",
      priority: "medium",
      status: "backlog",
      agent: miloId,
      attachments: previewImgId ? [previewImgId] : undefined,
      description:
        "## Audit Scope\nVerify WCAG AA contrast (>= 4.5:1) across `page`, `side`, `elevated`, and `ink` tokens in both light and dark modes across Block Doc, Base, Canvas, Media, and Settings.",
      criteria: ["All 4 Note primitive views use theme tokens without hardcoded hex borders", "Dark and light screenshots pass contrast checks"],
    },
    {
      title: "Add incremental snapshot compaction for long-lived whiteboard sessions",
      priority: "medium",
      status: "backlog",
      agent: adaId,
      description:
        "## Goal\nCompact Loro update history when collaborative whiteboards cross 500 incremental edits while preserving per-origin undo checkpoints.",
      criteria: ["History preview remains deterministic before and after compaction"],
    },
    {
      title: "Wire live VDP DevTools protocol for remote inspection and screenshot capture",
      priority: "urgent",
      status: "in_progress",
      agent: adaId,
      description: [
        "## Context\nEnable CDP-style live loopback inspection (`--remote-debugging-port` / `VIBEVALLEY_DEBUG_PORT=0`) across `apps/mac` and `vibevalley debug`.",
        "\n## Deliverables",
        "- Expose `/json/version`, `/json/list`, and authenticated `/devtools` WebSocket transport",
        "- Implement `Shell.*`, `Page.captureScreenshot`, `Page.getMetrics`, and `UI.*` probe methods",
        "- Wire `vp run ui:review` contact sheet generator with zero shell/view errors",
      ].join("\n"),
      criteria: [
        "vibevalley debug discover detects active sandboxed desktop instances",
        "Page.captureScreenshot returns non-empty PNG frames across light and dark themes",
        "UI.getTree and UI.waitFor resolve mounted workbench nodes cleanly",
      ],
    },
    {
      title: "Fix outline multiline wrapping and keyboard indent stability",
      priority: "high",
      status: "in_review",
      agent: adaId,
      description: [
        "## Problem\nLong bullet items in `OutlineView` clipped horizontally at 1280px instead of wrapping cleanly beneath the disclosure chevron.",
        "\n## Approach",
        "- Enforce `min-w-0 flex-1` on node text containers and wrap long URLs/sentences gracefully",
        "- Keep `Tab` / `Shift+Tab` indent focus stable when reparenting nested todos",
      ].join("\n"),
      criteria: ["Long wrapping outline nodes display full copy without clipping", "Todo checkbox toggle updates progress counters immediately"],
    },
    {
      title: "Silent WKWebView auto-cover capture for HTML preview blocks in doc notes",
      priority: "high",
      status: "in_review",
      agent: soraId,
      description:
        "## Summary\nWhen opening a `preview` block in `BlockDocView`, silently snapshot the loaded `WKWebView` into `note.cover.set` so `/library` cards display live thumbnails.",
      criteria: [
        "Library card updates with captured cover PNG after visiting prototype view",
        "Capture avoids flicker and skips redundant writes when seq is unchanged",
      ],
    },
    {
      title: "Publish Q4 developer ergonomics retrospective and release checklist",
      priority: "low",
      status: "done",
      agent: soraId,
      description: "## Highlights\nConsolidated native build timings, VDP debugging workflow, and screenshot acceptance steps for the alpha.5 release cut.",
      criteria: ["Checklist archived and announced in #release-ops"],
    },
    {
      title: "Archive legacy 0/6 lane concurrency header counter after unlimited queue redesign",
      priority: "low",
      status: "canceled",
      agent: miloId,
      description:
        "## Outcome\nReplaced the noisy `0 / 6` concurrency indicator on the Kanban header with clean PM lane labels (`待办 / 进行中 / 待验收 / 已完成`).",
      criteria: ["Board header shows lane icon, title, and issue count pill only"],
    },
  ];

  const issueIds: string[] = [];
  for (let idx = 0; idx < issueSpecs.length; idx++) {
    const spec = issueSpecs[idx]!;
    const descPath = writeTempPayload(payloadDir, `issue-${idx + 1}.md`, spec.description);
    const createArgs = ["issue", "create", spec.title, "--repo", repoName, "--priority", spec.priority, "--description", `@${descPath}`];
    if (spec.agent) createArgs.push("--agent", spec.agent);
    for (const criterion of spec.criteria) createArgs.push("--criterion", criterion);
    for (const attId of spec.attachments ?? []) createArgs.push("--attach", attId);
    const created = vvJson(createArgs, CreatedEntitySchema, `issue create #${idx + 1}`);
    issueIds.push(created.id);
    const transitions: Record<typeof spec.status, readonly string[]> = {
      backlog: [],
      todo: ["todo"],
      in_progress: ["todo"],
      in_review: ["todo"],
      done: ["canceled"],
      canceled: ["canceled"],
    };
    for (const stepStatus of transitions[spec.status]) {
      if (!runSoft(cliBin, ["issue", "status", created.id, stepStatus], { cwd: root, env: cliEnv, timeoutMs: 15_000 }).ok) break;
    }
  }

  const firstIssueId = issueIds[0]!;
  const releaseChannel = vvJson(
    ["channel", "create", "release-ops", "--description", "Release readiness, live VDP verification, and Papertrails UX reviews"],
    CreatedEntitySchema,
    "channel create release-ops",
  );

  const docPayload = {
    version: 1,
    blocks: [
      { id: "b1", type: "heading", level: 1, text: "VDP Remote Debugging Architecture RFC" },
      {
        id: "b2",
        type: "prose",
        text: "VibeValley exposes a loopback-only JSON-RPC 2.0 WebSocket protocol (VDP) so CLI tools, automated visual audits, and DevTools share one typed observation layer.",
      },
      {
        id: "b3",
        type: "kpi",
        items: [
          { label: "Mean Availability", value: "99.96%", delta: "+0.04%", tone: "ok" },
          { label: "Peak P99 Latency", value: "21.4 ms", delta: "-3.2 ms", tone: "ok" },
          { label: "Visual Coverage", value: "100%", tone: "info" },
        ],
      },
      {
        id: "b4",
        type: "chart",
        title: "RPC P99 Latency (ms)",
        kind: "bar",
        labels: ["Gateway", "Slice Feed", "Collab", "VDP"],
        series: [{ name: "P99 ms", data: [14.2, 9.6, 21.4, 11.8] }],
      },
      {
        id: "b5",
        type: "preview",
        entry: "structure/preview.html",
        height: 360,
        title: "Interactive Release Readiness Explorer",
      },
    ],
  };
  const docFile = writeTempPayload(payloadDir, "doc.json", `${JSON.stringify(docPayload, null, 2)}\n`);
  const docNote = vvJson(
    [
      "note",
      "create",
      "VDP Remote Debugging Architecture RFC",
      "--type",
      "doc",
      "--content",
      `@${docFile}`,
      "--issue",
      firstIssueId,
      "--channel",
      "general",
      "--announce",
      "--note",
      "Architecture RFC for VDP loopback inspection",
    ],
    CreatedEntitySchema,
    "note create doc",
  );

  const baseDoc = {
    version: 1,
    sheets: [
      {
        id: "sheet1",
        name: "Frame & RPC Benchmarks",
        columns: [
          { id: "c_title", name: "Workload", kind: "text", width: 280 },
          {
            id: "c_status",
            name: "Status",
            kind: "select",
            width: 140,
            options: [
              { value: "pass", label: "Pass", color: "green" },
              { value: "review", label: "Review", color: "amber" },
            ],
          },
          { id: "c_p50", name: "P50 (ms)", kind: "number", width: 120 },
          { id: "c_p99", name: "P99 (ms)", kind: "number", width: 120 },
        ],
        rows: [
          {
            id: "r1",
            cells: {
              c_title: { _tag: "text", value: "Board slice projection (200 issues)" },
              c_status: { _tag: "text", value: "pass" },
              c_p50: { _tag: "number", value: 1.4 },
              c_p99: { _tag: "number", value: 3.8 },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r2",
            cells: {
              c_title: { _tag: "text", value: "VDP Page.captureScreenshot (1280x840)" },
              c_status: { _tag: "text", value: "pass" },
              c_p50: { _tag: "number", value: 42.0 },
              c_p99: { _tag: "number", value: 68.5 },
            },
            createdAt: 0,
            updatedAt: 0,
          },
          {
            id: "r3",
            cells: {
              c_title: { _tag: "text", value: "Loro CRDT merge (500 blocks)" },
              c_status: { _tag: "text", value: "review" },
              c_p50: { _tag: "number", value: 2.1 },
              c_p99: { _tag: "number", value: 6.4 },
            },
            createdAt: 0,
            updatedAt: 0,
          },
        ],
        views: [
          { id: "v_table", name: "Table", kind: "table" },
          { id: "v_board", name: "Board", kind: "board", groupBy: "c_status" },
        ],
      },
    ],
  };
  const baseFile = writeTempPayload(payloadDir, "base.json", `${JSON.stringify(baseDoc, null, 2)}\n`);
  const baseNote = vvJson(
    ["note", "create", "Native Rendering & Latency Benchmark Base", "--type", "base", "--content", `@${baseFile}`, "--issue", issueIds[1] ?? firstIssueId],
    CreatedEntitySchema,
    "note create base",
  );

  const whiteboardDoc = {
    version: 1,
    grid: "architectural",
    theme: "warm",
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: {
      t_title: { id: "t_title", type: "text", variant: "title", x: 64, y: 28, w: 760, h: 48, label: "Q4 Native Workbench & VDP Architecture" },
      t_sub: {
        id: "t_sub",
        type: "text",
        variant: "subtitle",
        x: 64,
        y: 78,
        w: 760,
        h: 28,
        label: "Zero-drift loopback debugging, 6-slice state feeds, and 3+1 collaborative Note primitives",
        highlight: "3+1",
      },
      grp_core: { id: "grp_core", type: "container", x: 56, y: 128, w: 544, h: 292, title: "Desktop Host & VDP Loopback", fill: "side" },
      n_vdp: {
        id: "n_vdp",
        type: "shape",
        shape: "card",
        parentId: "grp_core",
        x: 80,
        y: 176,
        w: 204,
        h: 112,
        title: "VDP WebSocket Hub",
        body: "Auth token + JSON-RPC 2.0 on 127.0.0.1",
        fill: "water",
      },
      n_probe: {
        id: "n_probe",
        type: "shape",
        shape: "card",
        parentId: "grp_core",
        x: 372,
        y: 176,
        w: 204,
        h: 112,
        title: "vdpProbe & GPUI Shot",
        body: "UI.getTree + Metal frame PNG readback",
        fill: "leaf",
      },
      n_note: {
        id: "n_note",
        type: "shape",
        shape: "sticky",
        parentId: "grp_core",
        x: 224,
        y: 312,
        w: 228,
        h: 88,
        title: "UX Gate",
        body: "Assert zero shell/view errors on every route",
        fill: "sun",
      },
      n_collab: {
        id: "n_collab",
        type: "shape",
        shape: "card",
        x: 680,
        y: 176,
        w: 214,
        h: 112,
        title: "Loro Note Collab",
        body: "Multi-agent CRDT sync + origin undo",
        fill: "lavender",
      },
      n_review: {
        id: "n_review",
        type: "shape",
        shape: "card",
        x: 680,
        y: 332,
        w: 214,
        h: 108,
        title: "Visual Contact Sheet",
        body: "manifest.json + Light/Dark PNG matrix",
        fill: "peach",
      },
      a_1: { id: "a_1", type: "arrow", curve: "smooth", head: "arrow", from: { id: "n_vdp", side: "e" }, to: { id: "n_probe", side: "w" }, label: "dispatch" },
      a_2: {
        id: "a_2",
        type: "arrow",
        curve: "smooth",
        head: "arrow",
        from: { id: "n_probe", side: "e" },
        to: { id: "n_collab", side: "w" },
        label: "inspect",
      },
      a_3: {
        id: "a_3",
        type: "arrow",
        curve: "smooth",
        head: "arrow",
        from: { id: "n_collab", side: "s" },
        to: { id: "n_review", side: "n" },
        label: "capture",
      },
    },
  };
  const whiteboardFile = writeTempPayload(payloadDir, "board.json", `${JSON.stringify(whiteboardDoc, null, 2)}\n`);
  const canvasNote = vvJson(
    ["note", "create", "Q4 Release Milestone & System Topology", "--type", "canvas", "--content", `@${whiteboardFile}`],
    CreatedEntitySchema,
    "note create canvas",
  );

  const mediaDoc = {
    version: 1,
    title: "Release Walkthrough Audio & Transcript",
    mediaKind: "audio",
    caption: "Alpha release readiness sync recording",
    durationSec: 64,
    posterAsset: null,
    items: [
      {
        id: "m1",
        kind: "audio",
        src: "asset/audio/walkthrough.wav",
        title: "Release Walkthrough",
        durationSec: 64,
        transcript: [{ id: "c1", startSec: 0, endSec: 12, speaker: "Ada", text: "All 3+1 Note primitives and Loro CRDT sync are verified." }],
      },
    ],
  };
  const mediaFile = writeTempPayload(payloadDir, "media.json", `${JSON.stringify(mediaDoc, null, 2)}\n`);
  const mediaNote = vvJson(
    ["note", "create", "Release Walkthrough Audio & Transcript", "--type", "media", "--content", `@${mediaFile}`],
    CreatedEntitySchema,
    "note create media",
  );

  const protoHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Interactive Release Readiness Explorer</title><link rel="stylesheet" href="./styles.css" /></head><body><main class="canvas">
<header class="hero"><div><span class="eyebrow">PAPERTRAILS · ALPHA 0.2</span><h1>Release Readiness Explorer</h1>
<p class="subtitle">Interactive rollout gate monitor backed by live VDP telemetry and automated surface checks.</p></div>
<div class="pill-group" role="tablist" aria-label="Filter release checks"><button type="button" class="pill active" data-filter="all">All Gates (4)</button>
<button type="button" class="pill" data-filter="ready">Ready (3)</button><button type="button" class="pill" data-filter="review">In Review (1)</button></div></header>
<section class="metrics">
<article class="metric-card"><span class="m-label">Visual Coverage</span><strong class="m-val">100%</strong><span class="m-hint">Light + Dark verified</span></article>
<article class="metric-card"><span class="m-label">Mean Frame Time</span><strong class="m-val">6.4 ms</strong><span class="m-hint">Target &lt; 16.6 ms</span></article>
<article class="metric-card"><span class="m-label">Shell Errors</span><strong class="m-val ok">0</strong><span class="m-hint">Strict zero-error gate</span></article>
<article class="metric-card"><span class="m-label">Note Primitives</span><strong class="m-val">3+1</strong><span class="m-hint">CRDT collab enabled</span></article>
</section><section class="gates" id="gate-list"></section></main><script type="module" src="./app.js"></script></body></html>`;
  const protoCss = `:root { --bg: #f8f6f1; --surface: #ffffff; --ink: #1c1917; --muted: #645e56; --line: #e4dfd5; --accent: #4d7a2a; --accent-soft: #e9f2e1; --review: #b86e18; --review-soft: #fdf2e2; }
* { box-sizing: border-box; }
body { margin: 0; padding: 28px 32px; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif; background: radial-gradient(circle at top right, #eef4e6 0%, var(--bg) 52%); color: var(--ink); }
.canvas { max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.hero { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: 16px; }
.eyebrow { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; color: var(--accent); background: var(--accent-soft); padding: 3px 9px; border-radius: 999px; }
h1 { margin: 8px 0 4px; font-size: 26px; letter-spacing: -0.02em; }
.subtitle { margin: 0; color: var(--muted); font-size: 14px; }
.pill-group { display: flex; gap: 6px; background: var(--surface); border: 1px solid var(--line); padding: 4px; border-radius: 10px; }
.pill { border: 0; background: transparent; color: var(--muted); font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 7px; cursor: pointer; }
.pill.active { background: var(--accent); color: #fff; }
.metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.metric-card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 4px; box-shadow: 0 2px 8px rgba(28, 25, 23, 0.04); }
.m-label { font-size: 12px; color: var(--muted); font-weight: 500; } .m-val { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; } .m-val.ok { color: var(--accent); } .m-hint { font-size: 11px; color: var(--muted); }
.gates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.gate { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.gate-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; } .gate-title { font-size: 14px; font-weight: 600; margin: 0; }
.status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; } .status.ready { background: var(--accent-soft); color: var(--accent); } .status.review { background: var(--review-soft); color: var(--review); }
.gate-desc { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
.gate-foot { display: flex; justify-content: space-between; font-size: 11px; font-family: ui-monospace, SFMono-Regular, monospace; color: var(--muted); }`;
  const protoJs = `const gates = [
  { title: "VDP Loopback Protocol", status: "ready", owner: "Ada", metric: "14/14 RPCs", desc: "Authenticated WebSocket discovery, Shell controls, and UI probe queries." },
  { title: "GPUI Metal Screenshots", status: "ready", owner: "Ada", metric: "1280×840 PNG", desc: "Off-thread PNG encoding works even when the macOS display is locked." },
  { title: "24-Block Doc & Base", status: "review", owner: "Milo", metric: "3+1 Note", desc: "Block Doc editing, Base 4 views, and Row=Page Peek drawers." },
  { title: "CRDT Directory Storage", status: "ready", owner: "Sora", metric: "4 primitives", desc: "Per-origin history and collaborative presence across all views." },
];
const list = document.getElementById("gate-list"); let current = "all";
function render() {
  list.replaceChildren();
  for (const item of gates.filter((g) => current === "all" || g.status === current)) {
    const card = document.createElement("article"); card.className = "gate";
    card.innerHTML = '<div class="gate-top"><h2 class="gate-title"></h2><span class="status"></span></div><p class="gate-desc"></p><div class="gate-foot"><span class="owner"></span><span class="metric"></span></div>';
    card.querySelector(".gate-title").textContent = item.title;
    const badge = card.querySelector(".status"); badge.classList.add(item.status); badge.textContent = item.status === "ready" ? "Ready" : "In Review";
    card.querySelector(".gate-desc").textContent = item.desc; card.querySelector(".owner").textContent = "Owner: " + item.owner; card.querySelector(".metric").textContent = item.metric;
    list.append(card);
  }
}
for (const btn of document.querySelectorAll(".pill")) { btn.addEventListener("click", () => { current = btn.getAttribute("data-filter") || "all"; for (const b of document.querySelectorAll(".pill")) b.classList.toggle("active", b === btn); render(); }); }
render();`;
  const protoHtmlFile = writeTempPayload(payloadDir, "proto-index.html", protoHtml);
  const protoCssFile = writeTempPayload(payloadDir, "proto-styles.css", protoCss);
  const protoJsFile = writeTempPayload(payloadDir, "proto-app.js", protoJs);
  vv(["note", "file", "write", docNote.id, "structure/preview.html", `@${protoHtmlFile}`, "--mime", "text/html"]);
  vv(["note", "file", "write", docNote.id, "structure/styles.css", `@${protoCssFile}`, "--mime", "text/css"]);
  vv(["note", "file", "write", docNote.id, "structure/app.js", `@${protoJsFile}`, "--mime", "application/javascript"]);

  for (const msg of [
    `Kicked off the live VDP visual sweep — tracking architecture details in ${docNote.id} ("VDP Remote Debugging Architecture RFC").`,
    `Benchmark Base (${baseNote.id}) tracks P50/P99 latency across Board, Table, Gallery, and Timeline views.`,
    `System Topology canvas (${canvasNote.id}) and Media walkthrough (${mediaNote.id}) are synced in /library.`,
  ]) {
    vv(["channel", "message", "send", "general", msg]);
  }
  for (const msg of [
    `RFC & preview block (${docNote.id}) captures live WKWebView cover thumbnails for /library.`,
    `All release issues are triaged across todo, in_progress, in_review, and done — ready for the full-app VDP UX review pass.`,
  ]) {
    vv(["channel", "message", "send", releaseChannel.id, msg]);
  }

  return {
    firstIssueId,
    issueIds,
    agentIds,
    channelIds: ["general", releaseChannel.id],
    notes: {
      doc: docNote.id,
      base: baseNote.id,
      canvas: canvasNote.id,
      media: mediaNote.id,
    },
  };
}

function printUsage(): void {
  console.log(`Usage: vp run ui:review -- [options]

Options:
  --out <dir>          Output directory for manifest.json, index.html, and shots/ (default: /tmp/vv-ux-review)
  --themes <list>      Comma-separated themes: light, dark, or light,dark (default: light,dark)
  --width <px>         Window logical width in pixels (default: 1280)
  --height <px>        Window logical height in pixels (default: 840)
  --skip-build         Reuse existing vibevalley-mac, vibevalley CLI, and UI bundles when present
  --keep-sandbox       Preserve temporary VIBEVALLEY_HOME / store sandbox after exit
  -h, --help           Show this help message`);
}

export async function runVdpReview(options: ReviewOptions): Promise<ReviewManifest> {
  if (process.platform === "win32") {
    throw new Error("vdp-review requires macOS/Unix process groups");
  }

  const root = resolve(import.meta.dirname, "../..");
  const paths = resolveVdpWorkspacePaths(root);
  ensureVdpArtifactsBuilt(paths, { skipBuild: options.skipBuild });

  const shotsDir = resolve(options.outDir, "shots");
  mkdirSync(options.outDir, { recursive: true });
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });

  const manifest = await withVdpSandbox(
    {
      prefix: "vv-ux-review-",
      logTag: "vdp-review",
      paths,
      outDir: options.outDir,
      keepSandbox: options.keepSandbox,
      requireWorkbenchReady: true,
    },
    async ({ payloadDir, cliEnv, driver }) => {
      const seeded = seedRealisticWorkspace(paths.cliBin, root, cliEnv, payloadDir);

      await driver.resize(options.width, options.height);
      await driver.settle(300);

      // Visit the doc note with preview block once before capturing /library so silent WKWebView auto-cover populates its thumbnail.
      await driver.navigate(`/notes/${seeded.notes.doc}`);
      await driver.settle(1400);

      const plan = buildScreenMatrix(seeded, options.themes);
      const captures: ScreenCapture[] = [];
      let currentTheme: ReviewTheme | null = null;

      for (const entry of plan) {
        if (entry.theme !== currentTheme) {
          await driver.setTheme(entry.theme);
          currentTheme = entry.theme;
          await driver.settle(400);
        }

        await driver.navigate(entry.route);
        if (entry.waitTestId) {
          await driver.uiWaitFor({ testId: entry.waitTestId, timeoutMs: 3_500 });
        }
        await driver.settle(entry.settleMs);

        const stateRaw = await driver.getState();
        const shellCheck = extractShellErrors(stateRaw);
        const shellErrors = [...shellCheck.errors];
        const shot = await captureVdpScreenshot(driver, shotsDir, entry.fileName, shellErrors, entry.target ?? "shell");
        const rawMetrics = driver.getMetrics ? await driver.getMetrics() : null;
        const metrics = rawMetrics
          ? {
              width: rawMetrics.width,
              height: rawMetrics.height,
              scaleFactor: rawMetrics.scaleFactor,
              themeDark: rawMetrics.themeDark,
              lastFrameMs: rawMetrics.lastFrameMs ?? null,
            }
          : null;

        let uiNodeCount = 0;
        let uiRoute: string | null = null;
        try {
          const tree = await driver.uiGetTree("workbench");
          uiNodeCount = countUiTreeNodes(tree.nodes);
          uiRoute = tree.route ?? null;
        } catch {
          // Leave uiNodeCount at 0 if UI tree probe is unavailable on this screen.
        }

        captures.push({
          id: entry.id,
          label: entry.label,
          route: entry.route,
          theme: entry.theme,
          pngPath: shot.path,
          relPath: shot.relPath,
          bytes: shot.bytes,
          imageWidth: shot.width,
          imageHeight: shot.height,
          metrics,
          uiNodeCount,
          uiRoute,
          shellRoute: shellCheck.route,
          shellErrors,
        });
      }

      const totalErrors = captures.reduce((sum, item) => sum + item.shellErrors.length, 0);
      const totalBytes = captures.reduce((sum, item) => sum + item.bytes, 0);
      return ReviewManifestSchema.parse({
        generatedAt: new Date().toISOString(),
        outDir: options.outDir,
        viewport: { width: options.width, height: options.height },
        themes: [...options.themes],
        seeded,
        screens: captures,
        summary: { totalScreens: captures.length, totalErrors, totalBytes },
      });
    },
  );

  writeFileSync(resolve(options.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(resolve(options.outDir, "index.html"), renderContactSheetHtml(manifest), "utf8");

  if (manifest.summary.totalErrors > 0) {
    const details = manifest.screens
      .filter((c) => c.shellErrors.length > 0)
      .map((c) => `${c.id} (${c.theme}): ${c.shellErrors.join("; ")}`)
      .join("\n- ");
    throw new Error(`vdp-review found ${manifest.summary.totalErrors} shell/view error(s):\n- ${details}`);
  }

  console.log(
    `vdp-review: captured ${manifest.summary.totalScreens} screens (${manifest.themes.join(", ")}) -> ${resolve(options.outDir, "manifest.json")} & ${resolve(options.outDir, "index.html")}`,
  );
  return manifest;
}

if (import.meta.main) {
  try {
    const options = parseReviewArgs(process.argv.slice(2));
    if (options.help) {
      printUsage();
    } else {
      await runVdpReview(options);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
