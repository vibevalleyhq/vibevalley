import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { SliceMap } from "@vibevalley/protocol";
import { isFreeUserSession, isOrchestratorSession, sessionIssueId, sessionRepo } from "@vibevalley/protocol/rules";
import { HostRailRunningState as HostRailRunningStateSchema } from "@vibevalley/protocol/schema";

import type { GitWorktree } from "../GitPanel";
import type { RepoDetailTarget } from "../RepoDetailPanel";

export type RailRunningState = z.infer<typeof HostRailRunningStateSchema>;

export type RailTab = {
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
  branch?: string | null;
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
  shortcut?: string | null;
  branch?: string | null;
  mainRoot?: string | null;
  worktrees?: RailWorktree[];
  tabs?: RailTab[];
};

type RailFrame = { projects: RailProject[]; panel: string; inspectorOpen?: boolean };

export type VvRepo = {
  name: string;
  path: string;
  git?: boolean;
  external?: boolean;
  last?: number;
  maxSessions?: number;
  pullRequest?: { available: boolean; reason: string };
};

const railTabSchema: z.ZodType<RailTab> = z.object({
  id: z.number(),
  title: z.string(),
  active: z.boolean(),
  kind: z.string(),
  running: z.exactOptional(z.boolean()),
  runningState: z.exactOptional(HostRailRunningStateSchema),
  runningAgent: z.exactOptional(z.string().nullable()),
  runningLabel: z.exactOptional(z.string().nullable()),
  attention: z.exactOptional(z.boolean()),
});

const railWorktreeSchema: z.ZodType<RailWorktree> = z.object({
  path: z.string(),
  branch: z.exactOptional(z.string().nullable()),
  main: z.boolean(),
});

const railProjectSchema: z.ZodType<RailProject> = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  initials: z.string(),
  active: z.boolean(),
  attention: z.boolean(),
  terminals: z.number(),
  shortcut: z.exactOptional(z.string().nullable()),
  branch: z.exactOptional(z.string().nullable()),
  mainRoot: z.exactOptional(z.string().nullable()),
  worktrees: z.exactOptional(z.array(railWorktreeSchema)),
  tabs: z.exactOptional(z.array(railTabSchema)),
});

export const railFrameSchema: z.ZodType<RailFrame> = z.object({
  projects: z.array(railProjectSchema),
  panel: z.string(),
  inspectorOpen: z.exactOptional(z.boolean()),
});

export const vvRepoSchema: z.ZodType<VvRepo> = z.object({
  name: z.string(),
  path: z.string(),
  git: z.exactOptional(z.boolean()),
  external: z.exactOptional(z.boolean()),
  last: z.exactOptional(z.number()),
  maxSessions: z.exactOptional(z.number()),
  pullRequest: z.exactOptional(z.object({ available: z.boolean(), reason: z.string() })),
});

export type WorktreeGroup = {
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

export type RepoNode = {
  projectId?: number;
  name: string;
  path: string;
  branch?: string | null;
  active: boolean;
  groups: WorktreeGroup[];
  /** One of VibeValley's repos (repo.list), not a folder opened for its terminals. */
  vibevalley: boolean;
};

export type ActivitySummary = {
  working: number;
  ready: number;
  attention: number;
  tabs: number;
};

export interface SidebarTreeCtx {
  readonly hoveredKey: () => string | null;
  readonly setHoveredKey: (key: string | null) => void;
  readonly openMenuKey: () => string | null;
  readonly setOpenMenuKey: (key: string | null) => void;
  readonly sweepPhase: () => boolean;
  readonly engineLogoSrc: (agent: string | undefined) => string | undefined;
  readonly isRepoExpanded: (repo: RepoNode) => boolean;
  readonly isGroupExpanded: (group: WorktreeGroup) => boolean;
  readonly setFold: (key: string, expanded: boolean) => void;
  readonly toggleFold: (key: string, current: boolean) => void;
  readonly openRepoDetail: (path: string) => void;
}

// Pixel-strict tree grid constants:
// Depth 0 (Repo):     chevron @ 6,  icon @ 30, label @ 50
// Depth 1 (Tab):      icon @ 30,    label @ 50
// Depth 1 (Worktree): chevron @ 18, icon @ 42, label @ 62
// Depth 2 (Tab):      icon @ 42,    label @ 62
export const ROW_BASE_PAD = 12;
export const INDENT_STEP = 14;

export const rowClass = (selected: boolean) => `relative h-7 flex-row items-center gap-1.5 rounded-md pr-1.5 ${selected ? "bg-selected" : "hover:bg-hover"}`;
export const repoFoldKey = (repo: RepoNode) => `repo:${repo.path}`;
export const groupFoldKey = (group: WorktreeGroup) => `wt:${group.path}`;
export const isRepoExpandable = (repo: RepoNode) => repo.groups.length > 1 || (repo.groups[0]?.tabs.length ?? 0) > 0;
export const isGroupExpandable = (group: WorktreeGroup) => group.tabs.length > 0;

export function formatDisplayPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");
}

