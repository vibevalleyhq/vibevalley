// Source control split into three focused views:
//   - "changes": commit box, conflicts, staged & unstaged file diffs
//   - "branches": current branch, local branches (click to checkout) & worktrees
//   - "commits": commit history log (click to open commit diff)
import { Clipboard, computed, effect, Scroll, signal, Text, untracked, View, type TextStyle } from "nsh";
import { Button, ContextMenu, Input, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { BoardSlice, SessionsSlice } from "@vibevalley/protocol";
import { sessionIssueId, sessionWorktree } from "@vibevalley/protocol/rules";

import { Button as DesignButton } from "../design/Button";
import { Icon } from "../design/Icon";
import { ActiveBar } from "../design/layout";
import { motionClass } from "../design/motion";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../design/Skeleton";
import { Bubble } from "../design/Tip";
import { mix } from "../design/tone";
import { act, frame, hostApi } from "../infra/bridge";
import {
  gitToneTextClass,
  menuDangerItemClass,
  menuItemClass,
  menuPopupClass,
  menuSeparatorClass,
  PanelEmpty,
  SectionHead,
  ShellIconButton,
  startEllipsis,
} from "./chrome";

const autoDirection: TextStyle = { writingDirection: "auto" };

export type GitRow = { path: string; code: string; tone: string };
export type GitWorktree = {
  path: string;
  branch: string | null;
  main: boolean;
  locked: boolean;
  current?: boolean;
  changed?: number;
  conflicts?: number;
  ahead?: number;
  behind?: number;
  summary?: string | null;
};
export type GitFrame = {
  repo: boolean;
  error?: string | null;
  busy?: boolean;
  branch?: string | null;
  head?: string | null;
  upstream?: string | null;
  ahead?: number;
  behind?: number;
  staged?: GitRow[];
  changes?: GitRow[];
  conflicts?: GitRow[];
  branches?: { name: string; head: boolean; upstream: string | null }[];
  worktrees?: GitWorktree[];
  log?: { id: string; short: string; summary: string; author: string; time: number }[];
};

export type GitTab = "changes" | "branches" | "commits";

function formatCommitTime(epochSec: number): string {
  const nowSec = Math.floor(Date.now() / 1000);
  const diff = nowSec - epochSec;
  if (diff >= 0 && diff < 60) return t("web.shell.git.justNow");
  if (diff >= 60 && diff < 3600) return t("web.shell.git.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff >= 3600 && diff < 86400) return t("web.shell.git.hoursAgo", { n: Math.floor(diff / 3600) });
  if (diff >= 86400 && diff < 86400 * 7) return t("web.shell.git.daysAgo", { n: Math.floor(diff / 86400) });
  const d = new Date(epochSec * 1000);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  if (d.getFullYear() === new Date().getFullYear()) return `${mm}-${dd}`;
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function FileRow(props: { row: GitRow; staged: boolean }) {
  const hovered = signal(false);
  const confirmingDiscard = signal(false);
  const name = () => props.row.path.split("/").pop() ?? props.row.path;
  const dir = () => props.row.path.slice(0, Math.max(0, props.row.path.length - name().length - 1));
  const showActions = () => hovered() || confirmingDiscard();
  return (
    <View
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      class={`mx-1.5 h-6.5 flex-row items-center gap-1 rounded-md px-1.5 ${showActions() ? "bg-hover" : "bg-transparent"}`}
    >
      <Button
        onPress={() => {
          confirmingDiscard.set(false);
          act({ type: "open_diff", path: props.row.path, staged: props.staged });
        }}
        accessibilityLabel={`Open diff of ${props.row.path}`}
        tooltip={<Bubble text={props.row.path} />}
        class="h-6.5 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Text class={`shrink truncate text-sm ${gitToneTextClass(props.row.tone)}`}>{name()}</Text>
        <If when={dir()}>
          {(d) => (
            <Text class="min-w-0 flex-1 truncate text-2xs text-muted" style={startEllipsis}>
              {d()}
            </Text>
          )}
        </If>
      </Button>
      <If
        when={confirmingDiscard()}
        else={
          <If when={hovered()}>
            <View class="shrink-0 flex-row items-center gap-0.5">
              <If
                when={props.staged}
                else={
                  <>
                    <ShellIconButton
                      compact
                      danger
                      icon="undo"
                      label={t("web.shell.git.discardPath", { path: props.row.path })}
                      onPress={() => confirmingDiscard.set(true)}
                    />
                    <ShellIconButton
                      compact
                      icon="add"
                      label={t("web.shell.git.stagePath", { path: props.row.path })}
                      onPress={() => act({ type: "stage", paths: [props.row.path] })}
                    />
                  </>
                }
              >
                <ShellIconButton
                  compact
                  icon="minus"
                  label={t("web.shell.git.unstagePath", { path: props.row.path })}
                  onPress={() => act({ type: "unstage", paths: [props.row.path] })}
                />
              </If>
            </View>
          </If>
        }
      >
        <View class="shrink-0 flex-row items-center gap-1">
          <Button
            onPress={() => {
              confirmingDiscard.set(false);
              act({ type: "discard", paths: [props.row.path] });
            }}
            class={`h-5 justify-center rounded-sm bg-berry px-1.5 ${motionClass("transition-opacity duration-120 ease-out")} active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Text class="text-2xs font-medium text-page">{t("web.shell.git.confirmDiscard")}</Text>
          </Button>
          <Button
            onPress={() => confirmingDiscard.set(false)}
            class={`h-5 justify-center rounded-sm bg-selected px-1.5 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Text class="text-2xs text-ink">{t("web.shell.git.cancel")}</Text>
          </Button>
        </View>
      </If>
      <Text class={`w-4 shrink-0 text-center font-mono text-2xs font-semibold ${gitToneTextClass(props.row.tone)}`}>{props.row.code}</Text>
    </View>
  );
}

function normWtPath(p: string | undefined): string {
  if (!p) return "";
  return p.replace(/\/+$/u, "") || "/";
}

function WorktreeRow(props: {
  w: GitWorktree;
  badge?: string | null;
  running?: boolean;
  pendingRemove: () => string | null;
  setPendingRemove: (path: string | null) => void;
  removingPath: () => string | null;
  removeError: () => { path: string; text: string } | null;
  onConfirmRemove: (w: GitWorktree, force: boolean) => void;
}) {
  const w = () => props.w;
  const dirty = () => (w().changed ?? 0) > 0 || (w().conflicts ?? 0) > 0;
  const confirming = () => props.pendingRemove() === w().path;
  const isRemoving = () => props.removingPath() === w().path;
  const rowError = () => {
    const err = props.removeError();
    return err && err.path === w().path ? err.text : null;
  };
  const trigger = (
    <View
      class={`relative gap-1 border-b border-line px-3 py-2 ${motionClass("transition-opacity duration-120 ease-out")} ${w().current === true ? "bg-selected" : "bg-transparent hover:bg-hover"} ${isRemoving() ? "opacity-60" : ""}`}
    >
      <If when={w().current === true}>
        <ActiveBar />
      </If>
      <Button
        disabled={isRemoving()}
        onPress={() => {
          props.setPendingRemove(null);
          act({ type: "activate_path", path: w().path });
        }}
        tooltip={<Bubble text={w().path} />}
        class="gap-1 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
      >
        <View class="min-h-5 flex-row items-center gap-2">
          <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
            <View class="size-3.5 shrink-0 items-center justify-center">
              <Icon name="branch" size={12} tone={w().current === true ? "ink" : "muted"} />
            </View>
            <Text class="min-w-0 shrink truncate font-mono text-xs font-medium text-ink">{w().branch ?? "(detached)"}</Text>
            <If when={w().main}>
              <View
                class={`h-4 shrink-0 items-center justify-center rounded-sm border border-line px-1.5 ${w().current === true ? "bg-elevated" : "bg-hover"}`}
              >
                <Text class="text-2xs text-muted">{t("web.shell.git.mainLabel")}</Text>
              </View>
            </If>
            <If when={w().locked}>
              <Icon name="lock" size={11} tone="faint" />
            </If>
          </View>
          <View class="shrink-0 flex-row items-center gap-1.5">
            <If
              when={isRemoving()}
              else={
                <>
                  <If when={(w().ahead ?? 0) > 0}>
                    <View class="flex-row items-center gap-0.5">
                      <Icon name="moveUp" size={10} tone="leaf" />
                      <Text class="font-mono text-2xs font-medium text-leaf">{w().ahead}</Text>
                    </View>
                  </If>
                  <If when={(w().behind ?? 0) > 0}>
                    <View class="flex-row items-center gap-0.5">
                      <Icon name="moveDown" size={10} tone="warn-ink" />
                      <Text class="font-mono text-2xs font-medium text-warn-ink">{w().behind}</Text>
                    </View>
                  </If>
                  <If
                    when={(w().conflicts ?? 0) > 0}
                    else={
                      <If
                        when={(w().changed ?? 0) > 0}
                        else={
                          <View class={`h-4.5 items-center justify-center rounded-sm px-1.5 ${w().current === true ? "bg-elevated" : "bg-hover"}`}>
                            <Text class="text-2xs text-muted">{t("web.shell.git.wtClean")}</Text>
                          </View>
                        }
                      >
                        <View class="h-4.5 items-center justify-center rounded-sm border bg-warn-soft px-1.5" style={{ borderColor: mix("wheat", 0.25) }}>
                          <Text class="text-2xs font-medium text-warn-ink">{t("web.shell.git.wtChangedCount", { n: w().changed ?? 0 })}</Text>
                        </View>
                      </If>
                    }
                  >
                    <View class="h-4.5 items-center justify-center rounded-sm border bg-bad-soft px-1.5" style={{ borderColor: mix("berry", 0.25) }}>
                      <Text class="text-2xs font-medium text-berry">{t("web.shell.git.wtConflictsCount", { n: w().conflicts ?? 0 })}</Text>
                    </View>
                  </If>
                </>
              }
            >
              <Text class="text-2xs font-medium text-muted">{t("web.shell.git.removing")}</Text>
            </If>
          </View>
        </View>
        <If when={props.badge}>
          {(badge) => (
            <View class="flex-row items-center gap-1.5 pl-5">
              <View class={`size-1.5 shrink-0 rounded-full ${props.running === true ? "bg-leaf" : "bg-faint"}`} />
              <Text class={`min-w-0 flex-1 truncate text-2xs ${props.running === true ? "font-medium text-leaf" : "text-muted"}`}>{badge()}</Text>
            </View>
          )}
        </If>
        <If when={w().summary}>{(summary) => <Text class="truncate pl-5 text-xs text-ink">{summary()}</Text>}</If>
        <Text class="truncate pl-5 font-mono text-2xs text-faint" style={startEllipsis}>
          {w().path}
        </Text>
      </Button>
      <If when={confirming() && !isRemoving()}>
        <View class="flex-row items-center justify-end gap-1.5 pt-1">
          <Text class="text-2xs text-muted">{dirty() ? t("web.shell.git.wtDirtyPrompt") : t("web.shell.git.wtConfirmDeletePrompt")}</Text>
          <Button
            onPress={() => props.onConfirmRemove(w(), dirty())}
            class={`h-5.5 justify-center rounded-sm bg-berry px-2 ${motionClass("transition-opacity duration-120 ease-out")} active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Text class="text-2xs font-medium text-page">{dirty() ? t("web.shell.git.wtForceDelete") : t("web.shell.git.wtConfirmDelete")}</Text>
          </Button>
          <Button
            onPress={() => props.setPendingRemove(null)}
            class={`h-5.5 justify-center rounded-sm border border-line bg-hover px-2 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Text class="text-2xs text-ink">{t("web.shell.git.cancel")}</Text>
          </Button>
        </View>
      </If>
      <If when={rowError()}>{(err) => <Text class="pt-0.5 pl-5 text-2xs text-berry">{t("web.shell.git.removeFailed", { why: err() })}</Text>}</If>
    </View>
  );
  return (
    <ContextMenu trigger={trigger} popupClass={menuPopupClass}>
      <MenuItem onSelect={() => act({ type: "new_terminal_at", path: w().path })} class={menuItemClass}>
        <Text class="text-xs text-ink">{t("web.shell.sidebar.newTerminalHere")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void hostApi.reveal(w().path)} class={menuItemClass}>
        <Text class="text-xs text-ink">{t("web.shell.sidebar.revealInFinder")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void Clipboard.writeText(w().path)} class={menuItemClass}>
        <Text class="text-xs text-ink">{t("web.shell.sidebar.copyPath")}</Text>
      </MenuItem>
      <If when={!w().main}>
        <MenuSeparator class={menuSeparatorClass} />
        <MenuItem onSelect={() => props.setPendingRemove(w().path)} class={menuDangerItemClass}>
          <Text class="text-xs text-berry">{t("web.shell.git.wtRemoveMenu")}</Text>
        </MenuItem>
      </If>
    </ContextMenu>
  );
}

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
  const board = frame<BoardSlice>("slice:board");
  const sessionsSlice = frame<SessionsSlice>("slice:sessions");
  const activeTab = () => props.tab ?? localTab();
  const f = () => props.frame;
  const isOpen = (key: string) => !folded()[key];
  const toggleSection = (key: string) => folded.update((prev) => ({ ...prev, [key]: !prev[key] }));
  const ensureOpen = (key: string) => {
    if (folded()[key]) folded.update((prev) => ({ ...prev, [key]: false }));
  };

  const worktreeMetaMap = computed(() => {
    const map = new Map<string, { badge: string | null; running: boolean }>();
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
  const worktreeMeta = (path: string): { badge: string | null; running: boolean } => worktreeMetaMap().get(normWtPath(path)) ?? { badge: null, running: false };
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
  const committing = signal(false);
  const commitNotice = signal<string | null>(null);
  const branchQuery = signal("");
  const switchingBranch = signal<string | null>(null);
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
  const logCount = computed(() => f()?.log?.length ?? 0);
  const canCreate = computed(() => newBranch().trim() !== "" && !creatingWt());
  const canCommit = computed(() => !committing() && stagedCount() > 0 && message().trim() !== "");
  const changedCount = computed(() => stagedCount() + changesCount() + conflictsCount());
  const branchLabel = computed(() => f()?.branch ?? `detached ${f()?.head ?? ""}`);
  const filteredBranches = computed(() => {
    const q = branchQuery().trim().toLowerCase();
    return (f()?.branches ?? []).filter((b) => !q || b.name.toLowerCase().includes(q));
  });
  const subTabs: readonly { readonly id: GitTab; readonly label: () => string }[] = [
    {
      id: "changes",
      label: () => (changedCount() > 0 ? t("web.shell.git.tab.changesCount", { count: changedCount() }) : t("web.shell.git.tab.changes")),
    },
    { id: "branches", label: () => t("web.shell.git.tab.branches", { count: branchesCount() }) },
    { id: "commits", label: () => t("web.shell.git.tab.commits") },
  ];

  const renderWorktreesSection = (sectionKey: string, title: string, borderTop: boolean, showNotice: boolean) => (
    <View>
      <SectionHead
        title={title}
        count={worktreesCount()}
        collapsible
        expanded={isOpen(sectionKey)}
        onToggle={() => toggleSection(sectionKey)}
        borderTop={borderTop}
        borderBottom={isOpen(sectionKey) && worktreesCount() > 0 && !addingWt()}
        right={
          <Button
            onPress={() => {
              const next = !addingWt();
              addingWt.set(next);
              if (next) ensureOpen(sectionKey);
            }}
            accessibilityLabel={t("web.shell.git.newWorktree")}
            class={`h-5 flex-row items-center gap-1 rounded-md bg-hover px-1.5 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Icon name="add" size={10} tone="ink" />
            <Text class="text-2xs font-medium text-ink">{creatingWt() ? t("web.shell.git.creatingWorktree") : t("web.shell.git.createWorktreeBtn")}</Text>
          </Button>
        }
      />
      <If when={isOpen(sectionKey)}>
        <View>
          <If when={addingWt()}>
            <View class="flex-row items-center gap-1.5 border-b border-line px-3 pt-0.5 pb-2">
              <Input
                value={newBranch()}
                onChange={({ value }) => newBranch.set(value)}
                onSubmit={submitNewWorktree}
                placeholder={t("web.shell.git.newBranchPlaceholder")}
                class="h-6.5 flex-1 rounded-md border border-line bg-elevated px-2 text-xs text-ink placeholder:text-faint hover:border-faint focus:border-focus"
              />
              <Button
                onPress={submitNewWorktree}
                disabled={!canCreate()}
                class={`h-6.5 justify-center rounded-md border px-2.5 ${
                  !canCreate()
                    ? "border-line bg-hover"
                    : "border-accent bg-accent hover:bg-accent-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus"
                }`}
              >
                <Text class={`text-2xs font-medium ${!canCreate() ? "text-muted" : "text-page"}`}>{t("web.shell.git.createBtn")}</Text>
              </Button>
            </View>
          </If>
          <If when={showNotice ? removeNotice() : null}>
            {(notice) => (
              <View class="border-b border-line bg-ok-soft px-3 py-1.5">
                <Text class="text-2xs text-ok-ink">{notice()}</Text>
              </View>
            )}
          </If>
          <Each of={f()?.worktrees ?? []} key={(w) => w.path}>
            {(w) => {
              const meta = () => worktreeMeta(w().path);
              return (
                <WorktreeRow
                  w={w()}
                  badge={meta().badge}
                  running={meta().running}
                  pendingRemove={pendingRemove}
                  setPendingRemove={(path) => pendingRemove.set(path)}
                  removingPath={() => removing()?.path ?? null}
                  removeError={removeError}
                  onConfirmRemove={startRemove}
                />
              );
            }}
          </Each>
        </View>
      </If>
    </View>
  );

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
              <View>
                <If when={removeNotice()}>
                  {(notice) => (
                    <View class="border-b border-line bg-ok-soft px-3 py-1.5">
                      <Text class="text-2xs text-ok-ink">{notice()}</Text>
                    </View>
                  )}
                </If>
                <If when={worktreesCount() > 1}>{renderWorktreesSection("changes-worktrees", t("web.shell.git.worktrees"), false, false)}</If>
                <View class="gap-2 border-b border-line px-3 py-2.5">
                  <Input
                    value={message()}
                    onChange={({ value }) => message.set(value)}
                    placeholder={t("web.shell.git.commitPlaceholder")}
                    multiline
                    class="min-h-14 rounded-md border border-line bg-elevated px-2.5 py-1.5 text-xs leading-normal text-ink placeholder:text-faint hover:border-faint focus:border-focus"
                  />
                  <DesignButton tone="primary" class="px-3" disabled={!canCommit()} onPress={commit}>
                    {committing()
                      ? t("web.shell.git.committing")
                      : stagedCount() > 0
                        ? t("web.shell.git.commitStaged", { count: stagedCount() })
                        : t("web.shell.git.noStaged")}
                  </DesignButton>
                  <If when={stagedCount() === 0 && changesCount() > 0}>
                    <Button
                      onPress={() => act({ type: "stage", paths: (f()?.changes ?? []).map((r) => r.path) })}
                      class={`h-6.5 flex-row items-center justify-center gap-1 rounded-md border border-line bg-transparent px-2.5 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
                    >
                      <Icon name="add" size={11} tone="ink" />
                      <Text class="text-xs font-medium text-ink">{t("web.shell.git.stageAllCount", { count: changesCount().toLocaleString() })}</Text>
                    </Button>
                  </If>
                  <If when={commitNotice()}>{(notice) => <Text class="text-2xs text-ok-ink">{notice()}</Text>}</If>
                  <If when={f()?.error}>
                    {(err) => (
                      <View class="rounded-md border bg-bad-soft px-2 py-1.5" style={{ borderColor: mix("berry", 0.25) }}>
                        <Text class="text-2xs text-berry">{err()}</Text>
                      </View>
                    )}
                  </If>
                </View>

                <If when={conflictsCount() > 0}>
                  <View class="pb-1">
                    <SectionHead
                      title={t("web.shell.git.conflicts")}
                      count={conflictsCount()}
                      tone="danger"
                      collapsible
                      expanded={isOpen("conflicts")}
                      onToggle={() => toggleSection("conflicts")}
                    />
                    <If when={isOpen("conflicts")}>
                      <View class="gap-px">
                        <Each of={f()?.conflicts ?? []} key={(r) => r.path}>
                          {(row) => <FileRow row={row()} staged={false} />}
                        </Each>
                      </View>
                    </If>
                  </View>
                </If>

                <View class="pb-1">
                  <SectionHead
                    title={t("web.shell.git.staged")}
                    count={stagedCount()}
                    collapsible
                    expanded={isOpen("staged")}
                    onToggle={() => toggleSection("staged")}
                    borderTop={conflictsCount() > 0}
                    right={
                      <If when={stagedCount() > 0}>
                        <ShellIconButton
                          label={t("web.shell.git.unstageAll")}
                          icon="minus"
                          onPress={() => act({ type: "unstage", paths: (f()?.staged ?? []).map((r) => r.path) })}
                        />
                      </If>
                    }
                  />
                  <If when={isOpen("staged")}>
                    <If when={stagedCount() > 0} else={<PanelEmpty text={t("web.shell.git.stagedEmpty")} compact />}>
                      <View class="gap-px">
                        <Each of={f()?.staged ?? []} key={(r) => r.path}>
                          {(row) => <FileRow row={row()} staged />}
                        </Each>
                      </View>
                    </If>
                  </If>
                </View>

                <View class="pb-1">
                  <SectionHead
                    title={t("web.shell.git.changes")}
                    count={changesCount()}
                    collapsible
                    expanded={isOpen("changes")}
                    onToggle={() => toggleSection("changes")}
                    borderTop
                    right={
                      <If when={changesCount() > 0}>
                        <ShellIconButton
                          label={t("web.shell.git.stageAll")}
                          icon="add"
                          onPress={() => act({ type: "stage", paths: (f()?.changes ?? []).map((r) => r.path) })}
                        />
                      </If>
                    }
                  />
                  <If when={isOpen("changes")}>
                    <If when={changesCount() > 0} else={<PanelEmpty text={t("web.shell.git.clean")} compact />}>
                      <View class="gap-px">
                        <Each of={f()?.changes ?? []} key={(r) => r.path}>
                          {(row) => <FileRow row={row()} staged={false} />}
                        </Each>
                      </View>
                    </If>
                  </If>
                </View>
              </View>
            </If>

            <If when={activeTab() === "branches"}>
              <View>
                <View class="pb-1">
                  <SectionHead
                    title={t("web.shell.git.branches")}
                    count={branchesCount()}
                    collapsible
                    expanded={isOpen("branches")}
                    onToggle={() => toggleSection("branches")}
                  />
                  <If when={isOpen("branches")}>
                    <View>
                      <If when={branchesCount() > 6}>
                        <View class="px-3 pt-0.5 pb-1.5">
                          <Input
                            value={branchQuery()}
                            onChange={({ value }) => branchQuery.set(value)}
                            placeholder={t("web.shell.git.filterBranches")}
                            class="h-6.5 rounded-md border border-line bg-elevated px-2 text-xs text-ink placeholder:text-faint hover:border-faint focus:border-focus"
                          />
                        </View>
                      </If>
                      <If when={branchesCount() > 0} else={<PanelEmpty text={t("web.shell.git.noBranches")} compact />}>
                        <If when={filteredBranches().length > 0} else={<PanelEmpty text={t("web.shell.git.noMatchingBranches")} compact />}>
                          <View class="gap-px">
                            <Each of={filteredBranches()} key={(b) => b.name}>
                              {(b) => (
                                <Button
                                  disabled={switchingBranch() !== null}
                                  onPress={() => {
                                    if (!b().head) {
                                      switchingBranch.set(b().name);
                                      act({ type: "checkout", branch: b().name });
                                    }
                                  }}
                                  accessibilityLabel={
                                    b().head ? t("web.shell.git.currentBranch", { name: b().name }) : t("web.shell.git.switchBranch", { name: b().name })
                                  }
                                  class={`relative mx-1.5 h-6.5 flex-row items-center gap-1.5 rounded-md px-1.5 ${
                                    switchingBranch() !== null ? "" : "active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus"
                                  } ${b().head ? "bg-selected" : "bg-transparent hover:bg-hover"}`}
                                >
                                  <If when={b().head}>
                                    <ActiveBar />
                                  </If>
                                  <View class="size-3.5 shrink-0 items-center justify-center">
                                    <Icon name={b().head ? "ticked" : "branch"} size={12} tone={b().head ? "leaf" : "faint"} />
                                  </View>
                                  <Text class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-ink">{b().name}</Text>
                                  <If
                                    when={switchingBranch() === b().name}
                                    else={
                                      <If when={b().upstream}>
                                        {(upstream) => (
                                          <Text class="max-w-32 shrink-0 truncate font-mono text-2xs text-muted" style={startEllipsis}>
                                            {upstream()}
                                          </Text>
                                        )}
                                      </If>
                                    }
                                  >
                                    <Text class="shrink-0 text-2xs font-medium text-warn-ink">{t("web.shell.git.switching")}</Text>
                                  </If>
                                </Button>
                              )}
                            </Each>
                          </View>
                        </If>
                      </If>
                    </View>
                  </If>
                </View>

                <If when={worktreesCount() > 0}>{renderWorktreesSection("branches-worktrees", t("web.shell.git.worktrees"), true, true)}</If>
              </View>
            </If>

            <If when={activeTab() === "commits"}>
              <View>
                <SectionHead
                  title={t("web.shell.git.commits")}
                  count={logCount()}
                  collapsible
                  expanded={isOpen("commits")}
                  onToggle={() => toggleSection("commits")}
                  borderBottom={isOpen("commits") && logCount() > 0}
                />
                <If when={isOpen("commits")}>
                  <If when={logCount() > 0} else={<PanelEmpty text={t("web.shell.git.noCommits")} compact />}>
                    <Each of={f()?.log ?? []} key={(c) => c.id}>
                      {(c) => (
                        <Button
                          onPress={() => act({ type: "open_commit", id: c().id })}
                          accessibilityLabel={`Commit ${c().short}: ${c().summary}`}
                          tooltip={<Bubble text={`${c().short} · ${c().summary}`} />}
                          class={`gap-1 border-b border-line px-3 py-2 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
                        >
                          <View class="flex-row items-center gap-2">
                            <Text class="min-w-0 flex-1 truncate text-sm text-ink" style={autoDirection}>
                              {c().summary}
                            </Text>
                            <View class="h-4.5 min-w-17 shrink-0 items-center justify-center rounded-sm border border-line bg-elevated px-1.5">
                              <Text class="truncate font-mono text-2xs text-leaf tabular-nums">{c().short}</Text>
                            </View>
                          </View>
                          <View class="flex-row items-center gap-2">
                            <Text class="min-w-0 flex-1 truncate text-2xs text-muted">{c().author}</Text>
                            <Text class="shrink-0 text-right text-2xs text-faint">{formatCommitTime(c().time)}</Text>
                          </View>
                        </Button>
                      )}
                    </Each>
                  </If>
                </If>
              </View>
            </If>
            <View class="h-4" />
          </Scroll>
        </View>
      </If>
    </View>
  );
}
