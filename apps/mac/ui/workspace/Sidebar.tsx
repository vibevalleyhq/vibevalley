import { cleanup, computed, effect, host, Scroll, signal, Text, untracked, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { sessionRepo } from "@vibevalley/protocol/rules";

import { engineLogoUrl } from "../design/art";
import { motionOff } from "../design/motion";
import { act, callDecoded, frame, hostApi, sliceFrame } from "../infra/bridge";
import { readHostParams } from "../infra/hostParams";
import { ShellIconButton } from "./chrome";
import { filesFrameSchema } from "./FileTree";
import { gitFrameSchema } from "./GitPanel";
import { RepoDetailPanel } from "./RepoDetailPanel";
import { InspectorPane } from "./sidebar/InspectorPane";
import {
  buildRepoDetailTarget,
  buildRepoTree,
  disambiguatorMap,
  groupFoldKey,
  isGroupExpandable,
  isRepoExpandable,
  normPath,
  railFrameSchema,
  repoFoldKey,
  summarizeRepo,
  tabRunningState,
  vvRepoSchema,
  type RepoNode,
  type SidebarTreeCtx,
  type VvRepo,
  type WorktreeGroup,
} from "./sidebar/model";
import { SidebarHeaderButton, SweepTicker } from "./sidebar/StatusWidgets";
import { RepoNodeRow } from "./sidebar/TreeRows";

export function Sidebar() {
  const hostParams = readHostParams();
  if (hostParams.role === "inspector") {
    return <InspectorPane />;
  }

  const rail = frame("rail", railFrameSchema);
  const files = frame("files", filesFrameSchema);
  const git = frame("git", gitFrameSchema);
  const vvRepos = signal<VvRepo[]>([]);
  const board = sliceFrame("board");
  const sessionsSlice = sliceFrame("sessions");
  const assetsDir = signal<string | undefined>(hostParams.assetsDir);
  const foldOverrides = signal<Record<string, boolean>>({});
  const hoveredKey = signal<string | null>(null);
  const openMenuKey = signal<string | null>(null);
  const detailRepoPath = signal<string | null>(null);
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

  const railProjectsKey = computed(() =>
    (rail()?.projects ?? [])
      .map((p) => normPath(p.path))
      .filter(Boolean)
      .toSorted()
      .join("\0"),
  );

  const hasWorkingTab = computed(() => {
    for (const proj of rail()?.projects ?? []) {
      for (const tab of proj.tabs ?? []) {
        if ((tab.kind === "terminal" || tab.kind === "chat") && tabRunningState(tab) === "working") return true;
      }
    }
    return false;
  });

  const sweepActive = computed(() => hasWorkingTab() && !motionOff());

  effect(() => {
    if (!sweepActive()) sweepPhase.set(false);
  });

  if (host.available()) {
    if (!untracked(assetsDir)) {
      void hostApi.assetsDir().then((env) => {
        if (env.bizCode === 0 && env.data?.path) assetsDir.set(env.data.path);
      });
    }
    const refreshVvRepos = () =>
      void callDecoded("repo.list", {}, z.array(vvRepoSchema)).then((env) => {
        if (env.bizCode === 0 && env.data) {
          vvRepos.set(env.data);
        }
      });
    effect(() => {
      void repoNamesKey();
      void railProjectsKey();
      refreshVvRepos();
    });
    cleanup(host.on("repos-changed", refreshVvRepos));
  }

  const engineLogoSrc = (agent: string | undefined) => {
    const dir = assetsDir();
    return dir ? engineLogoUrl(dir, agent) : undefined;
  };

  const activePath = computed(() => normPath(rail()?.projects.find((proj) => proj.active)?.path ?? files()?.root));

  const repoTree = computed((): RepoNode[] =>
    buildRepoTree({
      projects: rail()?.projects ?? [],
      vvRepos: vvRepos(),
      sessions: sessions(),
      issues: issues(),
      gitWorktrees: git()?.worktrees,
      activePath: activePath(),
    }),
  );

  const isRepoExpanded = (repo: RepoNode) => {
    const ov = foldOverrides()[repoFoldKey(repo)];
    if (ov !== undefined) return ov;
    return repo.active || summarizeRepo(repo).tabs > 0;
  };

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

  const hasFoldableItems = computed(() => repoTree().some((r) => isRepoExpandable(r)));
  const anyExpanded = computed(() => {
    for (const repo of repoTree()) {
      if (isRepoExpandable(repo) && isRepoExpanded(repo)) return true;
      if (repo.groups.length > 1) {
        for (const group of repo.groups) {
          if (isGroupExpandable(group) && isGroupExpanded(group)) return true;
        }
      }
    }
    return false;
  });

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

  const orderedRepos = computed((): RepoNode[] => {
    const all = repoTree();
    return [...all.filter((r) => r.vibevalley), ...all.filter((r) => !r.vibevalley)];
  });

  const disambiguators = computed(() => disambiguatorMap(orderedRepos()));

  const vvRepoByPath = computed(() => {
    const map = new Map<string, VvRepo>();
    for (const r of vvRepos()) map.set(normPath(r.path), r);
    return map;
  });

  const detailRepo = computed(() =>
    buildRepoDetailTarget({
      path: detailRepoPath(),
      orderedRepos: orderedRepos(),
      vvRepoByPath: vvRepoByPath(),
      issues: issues(),
      sessions: sessions(),
    }),
  );

  const treeCtx: SidebarTreeCtx = {
    hoveredKey: () => hoveredKey(),
    setHoveredKey: (key) => hoveredKey.set(key),
    openMenuKey: () => openMenuKey(),
    setOpenMenuKey: (key) => openMenuKey.set(key),
    sweepPhase: () => sweepPhase(),
    engineLogoSrc,
    isRepoExpanded,
    isGroupExpanded,
    setFold,
    toggleFold,
    openRepoDetail: (path) => detailRepoPath.set(path),
  };

  return (
    <View testID="workspace-sidebar" class="flex-1 bg-side">
      <If when={sweepActive()}>
        <SweepTicker onTick={() => sweepPhase.set(!untracked(sweepPhase))} />
      </If>
      <If
        when={detailRepo()}
        else={
          <>
            <View desktop={{ windowDrag: true }} class="h-9 flex-row items-center justify-between gap-1.5 border-b border-line px-2">
              <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
                {/* Uses the supported `palette_select` host action (`sidebar.toggle` -> `Shell::toggle_sidebar`). */}
                <SidebarHeaderButton
                  testID="sidebar-toggle"
                  icon="sidebar"
                  size={14}
                  label={t("web.shell.sidebar.toggleSidebar")}
                  tooltip={t("web.shell.sidebar.toggleSidebarTooltip")}
                  onPress={() => act({ type: "palette_select", id: "sidebar.toggle" })}
                />
                <Text class="min-w-0 truncate text-xs font-semibold text-ink">{t("web.shell.sidebar.title")}</Text>
              </View>
              <View class="shrink-0 flex-row items-center gap-1">
                <If when={hasFoldableItems()}>
                  <SidebarHeaderButton
                    testID="sidebar-fold-all"
                    icon={anyExpanded() ? "collapseAll" : "expandAll"}
                    size={13}
                    label={anyExpanded() ? t("web.shell.sidebar.collapseAll") : t("web.shell.sidebar.expandCurrent")}
                    tooltip={anyExpanded() ? t("web.shell.sidebar.collapseAllTooltip") : t("web.shell.sidebar.expandCurrentTooltip")}
                    onPress={toggleCollapseAll}
                  />
                </If>
                <ShellIconButton
                  icon="folder"
                  size={13}
                  label={t("web.shell.sidebar.addRepo")}
                  tooltip={t("web.shell.sidebar.addRepoTooltip")}
                  onPress={() => act({ type: "add_project" })}
                />
              </View>
            </View>

            <Scroll
              class="flex-1"
              contentClass="gap-0.5 px-2 py-1.5"
              onMouseLeave={() => {
                if (hoveredKey() !== null) hoveredKey.set(null);
              }}
            >
              <Each of={orderedRepos()} key={(repo) => repo.path}>
                {(repo) => <RepoNodeRow repo={repo()} parentHint={disambiguators().get(repo().path)} ctx={treeCtx} />}
              </Each>
            </Scroll>
          </>
        }
      >
        {(repo) => <RepoDetailPanel repo={repo()} onClose={() => detailRepoPath.set(null)} />}
      </If>
    </View>
  );
}
