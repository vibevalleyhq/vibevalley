// The workspace sidebar (`host.params.contextual === true`):
//   Left tree: Open Repos -> (Worktree groups when >1, else flat) -> Terminal Tabs
//              with explicit fold/expand, aligned slot grid, and PTY-accurate status.
//   Right inspector (`host.params.role === "inspector"`): Files and Git changes.
import { Canvas, Clipboard, colorScheme, effect, host, Image, Path2D, Scroll, signal, Text, View, type JSX } from "nsh";
import { Button, ContextMenu, MenuItem, MenuSeparator, Tooltip } from "nsh/base";

import { act, call, frame, frameRev, hostApi } from "../bridge";
import { pressTransition } from "../motion";
import { radius, tok, type as ty } from "../tokens";
import { FileTree, type FilesFrame } from "./FileTree";
import { GitPanel, type GitFrame, type GitTab } from "./GitPanel";
import { ProjectRail, type RailFrame, type RailProject, type RailRunningState, type RailTab } from "./ProjectRail";

type VvRepo = { name: string; path: string; git?: boolean; last?: number };
type VvSession = {
  id: string;
  name: string;
  brief: string;
  runtime?: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  issue?: string;
  phase: { _tag: string; doing?: { action?: string } };
  phaseText?: string;
};
type VvIssue = { id: string; number: number; title: string; repo?: string };
type VvStateFrame = {
  seq: number;
  state?: {
    sessions?: VvSession[];
    issues?: VvIssue[];
  };
};

type WorktreeGroup = {
  id: string;
  label: string;
  branch?: string | null;
  path: string;
  isMain: boolean;
  active: boolean;
  sessionAgent?: string;
  sessionRunning: boolean;
  tabs: RailTab[];
};

type RepoNode = {
  projectId?: number;
  name: string;
  path: string;
  branch?: string | null;
  active: boolean;
  groups: WorktreeGroup[];
  /** One of VibeValley's repos (repo.list), not a folder opened for its terminals. */
  vibevalley: boolean;
};

type ActivitySummary = {
  working: number;
  ready: number;
  attention: number;
  tabs: number;
};

// Pixel-strict tree grid constants:
// Depth 0 (Repo):     chevron @ 6,  icon @ 26, label @ 48
// Depth 1 (WT / Tab): chevron @ 20, icon @ 40, label @ 62
// Depth 2 (Tab):      chevron @ 34, icon @ 54, label @ 76
const ROW_BASE_PAD = 6;
const INDENT_STEP = 14;
const CHEVRON_SLOT = 14;
const ICON_SLOT = 16;
const ACTION_SIZE = 20;

const KNOWN_RUNTIME_LOGOS = new Set(["claude", "codex", "opencode", "cursor", "kimi", "pi", "dsh", "grok", "antigravity"]);

function runtimeLogoOf(agent: string | undefined | null): string | undefined {
  if (!agent) return undefined;
  const key = agent.toLowerCase().replace(/^acp:/, "");
  return KNOWN_RUNTIME_LOGOS.has(key) ? `logo-${key}` : undefined;
}

function normPath(p: string | undefined | null): string {
  if (!p) return "";
  const trimmed = p.replace(/\/+$/, "");
  return trimmed || "/";
}

function tabRunningState(tab: RailTab): RailRunningState {
  if (tab.runningState) return tab.runningState;
  return tab.running ? "working" : "idle";
}

function summarizeGroup(group: WorktreeGroup): ActivitySummary {
  let working = group.sessionRunning ? 1 : 0;
  let ready = 0;
  let attention = 0;
  for (const tab of group.tabs) {
    const state = tabRunningState(tab);
    if (state === "working") working += 1;
    else if (state === "ready") ready += 1;
    if (tab.attention) attention += 1;
  }
  return { working, ready, attention, tabs: group.tabs.length };
}

function summarizeRepo(repo: RepoNode): ActivitySummary {
  let working = 0;
  let ready = 0;
  let attention = 0;
  let tabs = 0;
  for (const group of repo.groups) {
    const g = summarizeGroup(group);
    working += g.working;
    ready += g.ready;
    attention += g.attention;
    tabs += g.tabs;
  }
  return { working, ready, attention, tabs };
}

function summarizeRepos(repos: RepoNode[]): ActivitySummary {
  let working = 0;
  let ready = 0;
  let attention = 0;
  let tabs = 0;
  for (const repo of repos) {
    const r = summarizeRepo(repo);
    working += r.working;
    ready += r.ready;
    attention += r.attention;
    tabs += r.tabs;
  }
  return { working, ready, attention, tabs };
}

function disambiguatorMap(repos: RepoNode[]): Map<string, string> {
  const byName = new Map<string, RepoNode[]>();
  for (const r of repos) {
    const list = byName.get(r.name) ?? [];
    list.push(r);
    byName.set(r.name, list);
  }
  const result = new Map<string, string>();
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    const parents = group.map((r) => {
      const segs = r.path.split("/").filter(Boolean);
      return segs.length >= 2 ? segs[segs.length - 2]! : r.path;
    });
    const parentCounts = new Map<string, number>();
    for (const parent of parents) {
      parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
    }
    for (let i = 0; i < group.length; i++) {
      const r = group[i]!;
      const parent = parents[i]!;
      if ((parentCounts.get(parent) ?? 0) > 1) {
        const segs = r.path.split("/").filter(Boolean);
        const hint = segs.length >= 3 ? `${segs[segs.length - 3]}/${segs[segs.length - 2]}` : parent;
        result.set(r.path, hint);
      } else {
        result.set(r.path, parent);
      }
    }
  }
  return result;
}

// ---- Crisp Vector Glyphs (nsh Canvas, 24x24 box) ----------------------------

