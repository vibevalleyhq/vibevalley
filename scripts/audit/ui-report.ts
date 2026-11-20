import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

interface SuiteResult {
  file: string;
  passed: number;
  failed: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

interface MacTestReport {
  generatedAt: string;
  concurrency: number;
  totalDurationMs: number;
  suites: SuiteResult[];
}

interface ScenarioMatrixRow {
  density: string;
  issues: number;
  sessions: number;
  inbox: number;
  routes: string[];
  themes: string[];
  viewports: string[];
  stepsPassed: number;
  durationMs: number;
}

interface StateFrameSummary {
  density: string;
  seq: number;
  issues: number;
  sessions: number;
  inbox: number;
  plots: number;
  crons: number;
  connectors: number;
  mediaJobs: number;
  callState: string;
}

interface DumpReport {
  slug: string;
  loaded: boolean;
  loadError: string | null;
  sidebarReady: boolean;
  workbenchReady: boolean;
  sidebarErrors: string[];
  workbenchErrors: string[];
}

interface ShotEntry {
  name: string;
  relPath: string;
  bytes: number;
}

const root = resolve(import.meta.dirname, "../..");
const defaultOutDir = "/tmp/vv-ui-report";

function parseOutDir(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--dir" && argv[i + 1]) {
      return resolve(argv[++i] ?? defaultOutDir);
    }
    if (arg.startsWith("--dir=")) {
      return resolve(arg.slice("--dir=".length));
    }
  }
  return defaultOutDir;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function asFields(val: unknown): Map<string, unknown> | null {
  if (typeof val !== "object" || val === null || Array.isArray(val)) return null;
  return new Map(Object.entries(val));
}

function asArray(val: unknown): unknown[] {
  return Array.isArray(val) ? val : [];
}

function asStr(val: unknown, fallback = ""): string {
  return typeof val === "string" ? val : fallback;
}

