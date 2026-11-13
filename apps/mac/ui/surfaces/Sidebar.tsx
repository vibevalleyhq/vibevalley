// The workspace sidebar (`host.params.contextual === true`):
//   Left tree: Open Repos -> (Worktree groups when >1, else flat) -> Terminal Tabs
//              (highlighting tabs where codex/claude/opencode is running).
//   Right inspector (`host.params.role === "inspector"`): Files, Git changes, Agents.
import { effect, host, Image, Scroll, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import { act, call, frame, frameRev, hostApi } from "../bridge";
import type { Decision } from "../components/DecisionInbox";
import { radius, tok, type as ty } from "../tokens";
import { AgentsPanel, type AgentsFrame } from "./AgentsPanel";
import { FileTree, type FilesFrame } from "./FileTree";
import { GitPanel, type GitFrame, type GitTab } from "./GitPanel";
import { ProjectRail, type RailFrame, type RailProject, type RailTab } from "./ProjectRail";

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
  name: string;
  path: string;
  branch?: string | null;
  active: boolean;
  groups: WorktreeGroup[];
  /** One of VibeValley's repos (repo.list), not a folder opened for its terminals. */
  vibevalley: boolean;
};

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

export function Sidebar() {
  const rail = frame<RailFrame>("rail");
  const files = frame<FilesFrame>("files");
  const git = frame<GitFrame>("git");
  const agents = frame<AgentsFrame>("agents");
  const inbox = frame<{ entries: Decision[] }>("inbox");
  const vvState = frame<VvStateFrame>("state");
  const vvRev = frameRev("state");
  const vvRepos = signal<VvRepo[]>([]);
  const pixelDir = signal<string | undefined>(typeof host.params.pixelDir === "string" ? host.params.pixelDir : undefined);

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
  const panel = () => rail()?.panel ?? "files";
  const waiting = () => inbox()?.entries.length ?? 0;

  const spriteSrc = (name: string | undefined) => {
    const dir = pixelDir();
    return dir && name ? `file://${encodeURI(`${dir}/${name}.png`)}` : undefined;
  };

  // ---- Right-side Inspector (Files / Diff / Branch / History) ------------
  const gitTab = signal<GitTab>("changes");
  if (host.params.role === "inspector") {
    const gitCount = () => (git()?.staged?.length ?? 0) + (git()?.changes?.length ?? 0) + (git()?.conflicts?.length ?? 0);
    const currentView = () => (panel() === "git" ? `git:${gitTab()}` : panel());
    return (
      <View style={{ flex: 1, backgroundColor: p().canvas }}>
        <View
          style={{
            height: 36,
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 8,
            gap: 4,
            borderBottomWidth: 1,
            borderBottomColor: p().border,
          }}
        >
          {[
            { id: "files", label: "文件", onSelect: () => act({ type: "show_panel", panel: "files" }) },
            {
              id: "git:changes",
              label: gitCount() > 0 ? `Diff (${gitCount()})` : "Diff",
              onSelect: () => {
                gitTab.set("changes");
                if (panel() !== "git") act({ type: "show_panel", panel: "git" });
              },
            },
            {
              id: "git:branches",
              label: "Branch",
              onSelect: () => {
                gitTab.set("branches");
                if (panel() !== "git") act({ type: "show_panel", panel: "git" });
              },
            },
            {
              id: "git:commits",
              label: "Commits",
              onSelect: () => {
                gitTab.set("commits");
                if (panel() !== "git") act({ type: "show_panel", panel: "git" });
              },
            },
          ].map((item) => {
            const isCur = currentView() === item.id;
            return (
              <Button
                onPress={item.onSelect}
                style={{
                  height: 24,
                  paddingHorizontal: 8,
                  borderRadius: radius.sm,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: isCur ? p().subtle : "transparent",
                }}
              >
                <Text style={{ fontSize: 11.5, fontWeight: isCur ? "600" : "400", color: isCur ? p().ink : p().muted }}>{item.label}</Text>
              </Button>
            );
          })}
        </View>
        {panel() === "files" ? <FileTree frame={files()} /> : null}
        {panel() === "git" ? <GitPanel frame={git()} tab={gitTab()} /> : null}
        {panel() === "agents" ? <AgentsPanel agents={agents()} inbox={inbox()} /> : null}
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
          {panel() === "agents" ? <AgentsPanel agents={agents()} inbox={inbox()} /> : null}
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
      // Only terminals that are open get a row: a repo with none shows its header alone.
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
        name: root.name,
        path: root.path,
        branch: mainProj?.branch,
        active: repoActive,
        groups: allGroups,
        vibevalley: vvPaths.has(root.path),
      };
    });
  };

  /** VibeValley's repos first; folders opened only for their terminals after them. */
  const sections = (): { title: string; repos: RepoNode[] }[] => {
    const all = repoTree();
    const own = all.filter((r) => r.vibevalley);
    const other = all.filter((r) => !r.vibevalley);
    if (own.length === 0 || other.length === 0) return [{ title: "", repos: all }];
    return [
      { title: "", repos: own },
      { title: "其他文件夹", repos: other },
    ];
  };

  const renderTabRow = (group: WorktreeGroup, tab: RailTab, indent: number) => {
    const isSelected = group.active && tab.active;
    const runningAgent = tab.runningAgent || (group.sessionRunning ? group.sessionAgent : undefined);
    const isRunning = Boolean(tab.running || group.sessionRunning);
    const logoSrc = spriteSrc(runtimeLogoOf(runningAgent));
    const runText = runningAgent && runningAgent !== "cmd" ? `${runningAgent} 正在运行` : "正在运行";
    return (
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          height: 30,
          paddingLeft: indent,
          paddingRight: 6,
          borderRadius: radius.sm,
          backgroundColor: isSelected ? p().subtle : "transparent",
          gap: 6,
        }}
      >
        <Button
          onPress={() => act({ type: "activate_tab", path: group.path, tab_id: tab.id })}
          style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, height: 30 }}
        >
          {logoSrc ? (
            <Image src={logoSrc} style={{ width: 14, height: 14, objectFit: "contain" }} />
          ) : (
            <Text style={{ ...ty.mono, fontSize: 11, color: isRunning ? p().ok : isSelected ? p().ink : p().muted }}>
              {tab.kind === "diff" ? "⑂" : tab.kind === "file" ? "▤" : ">_"}
            </Text>
          )}
          <Text
            style={{
              fontSize: 12.5,
              fontWeight: isSelected ? "600" : "400",
              color: isSelected ? p().ink : p().text,
              flex: 1,
              numberOfLines: 1,
            }}
          >
            {tab.title}
          </Text>
          {isRunning ? (
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 999,
                backgroundColor: p().tile,
                borderWidth: 1,
                borderColor: p().ok,
              }}
            >
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p().ok }} />
              <Text style={{ fontSize: 10.5, fontWeight: "600", color: p().ok }}>{runText}</Text>
            </View>
          ) : tab.attention ? (
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p().alert }} />
          ) : null}
        </Button>
        {tab.kind === "terminal" || group.tabs.length > 1 ? (
          <Button
            onPress={() => act({ type: "close_tab_at", path: group.path, tab_id: tab.id })}
            accessibilityLabel={`关闭 ${tab.title}`}
            style={{ width: 18, height: 18, borderRadius: 4, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ fontSize: 12, color: p().muted }}>×</Text>
          </Button>
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
          paddingHorizontal: 12,
          borderBottomWidth: 1,
          borderBottomColor: p().border,
        }}
      >
        <Text style={{ ...ty.label, fontSize: 12, fontWeight: "600", color: p().ink }}>仓库与终端</Text>
        <Button
          onPress={() => act({ type: "add_project" })}
          accessibilityLabel="添加仓库"
          style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.sm, backgroundColor: p().tile }}
        >
          <Text style={{ fontSize: 11.5, color: p().text }}>＋ 仓库</Text>
        </Button>
      </View>

      <Scroll style={{ flex: 1 }}>
        <View style={{ padding: 8, gap: 10 }}>
          {sections().map((section) => (
            <View style={{ gap: 6 }}>
              {section.title ? (
                <Text style={{ ...ty.label, fontSize: 11, fontWeight: "600", color: p().muted, paddingHorizontal: 10, paddingTop: 6 }}>{section.title}</Text>
              ) : null}
              {section.repos.map((repo) => {
                const hasMultipleWorktrees = repo.groups.length > 1;
                const plotSrc = spriteSrc(repo.active ? "plot-flowering" : "plot-leafy");
                return (
                  <View
                    style={{
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: repo.active ? p().border : "transparent",
                      backgroundColor: repo.active ? p().surface : "transparent",
                      paddingVertical: 6,
                      paddingHorizontal: 6,
                      gap: 4,
                    }}
                  >
                    {/* Repo Header */}
                    <View style={{ flexDirection: "row", alignItems: "center", paddingHorizontal: 4, height: 26, gap: 6 }}>
                      <Button
                        onPress={() => act({ type: "activate_path", path: repo.path })}
                        style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6, height: 26 }}
                      >
                        {plotSrc ? <Image src={plotSrc} style={{ width: 15, height: 15, objectFit: "contain" }} /> : null}
                        <Text style={{ fontSize: 13, fontWeight: "600", color: p().ink, flex: 1, numberOfLines: 1 }}>{repo.name}</Text>
                        {!hasMultipleWorktrees && repo.branch ? <Text style={{ ...ty.mono, fontSize: 11, color: p().muted }}>⑂ {repo.branch}</Text> : null}
                      </Button>
                      <Button
                        onPress={() => act({ type: "new_terminal_at", path: repo.path })}
                        accessibilityLabel={`新终端：${repo.name}`}
                        style={{ width: 22, height: 22, borderRadius: 5, alignItems: "center", justifyContent: "center" }}
                      >
                        <Text style={{ fontSize: 14, color: p().muted }}>＋</Text>
                      </Button>
                    </View>

                    {/* Default case: no extra worktrees -> render terminal tabs directly under Repo */}
                    {!hasMultipleWorktrees ? (
                      <View style={{ gap: 2 }}>{(repo.groups[0]?.tabs ?? []).map((tab) => renderTabRow(repo.groups[0]!, tab, 12))}</View>
                    ) : (
                      /* Multiple worktrees -> render each worktree as a group with its terminal tabs */
                      <View style={{ gap: 6, paddingLeft: 6 }}>
                        {repo.groups.map((group) => (
                          <View style={{ gap: 2 }}>
                            <View style={{ flexDirection: "row", alignItems: "center", height: 24, paddingHorizontal: 6, gap: 6 }}>
                              <Button
                                onPress={() => act({ type: "activate_path", path: group.path })}
                                style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 5, height: 24 }}
                              >
                                <Text style={{ ...ty.mono, fontSize: 11, color: group.active ? p().ink : p().muted }}>⑂</Text>
                                <Text
                                  style={{
                                    fontSize: 12,
                                    fontWeight: group.active ? "600" : "500",
                                    color: group.active ? p().ink : p().muted,
                                    flex: 1,
                                    numberOfLines: 1,
                                  }}
                                >
                                  {group.isMain ? `${group.label} · 主目录` : group.label}
                                </Text>
                              </Button>
                              <Button
                                onPress={() => act({ type: "new_terminal_at", path: group.path })}
                                accessibilityLabel={`新终端：${group.label}`}
                                style={{ width: 20, height: 20, borderRadius: 4, alignItems: "center", justifyContent: "center" }}
                              >
                                <Text style={{ fontSize: 13, color: p().muted }}>＋</Text>
                              </Button>
                            </View>
                            <View style={{ gap: 2 }}>{group.tabs.map((tab) => renderTabRow(group, tab, 18))}</View>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </Scroll>
    </View>
  );
}
