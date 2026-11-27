// Source control split into three focused views:
//   - "changes": commit box, conflicts, staged & unstaged file diffs
//   - "branches": current branch, local branches (click to checkout) & worktrees
//   - "commits": commit history log (click to open commit diff)
import { computed, effect, keymap, Scroll, signal, Text, untracked, View } from "nsh";
import { Button } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { sessionIssueId, sessionWorktree } from "@vibevalley/protocol/rules";

import { Icon } from "../design/Icon";
import { motionClass } from "../design/motion";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../design/Skeleton";
import { Bubble } from "../design/Tip";
import { act, sliceFrame } from "../infra/bridge";
import { PanelEmpty, SectionHead, ShellIconButton } from "./chrome";
import { BranchesTab } from "./git/BranchesTab";
import { ChangesTab } from "./git/ChangesTab";
import { CommitsTab } from "./git/CommitsTab";
import { gitFrameSchema, normWtPath, type GitFrame, type GitTab, type GitWorktree, type GitWorktreeMeta, type WorktreesSectionCtx } from "./git/model";

export { gitFrameSchema, type GitFrame, type GitTab, type GitWorktree };

export function GitPanel(props: { frame: GitFrame | null; tab?: GitTab }) {
  const message = signal("");
  const localTab = signal<GitTab>("changes");
  const folded = signal<Record<string, boolean>>({});
  const pendingRemove = signal<string | null>(null);
  const removing = signal<{ path: string; label: string } | null>(null);
  const removeError = signal<{ path: string; text: string } | null>(null);
  const removeNotice = signal<string | null>(null);
  const addingWt = signal(false);
  const newBranch = signal("");
  const creatingWt = signal(false);
  const committing = signal(false);
  const commitNotice = signal<string | null>(null);
  const commitFocused = signal(false);
  const fileQuery = signal("");
  const branchQuery = signal("");
  const switchingBranch = signal<string | null>(null);

  const board = sliceFrame("board");
  const sessionsSlice = sliceFrame("sessions");
  const activeTab = () => props.tab ?? localTab();
  const f = () => props.frame;
  const isOpen = (key: string) => !folded()[key];
  const toggleSection = (key: string) => folded.update((prev) => ({ ...prev, [key]: !prev[key] }));
  const ensureOpen = (key: string) => {
    if (folded()[key]) folded.update((prev) => ({ ...prev, [key]: false }));
  };

  const worktreeMetaMap = computed(() => {
    const map = new Map<string, GitWorktreeMeta>();
    const issuesById = new Map((board()?.issues ?? []).map((i) => [i.id, i]));
    for (const session of sessionsSlice()?.sessions ?? []) {
      if (session.phase._tag === "closed") continue;
      const target = normWtPath(sessionWorktree(session));
      if (!target || map.has(target)) continue;
      const iid = sessionIssueId(session);
      const issue = iid ? issuesById.get(iid) : undefined;
      const running = session.phase._tag === "working";
      const parts = [issue ? `#${issue.number} ${issue.title}` : session.name, running ? t("web.shell.git.wtRunning") : ""].filter(Boolean);
      map.set(target, { badge: parts.join(" · "), running });
    }
    return map;
  });
  const worktreeMeta = (path: string): GitWorktreeMeta => worktreeMetaMap().get(normWtPath(path)) ?? { badge: null, running: false };

  let createWtStartFrame: GitFrame | null = null;
  const submitNewWorktree = () => {
    const branch = newBranch().trim();
    if (!branch || creatingWt()) return;
    createWtStartFrame = untracked(f);
    creatingWt.set(true);
    act({ type: "add_worktree", branch });
    newBranch.set("");
    addingWt.set(false);
  };
  effect(() => {
    const frameVal = f();
    if (!frameVal || frameVal === createWtStartFrame) return;
    if (creatingWt() && frameVal.busy !== true) {
      creatingWt.set(false);
      createWtStartFrame = null;
    }
  });

  const startRemove = (w: GitWorktree, force: boolean) => {
    pendingRemove.set(null);
    removeError.set(null);
    removeNotice.set(null);
    removing.set({ path: w.path, label: w.branch ?? w.path.split("/").pop() ?? w.path });
    act({ type: "remove_worktree", path: w.path, force });
  };
  effect(() => {
    const cur = removing();
    const frameVal = f();
    if (!cur || !frameVal) return;
    const stillPresent = (frameVal.worktrees ?? []).some((w) => w.path === cur.path);
    if (!stillPresent) {
      removing.set(null);
      removeError.set(null);
      removeNotice.set(t("web.shell.git.removedWorktree", { label: cur.label }));
      return;
    }
    if (frameVal.busy !== true && frameVal.error) {
      removing.set(null);
      removeError.set({ path: cur.path, text: frameVal.error });
    }
  });
  effect(() => {
    const notice = removeNotice();
    if (!notice) return;
    const timer = setTimeout(() => {
      if (untracked(removeNotice) === notice) removeNotice.set(null);
    }, 3000);
    return () => clearTimeout(timer);
  });

  let commitStartFrame: GitFrame | null = null;
  const commit = () => {
    const text = message().trim();
    if (!text || committing()) return;
    commitStartFrame = untracked(f);
    committing.set(true);
    commitNotice.set(null);
    act({ type: "commit", message: text });
  };
  effect(() => {
    const frameVal = f();
    if (!frameVal || frameVal === commitStartFrame) return;
    if (committing() && frameVal.busy !== true) {
      committing.set(false);
      commitStartFrame = null;
      if (!frameVal.error && (frameVal.staged?.length ?? 0) === 0) {
        message.set("");
        commitNotice.set(t("web.shell.git.commitSuccess"));
      }
    }
  });
  effect(() => {
    const notice = commitNotice();
    if (!notice) return;
    const timer = setTimeout(() => {
      if (untracked(commitNotice) === notice) commitNotice.set(null);
    }, 2500);
    return () => clearTimeout(timer);
  });
  effect(() => {
    const target = switchingBranch();
    const frameVal = f();
    if (!target || !frameVal) return;
    if (frameVal.branch === target || (frameVal.busy !== true && frameVal.error)) {
      switchingBranch.set(null);
    }
  });

  const stagedCount = computed(() => f()?.staged?.length ?? 0);
  const changesCount = computed(() => f()?.changes?.length ?? 0);
  const conflictsCount = computed(() => f()?.conflicts?.length ?? 0);
  const worktreesCount = computed(() => f()?.worktrees?.length ?? 0);
  const branchesCount = computed(() => f()?.branches?.length ?? 0);
  const canCreate = computed(() => newBranch().trim() !== "" && !creatingWt());
  const canCommit = computed(() => !committing() && stagedCount() > 0 && message().trim() !== "");
  const changedCount = computed(() => stagedCount() + changesCount() + conflictsCount());
  const branchLabel = computed(() => f()?.branch ?? `detached ${f()?.head ?? ""}`);

  effect(() => {
    if (!commitFocused() || !canCommit()) return;
    return keymap.bind("mod+enter", () => commit(), { when: "always" });
  });

  const subTabs: readonly { readonly id: GitTab; readonly label: () => string }[] = [
    {
      id: "changes",
      label: () => (changedCount() > 0 ? t("web.shell.git.tab.changesCount", { count: changedCount() }) : t("web.shell.git.tab.changes")),
    },
    { id: "branches", label: () => t("web.shell.git.tab.branches", { count: branchesCount() }) },
    { id: "commits", label: () => t("web.shell.git.tab.commits") },
  ];

  const worktreesCtx: WorktreesSectionCtx = {
    worktrees: () => f()?.worktrees ?? [],
    worktreesCount,
    isOpen,
    toggleSection,
    ensureOpen,
    addingWt,
    setAddingWt: (next) => addingWt.set(next),
    newBranch,
    setNewBranch: (value) => newBranch.set(value),
    creatingWt,
    canCreate,
    submitNewWorktree,
    worktreeMeta,
    pendingRemove,
    setPendingRemove: (path) => pendingRemove.set(path),
    removingPath: () => removing()?.path ?? null,
    removeError,
    removeNotice,
    startRemove,
  };

  const isRepo = computed(() => f()?.repo === true);
  const isLoadingGit = computed(() => !f() || (f()?.repo !== true && f()?.busy === true));
  const showGitSkeleton = useDelayedBusy(isLoadingGit);

  return (
    <View class="flex-1">
      <If
        when={isRepo()}
        else={
          <View class="flex-1">
            <SectionHead title={t("web.shell.git.title")} borderBottom />
            <If when={isLoadingGit()} else={<PanelEmpty text={f()?.error ?? t("web.shell.git.notRepo")} />}>
              <If when={showGitSkeleton()} else={<View class="flex-1" />}>
                <View testID="git-panel-skeleton" accessibilityLabel={t("web.shell.git.loading")} accessibilityState={{ busy: true }} class="gap-2.5 px-3 py-3">
                  <SkeletonBar surface="side" class="h-7 w-full rounded-md" />
                  <SkeletonLines surface="side" rows={["52%", "76%", "64%", "44%"]} />
                </View>
              </If>
            </If>
          </View>
        }
      >
        <View class="flex-1">
          <View class="h-7.5 flex-row items-center gap-1.5 border-b border-line pr-2 pl-3">
            <View class="size-3.5 shrink-0 items-center justify-center">
              <Icon name="branch" size={12} tone="muted" />
            </View>
            <View class="min-w-0 flex-1" tooltip={<Bubble text={branchLabel()} />}>
              <Text class="truncate font-mono text-xs font-medium text-ink">{branchLabel()}</Text>
            </View>
            <If when={(f()?.ahead ?? 0) > 0}>
              <View class="shrink-0 flex-row items-center gap-0.5">
                <Icon name="moveUp" size={10} tone="leaf" />
                <Text class="font-mono text-2xs font-medium text-leaf">{f()?.ahead}</Text>
              </View>
            </If>
            <If when={(f()?.behind ?? 0) > 0}>
              <View class="shrink-0 flex-row items-center gap-0.5">
                <Icon name="moveDown" size={10} tone="warn-ink" />
                <Text class="font-mono text-2xs font-medium text-warn-ink">{f()?.behind}</Text>
              </View>
            </If>
            <ShellIconButton label={t("web.shell.git.refresh")} icon="refresh" onPress={() => act({ type: "refresh_git" })} />
          </View>

          {/* Sub-navigation when not driven by parent header */}
          <If when={props.tab === undefined}>
            <View class="flex-row gap-1 border-b border-line px-2.5 py-1.5">
              <Each of={subTabs} key={(item) => item.id}>
                {(item) => {
                  const cur = () => activeTab() === item().id;
                  return (
                    <Button
                      onPress={() => localTab.set(item().id)}
                      class={`h-6 flex-1 items-center justify-center rounded-md ${motionClass("transition-opacity duration-120 ease-out")} active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus ${
                        cur() ? "bg-selected" : "bg-transparent hover:bg-hover"
                      }`}
                    >
                      <Text class={`text-2xs font-medium ${cur() ? "text-ink" : "text-muted"}`}>{item().label()}</Text>
                    </Button>
                  );
                }}
              </Each>
            </View>
          </If>

          <Scroll class="flex-1">
            <If when={activeTab() === "changes"}>
              <ChangesTab
                frame={f()}
                worktreesCtx={worktreesCtx}
                message={message()}
                onMessageChange={(v) => message.set(v)}
                onCommitFocusChange={(focused) => commitFocused.set(focused)}
                committing={committing()}
                canCommit={canCommit()}
                onCommit={commit}
                commitNotice={commitNotice()}
                fileQuery={fileQuery()}
                onFileQueryChange={(v) => fileQuery.set(v)}
                isOpen={isOpen}
                toggleSection={toggleSection}
              />
            </If>

            <If when={activeTab() === "branches"}>
              <BranchesTab
                frame={f()}
                branchQuery={branchQuery()}
                onBranchQueryChange={(v) => branchQuery.set(v)}
                switchingBranch={switchingBranch()}
                onSwitchBranch={(branch) => switchingBranch.set(branch)}
                isOpen={isOpen}
                toggleSection={toggleSection}
                worktreesCtx={worktreesCtx}
              />
            </If>

            <If when={activeTab() === "commits"}>
              <CommitsTab frame={f()} isOpen={isOpen} toggleSection={toggleSection} />
            </If>
            <View class="h-4" />
          </Scroll>
        </View>
      </If>
    </View>
  );
}