type GlyphName = "chevron" | "plus" | "close" | "branch" | "terminal" | "file" | "diff" | "folder" | "collapseAll" | "expandAll";

type GlyphStroke = {
  readonly d?: string;
  readonly circle?: readonly [number, number, number];
  readonly stroke: number;
};

const GLYPHS: Record<GlyphName, readonly GlyphStroke[]> = {
  chevron: [{ d: "M9 6 L15 12 L9 18", stroke: 2.2 }],
  plus: [
    { d: "M12 5 V19", stroke: 2.1 },
    { d: "M5 12 H19", stroke: 2.1 },
  ],
  close: [
    { d: "M6.5 6.5 L17.5 17.5", stroke: 2.1 },
    { d: "M17.5 6.5 L6.5 17.5", stroke: 2.1 },
  ],
  branch: [
    { circle: [6.5, 6, 2.3], stroke: 1.9 },
    { circle: [6.5, 18, 2.3], stroke: 1.9 },
    { circle: [17.5, 8.5, 2.3], stroke: 1.9 },
    { d: "M6.5 8.3 V15.7", stroke: 1.9 },
    { d: "M17.5 10.8 C17.5 14.5 13 15.7 6.5 15.7", stroke: 1.9 },
  ],
  terminal: [
    { d: "M5.5 3.5 H18.5 Q20.5 3.5 20.5 5.5 V18.5 Q20.5 20.5 18.5 20.5 H5.5 Q3.5 20.5 3.5 18.5 V5.5 Q3.5 3.5 5.5 3.5 Z", stroke: 1.85 },
    { d: "M7.5 9.5 L10.75 12 L7.5 14.5", stroke: 1.95 },
    { d: "M12.5 14.5 H16.5", stroke: 1.95 },
  ],
  file: [
    { d: "M7 3.5 H13.5 L18.5 8.5 V19 Q18.5 20.5 17 20.5 H7 Q5.5 20.5 5.5 19 V5 Q5.5 3.5 7 3.5 Z", stroke: 1.85 },
    { d: "M13.5 3.5 V8.5 H18.5", stroke: 1.75 },
  ],
  diff: [
    { d: "M5.5 3.5 H18.5 Q20.5 3.5 20.5 5.5 V18.5 Q20.5 20.5 18.5 20.5 H5.5 Q3.5 20.5 3.5 18.5 V5.5 Q3.5 3.5 5.5 3.5 Z", stroke: 1.85 },
    { d: "M12 7 V11.5", stroke: 1.85 },
    { d: "M9.75 9.25 H14.25", stroke: 1.85 },
    { d: "M9.75 15.5 H14.25", stroke: 1.85 },
  ],
  folder: [{ d: "M3.5 7 Q3.5 5 5.5 5 H9.5 L11.5 7.5 H18.5 Q20.5 7.5 20.5 9.5 V17.5 Q20.5 19.5 18.5 19.5 H5.5 Q3.5 19.5 3.5 17.5 Z", stroke: 1.85 }],
  collapseAll: [
    { d: "M7 4.5 L12 9 L17 4.5", stroke: 2.0 },
    { d: "M7 19.5 L12 15 L17 19.5", stroke: 2.0 },
  ],
  expandAll: [
    { d: "M7 9 L12 4.5 L17 9", stroke: 2.0 },
    { d: "M7 15 L12 19.5 L17 15", stroke: 2.0 },
  ],
};

const pathCache = new Map<string, Path2D>();
function cachedPath(d: string): Path2D {
  let p = pathCache.get(d);
  if (!p) {
    p = new Path2D(d);
    pathCache.set(d, p);
  }
  return p;
}

function Glyph(props: { name: GlyphName; size: number; color: string; rotateDeg?: number }) {
  return (
    <Canvas
      style={{ width: props.size, height: props.size, flexShrink: 0 }}
      draw={(cx) => {
        void colorScheme();
        const shapes = GLYPHS[props.name];
        const size = props.size;
        const rot = props.rotateDeg ?? 0;
        cx.scale(size / 24, size / 24);
        if (rot !== 0) {
          cx.translate(12, 12);
          cx.rotate((rot * Math.PI) / 180);
          cx.translate(-12, -12);
        }
        cx.strokeStyle = props.color;
        cx.lineCap = "round";
        cx.lineJoin = "round";
        for (const s of shapes) {
          cx.lineWidth = s.stroke;
          if (s.d) {
            cx.stroke(cachedPath(s.d));
          }
          if (s.circle) {
            const [x, y, r] = s.circle;
            cx.beginPath();
            cx.arc(x, y, r, 0, Math.PI * 2);
            cx.stroke();
          }
        }
      }}
    />
  );
}

function TipBubble(props: { text: string }) {
  const p = () => tok();
  const dark = () => colorScheme() === "dark";
  return (
    <Tooltip
      delay={350}
      offset={6}
      style={{
        maxWidth: 260,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 5,
        backgroundColor: p().primary,
        borderWidth: 1,
        borderColor: dark() ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)",
      }}
    >
      <Text style={{ fontSize: 11.5, lineHeight: 16, color: p().onPrimary }}>{props.text}</Text>
    </Tooltip>
  );
}

function StatusDots(props: { state: RailRunningState; attention?: boolean; readyRing?: boolean }) {
  const p = () => tok();
  const dark = () => colorScheme() === "dark";
  const showWorking = () => props.state === "working";
  const showReady = () => props.state === "ready" && props.readyRing !== false;
  const showAttention = () => Boolean(props.attention);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
      {showWorking() ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p().ok }} /> : null}
      {showReady() ? (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            borderWidth: 1.5,
            borderColor: dark() ? "rgba(65,189,116,0.65)" : "rgba(30,138,79,0.55)",
          }}
        />
      ) : null}
      {showAttention() ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p().alert }} /> : null}
    </View>
  );
}

