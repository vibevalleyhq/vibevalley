import { Clipboard, computed, effect, host, Image, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { Button, ContextMenu, Menu, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { BoardSlice, SessionsSlice } from "@vibevalley/protocol";
import { isFreeUserSession, isOrchestratorSession, sessionBranch, sessionIssueId, sessionRepo, sessionWorktree } from "@vibevalley/protocol/rules";

import { Icon } from "../design/Icon";
import type { IconName } from "../design/icons";
import { ActiveBar } from "../design/layout";
import { motionClass, motionOff, popupTransition } from "../design/motion";
import { Bubble } from "../design/Tip";
import { mix } from "../design/tone";
import { act, call, frame, hostApi } from "../infra/bridge";
import { readHostParams } from "../infra/hostParams";
import { menuDangerItemClass, menuItemClass, menuPopupClass, menuSeparatorClass, ShellIconButton } from "./chrome";
import { FileTree, type FilesFrame } from "./FileTree";
import { GitPanel, type GitFrame, type GitTab } from "./GitPanel";

type RailRunningState = "working" | "ready" | "idle";

type RailTab = {
  id: number;
  title: string;
  active: boolean;
  kind: string;
  running?: boolean;
  runningState?: RailRunningState;
  runningAgent?: string | null;
  runningLabel?: string | null;
  attention?: boolean;
};

type RailWorktree = {
  path: string;
  branch: string | null;
  main: boolean;
};

type RailProject = {
  id: number;
  name: string;
  path: string;
  initials: string;
  active: boolean;
  attention: boolean;
  terminals: number;
  shortcut: string | null;
  branch?: string | null;
  mainRoot?: string | null;
  worktrees?: RailWorktree[];
  tabs?: RailTab[];
};

type RailFrame = { projects: RailProject[]; panel: string; inspectorOpen?: boolean };

type VvRepo = { name: string; path: string; git?: boolean; last?: number };

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

const KNOWN_RUNTIME_LOGOS = new Set(["claude", "codex", "opencode", "cursor", "kimi", "pi", "dsh", "grok", "antigravity"]);

function runtimeLogoOf(agent: string | undefined): string | undefined {
  if (!agent) return undefined;
  const key = agent.toLowerCase().replace(/^acp:/u, "");
  return KNOWN_RUNTIME_LOGOS.has(key) ? `logo-${key}` : undefined;
}

function normPath(p: string | undefined): string {
  if (!p) return "";
  const trimmed = p.replace(/\/+$/u, "");
  return trimmed || "/";
}

function tabRunningState(tab: RailTab): RailRunningState {
  if (tab.runningState) return tab.runningState;
  return tab.running === true ? "working" : "idle";
}

function summarizeGroup(group: WorktreeGroup): ActivitySummary {
  let working = group.sessionRunning ? 1 : 0;
  let ready = 0;
  let attention = 0;
  for (const tab of group.tabs) {
    const state = tabRunningState(tab);
    if (state === "working") working += 1;
    else if (state === "ready") ready += 1;
    if (tab.attention === true) attention += 1;
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
      return segs.length >= 2 ? segs[segs.length - 2] : r.path;
    });
    const parentCounts = new Map<string, number>();
    for (const parent of parents) {
      parentCounts.set(parent, (parentCounts.get(parent) ?? 0) + 1);
    }
    for (let i = 0; i < group.length; i++) {
      const r = group[i];
      const parent = parents[i];
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

function TabIconStatus(props: {
  tabId: number;
  logoSrc?: string | undefined;
  fallbackIcon: IconName;
  iconTone: string;
  state: RailRunningState;
  attention: boolean;
  sweepPhase: boolean;
}) {
  return (
    <View class="relative size-4 shrink-0 items-center justify-center">
      {props.logoSrc ? <Image src={props.logoSrc} class="size-4 object-contain" /> : <Icon name={props.fallbackIcon} size={14} tone={props.iconTone} />}
      {props.state === "working" ? (
        <View
          testID={`sidebar-tab-working-${props.tabId}`}
          class="pointer-events-none absolute -bottom-1 left-0 h-0.5 w-4 overflow-hidden rounded-full"
          style={{ backgroundColor: mix("leaf", 0.24) }}
        >
          {motionOff() ? (
            <View class="h-full w-full rounded-full bg-leaf" />
          ) : (
            <View
              class={`h-full w-2 rounded-full bg-leaf ${motionClass("transition-transform duration-280 ease-in-out")}`}
              style={{ transform: [{ translateX: props.sweepPhase ? 8 : 0 }] }}
            />
          )}
        </View>
      ) : null}
      {props.attention ? (
        <View
          testID={`sidebar-tab-attention-${props.tabId}`}
          class={`pointer-events-none absolute -right-0.5 ${props.state === "working" ? "-top-0.5" : "-bottom-0.5"} size-1.5 rounded-full bg-wheat`}
        />
      ) : props.state === "ready" ? (
        <View
          testID={`sidebar-tab-ready-${props.tabId}`}
          class="pointer-events-none absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full border bg-side"
          style={{ borderColor: mix("leaf", 0.72) }}
        />
      ) : null}
    </View>
  );
}

function StatusDots(props: { state: RailRunningState; attention?: boolean; readyRing?: boolean }) {
  const showWorking = () => props.state === "working";
  const showReady = () => props.state === "ready" && props.readyRing !== false;
  const showAttention = () => Boolean(props.attention);
  return (
    <View class="shrink-0 flex-row items-center gap-1">
      {showWorking() ? <View class="size-1.5 rounded-full bg-leaf" /> : null}
      {showReady() ? <View class="size-1.5 rounded-full border" style={{ borderColor: mix("leaf", 0.62) }} /> : null}
      {showAttention() ? <View class="size-1.5 rounded-full bg-wheat" /> : null}
    </View>
  );
}

function CollapsedSummary(props: { summary: ActivitySummary }) {
  const s = () => props.summary;
  return (
    <View class="shrink-0 flex-row items-center gap-1">
      {s().working > 0 ? <View class="size-1.5 rounded-full bg-leaf" /> : null}
      {s().working === 0 && s().ready > 0 ? <View class="size-1.5 rounded-full border" style={{ borderColor: mix("leaf", 0.62) }} /> : null}
      {s().attention > 0 ? <View class="size-1.5 rounded-full bg-wheat" /> : null}
      {s().tabs > 0 ? <Text class={`text-2xs font-medium tabular-nums ${s().working > 0 ? "text-leaf" : "text-faint"}`}>{String(s().tabs)}</Text> : null}
    </View>
  );
}

function ChevronSlot(props: { expandable: boolean; expanded: boolean; label: string; onToggle: () => void }) {
  if (!props.expandable) {
    return <View class="h-3.5 w-3.5 shrink-0" />;
  }
  return (
    <Button
      onPress={props.onToggle}
      accessibilityLabel={props.label}
      class={`h-4.5 w-3.5 shrink-0 items-center justify-center rounded-sm ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
    >
      <View
        class={`size-2.5 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
        style={{ transform: [{ rotate: props.expanded ? "90deg" : "0deg" }] }}
      >
        <Icon name="expand" size={10} tone="muted" />
      </View>
    </Button>
  );
}

function formatTabTooltip(tab: RailTab, group: WorktreeGroup): string {
  const state = tabRunningState(tab);
  const parts: string[] = [tab.title];
  if (tab.kind === "terminal" || tab.kind === "chat") {
    const label =
      tab.runningLabel && tab.runningLabel !== tab.title ? tab.runningLabel : tab.runningAgent && tab.runningAgent !== "cmd" ? tab.runningAgent : null;
    if (state === "working") {
      parts.push(label ? t("web.shell.sidebar.runningAgent", { agent: label }) : t("web.shell.sidebar.running"));
    } else if (state === "ready") {
      parts.push(label ? t("web.shell.sidebar.readyAgent", { agent: label }) : t("web.shell.sidebar.ready"));
    }
    if (tab.attention === true) parts.push(tab.kind === "chat" ? t("web.shell.sidebar.chatWaiting") : t("web.shell.sidebar.needsAttention"));
  }
  parts.push(group.path);
  return parts.join(" · ");
}

function formatSummaryTooltip(base: string, summary: ActivitySummary, collapsed: boolean): string {
  const parts: string[] = [base];
  if (collapsed && summary.tabs > 0) parts.push(t("web.shell.sidebar.terminalCount", { n: summary.tabs }));
  if (summary.working > 0) parts.push(t("web.shell.sidebar.workingCount", { n: summary.working }));
  if (summary.ready > 0) parts.push(t("web.shell.sidebar.readyCount", { n: summary.ready }));
  if (summary.attention > 0) parts.push(t("web.shell.sidebar.attentionCount", { n: summary.attention }));
  return parts.join(" · ");
}

export function Sidebar() {
  const rail = frame<RailFrame>("rail");
  const files = frame<FilesFrame>("files");
  const git = frame<GitFrame>("git");
  const vvRepos = signal<VvRepo[]>([]);
  const hostParams = readHostParams();
  const isInspector = hostParams.role === "inspector";
  const board = isInspector ? () => null : frame<BoardSlice>("slice:board");
  const sessionsSlice = isInspector ? () => null : frame<SessionsSlice>("slice:sessions");
  const pixelDir = signal<string | undefined>(hostParams.pixelDir);
  const foldOverrides = signal<Record<string, boolean>>({});
  const hoveredKey = signal<string | null>(null);
  const openMenuKey = signal<string | null>(null);
  const sweepPhase = signal(false);

  const sessions = () => sessionsSlice()?.sessions ?? [];
  const issues = () => board()?.issues ?? [];
  const repoNamesKey = computed(() => {
    const names = new Set<string>();
    for (const s of sessions()) {
      const repo = sessionRepo(s);
      if (repo) names.add(repo);
    }
    for (const i of issues()) {
      if (i.repo) names.add(i.repo);
    }
    return [...names].toSorted().join("\0");
  });

  const hasWorkingTab = () => {
    for (const proj of rail()?.projects ?? []) {
      for (const tab of proj.tabs ?? []) {
        if ((tab.kind === "terminal" || tab.kind === "chat") && tabRunningState(tab) === "working") return true;
      }
    }
    return false;
  };

  effect(() => {
    if (!hasWorkingTab() || motionOff()) {
      sweepPhase.set(false);
      return;
    }
    const timer = setInterval(() => sweepPhase.set(!untracked(sweepPhase)), 420);
    return () => clearInterval(timer);
  });

  if (host.available()) {
    if (!pixelDir()) {
      void hostApi.pixelDir().then((env) => {
        if (env.bizCode === 0 && env.data?.path) pixelDir.set(env.data.path);
      });
    }
    if (hostParams.role !== "inspector") {
      effect(() => {
        void repoNamesKey();
        void call<VvRepo[]>("repo.list", {}).then((env) => {
          if (env.bizCode === 0 && Array.isArray(env.data)) {
            vvRepos.set(env.data);
          }
        });
      });
    }
  }

  const panel = () => rail()?.panel ?? "files";

  const rowClass = (selected: boolean) => `relative h-7 flex-row items-center gap-1.5 rounded-md pr-1.5 ${selected ? "bg-selected" : "hover:bg-hover"}`;

  const spriteSrc = (name: string | undefined) => {
    const dir = pixelDir();
    return dir && name ? `file://${encodeURI(`${dir}/${name}.png`)}` : undefined;
  };

  const gitTab = signal<GitTab>("changes");
  if (hostParams.role === "inspector") {
    const conflictCount = () => git()?.conflicts?.length ?? 0;
    const gitCount = () => (git()?.staged?.length ?? 0) + (git()?.changes?.length ?? 0) + conflictCount();
    const currentView = () => (panel() === "git" ? `git:${gitTab()}` : panel());

    const inspectorTabs: { id: string; label: string; tip: string; badge?: () => number; danger?: () => boolean; onSelect: () => void }[] = [
      { id: "files", label: t("web.shell.sidebar.files"), tip: t("web.shell.sidebar.filesTip"), onSelect: () => act({ type: "show_panel", panel: "files" }) },
      {
        id: "git:changes",
        label: t("web.shell.sidebar.gitChanges"),
        tip: t("web.shell.sidebar.gitChangesTip"),
        badge: gitCount,
        danger: () => conflictCount() > 0,
        onSelect: () => {
          gitTab.set("changes");
          if (panel() !== "git") act({ type: "show_panel", panel: "git" });
        },
      },
      {
        id: "git:branches",
        label: t("web.shell.sidebar.gitBranches"),
        tip: t("web.shell.sidebar.gitBranchesTip"),
        onSelect: () => {
          gitTab.set("branches");
          if (panel() !== "git") act({ type: "show_panel", panel: "git" });
        },
      },
      {
        id: "git:commits",
        label: t("web.shell.sidebar.gitCommits"),
        tip: t("web.shell.sidebar.gitCommitsTip"),
        onSelect: () => {
          gitTab.set("commits");
          if (panel() !== "git") act({ type: "show_panel", panel: "git" });
        },
      },
    ];

    return (
      <View testID="workspace-inspector" class="flex-1 bg-side">
        <View role="tablist" desktop={{ windowDrag: true }} class="h-9 flex-row items-center gap-0.5 border-b border-line px-2">
          {inspectorTabs.map((item) => {
            const isCur = currentView() === item.id;
            const count = item.badge?.() ?? 0;
            const isDanger = Boolean(item.danger?.());
            return (
              <Button
                onPress={item.onSelect}
                selected={isCur}
                accessibilityLabel={count > 0 ? `${item.label} (${count})` : item.label}
                tooltip={<Bubble text={item.tip} />}
                class={`h-6 flex-row items-center justify-center gap-1 rounded-md px-2 ${motionClass("transition-opacity duration-120 ease-out")} active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus ${
                  isCur ? "bg-selected" : "bg-transparent hover:bg-hover"
                }`}
              >
                <Text class={`text-xs font-medium ${isCur ? "text-ink" : "text-muted"}`}>{item.label}</Text>
                {count > 0 ? (
                  <View class={`h-4 min-w-4 items-center justify-center rounded-full px-1 ${isDanger ? "bg-bad-soft" : "bg-hover"}`}>
                    <Text class={`text-2xs font-semibold tabular-nums ${isDanger ? "text-berry" : isCur ? "text-ink" : "text-muted"}`}>{String(count)}</Text>
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

  const activePath = () => normPath(rail()?.projects.find((proj) => proj.active)?.path ?? files()?.root);

  const repoTree = (): RepoNode[] => {
    const projects = rail()?.projects ?? [];
    const byPath = new Map<string, RailProject>();
    for (const proj of projects) {
      byPath.set(normPath(proj.path), proj);
    }

    const worktreePaths = new Set<string>();
    for (const s of sessions()) {
      const wt = sessionWorktree(s);
      if (wt) worktreePaths.add(normPath(wt));
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
      const mainSession = sessions().find((s) => {
        if (isFreeUserSession(s) || isOrchestratorSession(s) || s.phase._tag === "closed") return false;
        if (sessionRepo(s) !== root.name) return false;
        const wt = sessionWorktree(s);
        return !wt || normPath(wt) === root.path;
      });
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
        if (s.phase._tag === "closed" || sessionRepo(s) !== root.name) continue;
        const wt = sessionWorktree(s);
        if (!wt) continue;
        const wp = normPath(wt);
        if (!wp || seenGroupPaths.has(wp)) continue;
        seenGroupPaths.add(wp);
        const wtProj = byPath.get(wp);
        const iid = sessionIssueId(s);
        const issue = iid ? issueMap.get(iid) : undefined;
        const branch = sessionBranch(s);
        const label = issue ? `#${issue.number} ${issue.title}` : branch || s.brief || s.name;
        const tabs: RailTab[] = wtProj?.tabs ?? [];
        extraGroups.push({
          id: `session:${s.id}`,
          label,
          branch,
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
    }
  };

  const orderedRepos = (): RepoNode[] => {
    const all = repoTree();
    return [...all.filter((r) => r.vibevalley), ...all.filter((r) => !r.vibevalley)];
  };

  const withWorktreeMenu = (group: WorktreeGroup, trigger: JSX.Element) => (
    <ContextMenu trigger={trigger} popupClass={menuPopupClass}>
      <MenuItem
        onSelect={() => {
          setFold(groupFoldKey(group), true);
          act({ type: "new_chat_at", path: group.path });
        }}
        class={menuItemClass}
      >
        <Text class="text-sm text-ink">{t("web.shell.sidebar.newChatHere")}</Text>
      </MenuItem>
      <MenuItem
        onSelect={() => {
          setFold(groupFoldKey(group), true);
          act({ type: "new_terminal_at", path: group.path });
        }}
        class={menuItemClass}
      >
        <Text class="text-sm text-ink">{t("web.shell.sidebar.newTerminalHere")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void hostApi.reveal(group.path)} class={menuItemClass}>
        <Text class="text-sm text-ink">{t("web.shell.sidebar.revealInFinder")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void Clipboard.writeText(group.path)} class={menuItemClass}>
        <Text class="text-sm text-ink">{t("web.shell.sidebar.copyPath")}</Text>
      </MenuItem>
      {!group.isMain ? (
        <>
          <MenuSeparator class={menuSeparatorClass} />
          <MenuItem onSelect={() => act({ type: "remove_worktree", path: group.path, force: false })} class={menuDangerItemClass}>
            <Text class="text-sm text-berry">{t("web.shell.sidebar.removeWorktree")}</Text>
          </MenuItem>
        </>
      ) : null}
    </ContextMenu>
  );

  const renderTabRow = (group: WorktreeGroup, tab: RailTab, depth: number) => {
    const rowKey = `tab:${group.path}:${tab.id}`;
    const isSelected = group.active && tab.active;
    const isHovered = () => hoveredKey() === rowKey;
    const isMenuOpen = () => openMenuKey() === rowKey;
    // Each terminal/chat tab displays strictly its own status (never polluted by group.sessionRunning).
    const state = tab.kind === "terminal" || tab.kind === "chat" ? tabRunningState(tab) : "idle";
    const ownAgent = tab.kind === "terminal" || tab.kind === "chat" ? tab.runningAgent : undefined;
    const logoSrc = spriteSrc(runtimeLogoOf(ownAgent ?? undefined));
    const canClose = tab.kind === "terminal" || tab.kind === "chat" || group.tabs.length > 1;
    const tabIconTone = () => (state === "working" ? "leaf" : isSelected ? "ink" : "muted");
    const fallbackIcon: IconName = tab.kind === "chat" ? "chat" : tab.kind === "diff" ? "diff" : tab.kind === "file" ? "file" : "terminal";
    const tabMenuItemClass = "h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";
    const tabMenuDangerClass = "h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-bad-soft focus:bg-bad-soft";

    return (
      <View
        onMouseEnter={() => hoveredKey.set(rowKey)}
        onMouseLeave={() => {
          if (hoveredKey() === rowKey) hoveredKey.set(null);
        }}
        tooltip={<Bubble text={formatTabTooltip(tab, group)} />}
        class={rowClass(isSelected)}
        style={{ paddingLeft: ROW_BASE_PAD + depth * INDENT_STEP }}
      >
        {isSelected ? <ActiveBar /> : null}
        {/* Leaf rows keep the exact 14px chevron slot so sibling icons & labels align vertically. */}
        <View class="h-3.5 w-3.5 shrink-0" />
        <Button
          onPress={() => act({ type: "activate_tab", path: group.path, tab_id: tab.id })}
          class="h-7 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
        >
          <TabIconStatus
            tabId={tab.id}
            logoSrc={logoSrc}
            fallbackIcon={fallbackIcon}
            iconTone={tabIconTone()}
            state={state}
            attention={tab.attention === true}
            sweepPhase={sweepPhase()}
          />
          <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{tab.title}</Text>
        </Button>
        {isHovered() || isMenuOpen() ? (
          <Menu
            open={isMenuOpen()}
            onOpenChange={(e) => {
              if (e.open) openMenuKey.set(rowKey);
              else if (openMenuKey() === rowKey) openMenuKey.set(null);
            }}
            placement="bottom"
            align="end"
            offset={4}
            popupClass={`${menuPopupClass} ${motionClass("transition-opacity duration-120 ease-out")}`}
            popupStartingClass={popupTransition("opacity-0")}
            popupEndingClass={popupTransition("opacity-0")}
            trigger={
              <View
                testID={`sidebar-tab-more-${tab.id}`}
                accessibilityLabel={t("web.shell.sidebar.tabMore")}
                tooltip={<Bubble text={t("web.shell.sidebar.tabMore")} />}
                class={`size-5 shrink-0 items-center justify-center rounded-sm ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus`}
              >
                <Icon name="more" size={13} tone="muted" />
              </View>
            }
          >
            <MenuItem
              testID={`sidebar-tab-menu-chat-${tab.id}`}
              onSelect={() => {
                setFold(groupFoldKey(group), true);
                act({ type: "new_chat_at", path: group.path });
              }}
              class={tabMenuItemClass}
            >
              <Icon name="chat" size={13} tone="muted" />
              <Text class="text-sm text-ink">{t("web.shell.sidebar.newChatHere")}</Text>
            </MenuItem>
            <MenuItem
              testID={`sidebar-tab-menu-term-${tab.id}`}
              onSelect={() => {
                setFold(groupFoldKey(group), true);
                act({ type: "new_terminal_at", path: group.path });
              }}
              class={tabMenuItemClass}
            >
              <Icon name="terminal" size={13} tone="muted" />
              <Text class="text-sm text-ink">{t("web.shell.sidebar.newTerminalHere")}</Text>
            </MenuItem>
            <MenuItem testID={`sidebar-tab-menu-reveal-${tab.id}`} onSelect={() => void hostApi.reveal(group.path)} class={tabMenuItemClass}>
              <Icon name="folder" size={13} tone="muted" />
              <Text class="text-sm text-ink">{t("web.shell.sidebar.revealInFinder")}</Text>
            </MenuItem>
            <MenuItem testID={`sidebar-tab-menu-copy-${tab.id}`} onSelect={() => void Clipboard.writeText(group.path)} class={tabMenuItemClass}>
              <Icon name="copy" size={13} tone="muted" />
              <Text class="text-sm text-ink">{t("web.shell.sidebar.copyPath")}</Text>
            </MenuItem>
            {canClose ? (
              <>
                <MenuSeparator class={menuSeparatorClass} />
                <MenuItem
                  testID={`sidebar-tab-menu-close-${tab.id}`}
                  onSelect={() => {
                    if (hoveredKey() === rowKey) hoveredKey.set(null);
                    if (openMenuKey() === rowKey) openMenuKey.set(null);
                    act({ type: "close_tab_at", path: group.path, tab_id: tab.id });
                  }}
                  class={tabMenuDangerClass}
                >
                  <Icon name="close" size={13} tone="berry" />
                  <Text class="text-sm text-berry">{t("web.shell.sidebar.closeTab")}</Text>
                </MenuItem>
              </>
            ) : null}
          </Menu>
        ) : null}
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
      group.isMain ? `${t("web.shell.sidebar.mainWorktree", { label: group.label })} · ${group.path}` : `${group.label} · ${group.path}`,
      summary,
      expandable && !expanded,
    );

    return (
      <View class="gap-px">
        {withWorktreeMenu(
          group,
          <View
            onMouseEnter={() => hoveredKey.set(rowKey)}
            onMouseLeave={() => {
              if (hoveredKey() === rowKey) hoveredKey.set(null);
            }}
            tooltip={<Bubble text={tipText} />}
            class={`${rowClass(isSelected)} pl-5`}
          >
            {isSelected ? <ActiveBar /> : null}
            <ChevronSlot
              expandable={expandable}
              expanded={expanded}
              label={expanded ? t("web.shell.sidebar.collapseItem", { name: group.label }) : t("web.shell.sidebar.expandItem", { name: group.label })}
              onToggle={() => toggleFold(groupFoldKey(group), expanded)}
            />
            <Button
              onPress={() => act({ type: "activate_path", path: group.path })}
              class="h-7 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
            >
              <View class="size-4 shrink-0 items-center justify-center">
                <Icon name="branch" size={14} tone={group.sessionRunning ? "leaf" : group.active ? "ink" : "muted"} />
              </View>
              <View class="min-w-0 flex-1 flex-row items-center gap-1">
                <Text class="shrink truncate text-sm font-medium text-ink">{group.label}</Text>
                {group.isMain ? <Text class="shrink-0 text-2xs font-medium text-faint">{t("web.shell.sidebar.mainLabel")}</Text> : null}
              </View>
            </Button>
            <View class="shrink-0 flex-row items-center gap-1">
              {isHovered() ? (
                <>
                  {expandable && !expanded ? <CollapsedSummary summary={summary} /> : group.sessionRunning ? <StatusDots state="working" /> : null}
                  <ShellIconButton
                    compact
                    icon="chat"
                    size={12}
                    label={t("web.shell.sidebar.newChat", { name: group.label })}
                    onPress={() => {
                      setFold(groupFoldKey(group), true);
                      act({ type: "new_chat_at", path: group.path });
                    }}
                  />
                  <ShellIconButton
                    compact
                    icon="add"
                    size={12}
                    label={t("web.shell.sidebar.newTerminal", { name: group.label })}
                    onPress={() => {
                      setFold(groupFoldKey(group), true);
                      act({ type: "new_terminal_at", path: group.path });
                    }}
                  />
                </>
              ) : expandable && !expanded ? (
                <CollapsedSummary summary={summary} />
              ) : group.sessionRunning ? (
                <View class="shrink-0 flex-row items-center gap-1">
                  {sessionLogo ? <Image src={sessionLogo} class="size-3.5 object-contain" /> : null}
                  <StatusDots state="working" />
                </View>
              ) : null}
            </View>
          </View>,
        )}
        {expandable && expanded ? <View class="gap-px">{group.tabs.map((tab) => renderTabRow(group, tab, 2))}</View> : null}
      </View>
    );
  };

  const renderRepoNode = (repo: RepoNode, disambiguators: Map<string, string>) => {
    const rowKey = `repo:${repo.path}`;
    const hasMultipleWorktrees = repo.groups.length > 1;
    const mainGroup = repo.groups[0];
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
        tooltip={<Bubble text={repoTip} />}
        class={`${rowClass(isRepoSelected)} pl-1.5`}
      >
        {isRepoSelected ? <ActiveBar /> : null}
        <ChevronSlot
          expandable={expandable}
          expanded={expanded}
          label={expanded ? t("web.shell.sidebar.collapseItem", { name: repo.name }) : t("web.shell.sidebar.expandItem", { name: repo.name })}
          onToggle={() => toggleFold(repoFoldKey(repo), expanded)}
        />
        <Button
          onPress={() => act({ type: "activate_path", path: repo.path })}
          class="h-7 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
        >
          <View class="size-4 shrink-0 items-center justify-center">
            {plotSrc ? <Image src={plotSrc} class="size-4 object-contain" /> : <Icon name="folder" size={14} tone={repo.active ? "ink" : "muted"} />}
          </View>
          <View class="min-w-0 flex-1 flex-row items-center gap-1">
            <Text class="shrink truncate text-sm font-semibold text-ink">{repo.name}</Text>
            {parentHint ? <Text class="shrink truncate text-2xs text-faint">{parentHint}</Text> : null}
          </View>
        </Button>

        <View class="shrink-0 flex-row items-center gap-0.5">
          {isHovered() ? (
            <>
              <ShellIconButton
                compact
                icon="chat"
                size={12}
                label={t("web.shell.sidebar.newChat", { name: repo.name })}
                onPress={() => {
                  setFold(repoFoldKey(repo), true);
                  act({ type: "new_chat_at", path: repo.path });
                }}
              />
              <ShellIconButton
                compact
                icon="add"
                size={12}
                label={t("web.shell.sidebar.newTerminal", { name: repo.name })}
                onPress={() => {
                  setFold(repoFoldKey(repo), true);
                  act({ type: "new_terminal_at", path: repo.path });
                }}
              />
              {repo.projectId !== undefined && !repo.vibevalley ? (
                <ShellIconButton
                  compact
                  icon="close"
                  size={11}
                  label={t("web.shell.sidebar.closeFolder", { name: repo.name })}
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
            <View class="shrink-0 flex-row items-center gap-1">
              {mainSessionRunning ? (
                <View class="shrink-0 flex-row items-center gap-1">
                  {mainSessionLogo ? <Image src={mainSessionLogo} class="size-3.5 object-contain" /> : null}
                  <StatusDots state="working" />
                </View>
              ) : null}
              {!hasMultipleWorktrees && repo.branch ? (
                <View class="max-w-21 shrink flex-row items-center gap-1">
                  <Icon name="branch" size={11} tone="faint" />
                  <Text class="shrink truncate font-mono text-2xs text-muted">{repo.branch}</Text>
                </View>
              ) : null}
            </View>
          )}
        </View>
      </View>
    );

    return (
      <View class={`gap-px rounded-lg border py-0.5 ${showActiveCard ? "border-line bg-elevated" : "border-transparent"}`}>
        {withWorktreeMenu(mainGroup, repoHeader)}
        {expandable && expanded ? (
          !hasMultipleWorktrees ? (
            <View class="gap-px">{mainGroup.tabs.map((tab) => renderTabRow(mainGroup, tab, 1))}</View>
          ) : (
            <View class="gap-px">{repo.groups.map((group) => renderWorktreeGroup(group))}</View>
          )
        ) : null}
      </View>
    );
  };

  return (
    <View testID="workspace-sidebar" class="flex-1 bg-side">
      <View desktop={{ windowDrag: true }} class="h-9 flex-row items-center justify-between border-b border-line pr-2 pl-3">
        <Text class="text-xs font-semibold text-ink">{t("web.shell.sidebar.title")}</Text>
        <View class="flex-row items-center gap-1">
          <ShellIconButton icon="catalog" size={13} label={t("web.shell.sidebar.manageRepos")} onPress={() => act({ type: "open_route", path: "/repos" })} />
          {hasFoldableItems() ? (
            <ShellIconButton
              icon={anyExpanded() ? "collapseAll" : "expandAll"}
              size={13}
              label={anyExpanded() ? t("web.shell.sidebar.collapseAll") : t("web.shell.sidebar.expandCurrent")}
              onPress={toggleCollapseAll}
            />
          ) : null}
          <Button
            onPress={() => act({ type: "add_project" })}
            accessibilityLabel={t("web.shell.sidebar.addRepo")}
            tooltip={<Bubble text={t("web.shell.sidebar.addRepoTooltip")} />}
            class={`h-5.5 flex-row items-center gap-1 rounded-md border border-line bg-hover px-2 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Icon name="add" size={11} tone="ink" />
            <Text class="text-2xs font-medium text-ink">{t("web.shell.sidebar.addRepoButton")}</Text>
          </Button>
        </View>
      </View>

      <Scroll
        class="flex-1"
        contentClass="gap-0.5 px-2 py-1.5"
        onMouseLeave={() => {
          if (hoveredKey() !== null) hoveredKey.set(null);
        }}
      >
        {(() => {
          const allRepos = orderedRepos();
          const disambiguators = disambiguatorMap(allRepos);
          return allRepos.map((repo) => renderRepoNode(repo, disambiguators));
        })()}
      </Scroll>
    </View>
  );
}
