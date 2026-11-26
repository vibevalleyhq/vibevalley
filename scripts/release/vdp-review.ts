import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { z } from "zod";

export const REVIEW_THEMES = ["light", "dark"] as const;
export type ReviewTheme = (typeof REVIEW_THEMES)[number];

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
  readonly artifacts: {
    readonly docs: string;
    readonly outline: string;
    readonly dashboard: string;
    readonly designSystem: string;
    readonly whiteboard: string;
    readonly slides: string;
    readonly sheet: string;
    readonly prototype: string;
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

const HostedViewDumpSchema = z.object({
  ready: z.boolean().optional(),
  errors: z.array(z.string()).default([]),
});

const ShellStateSchema = z.object({
  loaded: z.boolean().default(false),
  load_error: z.string().nullable().default(null),
  route: z.string().optional(),
  theme_dark: z.boolean().optional(),
  startup_failure: z
    .object({
      kind: z.string(),
      summary: z.string(),
    })
    .nullable()
    .optional(),
  sidebar: HostedViewDumpSchema.nullable().optional(),
  workbench: HostedViewDumpSchema.nullable().optional(),
  inspector: HostedViewDumpSchema.nullable().optional(),
  palette: z
    .object({
      view: HostedViewDumpSchema.optional(),
    })
    .nullable()
    .optional(),
  projects: z
    .array(
      z.object({
        tabs: z
          .array(
            z.object({
              hosted: HostedViewDumpSchema.optional(),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
});

const PageMetricsSchema = z.object({
  width: z.number(),
  height: z.number(),
  scaleFactor: z.number(),
  themeDark: z.boolean(),
  lastFrameMs: z.number().nullable().optional(),
});

interface UiNodeShape {
  readonly testId?: string | null | undefined;
  readonly role?: string | null | undefined;
  readonly text?: string | null | undefined;
  readonly children?: readonly UiNodeShape[] | null | undefined;
}

const UiNodeSchema: z.ZodType<UiNodeShape> = z.lazy(() =>
  z.object({
    testId: z.string().nullable().optional(),
    role: z.string().nullable().optional(),
    text: z.string().nullable().optional(),
    children: z.array(UiNodeSchema).nullable().optional(),
  }),
);

const UiTreeSchema = z.object({
  view: z.string(),
  route: z.string().nullable().optional(),
  nodes: z.array(UiNodeSchema).default([]),
});

const ScreenshotSavedSchema = z.object({
  path: z.string(),
  mime: z.string(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
});

const DebugEndpointFileSchema = z.object({
  pid: z.number(),
  port: z.number().int().positive(),
  httpUrl: z.string().min(1),
  wsUrl: z.string().min(1),
});

const ServerReceiptSchema = z.object({
  port: z.number().int().positive().optional(),
  url: z.string().min(1).optional(),
});

const CreatedEntitySchema = z.union([
  z
    .string()
    .min(1)
    .transform((id) => ({ id })),
  z.object({ id: z.string().min(1) }),
]);

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
  viewport: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  themes: z.array(z.enum(REVIEW_THEMES)),
  seeded: z.object({
    firstIssueId: z.string(),
    issueIds: z.array(z.string()),
    agentIds: z.array(z.string()),
    channelIds: z.array(z.string()),
    artifacts: z.object({
      docs: z.string(),
      outline: z.string(),
      dashboard: z.string(),
      designSystem: z.string(),
      whiteboard: z.string(),
      slides: z.string(),
      sheet: z.string(),
      prototype: z.string(),
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

export function isReviewTheme(value: string): value is ReviewTheme {
  return value === "light" || value === "dark";
}

function parsePositiveInt(flag: string, raw: string): number {
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(`${flag} requires a positive integer (got "${raw}")`);
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} requires a positive integer (got "${raw}")`);
  }
  return parsed;
}

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
    { id: "library", label: "Library & Artifacts", route: "/library", waitTestId: "library-page", settleMs: 650 },
    { id: "artifact-outline", label: "Artifact · Outline", route: `/artifacts/${ids.artifacts.outline}`, waitTestId: "artifact-outline-view", settleMs: 650 },
    {
      id: "artifact-dashboard",
      label: "Artifact · Dashboard",
      route: `/artifacts/${ids.artifacts.dashboard}`,
      waitTestId: "artifact-dashboard-view",
      settleMs: 700,
    },
    {
      id: "artifact-design-system",
      label: "Artifact · Design System",
      route: `/artifacts/${ids.artifacts.designSystem}`,
      waitTestId: "artifact-design-system-view",
      settleMs: 650,
    },
    { id: "artifact-whiteboard", label: "Artifact · Whiteboard", route: `/artifacts/${ids.artifacts.whiteboard}`, settleMs: 1200 },
    { id: "artifact-prototype", label: "Artifact · Prototype (Shell)", route: `/artifacts/${ids.artifacts.prototype}`, settleMs: 1100 },
    {
      id: "artifact-prototype-webview",
      label: "Artifact · Prototype (WKWebView)",
      route: `/artifacts/${ids.artifacts.prototype}`,
      target: "webview",
      settleMs: 700,
    },
    { id: "settings", label: "Settings", route: "/settings", settleMs: 550 },
    { id: "farm", label: "Papertrails Farm", route: "/farm", settleMs: 900 },
  ];

  const entries: ScreenPlanEntry[] = [];
  for (const theme of themes) {
    for (const screen of baseScreens) {
      entries.push({
        ...screen,
        theme,
        fileName: `${screen.id}-${theme}.png`,
      });
    }
  }
  return entries;
}

export function countUiTreeNodes(nodes: readonly UiNodeShape[]): number {
  let count = 0;
  for (const node of nodes) {
    count += 1;
    if (node.children && node.children.length > 0) {
      count += countUiTreeNodes(node.children);
    }
  }
  return count;
}

export function extractShellErrors(rawState: unknown): {
  readonly loaded: boolean;
  readonly route: string | null;
  readonly errors: string[];
} {
  const parsed = ShellStateSchema.safeParse(rawState);
  if (!parsed.success) {
    return {
      loaded: false,
      route: null,
      errors: [`invalid Shell.getState payload: ${parsed.error.issues.map((i) => i.message).join("; ")}`],
    };
  }
  const state = parsed.data;
  const errors: string[] = [];
  if (!state.loaded) errors.push("shell.loaded is false");
  if (state.load_error !== null) errors.push(`load_error: ${state.load_error}`);
  if (state.startup_failure) errors.push(`startup_failure(${state.startup_failure.kind}): ${state.startup_failure.summary}`);
  for (const msg of state.sidebar?.errors ?? []) errors.push(`sidebar: ${msg}`);
  for (const msg of state.workbench?.errors ?? []) errors.push(`workbench: ${msg}`);
  for (const msg of state.inspector?.errors ?? []) errors.push(`inspector: ${msg}`);
  for (const msg of state.palette?.view?.errors ?? []) errors.push(`palette: ${msg}`);
  for (const project of state.projects) {
    for (const tab of project.tabs) {
      for (const msg of tab.hosted?.errors ?? []) errors.push(`pane: ${msg}`);
    }
  }
  return {
    loaded: state.loaded,
    route: state.route ?? null,
    errors,
  };
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
        <a href="${escapeHtml(screen.relPath)}" target="_blank" rel="noreferrer">
          <img src="${escapeHtml(screen.relPath)}" alt="${escapeHtml(`${screen.label} (${screen.theme})`)}" loading="lazy" />
        </a>
        <figcaption>
          <div class="shot-head">
            <strong>${escapeHtml(screen.id)}</strong>
            <div class="shot-badges">
              <span class="badge theme">${escapeHtml(screen.theme)}</span>
              ${statusBadge}
            </div>
          </div>
          <div class="shot-route"><code>${escapeHtml(screen.route)}</code></div>
          <div class="shot-meta">
            <span>${screen.imageWidth}×${screen.imageHeight}</span>
            <span>${kb} KB</span>
            <span>${screen.uiNodeCount} UI nodes</span>
            <span>frame ${escapeHtml(frame)}</span>
          </div>
          ${errBlock}
        </figcaption>
      </figure>`;
    })
    .join("\n");

  const totalMb = (manifest.summary.totalBytes / (1024 * 1024)).toFixed(2);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VibeValley VDP UX Review Contact Sheet</title>
  <style>
    :root {
      --bg: #f6f5f0;
      --surface: #ffffff;
      --border: #e5e2da;
      --ink: #1f1e1a;
      --muted: #6c685d;
      --accent: #3d6b2c;
      --accent-soft: #e7f3e3;
      --ok-bg: #e7f3e3;
      --ok-ink: #27581d;
      --fail-bg: #fde8e8;
      --fail-ink: #991b1b;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #171714;
        --surface: #201f1b;
        --border: #34322b;
        --ink: #ece9df;
        --muted: #a19c8e;
        --accent: #74b457;
        --accent-soft: #1f331b;
        --ok-bg: #1f331b;
        --ok-ink: #9be084;
        --fail-bg: #3b1c1c;
        --fail-ink: #fca5a5;
      }
    }
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
  </style>
</head>
<body>
  <main>
    <h1>VibeValley Live VDP UX Review</h1>
    <div class="meta">Generated ${escapeHtml(manifest.generatedAt)} · Viewport ${manifest.viewport.width}×${manifest.viewport.height} · Output <code>${escapeHtml(manifest.outDir)}</code></div>
    <section class="kpis">
      <div class="kpi"><div class="label">Captured Screens</div><div class="val">${manifest.summary.totalScreens}</div></div>
      <div class="kpi"><div class="label">Themes</div><div class="val">${escapeHtml(manifest.themes.join(" / "))}</div></div>
      <div class="kpi"><div class="label">Shell / View Errors</div><div class="val">${manifest.summary.totalErrors}</div></div>
      <div class="kpi"><div class="label">Total PNG Size</div><div class="val">${totalMb} MB</div></div>
    </section>
    <div class="toolbar" id="filter-bar">
      ${themeButtons}
      <span class="count" id="filter-count">Showing ${manifest.screens.length} / ${manifest.screens.length}</span>
    </div>
    <section class="gallery" id="gallery">
      ${cards}
    </section>
  </main>
  <script>
    (() => {
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
    })();
  </script>
</body>
</html>
`;
}

const errorCode = (error: unknown): unknown => (typeof error === "object" && error !== null && "code" in error ? error.code : undefined);

function runChecked(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; capture?: boolean; timeoutMs?: number },
): string {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: options.timeoutMs ?? 60_000,
  });
  if (res.error) {
    throw new Error(`${command} ${args.join(" ")} failed to spawn: ${res.error.message}`, { cause: res.error });
  }
  if (res.status !== 0) {
    const stdout = typeof res.stdout === "string" ? res.stdout.trim() : "";
    const stderr = typeof res.stderr === "string" ? res.stderr.trim() : "";
    const detail = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(res.status)}${detail ? `:\n${detail}` : ""}`);
  }
  return typeof res.stdout === "string" ? res.stdout : "";
}

function runSoft(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
): {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
} {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs ?? 20_000,
  });
  return {
    ok: !res.error && res.status === 0,
    stdout: typeof res.stdout === "string" ? res.stdout : "",
    stderr: typeof res.stderr === "string" ? res.stderr : "",
  };
}

function isolatedEnv(root: string, homeDir: string, workDir: string, storeDb: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("VIBEVALLEY_") && key !== "DEEPSEEK_API_KEY") {
      env[key] = value;
    }
  }
  return {
    ...env,
    VIBEVALLEY_HOME: homeDir,
    VIBEVALLEY_WORK_ROOT: workDir,
    VIBEVALLEY_STORE: storeDb,
    VIBEVALLEY_PORT: "0",
    VIBEVALLEY_DEBUG_PORT: "0",
    VIBEVALLEY_NO_OPENING: "1",
    VIBEVALLEY_ASSETS: resolve(root, "assets"),
    VIBEVALLEY_DIORAMA_DIST: resolve(root, "assets/diorama"),
    VIBEVALLEY_VOICE_LINE_PORT: "0",
    VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0",
  };
}

function writeTempPayload(payloadDir: string, fileName: string, content: string): string {
  const filePath = join(payloadDir, fileName);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

function parseJsonOutput<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (err) {
    throw new Error(`failed to parse JSON from ${label}: ${raw.slice(0, 240)}`, { cause: err });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`unexpected JSON shape from ${label} (${detail}): ${raw.slice(0, 240)}`);
  }
  return parsed.data;
}

function seedRealisticWorkspace(cliBin: string, root: string, cliEnv: NodeJS.ProcessEnv, payloadDir: string): SeededWorkspaceIds {
  const vv = (args: readonly string[]): string => runChecked(cliBin, args, { cwd: root, env: cliEnv, capture: true, timeoutMs: 30_000 });
  const vvJson = <T>(args: readonly string[], schema: z.ZodType<T>, label: string): T => parseJsonOutput(vv([...args, "--json"]), schema, label);

  const agentSpecs = [
    {
      name: "Ada",
      runtime: "vibevalley",
      role: "worker",
      duty: "Core Rust architecture, VDP transport, and state projections",
    },
    {
      name: "Milo",
      runtime: "claude",
      role: "worker",
      duty: "Desktop GPUI & nsh UI polish, Papertrails design tokens, and interaction tests",
    },
    {
      name: "Sora",
      runtime: "codex",
      role: "worker",
      duty: "Collaborative artifacts, traceable SLO dashboards, and interactive prototypes",
    },
  ] as const;

  const agentIds: string[] = [];
  for (const spec of agentSpecs) {
    const created = vvJson(
      ["agent", "create", spec.name, "--runtime", spec.runtime, "--role", spec.role, "--duty", spec.duty],
      CreatedEntitySchema,
      `agent create ${spec.name}`,
    );
    agentIds.push(created.id);
  }

  const [adaId, miloId, soraId] = agentIds;

  const issueSpecs = [
    {
      title: "Wire live VDP DevTools protocol for remote inspection and screenshot capture",
      priority: "urgent",
      status: "in_progress",
      agent: adaId,
      description: [
        "## Context",
        "Enable CDP-style live loopback inspection (`--remote-debugging-port` / `VIBEVALLEY_DEBUG_PORT=0`) across `apps/mac` and `vibevalley debug`.",
        "",
        "## Deliverables",
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
      agent: miloId,
      description: [
        "## Problem",
        "Long bullet items in `OutlineView` clipped horizontally at 1280px instead of wrapping cleanly beneath the disclosure chevron.",
        "",
        "## Approach",
        "- Enforce `min-w-0 flex-1` on node text containers and wrap long URLs/sentences gracefully",
        "- Keep `Tab` / `Shift+Tab` indent focus stable when reparenting nested todos",
      ].join("\n"),
      criteria: ["Long wrapping outline nodes display full copy without clipping", "Todo checkbox toggle updates progress counters immediately"],
    },
    {
      title: "Silent WKWebView auto-cover capture for HTML prototype artifacts",
      priority: "high",
      status: "in_review",
      agent: soraId,
      description: [
        "## Summary",
        "When opening a `prototype` artifact in `PrototypeView`, silently snapshot the loaded `WKWebView` into `artifact.cover.set` so `/library` cards display live thumbnails.",
      ].join("\n"),
      criteria: [
        "Library card updates with captured cover PNG after visiting prototype view",
        "Capture avoids flicker and skips redundant writes when seq is unchanged",
      ],
    },
    {
      title: "Unify Papertrails light and dark surface contrast tokens across 12 artifact views",
      priority: "medium",
      status: "todo",
      agent: miloId,
      description: [
        "## Audit Scope",
        "Verify WCAG AA contrast (>= 4.5:1) across `surface`, `panel`, `side`, and `ink` tokens in both light and dark modes across Dashboard, Design System, Whiteboard, and Settings.",
      ].join("\n"),
      criteria: ["All 12 artifact views use theme tokens without hardcoded hex borders"],
    },
    {
      title: "Add incremental snapshot compaction for long-lived whiteboard sessions",
      priority: "medium",
      status: "todo",
      agent: adaId,
      description: [
        "## Goal",
        "Compact Loro update history when collaborative whiteboards cross 500 incremental edits while preserving per-origin undo checkpoints.",
      ].join("\n"),
      criteria: ["History preview remains deterministic before and after compaction"],
    },
    {
      title: "Publish Q4 developer ergonomics retrospective and release checklist",
      priority: "low",
      status: "done",
      agent: soraId,
      description: [
        "## Highlights",
        "Consolidated native build timings, VDP debugging workflow, and screenshot acceptance steps for the alpha.5 release cut.",
      ].join("\n"),
      criteria: ["Checklist archived and announced in #release-ops"],
    },
  ] as const;

  const issueIds: string[] = [];
  for (let idx = 0; idx < issueSpecs.length; idx++) {
    const spec = issueSpecs[idx]!;
    const descPath = writeTempPayload(payloadDir, `issue-${idx + 1}.md`, spec.description);
    const createArgs = ["issue", "create", spec.title, "--priority", spec.priority, "--description", `@${descPath}`];
    // Assign agents up front only for in_progress items; other statuses transition cleanly before optional assignment.
    if (spec.agent && spec.status === "in_progress") createArgs.push("--agent", spec.agent);
    for (const criterion of spec.criteria) createArgs.push("--criterion", criterion);
    const created = vvJson(createArgs, CreatedEntitySchema, `issue create #${idx + 1}`);
    issueIds.push(created.id);
    const transitions: Record<typeof spec.status, readonly string[]> = {
      todo: ["todo"],
      in_progress: ["todo", "in_progress"],
      in_review: ["todo", "in_progress", "in_review"],
      done: ["todo", "in_progress", "in_review", "done"],
    };
    for (const stepStatus of transitions[spec.status]) {
      const res = runSoft(cliBin, ["issue", "status", created.id, stepStatus], { cwd: root, env: cliEnv, timeoutMs: 15_000 });
      if (!res.ok) break;
    }
  }

  const firstIssueId = issueIds[0]!;

  const releaseChannel = vvJson(
    ["channel", "create", "release-ops", "--description", "Release readiness, live VDP verification, and Papertrails UX reviews"],
    CreatedEntitySchema,
    "channel create release-ops",
  );

  const docsMarkdown = [
    "# VDP Remote Debugging Architecture RFC",
    "",
    "## Executive Summary",
    "VibeValley exposes a loopback-only JSON-RPC 2.0 WebSocket protocol (**VDP**) so CLI tools, automated visual audits, and the embedded DevTools inspector share one typed observation and actuation layer.",
    "",
    "## Protocol Domains",
    "- **Target**: `Target.list`, `Target.attach`, `Target.detach`",
    "- **Shell**: `Shell.getState`, `Shell.navigate`, `Shell.resize`, `Shell.setTheme`",
    "- **Page**: `Page.captureScreenshot` (GPUI Metal frame or active `WKWebView`), `Page.getMetrics`",
    "- **UI**: `UI.getTree`, `UI.query`, `UI.press`, `UI.waitFor` via `vdpProbe`",
    "",
    "## Security Boundary",
    "Every VDP listener binds strictly to `127.0.0.1`, generates a per-launch bearer token persisted under `$VIBEVALLEY_HOME/debug.json` (`0600`), and never opens external ports.",
  ].join("\n");
  const docsFile = writeTempPayload(payloadDir, "docs.md", docsMarkdown);
  const docsArtifact = vvJson(
    [
      "artifact",
      "create",
      "VDP Remote Debugging Architecture RFC",
      "--type",
      "docs",
      "--content",
      `@${docsFile}`,
      "--issue",
      firstIssueId,
      "--channel",
      "general",
      "--announce",
      "--note",
      "Architecture RFC for VDP loopback inspection",
    ],
    CreatedEntitySchema,
    "artifact create docs",
  );

  const outlineDoc = {
    version: 1,
    rootIds: ["n_release", "n_ux", "n_risks"],
    nodes: {
      n_release: {
        id: "n_release",
        text: "Release 0.2 — Native Workbench Polish",
        kind: "heading",
        children: ["n_r1", "n_r2", "n_r3"],
        props: { owner: "Ada" },
      },
      n_r1: {
        id: "n_r1",
        text: "Verify live VDP screenshot runner captures light & dark screens at 1280×840 with zero console or hosted view errors",
        kind: "todo",
        checked: true,
        children: [],
      },
      n_r2: {
        id: "n_r2",
        text: "Ensure multiline wrapping in OutlineView handles long descriptive specifications gracefully even when nested three levels deep inside a collaborative release checklist without clipping punctuation or overflowing the card boundary",
        kind: "todo",
        checked: false,
        children: ["n_r2a", "n_r2b"],
      },
      n_r2a: {
        id: "n_r2a",
        text: "Confirm disclosure chevron stays top-aligned with the first line of wrapped text",
        kind: "bullet",
        children: [],
      },
      n_r2b: {
        id: "n_r2b",
        text: "Validate keyboard Tab / Shift+Tab preserves focus while indenting subtrees",
        kind: "todo",
        checked: true,
        children: [],
      },
      n_r3: {
        id: "n_r3",
        text: "Freeze Papertrails token baseline in default design-system artifact before beta cut",
        kind: "todo",
        checked: false,
        children: [],
      },
      n_ux: {
        id: "n_ux",
        text: "Visual & Accessibility Checks",
        kind: "heading",
        children: ["n_u1", "n_u2"],
        props: { owner: "Milo" },
      },
      n_u1: {
        id: "n_u1",
        text: "Check WCAG AA contrast across light parchment and dark charcoal surfaces",
        kind: "todo",
        checked: true,
        children: [],
      },
      n_u2: {
        id: "n_u2",
        text: "Audit spacing rhythm across Issues board, Library masonry cards, and Settings panes",
        kind: "bullet",
        children: [],
      },
      n_risks: {
        id: "n_risks",
        text: "Open Risks & Mitigations",
        kind: "heading",
        children: ["n_k1"],
      },
      n_k1: {
        id: "n_k1",
        text: "WKWebView prototype cover capture needs initial visit settle window so library thumbnails never render stale placeholders",
        kind: "quote",
        children: [],
      },
    },
  };
  const outlineFile = writeTempPayload(payloadDir, "outline.json", `${JSON.stringify(outlineDoc, null, 2)}\n`);
  const outlineArtifact = vvJson(
    [
      "artifact",
      "create",
      "Release 0.2 UX Polish & Launch Checklist",
      "--type",
      "outline",
      "--content",
      `@${outlineFile}`,
      "--issue",
      issueIds[1] ?? firstIssueId,
    ],
    CreatedEntitySchema,
    "artifact create outline",
  );

  const dashboardDoc = {
    title: "Q4 Platform Reliability & SLO Dashboard",
    filters: [],
    panels: [
      {
        id: "kpi_avail",
        kind: "kpi",
        label: "Mean Availability",
        source: { dataset: "structure/data/sample.json", field: "availability", agg: "avg" },
        format: "percent",
      },
      {
        id: "kpi_p99",
        kind: "kpi",
        label: "Peak P99 Latency (ms)",
        source: { dataset: "structure/data/sample.json", field: "p99Ms", agg: "max" },
        format: "number",
      },
      {
        id: "kpi_budget",
        kind: "kpi",
        label: "Min Error Budget",
        source: { dataset: "structure/data/sample.json", field: "budgetLeft", agg: "min" },
        format: "percent",
      },
      {
        id: "kpi_throughput",
        kind: "kpi",
        label: "Total Req/s",
        source: { dataset: "structure/data/sample.json", field: "rps", agg: "sum" },
        format: "number",
      },
    ],
  };
  const dashboardDataset = {
    schema: [
      { name: "service", label: "Service", type: "string" },
      { name: "availability", label: "Availability %", type: "number" },
      { name: "p99Ms", label: "P99 (ms)", type: "number" },
      { name: "budgetLeft", label: "Budget Left %", type: "number" },
      { name: "rps", label: "Req/s", type: "number" },
    ],
    rows: [
      { service: "Gateway RPC", availability: 99.98, p99Ms: 14.2, budgetLeft: 94, rps: 1840 },
      { service: "Slice Feed", availability: 99.99, p99Ms: 9.6, budgetLeft: 97, rps: 2420 },
      { service: "Collab Loro", availability: 99.95, p99Ms: 21.4, budgetLeft: 86, rps: 1120 },
      { service: "VDP Bridge", availability: 99.97, p99Ms: 11.8, budgetLeft: 91, rps: 640 },
      { service: "Media Pipeline", availability: 99.92, p99Ms: 34.5, budgetLeft: 78, rps: 390 },
    ],
  };
  const dashboardFile = writeTempPayload(payloadDir, "dashboard.json", `${JSON.stringify(dashboardDoc, null, 2)}\n`);
  const dashboardDataFile = writeTempPayload(payloadDir, "sample.json", `${JSON.stringify(dashboardDataset, null, 2)}\n`);
  const dashboardArtifact = vvJson(
    ["artifact", "create", "Q4 Platform Reliability & SLO Dashboard", "--type", "dashboard", "--content", `@${dashboardFile}`],
    CreatedEntitySchema,
    "artifact create dashboard",
  );
  vv(["artifact", "file", "write", dashboardArtifact.id, "structure/data/sample.json", `@${dashboardDataFile}`, "--mime", "application/json"]);

  const dsTokens = {
    name: "Papertrails Fieldcraft Design System",
    version: "1.2.0",
    defaultTheme: "light",
    color: [
      { id: "surface", group: "surface", value: { light: "#fcfcfb", dark: "#151413" }, note: "Primary parchment & obsidian canvas" },
      { id: "panel", group: "surface", value: { light: "#f4f3ef", dark: "#1f1d1b" }, note: "Secondary cards, sidebars, and callouts" },
      { id: "ink", group: "text", value: { light: "#1c1917", dark: "#ecebe8" }, note: "Primary body & headline ink" },
      { id: "muted", group: "text", value: { light: "#6b655e", dark: "#a69f95" }, note: "Secondary metadata & timestamps" },
      { id: "accent", group: "brand", value: { light: "#4d7a2a", dark: "#7fae4f" }, note: "Field moss primary action" },
      { id: "water", group: "semantic", value: { light: "#2b7a9b", dark: "#5ea8c9" }, note: "Active run & telemetry highlight" },
      { id: "sun", group: "semantic", value: { light: "#c9851e", dark: "#e5a94c" }, note: "Review pending & warm emphasis" },
      { id: "berry", group: "status", value: { light: "#b83a2d", dark: "#e06c5f" }, note: "Urgent priority & destructive states" },
    ],
    type: {
      families: [
        { id: "sans", value: "SF Pro Text, system-ui, -apple-system, sans-serif" },
        { id: "mono", value: "SF Mono, ui-monospace, Menlo, monospace" },
      ],
      scale: [
        { id: "xs", value: "12px" },
        { id: "sm", value: "13px" },
        { id: "md", value: "15px" },
        { id: "lg", value: "18px" },
        { id: "xl", value: "24px" },
      ],
      styles: [
        { id: "display", family: "{sans}", size: "{xl}", weight: 700, lineHeight: 1.2 },
        { id: "title", family: "{sans}", size: "{lg}", weight: 600, lineHeight: 1.3 },
        { id: "body", family: "{sans}", size: "{md}", weight: 400, lineHeight: 1.55 },
        { id: "caption", family: "{sans}", size: "{xs}", weight: 500, lineHeight: 1.4 },
      ],
    },
    space: [
      { id: "1", value: "4px" },
      { id: "2", value: "8px" },
      { id: "3", value: "12px" },
      { id: "4", value: "16px" },
      { id: "6", value: "24px" },
      { id: "8", value: "32px" },
    ],
    radius: [
      { id: "sm", value: "6px" },
      { id: "md", value: "10px" },
      { id: "lg", value: "16px" },
      { id: "full", value: "9999px" },
    ],
  };
  const dsButtonComp = {
    id: "button",
    title: "Action Button",
    summary: "Tactile cardstock buttons with crisp focus rings and WCAG AA contrast.",
    variants: [
      { id: "primary", bg: "{color.accent}", fg: "{color.surface}" },
      { id: "secondary", bg: "{color.panel}", fg: "{color.ink}" },
      { id: "danger", bg: "{color.berry}", fg: "{color.surface}" },
    ],
    states: ["default", "hover", "active", "disabled"],
    guidelines: {
      do: ["Use one primary action per toolbar or dialog footer"],
      dont: ["Never mix raw hex fills outside design tokens"],
    },
  };
  const dsBadgeComp = {
    id: "badge",
    title: "Status Pill",
    summary: "Compact semantic indicator for issue status, theme mode, and live runtime health.",
    variants: [
      { id: "accent", bg: "{color.accent}", fg: "{color.surface}" },
      { id: "water", bg: "{color.water}", fg: "{color.surface}" },
      { id: "neutral", bg: "{color.panel}", fg: "{color.muted}" },
    ],
    states: ["default"],
    guidelines: {
      do: ["Pair semantic color with concise 1-2 word status copy"],
      dont: ["Avoid using status pills as interactive primary triggers"],
    },
  };
  const dsTokensFile = writeTempPayload(payloadDir, "tokens.json", `${JSON.stringify(dsTokens, null, 2)}\n`);
  const dsButtonFile = writeTempPayload(payloadDir, "button.json", `${JSON.stringify(dsButtonComp, null, 2)}\n`);
  const dsBadgeFile = writeTempPayload(payloadDir, "badge.json", `${JSON.stringify(dsBadgeComp, null, 2)}\n`);
  const dsArtifact = vvJson(
    ["artifact", "create", "Papertrails Fieldcraft Design System", "--type", "design-system", "--default", "--content", `@${dsTokensFile}`],
    CreatedEntitySchema,
    "artifact create design-system",
  );
  vv(["artifact", "file", "write", dsArtifact.id, "structure/components/button.json", `@${dsButtonFile}`, "--mime", "application/json"]);
  vv(["artifact", "file", "write", dsArtifact.id, "structure/components/badge.json", `@${dsBadgeFile}`, "--mime", "application/json"]);

  const whiteboardDoc = {
    version: 1,
    grid: "architectural",
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: {
      t_title: {
        id: "t_title",
        type: "text",
        variant: "title",
        x: 64,
        y: 28,
        w: 760,
        h: 48,
        label: "Q4 Native Workbench & VDP Architecture",
      },
      t_sub: {
        id: "t_sub",
        type: "text",
        variant: "subtitle",
        x: 64,
        y: 78,
        w: 760,
        h: 28,
        label: "Zero-drift loopback debugging, 6-slice state feeds, and 12 collaborative artifact surfaces in 14 days",
        highlight: "14 days",
      },
      grp_core: {
        id: "grp_core",
        type: "container",
        x: 56,
        y: 128,
        w: 544,
        h: 292,
        title: "Desktop Host & VDP Loopback",
        fill: "side",
      },
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
        title: "Loro Artifact Collab",
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
  const whiteboardArtifact = vvJson(
    ["artifact", "create", "Q4 Release Milestone & System Topology", "--type", "whiteboard", "--content", `@${whiteboardFile}`],
    CreatedEntitySchema,
    "artifact create whiteboard",
  );

  const slideDefs = [
    {
      id: "s01-cover",
      file: "structure/slides/s01-cover.json",
      layout: "cover",
      title: "VibeValley Native Workbench",
      subtitle: "Sprint Review — VDP Live Inspection & Artifact Collab",
      blocks: [],
      notes: "Lead with the live VDP capture loop and zero-drift native performance.",
    },
    {
      id: "s02-vdp",
      file: "structure/slides/s02-vdp.json",
      layout: "content",
      title: "Live VDP Remote Debugging",
      subtitle: "Single typed executor for CLI, DevTools, and UX audits",
      blocks: [
        { kind: "bullet", text: "Loopback discovery via debug.json with ephemeral bearer tokens" },
        { kind: "bullet", text: "Live Shell.navigate, Shell.setTheme, UI.getTree, and Metal screenshots" },
        { kind: "bullet", text: "One-command vp run ui:review captures every major route in light & dark" },
      ],
      notes: "Show the contact sheet output after this slide.",
    },
    {
      id: "s03-artifacts",
      file: "structure/slides/s03-artifacts.json",
      layout: "content",
      title: "12 Collaborative Artifact Surfaces",
      subtitle: "Directory-backed storage with per-origin history",
      blocks: [
        { kind: "bullet", text: "Outline multiline wrap & keyboard indent polish" },
        { kind: "bullet", text: "Silent WKWebView cover snapshots for interactive HTML prototypes" },
        { kind: "bullet", text: "Traceable SLO dashboards linked directly to structure/data/*.json" },
      ],
      notes: "Highlight how agents and humans edit concurrently.",
    },
  ] as const;
  const deckDoc = {
    title: "VibeValley Native Workbench — Sprint Review",
    aspectRatio: "16:9",
    designSystemId: dsArtifact.id,
    slides: slideDefs.map((s) => ({ id: s.id, file: s.file, title: s.title })),
  };
  const deckFile = writeTempPayload(payloadDir, "deck.json", `${JSON.stringify(deckDoc, null, 2)}\n`);
  const slidesArtifact = vvJson(
    ["artifact", "create", "VibeValley Native Workbench — Sprint Review", "--type", "slides", "--content", `@${deckFile}`],
    CreatedEntitySchema,
    "artifact create slides",
  );
  for (const slide of slideDefs) {
    const slideFile = writeTempPayload(payloadDir, `${slide.id}.json`, `${JSON.stringify(slide, null, 2)}\n`);
    vv(["artifact", "file", "write", slidesArtifact.id, slide.file, `@${slideFile}`, "--mime", "application/json"]);
  }

  const workbookDoc = {
    title: "Native Rendering & Latency Benchmark Matrix",
    locale: "en-US",
    currency: "USD",
    sheets: [
      { id: "sheet1", title: "Frame & RPC Benchmarks", file: "structure/sheets/sheet1.json" },
      { id: "sheet2", title: "Test Harness Config", file: "structure/sheets/sheet2.json" },
    ],
    namedRanges: {},
  };
  const sheet1Doc = {
    id: "sheet1",
    title: "Frame & RPC Benchmarks",
    columns: [
      { key: "workload", title: "Workload", type: "string" },
      { key: "p50Ms", title: "P50 (ms)", type: "number" },
      { key: "p99Ms", title: "P99 (ms)", type: "number" },
      { key: "rssMb", title: "Memory (MB)", type: "number" },
      { key: "status", title: "Status", type: "string" },
    ],
    rows: [
      { workload: "Board slice projection (200 issues)", p50Ms: 1.4, p99Ms: 3.8, rssMb: 74, status: "Pass" },
      { workload: "VDP Page.captureScreenshot (1280×840)", p50Ms: 42.0, p99Ms: 68.5, rssMb: 118, status: "Pass" },
      { workload: "Outline CRDT merge (500 nodes)", p50Ms: 2.1, p99Ms: 6.4, rssMb: 82, status: "Pass" },
      { workload: "Whiteboard pan/zoom 60fps frame", p50Ms: 4.8, p99Ms: 11.2, rssMb: 96, status: "Pass" },
    ],
  };
  const sheet2Doc = {
    id: "sheet2",
    title: "Test Harness Config",
    columns: [
      { key: "param", title: "Parameter", type: "string" },
      { key: "value", title: "Value", type: "string" },
    ],
    rows: [
      { param: "Viewport", value: "1280×840 @2x" },
      { param: "Server Mode", value: "Embedded loopback SQLite" },
      { param: "Theme Sweep", value: "Light + Dark" },
    ],
  };
  const workbookFile = writeTempPayload(payloadDir, "workbook.json", `${JSON.stringify(workbookDoc, null, 2)}\n`);
  const sheet1File = writeTempPayload(payloadDir, "sheet1.json", `${JSON.stringify(sheet1Doc, null, 2)}\n`);
  const sheet2File = writeTempPayload(payloadDir, "sheet2.json", `${JSON.stringify(sheet2Doc, null, 2)}\n`);
  const sheetArtifact = vvJson(
    ["artifact", "create", "Native Rendering & Latency Benchmark Matrix", "--type", "sheet", "--content", `@${workbookFile}`],
    CreatedEntitySchema,
    "artifact create sheet",
  );
  vv(["artifact", "file", "write", sheetArtifact.id, "structure/sheets/sheet1.json", `@${sheet1File}`, "--mime", "application/json"]);
  vv(["artifact", "file", "write", sheetArtifact.id, "structure/sheets/sheet2.json", `@${sheet2File}`, "--mime", "application/json"]);

  const protoHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Interactive Release Readiness Explorer</title>
  <link rel="stylesheet" href="./styles.css" />
</head>
<body>
  <main class="canvas">
    <header class="hero">
      <div>
        <span class="eyebrow">PAPERTRAILS · ALPHA 0.2</span>
        <h1>Release Readiness Explorer</h1>
        <p class="subtitle">Interactive rollout gate monitor backed by live VDP telemetry and automated surface checks.</p>
      </div>
      <div class="pill-group" role="tablist" aria-label="Filter release checks">
        <button type="button" class="pill active" data-filter="all">All Gates (6)</button>
        <button type="button" class="pill" data-filter="ready">Ready (4)</button>
        <button type="button" class="pill" data-filter="review">In Review (2)</button>
      </div>
    </header>
    <section class="metrics">
      <article class="metric-card"><span class="m-label">Visual Coverage</span><strong class="m-val">13 / 13</strong><span class="m-hint">Light + Dark verified</span></article>
      <article class="metric-card"><span class="m-label">Mean Frame Time</span><strong class="m-val">6.4 ms</strong><span class="m-hint">Target &lt; 16.6 ms</span></article>
      <article class="metric-card"><span class="m-label">Shell Errors</span><strong class="m-val ok">0</strong><span class="m-hint">Strict zero-error gate</span></article>
      <article class="metric-card"><span class="m-label">Artifact Surfaces</span><strong class="m-val">12</strong><span class="m-hint">CRDT collab enabled</span></article>
    </section>
    <section class="gates" id="gate-list"></section>
  </main>
  <script type="module" src="./app.js"></script>
</body>
</html>
`;
  const protoCss = `:root {
  --bg: #f8f6f1;
  --surface: #ffffff;
  --ink: #1c1917;
  --muted: #645e56;
  --line: #e4dfd5;
  --accent: #4d7a2a;
  --accent-soft: #e9f2e1;
  --review: #b86e18;
  --review-soft: #fdf2e2;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 28px 32px;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, sans-serif;
  background: radial-gradient(circle at top right, #eef4e6 0%, var(--bg) 52%);
  color: var(--ink);
}
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
.m-label { font-size: 12px; color: var(--muted); font-weight: 500; }
.m-val { font-size: 24px; font-weight: 700; font-variant-numeric: tabular-nums; }
.m-val.ok { color: var(--accent); }
.m-hint { font-size: 11px; color: var(--muted); }
.gates { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.gate { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.gate-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.gate-title { font-size: 14px; font-weight: 600; margin: 0; }
.status { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.status.ready { background: var(--accent-soft); color: var(--accent); }
.status.review { background: var(--review-soft); color: var(--review); }
.gate-desc { margin: 0; font-size: 12px; color: var(--muted); line-height: 1.5; }
.gate-foot { display: flex; justify-content: space-between; font-size: 11px; font-family: ui-monospace, SFMono-Regular, monospace; color: var(--muted); }
`;
  const protoJs = `const gates = [
  { title: "VDP Loopback Protocol", status: "ready", owner: "Ada", metric: "14/14 RPCs", desc: "Authenticated WebSocket discovery, Shell controls, and UI probe queries." },
  { title: "GPUI Metal Screenshots", status: "ready", owner: "Ada", metric: "1280×840 PNG", desc: "Off-thread PNG encoding works even when the macOS display is locked." },
  { title: "Outline Multiline Wrapping", status: "review", owner: "Milo", metric: "PR #418", desc: "Long nested checklist rows wrap cleanly under disclosure chevrons." },
  { title: "WKWebView Auto-Cover", status: "review", owner: "Sora", metric: "Auto PNG", desc: "Silent cover capture refreshes Library cards on prototype visit." },
  { title: "Papertrails Dual Theme", status: "ready", owner: "Milo", metric: "WCAG AA", desc: "Unified parchment light and obsidian dark semantic surfaces." },
  { title: "CRDT Directory Storage", status: "ready", owner: "Sora", metric: "12 types", desc: "Per-origin history and collaborative presence across all views." },
];
const list = document.getElementById("gate-list");
let current = "all";
function render() {
  list.replaceChildren();
  for (const item of gates.filter((g) => current === "all" || g.status === current)) {
    const card = document.createElement("article");
    card.className = "gate";
    card.innerHTML =
      '<div class="gate-top"><h2 class="gate-title"></h2><span class="status"></span></div>' +
      '<p class="gate-desc"></p>' +
      '<div class="gate-foot"><span class="owner"></span><span class="metric"></span></div>';
    card.querySelector(".gate-title").textContent = item.title;
    const badge = card.querySelector(".status");
    badge.classList.add(item.status);
    badge.textContent = item.status === "ready" ? "Ready" : "In Review";
    card.querySelector(".gate-desc").textContent = item.desc;
    card.querySelector(".owner").textContent = "Owner: " + item.owner;
    card.querySelector(".metric").textContent = item.metric;
    list.append(card);
  }
}
for (const btn of document.querySelectorAll(".pill")) {
  btn.addEventListener("click", () => {
    current = btn.getAttribute("data-filter") || "all";
    for (const b of document.querySelectorAll(".pill")) b.classList.toggle("active", b === btn);
    render();
  });
}
render();
`;
  const protoHtmlFile = writeTempPayload(payloadDir, "proto-index.html", protoHtml);
  const protoCssFile = writeTempPayload(payloadDir, "proto-styles.css", protoCss);
  const protoJsFile = writeTempPayload(payloadDir, "proto-app.js", protoJs);
  const protoArtifact = vvJson(
    [
      "artifact",
      "create",
      "Interactive Release Readiness Explorer",
      "--type",
      "prototype",
      "--content",
      `@${protoHtmlFile}`,
      "--issue",
      issueIds[2] ?? firstIssueId,
      "--channel",
      "general",
      "--announce",
      "--note",
      "Interactive rollout readiness explorer prototype",
    ],
    CreatedEntitySchema,
    "artifact create prototype",
  );
  vv(["artifact", "file", "write", protoArtifact.id, "structure/styles.css", `@${protoCssFile}`, "--mime", "text/css"]);
  vv(["artifact", "file", "write", protoArtifact.id, "structure/app.js", `@${protoJsFile}`, "--mime", "application/javascript"]);

  const generalMessages = [
    `Kicked off the live VDP visual sweep — tracking architecture details in ${docsArtifact.id} ("VDP Remote Debugging Architecture RFC").`,
    `Outline multiline wrapping fix is up for review; check the nested checklist in ${outlineArtifact.id} at 1280×840.`,
    `Posted the interactive Release Readiness Explorer (${protoArtifact.id}) — visiting it once captures the WKWebView cover thumbnail for /library.`,
    `Papertrails Fieldcraft tokens (${dsArtifact.id}) are set as default so Dashboard, Whiteboard, and Slides stay visually aligned in light and dark themes.`,
  ];
  for (const msg of generalMessages) {
    vv(["channel", "message", "send", "general", msg]);
  }

  const releaseOpsMessages = [
    `SLO dashboard (${dashboardArtifact.id}) shows 99.96% mean availability across Gateway RPC, Slice Feed, and VDP Bridge.`,
    `All 6 release issues are triaged across todo, in_progress, in_review, and done — ready for the full-app VDP UX review pass.`,
  ];
  for (const msg of releaseOpsMessages) {
    vv(["channel", "message", "send", releaseChannel.id, msg]);
  }

  return {
    firstIssueId,
    issueIds,
    agentIds,
    channelIds: ["general", releaseChannel.id],
    artifacts: {
      docs: docsArtifact.id,
      outline: outlineArtifact.id,
      dashboard: dashboardArtifact.id,
      designSystem: dsArtifact.id,
      whiteboard: whiteboardArtifact.id,
      slides: slidesArtifact.id,
      sheet: sheetArtifact.id,
      prototype: protoArtifact.id,
    },
  };
}

function readValidJsonFile<T>(filePath: string, schema: z.ZodType<T>): T | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function waitForSandboxReady(
  homeDir: string,
  cliBin: string,
  root: string,
  cliEnv: NodeJS.ProcessEnv,
  appExited: () => number | null,
  logPath: string,
): Promise<void> {
  const debugJsonPath = join(homeDir, "debug.json");
  const serverJsonPath = join(homeDir, "server.json");
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const code = appExited();
    if (code !== null) {
      throw new Error(`vibevalley-mac exited early with code ${code} (see ${logPath})`);
    }
    const debugInfo = readValidJsonFile(debugJsonPath, DebugEndpointFileSchema);
    const serverInfo = readValidJsonFile(serverJsonPath, ServerReceiptSchema);
    if (debugInfo && serverInfo) {
      const stateRes = runSoft(cliBin, ["debug", "--home", homeDir, "state", "--json"], { cwd: root, env: cliEnv, timeoutMs: 10_000 });
      if (stateRes.ok) {
        try {
          const parsed = ShellStateSchema.safeParse(JSON.parse(stateRes.stdout));
          if (parsed.success && parsed.data.loaded && parsed.data.workbench?.ready === true) {
            return;
          }
        } catch {
          /* Retry while shell finishes hydrating its initial state snapshot. */
        }
      }
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for VDP debug.json, server.json, and workbench readiness in ${homeDir} (see ${logPath})`);
}

function signalGroup(pid: number | undefined, sig: "SIGTERM" | "SIGKILL"): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(-pid, sig);
    return true;
  } catch (err) {
    if (errorCode(err) === "ESRCH") return true;
    if (errorCode(err) === "EPERM") return false;
    throw err;
  }
}

function groupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (errorCode(err) === "ESRCH") return false;
    if (errorCode(err) === "EPERM") return true;
    throw err;
  }
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
  const targetDir = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : resolve(root, "target");
  const macBin = resolve(targetDir, "debug/vibevalley-mac");
  const cliBin = resolve(targetDir, "debug/vibevalley");
  const uiBundle = resolve(root, "apps/mac/ui/build/bundle.nshc");
  const uiShellBundle = resolve(root, "apps/mac/ui/build-shell/bundle.nshc");
  const nshBin = resolve(root, ".tools/bin/nsh");

  if (!options.skipBuild || !existsSync(uiBundle) || !existsSync(uiShellBundle)) {
    runChecked(nshBin, ["build", "App.tsx", "-o", "build"], { cwd: resolve(root, "apps/mac/ui"), timeoutMs: 180_000 });
    runChecked(nshBin, ["build", "ShellApp.tsx", "-o", "build-shell"], { cwd: resolve(root, "apps/mac/ui"), timeoutMs: 180_000 });
  }
  if (!options.skipBuild || !existsSync(macBin)) {
    runChecked("cargo", ["build", "-p", "vibevalley-mac", "--features", "shot"], { cwd: root, timeoutMs: 600_000 });
  }
  if (!options.skipBuild || !existsSync(cliBin)) {
    runChecked("cargo", ["build", "-p", "vibevalley-cli"], { cwd: root, timeoutMs: 300_000 });
  }

  const shotsDir = resolve(options.outDir, "shots");
  mkdirSync(options.outDir, { recursive: true });
  rmSync(shotsDir, { recursive: true, force: true });
  mkdirSync(shotsDir, { recursive: true });

  const sandboxDir = mkdtempSync(join(tmpdir(), "vv-ux-review-"));
  const homeDir = join(sandboxDir, "home");
  const workDir = join(sandboxDir, "work");
  const payloadDir = join(sandboxDir, "payloads");
  const storeDb = join(sandboxDir, "state.db");
  const sandboxLogPath = join(sandboxDir, "app.log");
  const outLogPath = resolve(options.outDir, "app.log");
  for (const dir of [homeDir, workDir, payloadDir]) mkdirSync(dir, { recursive: true });

  const appEnv = isolatedEnv(root, homeDir, workDir, storeDb);
  const cliEnv: Record<string, string> = { ...appEnv, VIBEVALLEY_HOME: homeDir };

  const logFd = openSync(sandboxLogPath, "w");
  let child: ChildProcess | undefined;
  let exitCode: number | null = null;
  let exitedPromise: Promise<number> = Promise.resolve(0);

  const onSignal = () => {
    signalGroup(child?.pid, "SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  const vdp = (args: readonly string[], timeoutMs = 20_000): string =>
    runChecked(cliBin, ["debug", "--home", homeDir, ...args], { cwd: root, env: cliEnv, capture: true, timeoutMs });

  try {
    child = spawn(macBin, [], {
      cwd: root,
      env: appEnv,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    closeSync(logFd);

    exitedPromise = new Promise<number>((done) => {
      child?.once("exit", (code, sig) => {
        exitCode = code ?? (sig ? 128 : 1);
        done(exitCode);
      });
      child?.once("error", () => {
        exitCode = 1;
        done(1);
      });
    });

    await waitForSandboxReady(homeDir, cliBin, root, cliEnv, () => exitCode, sandboxLogPath);

    const seeded = seedRealisticWorkspace(cliBin, root, cliEnv, payloadDir);

    vdp(["resize", String(options.width), String(options.height), "--json"]);
    await sleep(300);

    // Visit the prototype once before capturing /library so silent WKWebView auto-cover populates its thumbnail.
    vdp(["navigate", `/artifacts/${seeded.artifacts.prototype}`, "--json"]);
    await sleep(1400);

    const plan = buildScreenMatrix(seeded, options.themes);
    const captures: ScreenCapture[] = [];
    let currentTheme: ReviewTheme | null = null;

    for (const entry of plan) {
      if (entry.theme !== currentTheme) {
        vdp(["theme", entry.theme === "dark" ? "--dark" : "--light", "--json"]);
        currentTheme = entry.theme;
        await sleep(400);
      }

      vdp(["navigate", entry.route, "--json"]);
      if (entry.waitTestId) {
        runSoft(cliBin, ["debug", "--home", homeDir, "ui-wait", "--test-id", entry.waitTestId, "--timeout-ms", "3500", "--json"], {
          cwd: root,
          env: cliEnv,
          timeoutMs: 10_000,
        });
      }
      await sleep(entry.settleMs);

      const pngPath = resolve(shotsDir, entry.fileName);
      const captureTarget = entry.target ?? "shell";
      const shot = parseJsonOutput(
        vdp(["screenshot", pngPath, "--target", captureTarget, "--json"], 25_000),
        ScreenshotSavedSchema,
        `debug screenshot ${entry.fileName}`,
      );

      const stateRaw: unknown = JSON.parse(vdp(["state", "--json"]));
      const shellCheck = extractShellErrors(stateRaw);

      let metrics: ScreenCapture["metrics"] = null;
      const metricsRes = runSoft(cliBin, ["debug", "--home", homeDir, "call", "Page.getMetrics", "--json"], { cwd: root, env: cliEnv });
      if (metricsRes.ok) {
        const parsedMetrics = PageMetricsSchema.safeParse(JSON.parse(metricsRes.stdout));
        if (parsedMetrics.success) {
          metrics = {
            width: parsedMetrics.data.width,
            height: parsedMetrics.data.height,
            scaleFactor: parsedMetrics.data.scaleFactor,
            themeDark: parsedMetrics.data.themeDark,
            lastFrameMs: parsedMetrics.data.lastFrameMs ?? null,
          };
        }
      }

      let uiNodeCount = 0;
      let uiRoute: string | null = null;
      const treeRes = runSoft(cliBin, ["debug", "--home", homeDir, "ui-tree", "--view", "workbench", "--json"], { cwd: root, env: cliEnv });
      if (treeRes.ok) {
        const parsedTree = UiTreeSchema.safeParse(JSON.parse(treeRes.stdout));
        if (parsedTree.success) {
          uiNodeCount = countUiTreeNodes(parsedTree.data.nodes);
          uiRoute = parsedTree.data.route ?? null;
        }
      }

      const fileBytes = existsSync(pngPath) ? statSync(pngPath).size : 0;
      const shellErrors = [...shellCheck.errors];
      if (fileBytes <= 0) {
        shellErrors.push(`screenshot missing or empty: ${pngPath}`);
      }

      captures.push({
        id: entry.id,
        label: entry.label,
        route: entry.route,
        theme: entry.theme,
        pngPath,
        relPath: `shots/${basename(pngPath)}`,
        bytes: fileBytes > 0 ? fileBytes : shot.bytes,
        imageWidth: shot.width,
        imageHeight: shot.height,
        metrics,
        uiNodeCount,
        uiRoute,
        shellRoute: shellCheck.route,
        shellErrors,
      });
    }

    // Request a graceful macOS quit over VDP before falling back to process group termination in finally.
    runSoft(cliBin, ["debug", "--home", homeDir, "key", "cmd-q", "--json"], { cwd: root, env: cliEnv, timeoutMs: 8_000 });
    const quitDeadline = Date.now() + 6_000;
    while (exitCode === null && Date.now() < quitDeadline) {
      await sleep(100);
    }

    const totalErrors = captures.reduce((sum, item) => sum + item.shellErrors.length, 0);
    const totalBytes = captures.reduce((sum, item) => sum + item.bytes, 0);
    const manifest: ReviewManifest = ReviewManifestSchema.parse({
      generatedAt: new Date().toISOString(),
      outDir: options.outDir,
      viewport: { width: options.width, height: options.height },
      themes: [...options.themes],
      seeded,
      screens: captures,
      summary: {
        totalScreens: captures.length,
        totalErrors,
        totalBytes,
      },
    });

    writeFileSync(resolve(options.outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    writeFileSync(resolve(options.outDir, "index.html"), renderContactSheetHtml(manifest), "utf8");

    if (totalErrors > 0) {
      const details = captures
        .filter((c) => c.shellErrors.length > 0)
        .map((c) => `${c.id} (${c.theme}): ${c.shellErrors.join("; ")}`)
        .join("\n- ");
      throw new Error(`vdp-review found ${totalErrors} shell/view error(s):\n- ${details}`);
    }

    console.log(
      `vdp-review: captured ${manifest.summary.totalScreens} screens (${manifest.themes.join(", ")}) -> ${resolve(options.outDir, "manifest.json")} & ${resolve(options.outDir, "index.html")}`,
    );
    return manifest;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);

    if (child && exitCode === null) {
      signalGroup(child.pid, "SIGTERM");
      const termDeadline = Date.now() + 6_000;
      while (groupAlive(child.pid) && Date.now() < termDeadline) {
        await sleep(100);
      }
      if (groupAlive(child.pid)) {
        signalGroup(child.pid, "SIGKILL");
      }
      await exitedPromise;
    }

    if (existsSync(sandboxLogPath)) {
      copyFileSync(sandboxLogPath, outLogPath);
    }
    if (!options.keepSandbox) {
      rmSync(sandboxDir, { recursive: true, force: true });
    } else {
      console.log(`vdp-review: kept sandbox at ${sandboxDir}`);
    }
  }
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