function CollapsedSummary(props: { summary: ActivitySummary }) {
  const p = () => tok();
  const dark = () => colorScheme() === "dark";
  const s = () => props.summary;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
      {s().working > 0 ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p().ok }} /> : null}
      {s().working === 0 && s().ready > 0 ? (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            borderWidth: 1.5,
            borderColor: dark() ? "rgba(65,189,116,0.65)" : "rgba(30,138,79,0.55)",
          }}
        />
      ) : null}
      {s().attention > 0 ? <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p().alert }} /> : null}
      {s().tabs > 0 ? (
        <Text style={{ fontSize: 11, fontWeight: "500", fontVariant: ["tabular-nums"], color: s().working > 0 ? p().ok : p().faint }}>{String(s().tabs)}</Text>
      ) : null}
    </View>
  );
}

function ActionIconBtn(props: { icon: GlyphName; size?: number; label: string; onPress: () => void; danger?: boolean }) {
  const p = () => tok();
  const dark = () => colorScheme() === "dark";
  const hoverBg = () => (dark() ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.08)");
  return (
    <Button
      onPress={props.onPress}
      accessibilityLabel={props.label}
      tooltip={<TipBubble text={props.label} />}
      hoverStyle={{ backgroundColor: hoverBg() }}
      activeStyle={{ opacity: 0.75 }}
      style={{
        width: ACTION_SIZE,
        height: ACTION_SIZE,
        borderRadius: 4,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        ...pressTransition(),
      }}
    >
      <Glyph name={props.icon} size={props.size ?? 12} color={props.danger ? p().danger : p().muted} />
    </Button>
  );
}

