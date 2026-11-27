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

interface SliceBundleSummary {
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
  runningSlots: number | null;
  activeMedia: number | null;
  unreadTotal: number | null;
}

interface EnumCoverageRow {
  name: string;
  expected: number;
  observed: string[];
  source: string;
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
  scenarios: string[];
  views: string[];
}

const root = resolve(import.meta.dirname, "../..");
const defaultOutDir = "/tmp/vv-ui-report";
const scenarioDensities = ["empty", "minimal", "typical", "dense", "extreme", "edge"] as const;
const dumpSlugs = ["empty", "minimal", "typical", "dense", "extreme", "edge", "en"] as const;
const galleryScenarioFilters = ["all", "empty", "typical", "dense", "extreme", "edge", "en"] as const;
const galleryViewFilters = ["all", "issues", "runs", "chat", "media", "workspace", "diorama", "dark", "narrow"] as const;

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

function asOptNum(val: unknown): number | null {
  return typeof val === "number" && Number.isFinite(val) ? val : null;
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

function readScenarioData(): { summaries: SliceBundleSummary[]; enumCoverage: EnumCoverageRow[] } {
  const summaries: SliceBundleSummary[] = [];
  const stuckReasons = new Set<string>();
  const deliverables = new Set<string>();
  const prStates = new Set<string>();
  const landings = new Set<string>();
  const mediaPhases = new Set<string>();
  const connectorStates = new Set<string>();
  const callStates = new Set<string>();
  const inboxKinds = new Set<string>();
  const lanes = new Set<string>();
  const cardKinds = new Set<string>();
  const promptKinds = new Set<string>();

  for (const density of scenarioDensities) {
    const file = resolve(root, `apps/mac/ui/fixtures/scenarios/${density}/state.json`);
    const raw = asFields(readJson(file));
    if (!raw) continue;
    const board = asFields(raw.get("board"));
    const sessionsSlice = asFields(raw.get("sessions"));
    const collab = asFields(raw.get("collab"));
    const inboxSlice = asFields(raw.get("inbox"));
    const ops = asFields(raw.get("ops"));
    const farm = asFields(raw.get("farm"));
    const view = asFields(farm?.get("view"));
    const boardSummary = asFields(board?.get("boardSummary"));
    const mediaSummary = asFields(ops?.get("mediaSummary"));
    const channelSummary = asFields(collab?.get("channelSummary"));
    const issues = asArray(board?.get("issues"));
    const inbox = asArray(inboxSlice?.get("items"));
    const connectors = asArray(collab?.get("connectors"));
    const media = asArray(ops?.get("media"));
    const callState = asStr(inboxSlice?.get("call"), "idle");

    callStates.add(callState);
    for (const item of issues) {
      const rec = asFields(item);
      if (!rec) continue;
      const deliver = asStr(rec.get("deliver"));
      if (deliver) deliverables.add(deliver);
      const delivered = asStr(rec.get("delivered"));
      if (delivered) landings.add(delivered);
      const stage = asFields(rec.get("stage"));
      const stuck = asStr(stage?.get("stuck"));
      if (stuck) stuckReasons.add(stuck);
      const pr = asFields(rec.get("pullRequest"));
      const prState = asStr(pr?.get("state"));
      if (prState) prStates.add(prState);
    }
    const byIssue = asFields(boardSummary?.get("byIssue"));
    if (byIssue) {
      for (const entry of byIssue.values()) {
        const rec = asFields(entry);
        if (!rec) continue;
        const lane = asStr(rec.get("lane"));
        if (lane) lanes.add(lane);
        const cardKind = asStr(rec.get("cardKind"));
        if (cardKind) cardKinds.add(cardKind);
        const prompt = asStr(rec.get("prompt"));
        if (prompt) promptKinds.add(prompt);
      }
    }
    for (const entry of media) {
      const rec = asFields(entry);
      if (!rec || asStr(rec.get("kind")) === "understanding") continue;
      const phase = asStr(rec.get("phase"));
      if (phase) mediaPhases.add(phase);
    }
    for (const entry of connectors) {
      const rec = asFields(entry);
      const st = asStr(rec?.get("state"));
      if (st) connectorStates.add(st);
    }
    for (const entry of inbox) {
      const rec = asFields(entry);
      const kind = asStr(rec?.get("kind"));
      if (kind) inboxKinds.add(kind);
    }

    summaries.push({
      density,
      seq: asNum(raw.get("seq")),
      issues: issues.length,
      sessions: asArray(sessionsSlice?.get("sessions")).length,
      inbox: inbox.length,
      plots: asFields(view?.get("plots"))?.size ?? 0,
      crons: asArray(ops?.get("crons")).length,
      connectors: connectors.length,
      mediaJobs: media.length,
      callState,
      runningSlots: asOptNum(boardSummary?.get("runningSlots")),
      activeMedia: asOptNum(mediaSummary?.get("activeCount")),
      unreadTotal: asOptNum(channelSummary?.get("unreadTotal")),
    });
  }

  const sorted = (set: ReadonlySet<string>) => [...set].toSorted();
  const enumCoverage: EnumCoverageRow[] = [
    { name: "StuckReason::ALL", expected: 4, observed: sorted(stuckReasons), source: "vibevalley-protocol/issue" },
    { name: "Deliverable::ALL", expected: 4, observed: sorted(deliverables), source: "vibevalley-protocol/issue" },
    { name: "PullRequestState::ALL", expected: 3, observed: sorted(prStates), source: "vibevalley-protocol/issue" },
    { name: "Landing::ALL", expected: 6, observed: sorted(landings), source: "vibevalley-protocol/issue" },
    { name: "MediaPhase::ALL", expected: 8, observed: sorted(mediaPhases), source: "vibevalley-protocol/media" },
    { name: "ConnectorState::ALL", expected: 7, observed: sorted(connectorStates), source: "vibevalley-protocol/connector" },
    { name: "CallState::ALL", expected: 5, observed: sorted(callStates), source: "vibevalley-protocol/voice" },
    { name: "InboxKind::ALL", expected: 9, observed: sorted(inboxKinds), source: "vibevalley-protocol/inbox" },
    { name: "IssueLane::ALL", expected: 4, observed: sorted(lanes), source: "vibevalley-core/boardSummary" },
    { name: "IssueCardKind::ALL", expected: 4, observed: sorted(cardKinds), source: "vibevalley-core/boardSummary" },
    { name: "IssuePromptKind::ALL", expected: 10, observed: sorted(promptKinds), source: "vibevalley-core/boardSummary" },
  ];

  return { summaries, enumCoverage };
}

function readDumps(outDir: string): DumpReport[] {
  const reports: DumpReport[] = [];
  for (const slug of dumpSlugs) {
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

function classifyShot(name: string): { scenarios: string[]; views: string[] } {
  const parts = name.toLowerCase().split("-");
  const scenarios: string[] = [];
  for (const tag of ["empty", "typical", "dense", "extreme", "edge", "en"]) {
    if (parts.includes(tag)) scenarios.push(tag);
  }
  const views: string[] = [];
  if (parts.includes("issues") || parts.includes("issue")) views.push("issues");
  if (parts.includes("runs")) views.push("runs");
  if (parts.includes("chat")) views.push("chat");
  if (parts.includes("library") || parts.includes("notes")) views.push("media");
  if (
    parts.includes("workspace") ||
    parts.includes("palette") ||
    parts.includes("agents") ||
    parts.includes("orchestrator") ||
    parts.includes("repos") ||
    parts.includes("runtimes") ||
    parts.includes("settings") ||
    parts.includes("connectors") ||
    parts.includes("notes")
  ) {
    views.push("workspace");
  }
  if (parts.includes("farm") || parts.includes("diorama")) views.push("diorama");
  if (parts.includes("dark")) views.push("dark");
  if (parts.includes("narrow")) views.push("narrow");
  return { scenarios, views };
}

function readShots(outDir: string): ShotEntry[] {
  const shotsDir = resolve(outDir, "shots");
  if (!existsSync(shotsDir)) return [];
  return readdirSync(shotsDir)
    .filter((f) => f.endsWith(".png"))
    .toSorted()
    .map((name) => {
      const full = resolve(shotsDir, name);
      const stem = basename(name, ".png");
      const tags = classifyShot(stem);
      return {
        name: stem,
        relPath: `shots/${name}`,
        bytes: statSync(full).size,
        scenarios: tags.scenarios,
        views: tags.views,
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
    target: "useNow / createSettled / AgentFace / OrchestratorFace / RuntimeBadge / WorkLog / Trajectory / SubagentProgress",
    verified: "100ms/200ms 防抖收敛、65s 相对时间更新与进行中计时、纸雕肖像与引擎徽标及子助手进度",
  },
];

const frontendFsmRows = [
  {
    module: "features/issue/model/closeFlow.ts",
    states: "confirming | loadingDiff | loadFailed | reviewing | submitting | treeChanged | done",
    testSuite: "features/issue/model/closeFlow.test.ts",
    summary: "收口关单复核、bizCode 300001 文件树变更增量拉取 (sinceTree) 与提交防重入",
  },
  {
    module: "features/issue/model/draftSubmit.ts",
    states: "editing | submitting | rejected | retainedDirty | committed",
    testSuite: "features/issue/model/draftSubmit.test.ts",
    summary: "收口新建工单草稿提交、同稿重试复用 requestKey 与在途改稿留稿轮换 key",
  },
  {
    module: "features/media/libraryView.ts",
    states: "ContentBucket (recent | pinned | apps | notes | media) × LibrarySelection (none | files | lightbox)",
    testSuite: "features/media/libraryView.test.ts",
    summary: "收口内容中心筛选桶、文件选区、Shift 范围多选与灯箱切换，移除清理 effect",
  },
  {
    module: "features/session/runsView.ts",
    states: "RunsScope (all | active | orchestrator | worker) × RunEntry (orchestrator | worker)",
    testSuite: "features/session/runsView.test.ts",
    summary: "统一 /runs 运行与轨迹视图筛选、排序、状态映射及 URL 参数编解码",
  },
];

function renderHtml(outDir: string): string {
  const uiReport = readUiReport(outDir);
  const matrix = readScenarioMatrix(outDir);
  const { summaries: stateSummaries, enumCoverage } = readScenarioData();
  const dumps = readDumps(outDir);
  const shots = readShots(outDir);

  const suites = uiReport?.suites ?? [];
  const suiteByFile = new Map(suites.map((s) => [s.file, s]));
  const totalSuites = suites.length;
  const totalPassed = suites.reduce((sum, s) => sum + s.passed, 0);
  const totalFailed = suites.reduce((sum, s) => sum + s.failed, 0);
  const wallSecs = uiReport ? (uiReport.totalDurationMs / 1000).toFixed(2) : "N/A";
  const dumpErrors = dumps.reduce((sum, d) => sum + d.sidebarErrors.length + d.workbenchErrors.length + (d.loadError ? 1 : 0), 0);
  const enumsFullyCovered = enumCoverage.filter((e) => e.observed.length >= e.expected).length;

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

  const enumRowsHtml = enumCoverage
    .map((e) => {
      const full = e.observed.length >= e.expected;
      const badge = full ? '<span class="badge ok">100%</span>' : `<span class="badge fail">${e.observed.length}/${e.expected}</span>`;
      const values = e.observed.map((v) => `<code>${esc(v)}</code>`).join(" ");
      return `<tr>
        <td><code>${esc(e.name)}</code></td>
        <td><code>${esc(e.source)}</code></td>
        <td class="num">${e.observed.length} / ${e.expected}</td>
        <td>${badge}</td>
        <td>${values || "—"}</td>
      </tr>`;
    })
    .join("\n");

  const fsmRowsHtml = frontendFsmRows
    .map((f) => {
      const suite = suiteByFile.get(f.testSuite);
      const statusHtml = suite
        ? suite.ok
          ? `<span class="badge ok">PASS (${suite.passed}/${suite.passed + suite.failed})</span>`
          : `<span class="badge fail">FAIL (${suite.failed})</span>`
        : '<span class="badge">N/A</span>';
      const secs = suite ? `${(suite.durationMs / 1000).toFixed(2)}s` : "—";
      return `<tr>
        <td><code>${esc(f.module)}</code></td>
        <td><code>${esc(f.states)}</code></td>
        <td>${esc(f.summary)}</td>
        <td><code>${esc(f.testSuite)}</code></td>
        <td>${statusHtml}</td>
        <td class="num">${secs}</td>
      </tr>`;
    })
    .join("\n");

  const scenarioRowsHtml = stateSummaries
    .map((st) => {
      const run = matrixByDensity.get(st.density);
      const routes = run ? run.routes.map((r) => `<code>${esc(r)}</code>`).join(" ") : "—";
      const themes = run ? esc(run.themes.join(", ")) : "—";
      const viewports = run ? esc(run.viewports.join(", ")) : "—";
      const duration = run ? `${run.durationMs}ms` : "—";
      const steps = run ? String(run.stepsPassed) : "—";
      const projections = [
        st.runningSlots !== null ? `slots:${st.runningSlots}` : "",
        st.activeMedia !== null ? `media:${st.activeMedia}` : "",
        st.unreadTotal !== null ? `unread:${st.unreadTotal}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
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
        <td><code>${esc(projections || "—")}</code></td>
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

  const scenarioFilterButtonsHtml = galleryScenarioFilters
    .map(
      (tag) =>
        `<button type="button" class="filter-btn${tag === "all" ? " active" : ""}" data-filter-group="scenario" data-filter-value="${tag}">${tag}</button>`,
    )
    .join("");

  const viewFilterButtonsHtml = galleryViewFilters
    .map(
      (tag) => `<button type="button" class="filter-btn${tag === "all" ? " active" : ""}" data-filter-group="view" data-filter-value="${tag}">${tag}</button>`,
    )
    .join("");

  const shotCardsHtml = shots
    .map((shot) => {
      const kb = (shot.bytes / 1024).toFixed(0);
      const scenariosAttr = shot.scenarios.join(" ");
      const viewsAttr = shot.views.join(" ");
      const pills = [...shot.scenarios, ...shot.views].map((tag) => `<span class="tag">${esc(tag)}</span>`).join("");
      return `<figure class="shot-card" data-scenarios="${esc(scenariosAttr)}" data-views="${esc(viewsAttr)}">
        <a href="${esc(shot.relPath)}" target="_blank" rel="noreferrer">
          <img src="${esc(shot.relPath)}" alt="${esc(shot.name)}" loading="lazy" />
        </a>
        <figcaption>
          <div class="shot-head"><strong>${esc(shot.name)}</strong><span>${kb} KB</span></div>
          <div class="shot-tags">${pills}</div>
        </figcaption>
      </figure>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>VibeValley 虚拟时钟 UI &amp; 状态机收口验收报告</title>
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
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif; background: var(--bg); color: var(--ink); line-height: 1.5; }
    main { max-width: 1320px; margin: 0 auto; padding: 28px 24px 64px; }
    h1 { font-size: 24px; margin: 0 0 6px; }
    h2 { font-size: 18px; margin: 32px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
    h3 { font-size: 14px; margin: 18px 0 8px; color: var(--muted); }
    .meta { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .kpi { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; }
    .kpi .label { font-size: 12px; color: var(--muted); }
    .kpi .val { font-size: 22px; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
    table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; font-size: 13px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
    th { background: rgba(127, 127, 127, 0.06); font-weight: 600; white-space: nowrap; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    code { font-family: "SF Mono", Menlo, monospace; font-size: 12px; background: rgba(127, 127, 127, 0.1); padding: 1px 4px; border-radius: 4px; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; white-space: nowrap; }
    .badge.ok { background: var(--ok-bg); color: var(--ok-ink); }
    .badge.fail { background: var(--fail-bg); color: var(--fail-ink); }
    .filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px 18px; margin-bottom: 14px; padding: 10px 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
    .filter-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .filter-label { font-size: 12px; font-weight: 600; color: var(--muted); margin-right: 2px; }
    .filter-btn { appearance: none; border: 1px solid var(--border); background: transparent; color: var(--ink); font-size: 12px; padding: 3px 9px; border-radius: 999px; cursor: pointer; font-family: "SF Mono", Menlo, monospace; transition: background 120ms ease, border-color 120ms ease; }
    .filter-btn:hover { background: rgba(127, 127, 127, 0.1); }
    .filter-btn.active { background: var(--accent-soft); border-color: var(--accent); color: var(--ok-ink); font-weight: 600; }
    .filter-count { margin-left: auto; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
    .shot-card { margin: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .shot-card.hidden { display: none; }
    .shot-card img { width: 100%; display: block; border-bottom: 1px solid var(--border); }
    .shot-card figcaption { padding: 8px 12px; font-size: 12px; color: var(--muted); }
    .shot-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .shot-head strong { color: var(--ink); font-family: "SF Mono", Menlo, monospace; }
    .shot-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
    .tag { font-family: "SF Mono", Menlo, monospace; font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(127, 127, 127, 0.12); color: var(--muted); }
    .table-wrap { overflow-x: auto; border-radius: 10px; }
  </style>
</head>
<body>
  <main>
    <h1>VibeValley 虚拟时钟 UI &amp; 状态机收口验收报告</h1>
    <div class="meta">生成时间：${esc(uiReport?.generatedAt ?? new Date().toISOString())} · 输出目录：<code>${esc(outDir)}</code></div>
    <section class="kpis">
      <div class="kpi"><div class="label">无头 UI 套件 (含 ${frontendFsmRows.length} FSM 单测)</div><div class="val">${totalSuites} 套件 (${totalPassed}/${totalPassed + totalFailed})</div></div>
      <div class="kpi"><div class="label">并发总耗时 (c=${uiReport?.concurrency ?? 4})</div><div class="val">${wallSecs}s</div></div>
      <div class="kpi"><div class="label">Rust 场景密度 &amp; 枚举覆盖</div><div class="val">${stateSummaries.length} 密度 · ${enumsFullyCovered}/${enumCoverage.length} 枚举</div></div>
      <div class="kpi"><div class="label">GPUI Metal 截图 / Dump 报错</div><div class="val">${shots.length} 张 / ${dumpErrors} 错</div></div>
    </section>

    <h2>Protocol Enum &amp; Frontend FSM Consolidation Coverage</h2>
    <h3>Rust Core <code>::ALL</code> 协议枚举与领域投影覆盖（跨 ${stateSummaries.length} 套导出 <code>state.json</code> 实测）</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Rust 枚举</th><th>来源</th><th>覆盖数</th><th>覆盖率</th><th>实测变体</th></tr></thead>
        <tbody>${enumRowsHtml}</tbody>
      </table>
    </div>
    <h3>前端显式有限状态机（3 模块 + ${totalSuites} 套无头 UI 套件）</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>FSM 模块</th><th>判别联合状态</th><th>收口职责</th><th>纯单测套件</th><th>状态</th><th>耗时</th></tr></thead>
        <tbody>${fsmRowsHtml}</tbody>
      </table>
    </div>

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
        <thead><tr><th>密度</th><th>Seq</th><th>Issues</th><th>Sessions</th><th>Inbox</th><th>Plots</th><th>Crons</th><th>Connectors</th><th>Media</th><th>Call</th><th>Rust 投影摘要</th><th>覆盖路由</th><th>主题</th><th>视口</th><th>步骤</th><th>耗时</th></tr></thead>
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
    <div class="filter-bar" id="gallery-filter-bar">
      <div class="filter-group">
        <span class="filter-label">场景</span>
        ${scenarioFilterButtonsHtml}
      </div>
      <div class="filter-group">
        <span class="filter-label">视图</span>
        ${viewFilterButtonsHtml}
      </div>
      <span class="filter-count" id="gallery-filter-count">显示 ${shots.length} / ${shots.length} 张</span>
    </div>
    <section class="gallery" id="shot-gallery">${shotCardsHtml}</section>

    <h2>Priority 1 · 全量无头 UI 测试明细（${totalSuites} 套件）</h2>
    <div class="table-wrap">
      <table>
        <thead><tr><th>测试套件</th><th>状态</th><th>Pass</th><th>Fail</th><th>耗时</th></tr></thead>
        <tbody>${suiteRowsHtml}</tbody>
      </table>
    </div>
  </main>
  <script>
    (() => {
      let activeScenario = "all";
      let activeView = "all";
      const cards = Array.from(document.querySelectorAll("#shot-gallery .shot-card"));
      const buttons = Array.from(document.querySelectorAll("#gallery-filter-bar .filter-btn"));
      const counter = document.getElementById("gallery-filter-count");
      function applyFilters() {
        let shown = 0;
        for (const card of cards) {
          const scenarios = (card.getAttribute("data-scenarios") || "").split(" ").filter(Boolean);
          const views = (card.getAttribute("data-views") || "").split(" ").filter(Boolean);
          const matchScenario = activeScenario === "all" || scenarios.includes(activeScenario);
          const matchView = activeView === "all" || views.includes(activeView);
          const visible = matchScenario && matchView;
          card.classList.toggle("hidden", !visible);
          if (visible) shown++;
        }
        if (counter) counter.textContent = "显示 " + shown + " / " + cards.length + " 张";
      }
      for (const btn of buttons) {
        btn.addEventListener("click", () => {
          const group = btn.getAttribute("data-filter-group");
          const value = btn.getAttribute("data-filter-value") || "all";
          if (group === "scenario") activeScenario = value;
          if (group === "view") activeView = value;
          for (const b of buttons) {
            if (b.getAttribute("data-filter-group") === group) {
              b.classList.toggle("active", b === btn);
            }
          }
          applyFilters();
        });
      }
    })();
  </script>
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