export function normPath(p: string | undefined): string {
  if (!p) return "";
  const trimmed = p.replace(/\/+$/u, "");
  return trimmed || "/";
}

export function tabRunningState(tab: RailTab): RailRunningState {
  if (tab.runningState) return tab.runningState;
  return tab.running === true ? "working" : "idle";
}

export function summarizeGroup(group: WorktreeGroup): ActivitySummary {
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

export function summarizeRepo(repo: RepoNode): ActivitySummary {
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

export function disambiguatorMap(repos: RepoNode[]): Map<string, string> {
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

export function formatTabTooltip(tab: RailTab, group: WorktreeGroup): string {
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

export function formatSummaryTooltip(base: string, summary: ActivitySummary, collapsed: boolean): string {
  const parts: string[] = [base];
  if (collapsed && summary.tabs > 0) parts.push(t("web.shell.sidebar.terminalCount", { n: summary.tabs }));
  if (summary.working > 0) parts.push(t("web.shell.sidebar.workingCount", { n: summary.working }));
  if (summary.ready > 0) parts.push(t("web.shell.sidebar.readyCount", { n: summary.ready }));
  if (summary.attention > 0) parts.push(t("web.shell.sidebar.attentionCount", { n: summary.attention }));
  return parts.join(" · ");
}

type SidebarSession = SliceMap["sessions"]["sessions"][number];
type SidebarIssue = SliceMap["board"]["issues"][number];

export function buildRepoTree(args: {
  readonly projects: readonly RailProject[];
  readonly vvRepos: readonly VvRepo[];
  readonly sessions: readonly SidebarSession[];
  readonly issues: readonly SidebarIssue[];
  readonly gitWorktrees: readonly GitWorktree[] | undefined;
  readonly activePath: string;
}): RepoNode[] {
  const { projects, vvRepos, sessions, issues, gitWorktrees, activePath: curPath } = args;
  const byPath = new Map<string, RailProject>();
  for (const proj of projects) {
    byPath.set(normPath(proj.path), proj);
  }

  const worktreePaths = new Set<string>();
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

  for (const r of vvRepos) {
    const rp = normPath(r.path);
    if (!rp || seenRoots.has(rp)) continue;
    roots.push({ name: r.name, path: rp });
    seenRoots.add(rp);
  }

  const vvPaths = new Set(vvRepos.map((r) => normPath(r.path)));
  const issueMap = new Map(issues.map((i) => [i.id, i]));

  return roots.map((root) => {
    const mainProj = byPath.get(root.path);
    const mainSession = sessions.find((s) => {
      if (isFreeUserSession(s) || isOrchestratorSession(s) || s.phase._tag === "closed") return false;
      if (sessionRepo(s) !== root.name) return false;
      const cwd = normPath(s.cwd);
      return !cwd || cwd === root.path;
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

    for (const s of sessions) {
      if (s.phase._tag === "closed" || sessionRepo(s) !== root.name) continue;
      const wp = normPath(s.cwd);
      if (!wp || seenGroupPaths.has(wp)) continue;
      seenGroupPaths.add(wp);
      const wtProj = byPath.get(wp);
      const iid = sessionIssueId(s);
      const issue = iid ? issueMap.get(iid) : undefined;
      const branch = wtProj?.branch;
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

    const knownWorktrees = mainProj?.worktrees ?? (curPath === root.path ? gitWorktrees : undefined) ?? [];
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
}

export function buildRepoDetailTarget(args: {
  readonly path: string | null;
  readonly orderedRepos: readonly RepoNode[];
  readonly vvRepoByPath: ReadonlyMap<string, VvRepo>;
  readonly issues: readonly SidebarIssue[];
  readonly sessions: readonly SidebarSession[];
}): RepoDetailTarget | null {
  const { path, orderedRepos, vvRepoByPath, issues, sessions } = args;
  if (!path) return null;
  const repo = orderedRepos.find((r) => r.path === path);
  if (!repo) return null;
  const vv = vvRepoByPath.get(repo.path);
  const openIssues = issues.filter((i) => i.repo === repo.name && i.status !== "done" && i.status !== "canceled").length;
  const activeSessions = sessions.filter(
    (s) => !isFreeUserSession(s) && !isOrchestratorSession(s) && s.phase._tag === "working" && sessionRepo(s) === repo.name,
  ).length;
  const totalTabs = repo.groups.reduce((sum, g) => sum + g.tabs.length, 0);
  return {
    projectId: repo.projectId,
    name: repo.name,
    path: repo.path,
    branch: repo.branch,
    active: repo.active,
    vibevalley: repo.vibevalley,
    external: vv?.external,
    git: vv?.git,
    maxSessions: vv?.maxSessions,
    pullRequest: vv?.pullRequest,
    openIssues,
    activeSessions,
    totalTabs,
    worktrees: repo.groups.map((g) => ({
      id: g.id,
      label: g.label,
      branch: g.branch,
      path: g.path,
      isMain: g.isMain,
      active: g.active,
      sessionRunning: g.sessionRunning,
      tabsCount: g.tabs.length,
    })),
  };
}