function ChevronSlot(props: { expandable: boolean; expanded: boolean; label: string; onToggle: () => void }) {
  const p = () => tok();
  const dark = () => colorScheme() === "dark";
  if (!props.expandable) {
    return <View style={{ width: CHEVRON_SLOT, height: 14, flexShrink: 0 }} />;
  }
  return (
    <Button
      onPress={props.onToggle}
      accessibilityLabel={props.label}
      hoverStyle={{ backgroundColor: dark() ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.06)" }}
      activeStyle={{ opacity: 0.7 }}
      style={{
        width: CHEVRON_SLOT,
        height: 18,
        borderRadius: 3,
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        ...pressTransition(),
      }}
    >
      <Glyph name="chevron" size={10} color={p().muted} rotateDeg={props.expanded ? 90 : 0} />
    </Button>
  );
}

function formatTabTooltip(tab: RailTab, group: WorktreeGroup): string {
  const state = tabRunningState(tab);
  const parts: string[] = [tab.title];
  if (tab.kind === "terminal") {
    const label =
      tab.runningLabel && tab.runningLabel !== tab.title ? tab.runningLabel : tab.runningAgent && tab.runningAgent !== "cmd" ? tab.runningAgent : null;
    if (state === "working") {
      parts.push(label ? `${label} 正在运行` : "正在运行");
    } else if (state === "ready") {
      parts.push(label ? `${label} 待命` : "待命");
    }
    if (tab.attention) parts.push("需要关注");
  }
  parts.push(group.path);
  return parts.join(" · ");
}

function formatSummaryTooltip(base: string, summary: ActivitySummary, collapsed: boolean): string {
  const parts: string[] = [base];
  if (collapsed && summary.tabs > 0) parts.push(`${summary.tabs} 个终端`);
  if (summary.working > 0) parts.push(`${summary.working} 运行中`);
  if (summary.ready > 0) parts.push(`${summary.ready} 待命`);
  if (summary.attention > 0) parts.push(`${summary.attention} 需要关注`);
  return parts.join(" · ");
}

export function Sidebar() {
  const rail = frame<RailFrame>("rail");
  const files = frame<FilesFrame>("files");
  const git = frame<GitFrame>("git");
  const vvState = frame<VvStateFrame>("state");
  const vvRev = frameRev("state");
  const vvRepos = signal<VvRepo[]>([]);
  const pixelDir = signal<string | undefined>(typeof host.params.pixelDir === "string" ? host.params.pixelDir : undefined);
  const foldOverrides = signal<Record<string, boolean>>({});
  const otherSectionCollapsed = signal(false);
  const hoveredKey = signal<string | null>(null);

  if (host.available() && (host.params.contextual === true || host.params.role === "inspector")) {
    if (!pixelDir()) {
      void hostApi.pixelDir().then((env) => {
        if (env.bizCode === 0 && env.data?.path) pixelDir.set(env.data.path);
      });
    }
    if (host.params.contextual === true) {
      effect(() => {
        void vvRev();
        void call<VvRepo[]>("repo.list", {}).then((env) => {
          if (env.bizCode === 0 && Array.isArray(env.data)) {
            vvRepos.set(env.data);
          }
        });
      });
    }
  }

  const p = () => tok();
  const dark = () => colorScheme() === "dark";
  const panel = () => rail()?.panel ?? "files";

  const rowBg = (selected: boolean, hovered: boolean) => {
    if (selected && hovered) return dark() ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.085)";
    if (selected) return p().subtle;
    if (hovered) return dark() ? "rgba(255,255,255,0.055)" : "rgba(0,0,0,0.045)";
    return "transparent";
  };

  const spriteSrc = (name: string | undefined) => {
    const dir = pixelDir();
    return dir && name ? `file://${encodeURI(`${dir}/${name}.png`)}` : undefined;
  };

  // ---- Right-side Inspector (Files / Diff / Branch / History) ------------
  const gitTab = signal<GitTab>("changes");
  if (host.params.role === "inspector") {
    const conflictCount = () => git()?.conflicts?.length ?? 0;
    const gitCount = () => (git()?.staged?.length ?? 0) + (git()?.changes?.length ?? 0) + conflictCount();
    const currentView = () => (panel() === "git" ? `git:${gitTab()}` : panel());
    const tabHoverBg = () => (dark() ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.045)");
    const tabActiveBg = () => (dark() ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)");

    const inspectorTabs: { id: string; label: string; tip: string; badge?: () => number; danger?: () => boolean; onSelect: () => void }[] = [
      { id: "files", label: "文件", tip: "工作区文件", onSelect: () => act({ type: "show_panel", panel: "files" }) },
      {
        id: "git:changes",
        label: "变更",
        tip: "工作区改动与暂存",
        badge: gitCount,
        danger: () => conflictCount() > 0,
        onSelect: () => {
          gitTab.set("changes");
          if (panel() !== "git") act({ type: "show_panel", panel: "git" });
        },
      },
      {
        id: "git:branches",
        label: "分支",
        tip: "本地分支与工作树",
        onSelect: () => {
          gitTab.set("branches");
          if (panel() !== "git") act({ type: "show_panel", panel: "git" });
        },
      },
      {
        id: "git:commits",
        label: "提交",
        tip: "提交历史记录",
        onSelect: () => {
          gitTab.set("commits");
          if (panel() !== "git") act({ type: "show_panel", panel: "git" });
        },
      },
    ];

    return (
      <View style={{ flex: 1, backgroundColor: p().canvas }}>
        <View
          role="tablist"
          style={{
            height: 36,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            gap: 2,
            borderBottomWidth: 1,
            borderBottomColor: p().border,
          }}
        >
          {inspectorTabs.map((item) => {
            const isCur = currentView() === item.id;
            const count = item.badge?.() ?? 0;
            const isDanger = Boolean(item.danger?.());
            return (
              <Button
                onPress={item.onSelect}
                selected={isCur}
                accessibilityLabel={count > 0 ? `${item.label} (${count})` : item.label}
                tooltip={<TipBubble text={item.tip} />}
                hoverStyle={{ backgroundColor: isCur ? tabActiveBg() : tabHoverBg() }}
                activeStyle={{ opacity: 0.8 }}
                style={{
                  height: 24,
                  paddingHorizontal: 8,
                  borderRadius: 5,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  backgroundColor: isCur ? tabActiveBg() : "transparent",
                  ...pressTransition(),
                }}
              >
                <Text style={{ fontSize: 12, fontWeight: "500", color: isCur ? p().ink : p().muted }}>{item.label}</Text>
                {count > 0 ? (
                  <View
                    style={{
                      minWidth: 16,
                      height: 15,
                      paddingHorizontal: 4,
                      borderRadius: 999,
                      alignItems: "center",
                      justifyContent: "center",
                      backgroundColor: isDanger
                        ? dark()
                          ? "rgba(255,138,122,0.18)"
                          : "rgba(196,50,10,0.12)"
                        : dark()
                          ? "rgba(255,255,255,0.10)"
                          : "rgba(0,0,0,0.07)",
                    }}
                  >
                    <Text
                      style={{ fontSize: 10.5, fontWeight: "600", fontVariant: ["tabular-nums"], color: isDanger ? p().danger : isCur ? p().ink : p().muted }}
                    >
                      {String(count)}
                    </Text>
                  </View>
                ) : null}
              </Button>
            );
          })}
        </View>
        {panel() === "files" ? <FileTree frame={files()} /> : null}
        {panel() === "git" ? <GitPanel frame={git()} tab={gitTab()} /> : null}
      </View>
    );
  }

  // ---- Legacy non-contextual mode -----------------------------------------
  if (host.params.contextual !== true) {
    return (
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: p().canvas }}>
        <ProjectRail frame={rail()} />
        <View style={{ flex: 1 }}>
          {panel() === "files" ? <FileTree frame={files()} /> : null}
          {panel() === "git" ? <GitPanel frame={git()} /> : null}
        </View>
      </View>
    );
  }

  // ---- Left Workspace Tree: Repos -> (Worktree groups) -> Terminal Tabs ---
  const activePath = () => normPath(rail()?.projects.find((proj) => proj.active)?.path ?? files()?.root);
  const sessions = () => vvState()?.state?.sessions ?? [];
  const issues = () => vvState()?.state?.issues ?? [];

  const repoTree = (): RepoNode[] => {
    const projects = rail()?.projects ?? [];
    const byPath = new Map<string, RailProject>();
    for (const proj of projects) {
      byPath.set(normPath(proj.path), proj);
    }

    const worktreePaths = new Set<string>();
    for (const s of sessions()) {
      if (s.worktree) worktreePaths.add(normPath(s.worktree));
    }
    for (const proj of projects) {
      for (const w of proj.worktrees ?? []) {
        if (!w.main && w.path) worktreePaths.add(normPath(w.path));
      }
      if (proj.mainRoot && normPath(proj.mainRoot) !== normPath(proj.path)) {
        worktreePaths.add(normPath(proj.path));
      }
    }

    const roots: { name: string; path: string }[] = [];
    const seenRoots = new Set<string>();

    for (const proj of projects) {
      const mainPath = proj.mainRoot ? normPath(proj.mainRoot) : normPath(proj.path);
      if (!mainPath || seenRoots.has(mainPath)) continue;
      if (!proj.mainRoot && worktreePaths.has(mainPath)) continue;
      const name = mainPath.split("/").pop() || proj.name;
      roots.push({ name, path: mainPath });
      seenRoots.add(mainPath);
    }

    for (const r of vvRepos()) {
      const rp = normPath(r.path);
      if (!rp || seenRoots.has(rp)) continue;
      roots.push({ name: r.name, path: rp });
      seenRoots.add(rp);
    }

    const vvPaths = new Set(vvRepos().map((r) => normPath(r.path)));
    const issueMap = new Map(issues().map((i) => [i.id, i]));
    const curPath = activePath();

    return roots.map((root) => {
      const mainProj = byPath.get(root.path);
      const mainSession = sessions().find((s) => s.repo === root.name && (!s.worktree || normPath(s.worktree) === root.path) && s.phase._tag !== "closed");
      const defaultTabs: RailTab[] = mainProj?.tabs ?? [];
      const defaultGroup: WorktreeGroup = {
        id: `main:${root.path}`,
        label: mainProj?.branch || "main",
        branch: mainProj?.branch,
        path: root.path,
        isMain: true,
        active: curPath === root.path,
        sessionAgent: mainSession?.runtime,
        sessionRunning: mainSession?.phase._tag === "working",
        tabs: defaultTabs,
      };

      const extraGroups: WorktreeGroup[] = [];
      const seenGroupPaths = new Set<string>([root.path]);

      for (const s of sessions()) {
        if (s.repo !== root.name || s.phase._tag === "closed" || !s.worktree) continue;
        const wp = normPath(s.worktree);
        if (!wp || seenGroupPaths.has(wp)) continue;
        seenGroupPaths.add(wp);
        const wtProj = byPath.get(wp);
        const issue = s.issue ? issueMap.get(s.issue) : undefined;
        const label = issue ? `#${issue.number} ${issue.title}` : s.branch || s.brief || s.name;
        const tabs: RailTab[] = wtProj?.tabs ?? [];
        extraGroups.push({
          id: `session:${s.id}`,
          label,
          branch: s.branch,
          path: wp,
          isMain: false,
          active: curPath === wp,
          sessionAgent: s.runtime,
          sessionRunning: s.phase._tag === "working",
          tabs,
        });
      }

      const knownWorktrees = mainProj?.worktrees ?? (curPath === root.path ? git()?.worktrees : undefined) ?? [];
      for (const w of knownWorktrees) {
        const wp = normPath(w.path);
        if (w.main || !wp || seenGroupPaths.has(wp)) continue;
        seenGroupPaths.add(wp);
        const wtProj = byPath.get(wp);
        const folder = wp.split("/").pop() || wp;
        const tabs: RailTab[] = wtProj?.tabs ?? [];
        extraGroups.push({
          id: `wt:${wp}`,
          label: w.branch || folder,
          branch: w.branch,
          path: wp,
          isMain: false,
          active: curPath === wp,
          sessionRunning: false,
          tabs,
        });
      }

      for (const proj of projects) {
        const pp = normPath(proj.path);
        if (proj.mainRoot && normPath(proj.mainRoot) === root.path && !seenGroupPaths.has(pp)) {
          seenGroupPaths.add(pp);
          extraGroups.push({
            id: `proj:${proj.id}`,
            label: proj.branch || proj.name,
            branch: proj.branch,
            path: pp,
            isMain: false,
            active: curPath === pp,
            sessionRunning: false,
            tabs: proj.tabs ?? [],
          });
        }
      }

      const allGroups = [defaultGroup, ...extraGroups];
      const repoActive = allGroups.some((g) => g.active);

      return {
        projectId: mainProj?.id,
        name: root.name,
        path: root.path,
        branch: mainProj?.branch,
        active: repoActive,
        groups: allGroups,
        vibevalley: vvPaths.has(root.path),
      };
    });
  };

  const repoFoldKey = (repo: RepoNode) => `repo:${repo.path}`;
  const groupFoldKey = (group: WorktreeGroup) => `wt:${group.path}`;

  const isRepoExpandable = (repo: RepoNode) => repo.groups.length > 1 || (repo.groups[0]?.tabs.length ?? 0) > 0;
  const isRepoExpanded = (repo: RepoNode) => {
    const ov = foldOverrides()[repoFoldKey(repo)];
    if (ov !== undefined) return ov;
    return repo.active || summarizeRepo(repo).tabs > 0;
  };

  const isGroupExpandable = (group: WorktreeGroup) => group.tabs.length > 0;
  const isGroupExpanded = (group: WorktreeGroup) => {
    const ov = foldOverrides()[groupFoldKey(group)];
    if (ov !== undefined) return ov;
    return group.active || group.tabs.length > 0;
  };

  const setFold = (key: string, expanded: boolean) => {
    foldOverrides.update((prev) => ({ ...prev, [key]: expanded }));
  };

  const toggleFold = (key: string, current: boolean) => {
    setFold(key, !current);
  };

  const hasFoldableItems = () => repoTree().some((r) => isRepoExpandable(r));
  const anyExpanded = () => {
    for (const repo of repoTree()) {
      if (isRepoExpandable(repo) && isRepoExpanded(repo)) return true;
      if (repo.groups.length > 1) {
        for (const group of repo.groups) {
          if (isGroupExpandable(group) && isGroupExpanded(group)) return true;
        }
      }
    }
    return false;
  };

  const toggleCollapseAll = () => {
    if (anyExpanded()) {
      const next: Record<string, boolean> = {};
      for (const repo of repoTree()) {
        if (isRepoExpandable(repo)) next[repoFoldKey(repo)] = false;
        if (repo.groups.length > 1) {
          for (const group of repo.groups) {
            if (isGroupExpandable(group)) next[groupFoldKey(group)] = false;
          }
        }
      }
      foldOverrides.set(next);
    } else {
      // Restore defaults: expand active repo and worktrees with open tabs.
      foldOverrides.set({});
      otherSectionCollapsed.set(false);
    }
  };

  /** VibeValley's repos first; folders opened only for their terminals after them. */
  const sections = (): { id: string; title: string; repos: RepoNode[] }[] => {
    const all = repoTree();
    const own = all.filter((r) => r.vibevalley);
    const other = all.filter((r) => !r.vibevalley);
    if (own.length === 0 || other.length === 0) return [{ id: "all", title: "", repos: all }];
    return [
      { id: "own", title: "", repos: own },
      { id: "other", title: "其他文件夹", repos: other },
    ];
  };

  const withWorktreeMenu = (group: WorktreeGroup, trigger: JSX.Element) => {
    const itemStyle = { height: 28, paddingHorizontal: 10, borderRadius: 5, justifyContent: "center" as const };
    return (
      <ContextMenu
        trigger={trigger}
        popupStyle={{
          minWidth: 168,
          padding: 4,
          borderRadius: radius.sm,
          backgroundColor: p().surface,
          borderWidth: 1,
          borderColor: p().border,
        }}
      >
        <MenuItem
          onSelect={() => {
            setFold(groupFoldKey(group), true);
            act({ type: "new_terminal_at", path: group.path });
          }}
          style={itemStyle}
          hoverStyle={{ backgroundColor: p().subtle }}
        >
          <Text style={{ fontSize: 12.5, color: p().ink }}>在此新建终端</Text>
        </MenuItem>
        <MenuItem onSelect={() => void hostApi.reveal(group.path)} style={itemStyle} hoverStyle={{ backgroundColor: p().subtle }}>
          <Text style={{ fontSize: 12.5, color: p().ink }}>在 Finder 中显示</Text>
        </MenuItem>
        <MenuItem onSelect={() => void Clipboard.writeText(group.path)} style={itemStyle} hoverStyle={{ backgroundColor: p().subtle }}>
          <Text style={{ fontSize: 12.5, color: p().ink }}>复制路径</Text>
        </MenuItem>
        {!group.isMain ? (
          <>
            <MenuSeparator style={{ height: 1, marginVertical: 4, backgroundColor: p().border }} />
            <MenuItem
              onSelect={() => act({ type: "remove_worktree", path: group.path, force: false })}
              style={itemStyle}
              hoverStyle={{ backgroundColor: p().subtle }}
            >
              <Text style={{ fontSize: 12.5, color: p().danger }}>删除工作树</Text>
            </MenuItem>
          </>
        ) : null}
      </ContextMenu>
    );
  };

  const renderTabRow = (group: WorktreeGroup, tab: RailTab, depth: number) => {
    const rowKey = `tab:${group.path}:${tab.id}`;
    const isSelected = group.active && tab.active;
    const isHovered = () => hoveredKey() === rowKey;
    // Each terminal tab displays strictly its own PTY status (never polluted by group.sessionRunning).
    const state = tab.kind === "terminal" ? tabRunningState(tab) : "idle";
    const ownAgent = tab.kind === "terminal" ? tab.runningAgent : undefined;
    const logoSrc = spriteSrc(runtimeLogoOf(ownAgent));
    const canClose = tab.kind === "terminal" || group.tabs.length > 1;
    const tabIconColor = () => (state === "working" ? p().ok : isSelected ? p().ink : p().muted);

    return (
      <View
        onMouseEnter={() => hoveredKey.set(rowKey)}
        onMouseLeave={() => {
          if (hoveredKey() === rowKey) hoveredKey.set(null);
        }}
        tooltip={<TipBubble text={formatTabTooltip(tab, group)} />}
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: 28,
          paddingLeft: ROW_BASE_PAD + depth * INDENT_STEP,
          paddingRight: 6,
          borderRadius: 6,
          backgroundColor: rowBg(isSelected, isHovered()),
          gap: 6,
        }}
      >
        {/* Leaf rows keep the exact 14px chevron slot so sibling icons & labels align vertically. */}
        <View style={{ width: CHEVRON_SLOT, height: 14, flexShrink: 0 }} />
        <Button
          onPress={() => act({ type: "activate_tab", path: group.path, tab_id: tab.id })}
          style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, height: 28 }}
        >
          <View style={{ width: ICON_SLOT, height: ICON_SLOT, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {logoSrc ? (
              <Image src={logoSrc} style={{ width: 15, height: 15, objectFit: "contain" }} />
            ) : (
              <Glyph name={tab.kind === "diff" ? "diff" : tab.kind === "file" ? "file" : "terminal"} size={14} color={tabIconColor()} />
            )}
          </View>
          <Text
            style={{
              fontSize: 12.5,
              fontWeight: isSelected ? "500" : "400",
              color: isSelected ? p().ink : p().text,
              flex: 1,
              minWidth: 0,
              numberOfLines: 1,
            }}
          >
            {tab.title}
          </Text>
        </Button>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
          {state !== "idle" || tab.attention ? <StatusDots state={state} attention={tab.attention} /> : null}
          {canClose && isHovered() ? (
            <ActionIconBtn
              icon="close"
              size={11}
              label={`关闭 ${tab.title}`}
              onPress={() => {
                if (hoveredKey() === rowKey) hoveredKey.set(null);
                act({ type: "close_tab_at", path: group.path, tab_id: tab.id });
              }}
            />
          ) : null}
        </View>
      </View>
    );
  };

  const renderWorktreeGroup = (group: WorktreeGroup) => {
    const rowKey = `wt:${group.path}`;
    const expandable = isGroupExpandable(group);
    const expanded = isGroupExpanded(group);
    const isHovered = () => hoveredKey() === rowKey;
    const isSelected = group.active && group.tabs.length === 0;
    const summary = summarizeGroup(group);
    const sessionLogo = group.sessionRunning ? spriteSrc(runtimeLogoOf(group.sessionAgent)) : undefined;
    const tipText = formatSummaryTooltip(
      group.isMain ? `${group.label}（主目录） · ${group.path}` : `${group.label} · ${group.path}`,
      summary,
      expandable && !expanded,
    );

    return (
      <View style={{ gap: 1 }}>
        {withWorktreeMenu(
          group,
          <View
            onMouseEnter={() => hoveredKey.set(rowKey)}
            onMouseLeave={() => {
              if (hoveredKey() === rowKey) hoveredKey.set(null);
            }}
            tooltip={<TipBubble text={tipText} />}
            style={{
              flexDirection: "row",
              alignItems: "center",
              height: 28,
              paddingLeft: ROW_BASE_PAD + INDENT_STEP,
              paddingRight: 6,
              borderRadius: 6,
              backgroundColor: rowBg(isSelected, isHovered()),
              gap: 6,
            }}
          >
            <ChevronSlot
              expandable={expandable}
              expanded={expanded}
              label={expanded ? `折叠 ${group.label}` : `展开 ${group.label}`}
              onToggle={() => toggleFold(groupFoldKey(group), expanded)}
            />
            <Button
              onPress={() => act({ type: "activate_path", path: group.path })}
              style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, height: 28 }}
            >
              <View style={{ width: ICON_SLOT, height: ICON_SLOT, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <Glyph name="branch" size={14} color={group.sessionRunning ? p().ok : group.active ? p().ink : p().muted} />
              </View>
              <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5 }}>
                <Text
                  style={{
                    fontSize: 12.5,
                    fontWeight: group.active ? "500" : "400",
                    color: group.active ? p().ink : p().text,
                    flexShrink: 1,
                    numberOfLines: 1,
                  }}
                >
                  {group.label}
                </Text>
                {group.isMain ? <Text style={{ fontSize: 11, fontWeight: "500", color: p().faint, flexShrink: 0 }}>主目录</Text> : null}
              </View>
            </Button>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
              {isHovered() ? (
                <>
                  {expandable && !expanded ? <CollapsedSummary summary={summary} /> : group.sessionRunning ? <StatusDots state="working" /> : null}
                  <ActionIconBtn
                    icon="plus"
                    size={12}
                    label={`新终端：${group.label}`}
                    onPress={() => {
                      setFold(groupFoldKey(group), true);
                      act({ type: "new_terminal_at", path: group.path });
                    }}
                  />
                </>
              ) : expandable && !expanded ? (
                <CollapsedSummary summary={summary} />
              ) : group.sessionRunning ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 0 }}>
                  {sessionLogo ? <Image src={sessionLogo} style={{ width: 13, height: 13, objectFit: "contain" }} /> : null}
                  <StatusDots state="working" />
                </View>
              ) : null}
            </View>
          </View>,
        )}
        {expandable && expanded ? <View style={{ gap: 1 }}>{group.tabs.map((tab) => renderTabRow(group, tab, 2))}</View> : null}
      </View>
    );
  };

  const renderRepoNode = (repo: RepoNode, disambiguators: Map<string, string>) => {
    const rowKey = `repo:${repo.path}`;
    const hasMultipleWorktrees = repo.groups.length > 1;
    const mainGroup = repo.groups[0]!;
    const expandable = isRepoExpandable(repo);
    const expanded = isRepoExpanded(repo);
    const isHovered = () => hoveredKey() === rowKey;
    const summary = summarizeRepo(repo);
    const showActiveCard = repo.active && expandable && expanded;
    const isRepoSelected = repo.active && (!expandable || !expanded);
    const plotSrc = repo.vibevalley ? spriteSrc(repo.active ? "plot-flowering" : "plot-leafy") : undefined;
    const parentHint = disambiguators.get(repo.path);
    const mainSessionRunning = !hasMultipleWorktrees && mainGroup.sessionRunning;
    const mainSessionLogo = mainSessionRunning ? spriteSrc(runtimeLogoOf(mainGroup.sessionAgent)) : undefined;
    const repoTip = formatSummaryTooltip(repo.path, summary, expandable && !expanded);

    const repoHeader = (
      <View
        onMouseEnter={() => hoveredKey.set(rowKey)}
        onMouseLeave={() => {
          if (hoveredKey() === rowKey) hoveredKey.set(null);
        }}
        tooltip={<TipBubble text={repoTip} />}
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: 28,
          paddingLeft: ROW_BASE_PAD,
          paddingRight: 6,
          borderRadius: 6,
          backgroundColor: rowBg(isRepoSelected, isHovered()),
          gap: 6,
        }}
      >
        <ChevronSlot
          expandable={expandable}
          expanded={expanded}
          label={expanded ? `折叠 ${repo.name}` : `展开 ${repo.name}`}
          onToggle={() => toggleFold(repoFoldKey(repo), expanded)}
        />
        <Button
          onPress={() => act({ type: "activate_path", path: repo.path })}
          style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 6, height: 28 }}
        >
          <View style={{ width: ICON_SLOT, height: ICON_SLOT, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {plotSrc ? (
              <Image src={plotSrc} style={{ width: 16, height: 16, objectFit: "contain" }} />
            ) : (
              <Glyph name="folder" size={14} color={repo.active ? p().ink : p().muted} />
            )}
          </View>
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5 }}>
            <Text
              style={{
                fontSize: 13,
                fontWeight: repo.active ? "600" : "500",
                color: p().ink,
                flexShrink: 1,
                numberOfLines: 1,
              }}
            >
              {repo.name}
            </Text>
            {parentHint ? <Text style={{ fontSize: 11, fontWeight: "400", color: p().faint, flexShrink: 1, numberOfLines: 1 }}>{parentHint}</Text> : null}
          </View>
        </Button>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 }}>
          {isHovered() ? (
            <>
              <ActionIconBtn
                icon="plus"
                size={12}
                label={`新终端：${repo.name}`}
                onPress={() => {
                  setFold(repoFoldKey(repo), true);
                  act({ type: "new_terminal_at", path: repo.path });
                }}
              />
              {repo.projectId !== undefined && !repo.vibevalley ? (
                <ActionIconBtn
                  icon="close"
                  size={11}
                  label={`关闭文件夹：${repo.name}`}
                  onPress={() => {
                    if (hoveredKey() === rowKey) hoveredKey.set(null);
                    act({ type: "close_project", id: repo.projectId! });
                  }}
                />
              ) : null}
            </>
          ) : expandable && !expanded ? (
            <CollapsedSummary summary={summary} />
          ) : (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 0 }}>
              {mainSessionRunning ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 3, flexShrink: 0 }}>
                  {mainSessionLogo ? <Image src={mainSessionLogo} style={{ width: 13, height: 13, objectFit: "contain" }} /> : null}
                  <StatusDots state="working" />
                </View>
              ) : null}
              {!hasMultipleWorktrees && repo.branch ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 3, maxWidth: 84, flexShrink: 1 }}>
                  <Glyph name="branch" size={11} color={p().faint} />
                  <Text style={{ ...ty.mono, fontSize: 11, color: p().muted, numberOfLines: 1, flexShrink: 1 }}>{repo.branch}</Text>
                </View>
              ) : null}
            </View>
          )}
        </View>
      </View>
    );

    return (
      <View
        style={{
          borderRadius: 8,
          borderWidth: 1,
          borderColor: showActiveCard ? p().border : "transparent",
          backgroundColor: showActiveCard ? p().surface : "transparent",
          paddingVertical: 2,
          gap: 1,
        }}
      >
        {withWorktreeMenu(mainGroup, repoHeader)}
        {expandable && expanded ? (
          !hasMultipleWorktrees ? (
            <View style={{ gap: 1 }}>{mainGroup.tabs.map((tab) => renderTabRow(mainGroup, tab, 1))}</View>
          ) : (
            <View style={{ gap: 1 }}>{repo.groups.map((group) => renderWorktreeGroup(group))}</View>
          )
        ) : null}
      </View>
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: p().canvas }}>
      <View
        style={{
          height: 36,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingLeft: 12,
          paddingRight: 8,
          borderBottomWidth: 1,
          borderBottomColor: p().border,
        }}
      >
        <Text style={{ fontSize: 12, fontWeight: "600", color: p().ink }}>仓库与终端</Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          {hasFoldableItems() ? (
            <Button
              onPress={toggleCollapseAll}
              accessibilityLabel={anyExpanded() ? "折叠全部" : "展开当前"}
              tooltip={<TipBubble text={anyExpanded() ? "折叠全部" : "展开当前"} />}
              hoverStyle={{ backgroundColor: dark() ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)" }}
              activeStyle={{ opacity: 0.75 }}
              style={{
                width: 22,
                height: 22,
                borderRadius: 5,
                alignItems: "center",
                justifyContent: "center",
                ...pressTransition(),
              }}
            >
              <Glyph name={anyExpanded() ? "collapseAll" : "expandAll"} size={13} color={p().muted} />
            </Button>
          ) : null}
          <Button
            onPress={() => act({ type: "add_project" })}
            accessibilityLabel="添加仓库"
            tooltip={<TipBubble text="添加本地仓库或文件夹" />}
            hoverStyle={{ backgroundColor: dark() ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.07)" }}
            activeStyle={{ opacity: 0.8 }}
            style={{
              height: 22,
              paddingHorizontal: 7,
              borderRadius: 5,
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              backgroundColor: p().tile,
              borderWidth: 1,
              borderColor: p().border,
              ...pressTransition(),
            }}
          >
            <Glyph name="plus" size={11} color={p().text} />
            <Text style={{ fontSize: 11, fontWeight: "500", color: p().text }}>仓库</Text>
          </Button>
        </View>
      </View>

      <Scroll
        style={{ flex: 1 }}
        onMouseLeave={() => {
          if (hoveredKey() !== null) hoveredKey.set(null);
        }}
      >
        <View style={{ paddingHorizontal: 8, paddingVertical: 6, gap: 6 }}>
          {(() => {
            const allRepos = repoTree();
            const disambiguators = disambiguatorMap(allRepos);
            return sections().map((section) => {
              const isCollapsibleSection = section.id === "other" && section.title.length > 0;
              const isCollapsed = isCollapsibleSection && otherSectionCollapsed();
              const sectionSummary = isCollapsibleSection ? summarizeRepos(section.repos) : undefined;
              return (
                <View style={{ gap: 2 }}>
                  {section.title ? (
                    <Button
                      onPress={() => {
                        if (isCollapsibleSection) otherSectionCollapsed.update((v) => !v);
                      }}
                      accessibilityLabel={isCollapsed ? `展开 ${section.title}` : `折叠 ${section.title}`}
                      hoverStyle={{ backgroundColor: dark() ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)" }}
                      style={{
                        height: 24,
                        flexDirection: "row",
                        alignItems: "center",
                        marginHorizontal: 1,
                        paddingLeft: ROW_BASE_PAD,
                        paddingRight: 6,
                        marginTop: 4,
                        borderRadius: 5,
                        gap: 6,
                        ...pressTransition(),
                      }}
                    >
                      <View style={{ width: CHEVRON_SLOT, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                        <Glyph name="chevron" size={9.5} color={p().muted} rotateDeg={isCollapsed ? 0 : 90} />
                      </View>
                      <Text style={{ fontSize: 11, fontWeight: "600", color: p().muted, flex: 1, numberOfLines: 1 }}>{section.title}</Text>
                      {isCollapsed && sectionSummary ? (
                        <CollapsedSummary summary={sectionSummary} />
                      ) : (
                        <Text style={{ fontSize: 11, fontWeight: "500", fontVariant: ["tabular-nums"], color: p().faint }}>{String(section.repos.length)}</Text>
                      )}
                    </Button>
                  ) : null}
                  {!isCollapsed ? section.repos.map((repo) => renderRepoNode(repo, disambiguators)) : null}
                </View>
              );
            });
          })()}
        </View>
      </Scroll>
    </View>
  );
}