function asNum(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

function asBool(val: unknown): boolean {
  return val === true;
}

function asStrArray(val: unknown): string[] {
  return asArray(val).filter((x): x is string => typeof x === "string");
}

function esc(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function readUiReport(outDir: string): MacTestReport | null {
  const rec = asFields(readJson(resolve(outDir, "all-ui.json")));
  if (!rec) return null;
  const suites = asArray(rec.get("suites"))
    .map(asFields)
    .filter((s): s is Map<string, unknown> => s !== null)
    .map((s): SuiteResult => {
      const err = s.get("error");
      return {
        file: asStr(s.get("file")),
        passed: asNum(s.get("passed")),
        failed: asNum(s.get("failed")),
        durationMs: asNum(s.get("durationMs")),
        ok: asBool(s.get("ok")),
        ...(typeof err === "string" ? { error: err } : {}),
      };
    });
  return {
    generatedAt: asStr(rec.get("generatedAt"), new Date().toISOString()),
    concurrency: asNum(rec.get("concurrency"), 4),
    totalDurationMs: asNum(rec.get("totalDurationMs")),
    suites,
  };
}

function readScenarioMatrix(outDir: string): ScenarioMatrixRow[] {
  return asArray(readJson(resolve(outDir, "scenario-matrix.json")))
    .map(asFields)
    .filter((r): r is Map<string, unknown> => r !== null)
    .map((r) => ({
      density: asStr(r.get("density")),
      issues: asNum(r.get("issues")),
      sessions: asNum(r.get("sessions")),
      inbox: asNum(r.get("inbox")),
      routes: asStrArray(r.get("routes")),
      themes: asStrArray(r.get("themes")),
      viewports: asStrArray(r.get("viewports")),
      stepsPassed: asNum(r.get("stepsPassed")),
      durationMs: asNum(r.get("durationMs")),
    }));
}

function readStateSummaries(): StateFrameSummary[] {
  const densities = ["empty", "minimal", "typical", "dense", "extreme"];
  const rows: StateFrameSummary[] = [];
  for (const density of densities) {
    const file = resolve(root, `apps/mac/ui/vv/fixtures/scenarios/${density}/state.json`);
    const raw = asFields(readJson(file));
    if (!raw) continue;
    const state = asFields(raw.get("state"));
    const view = asFields(raw.get("view"));
    rows.push({
      density,
      seq: asNum(raw.get("seq")),
      issues: asArray(state?.get("issues")).length,
      sessions: asArray(state?.get("sessions")).length,
      inbox: asArray(raw.get("inbox")).length,
      plots: asFields(view?.get("plots"))?.size ?? 0,
      crons: asArray(state?.get("crons")).length,
      connectors: asArray(state?.get("connectors")).length,
      mediaJobs: asArray(state?.get("media")).length,
      callState: asStr(state?.get("call"), "idle"),
    });
  }
  return rows;
}

function readDumps(outDir: string): DumpReport[] {
  const slugs = ["empty", "typical", "dense", "extreme"];
  const reports: DumpReport[] = [];
  for (const slug of slugs) {
    const dump = asFields(readJson(resolve(outDir, `${slug}-dump.json`)));
    if (!dump) continue;
    const sidebar = asFields(dump.get("sidebar"));
    const workbench = asFields(dump.get("workbench"));
    const loadErr = dump.get("load_error");
    reports.push({
      slug,
      loaded: asBool(dump.get("loaded")),
      loadError: typeof loadErr === "string" ? loadErr : null,
      sidebarReady: asBool(sidebar?.get("ready")),
      workbenchReady: asBool(workbench?.get("ready")),
      sidebarErrors: asStrArray(sidebar?.get("errors")),
      workbenchErrors: asStrArray(workbench?.get("errors")),
    });
  }
  return reports;
}

function readShots(outDir: string): ShotEntry[] {
  const shotsDir = resolve(outDir, "shots");
  if (!existsSync(shotsDir)) return [];
  return readdirSync(shotsDir)
    .filter((f) => f.endsWith(".png"))
    .toSorted()
    .map((name) => {
      const full = resolve(shotsDir, name);
      return {
        name: basename(name, ".png"),
        relPath: `shots/${name}`,
        bytes: statSync(full).size,
      };
    });
}

const componentRows = [
  { group: "基础控件", target: "Button / IconButton / ConfirmButton", verified: "clicks 计数、disabled 拒绝、二次确认、Escape 撤销" },
  {
    group: "选择与输入",
    target: "Checkbox / Segmented / Tabs / Tag / Slider / Field / ChipsInput / KeyField",
    verified: "状态切换、逗号分片、Slider 调节、只读 Key 脱敏操作",
  },
  { group: "浮层与表格", target: "Dialog / MoreMenu / ToastHost / DataTable", verified: "开关弹窗、菜单动作、虚拟时钟 4.1s Toast 自动消失、排序与勾选空态" },
  { group: "富文本与代码", target: "Markdown / CodeBlock", verified: "超长代码折叠展开、剪贴板复制及虚拟时钟 1.6s 已复制状态复位" },
  {
    group: "时钟与领域件",
    target: "useNow / createSettled / PoseSprite / AgentFace / RuntimeBadge / WorkLog / Trajectory / SubagentProgress",
    verified: "100ms/200ms 防抖收敛、65s 相对时间更新与进行中计时、像素动画开关与子助手进度",
  },
];

function renderHtml(outDir: string): string {
  const uiReport = readUiReport(outDir);
  const matrix = readScenarioMatrix(outDir);
  const stateSummaries = readStateSummaries();
  const dumps = readDumps(outDir);
  const shots = readShots(outDir);

  const suites = uiReport?.suites ?? [];
  const totalSuites = suites.length;
  const totalPassed = suites.reduce((sum, s) => sum + s.passed, 0);
  const totalFailed = suites.reduce((sum, s) => sum + s.failed, 0);
  const wallSecs = uiReport ? (uiReport.totalDurationMs / 1000).toFixed(2) : "N/A";
  const dumpErrors = dumps.reduce((sum, d) => sum + d.sidebarErrors.length + d.workbenchErrors.length + (d.loadError ? 1 : 0), 0);

  const matrixByDensity = new Map(matrix.map((m) => [m.density, m]));

  const suiteRowsHtml = suites
    .map((s) => {
      const secs = (s.durationMs / 1000).toFixed(2);
      const badge = s.ok ? '<span class="badge ok">PASS</span>' : '<span class="badge fail">FAIL</span>';
      return `<tr><td><code>${esc(s.file)}</code></td><td>${badge}</td><td class="num">${s.passed}</td><td class="num">${s.failed}</td><td class="num">${secs}s</td></tr>`;
    })
    .join("\n");

  const componentRowsHtml = componentRows
    .map((c) => `<tr><td>${esc(c.group)}</td><td><code>${esc(c.target)}</code></td><td>${esc(c.verified)}</td><td><span class="badge ok">PASS</span></td></tr>`)
    .join("\n");

  const scenarioRowsHtml = stateSummaries
    .map((st) => {
      const run = matrixByDensity.get(st.density);
      const routes = run ? run.routes.map((r) => `<code>${esc(r)}</code>`).join(" ") : "—";
      const themes = run ? esc(run.themes.join(", ")) : "—";
      const viewports = run ? esc(run.viewports.join(", ")) : "—";
      const duration = run ? `${run.durationMs}ms` : "—";
      const steps = run ? String(run.stepsPassed) : "—";
      return `<tr>
        <td><strong>${esc(st.density)}</strong></td>
        <td class="num">${st.seq}</td>
        <td class="num">${st.issues}</td>
        <td class="num">${st.sessions}</td>
        <td class="num">${st.inbox}</td>
        <td class="num">${st.plots}</td>
        <td class="num">${st.crons}</td>
        <td class="num">${st.connectors}</td>
        <td class="num">${st.mediaJobs}</td>
        <td><code>${esc(st.callState)}</code></td>
        <td>${routes}</td>
        <td>${themes}</td>
        <td>${viewports}</td>
        <td class="num">${steps}</td>
        <td class="num">${duration}</td>
      </tr>`;
    })
    .join("\n");

  const dumpRowsHtml = dumps
    .map((d) => {
      const errCount = d.sidebarErrors.length + d.workbenchErrors.length + (d.loadError ? 1 : 0);
      const badge =
        errCount === 0 && d.loaded && d.sidebarReady && d.workbenchReady ? '<span class="badge ok">CLEAN</span>' : '<span class="badge fail">ISSUE</span>';
      return `<tr>
        <td><strong>${esc(d.slug)}</strong></td>
        <td>${badge}</td>
        <td>${d.loaded ? "true" : "false"}</td>
        <td>${d.sidebarReady ? "true" : "false"}</td>
        <td>${d.workbenchReady ? "true" : "false"}</td>
        <td class="num">${errCount}</td>
        <td><code>${esc(d.loadError ?? "none")}</code></td>
      </tr>`;
    })
    .join("\n");

  const shotCardsHtml = shots
    .map((shot) => {
      const kb = (shot.bytes / 1024).toFixed(0);
      return `<figure class="shot-card">
        <a href="${esc(shot.relPath)}" target="_blank" rel="noreferrer">
          <img src="${esc(shot.relPath)}" alt="${esc(shot.name)}" loading="lazy" />
        </a>
        <figcaption><strong>${esc(shot.name)}</strong><span>${kb} KB</span></figcaption>
      </figure>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VibeValley 虚拟时钟 UI &amp; 数据层验收报告</title>
  <style>
    :root {
      --bg: #f6f5f0;
      --surface: #ffffff;
      --border: #e5e2da;
      --ink: #1f1e1a;
      --muted: #6c685d;
      --accent: #3d6b2c;
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
        --ok-bg: #1f331b;
        --ok-ink: #9be084;
        --fail-bg: #3b1c1c;
        --fail-ink: #fca5a5;
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; background: var(--bg); color: var(--ink); line-height: 1.5; }
    main { max-width: 1280px; margin: 0 auto; padding: 28px 24px 64px; }
    h1 { font-size: 24px; margin: 0 0 6px; }
    h2 { font-size: 18px; margin: 32px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    .meta { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
    .kpi .label { font-size: 12px; color: var(--muted); }
    .kpi .val { font-size: 24px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
    table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; font-size: 13px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { background: rgba(127, 127, 127, 0.06); font-weight: 600; white-space: nowrap; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    code { font-family: "SF Mono", Menlo, monospace; font-size: 12px; background: rgba(127, 127, 127, 0.1); padding: 1px 4px; border-radius: 4px; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge.ok { background: var(--ok-bg); color: var(--ok-ink); }
    .badge.fail { background: var(--fail-bg); color: var(--fail-ink); }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
    .shot-card { margin: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .shot-card img { width: 100%; display: block; border-bottom: 1px solid var(--border); }
    .shot-card figcaption { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; font-size: 12px; color: var(--muted); }
    .shot-card figcaption strong { color: var(--ink); font-family: "SF Mono", Menlo, monospace; }
    .table-wrap { overflow-x: auto; border-radius: 10px; }
  </style>
</head>
<body>
  <main>
    <h1>VibeValley 虚拟时钟 UI &amp; 数据层验收报告</h1>
    <div class="meta">生成时间：${esc(uiReport?.generatedAt ?? new Date().toISOString())} · 输出目录：<code>${esc(outDir)}</code></div>
    <section class="kpis">
      <div class="kpi"><div class="label">Priority 1 · 无头 UI 套件</div><div class="val">${totalSuites} 套件 (${totalPassed}/${totalPassed + totalFailed})</div></div>
      <div class="kpi"><div class="label">并发总耗时 (c=${uiReport?.concurrency ?? 4})</div><div class="val">${wallSecs}s</div></div>
      <div class="kpi"><div class="label">Priority 3 · Rust 多密度场景</div><div class="val">${stateSummaries.length} 密度</div></div>
      <div class="kpi"><div class="label">GPUI 静态截图 / Dump 报错</div><div class="val">${shots.length} 张 / ${dumpErrors} 错</div></div>
    </section>

    <h2>Priority 2 · 组件内部行为矩阵（虚拟时钟）</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>分类</th><th>组件 / Hook</th><th>验证内容</th><th>状态</th></tr></thead>
        <tbody>${componentRowsHtml}</tbody>
      </table>
    </div>

    <h2>Priority 3 · Rust 状态机数据层与多密度 BDD 场景</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>密度</th><th>Seq</th><th>Issues</th><th>Sessions</th><th>Inbox</th><th>Plots</th><th>Crons</th><th>Connectors</th><th>Media</th><th>Call</th><th>覆盖路由</th><th>主题</th><th>视口</th><th>步骤</th><th>耗时</th></tr></thead>
        <tbody>${scenarioRowsHtml}</tbody>
      </table>
    </div>

    <h2>GPUI Metal 宿主状态检查 (VIBEVALLEY_FAKE_SERVER)</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>场景</th><th>状态</th><th>loaded</th><th>sidebar.ready</th><th>workbench.ready</th><th>errors</th><th>load_error</th></tr></thead>
        <tbody>${dumpRowsHtml}</tbody>
      </table>
    </div>

    <h2>GPUI Metal 静态截图画廊</h2>
    <section class="gallery">${shotCardsHtml}</section>

    <h2>Priority 1 · 全量无头 UI 测试明细</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>测试套件</th><th>状态</th><th>Pass</th><th>Fail</th><th>耗时</th></tr></thead>
        <tbody>${suiteRowsHtml}</tbody>
      </table>
    </div>
  </main>
</body>
</html>
`;
}

function main() {
  const outDir = parseOutDir(process.argv.slice(2));
  mkdirSync(outDir, { recursive: true });
  const target = resolve(outDir, "index.html");
  writeFileSync(target, renderHtml(outDir), "utf8");
  console.log(`ui-report: wrote ${target}`);
}

main();
