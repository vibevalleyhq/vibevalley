import type { JSX } from "@solidjs/web";
import { createSignal, For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { aria, Keyed } from "#/base/dom.tsx";
import { useInterval } from "#/base/timer.ts";
import {
  allTabs,
  findGroup,
  firstGroup,
  type LayoutNode,
  type PaneGroup,
  type PaneSplit,
  type TerminalTab,
  workspaceFoldersOf,
} from "#/features/terminal/model/layout.ts";
import {
  closeTerminalTab,
  focusTerminalGroup,
  focusTerminalTab,
  lastTerminalCwd,
  openTerminalIn,
  pollActiveTerminals,
  setTerminalSplitRatio,
  splitTerminalGroup,
  terminalWorkspace,
} from "#/features/terminal/model/sessions.ts";
import { useCore } from "#/infra/frame.ts";
import { currentHost } from "#/infra/host.ts";
import { ready, useRepos } from "#/infra/query.ts";
import { Button } from "#/ui/Button.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Splitter, usePaneWidth } from "#/ui/Splitter.tsx";

import { TerminalSurface } from "./TerminalSurface";

const styles = {
  paneWidth: (px: number): JSX.CSSProperties => ({ width: `${px}px` }),
  splitFlex: (ratio: number): JSX.CSSProperties => ({ flex: `${ratio * 100} 1 0%` }),
};

function AgentPill(props: { name: string }) {
  return <span class="shrink-0 rounded-sm bg-leaf-300/40 px-1 font-mono text-2xs font-medium text-ink">{props.name}</span>;
}

function SidebarTabRow(props: { tab: TerminalTab; active: boolean }) {
  return (
    <div
      class={[
        "group/tab flex h-7 items-center gap-1.5 rounded-md pr-1 pl-5 text-xs",
        props.active ? "bg-selected text-ink font-medium" : "text-muted hover:bg-hover hover:text-ink",
      ]}
    >
      <button type="button" onClick={() => focusTerminalTab(props.tab.id)} class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left">
        <Icon name="terminal" size={12} />
        <span class="min-w-0 flex-1 truncate font-mono">{props.tab.title}</span>
        <Show when={props.tab.agentTui}>{(agent) => <AgentPill name={agent()} />}</Show>
      </button>
      <button
        type="button"
        title={t("web.terminal.closeTab")}
        aria-label={t("web.terminal.closeTab")}
        onClick={() => closeTerminalTab(props.tab.id)}
        class="cursor-pointer rounded-sm p-0.5 text-faint opacity-0 group-hover/tab:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100"
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}

function SplitDivider(props: { split: PaneSplit; container: () => HTMLDivElement | undefined }) {
  const [dragging, setDragging] = createSignal(false);
  const horizontal = () => props.split.direction === "row";
  return (
    <div
      role="separator"
      aria-orientation={horizontal() ? "vertical" : "horizontal"}
      class={["group/split relative z-10 shrink-0 bg-line select-none touch-none", horizontal() ? "w-px cursor-col-resize" : "h-px cursor-row-resize"]}
      onPointerDown={(e) => {
        const box = props.container()?.getBoundingClientRect();
        if (!box) return;
        e.preventDefault();
        const handle = e.currentTarget;
        handle.setPointerCapture(e.pointerId);
        setDragging(true);
        const move = (m: PointerEvent) => {
          const rect = props.container()?.getBoundingClientRect() ?? box;
          const next = horizontal() ? (m.clientX - rect.left) / Math.max(1, rect.width) : (m.clientY - rect.top) / Math.max(1, rect.height);
          setTerminalSplitRatio(props.split.id, next);
        };
        const up = () => {
          setDragging(false);
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", up);
          handle.removeEventListener("pointercancel", up);
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
      }}
      onDblClick={() => setTerminalSplitRatio(props.split.id, 0.5)}
    >
      <span
        class={[
          "absolute transition-colors duration-120",
          horizontal() ? "inset-y-0 -left-1 w-2" : "inset-x-0 -top-1 h-2",
          dragging() ? "bg-focus/50" : "bg-transparent group-hover/split:bg-focus/40",
        ]}
      />
    </div>
  );
}

function GroupView(props: { group: PaneGroup; focused: boolean; defaultCwd: string }) {
  const activeTab = () => props.group.tabs.find((item) => item.id === props.group.activeTabId) ?? props.group.tabs[0];
  return (
    <section
      data-testid="terminal-group"
      data-focused={aria(props.focused)}
      onMouseDown={() => focusTerminalGroup(props.group.id)}
      class="flex h-full w-full min-h-0 min-w-0 flex-col bg-page"
    >
      <div class="flex h-9 shrink-0 items-center justify-between gap-1 border-b border-line bg-side px-2">
        <div role="tablist" class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          <For each={props.group.tabs}>
            {(tab) => {
              const selected = () => tab.id === props.group.activeTabId;
              return (
                <div
                  role="tab"
                  data-testid="terminal-tab"
                  aria-selected={aria(selected())}
                  onClick={() => focusTerminalTab(tab.id)}
                  class={[
                    "group/tab flex h-7 max-w-52 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2 text-xs",
                    selected() ? "border-line bg-page font-medium text-ink" : "border-transparent text-muted hover:bg-hover hover:text-ink",
                  ]}
                >
                  <Icon name="terminal" size={12} />
                  <span class="truncate font-mono">{tab.title}</span>
                  <Show when={tab.agentTui}>{(agent) => <AgentPill name={agent()} />}</Show>
                  <button
                    type="button"
                    data-testid="terminal-close-tab"
                    title={t("web.terminal.closeTab")}
                    aria-label={t("web.terminal.closeTab")}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminalTab(tab.id);
                    }}
                    class="cursor-pointer rounded-sm p-0.5 text-faint hover:bg-hover hover:text-ink"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              );
            }}
          </For>
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            data-testid="terminal-group-new"
            title={t("web.terminal.newShell")}
            aria-label={t("web.terminal.newShell")}
            onClick={() => {
              focusTerminalGroup(props.group.id);
              const base = activeTab()?.liveCwd || activeTab()?.cwd || props.defaultCwd;
              openTerminalIn(base);
            }}
            class="cursor-pointer rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink"
          >
            <Icon name="add" size={14} />
          </button>
          <button
            type="button"
            data-testid="terminal-split-right"
            title={t("web.terminal.splitRight")}
            aria-label={t("web.terminal.splitRight")}
            onClick={() => splitTerminalGroup(props.group.id, "row", props.defaultCwd)}
            class="cursor-pointer rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink"
          >
            <Icon name="indent" size={14} />
          </button>
          <button
            type="button"
            data-testid="terminal-split-down"
            title={t("web.terminal.splitDown")}
            aria-label={t("web.terminal.splitDown")}
            onClick={() => splitTerminalGroup(props.group.id, "col", props.defaultCwd)}
            class="cursor-pointer rounded-md p-1.5 text-muted hover:bg-hover hover:text-ink"
          >
            <Icon name="moveDown" size={14} />
          </button>
        </div>
      </div>
      <div class="min-h-0 flex-1">
        <Show when={activeTab()}>
          {(tab) => <Keyed key={tab().id}>{() => <TerminalSurface tab={tab()} onFocus={() => focusTerminalGroup(props.group.id)} />}</Keyed>}
        </Show>
      </div>
    </section>
  );
}

function LayoutTreeView(props: { node: LayoutNode; focusedGroupId: string; defaultCwd: string }) {
  let splitContainer: HTMLDivElement | undefined;
  return (
    <Show
      when={props.node.kind === "split" ? props.node : undefined}
      fallback={
        props.node.kind === "group" ? <GroupView group={props.node} focused={props.node.id === props.focusedGroupId} defaultCwd={props.defaultCwd} /> : null
      }
    >
      {(split) => (
        <div
          ref={(el) => {
            splitContainer = el;
          }}
          data-testid="terminal-split"
          data-direction={split().direction}
          class={["flex h-full w-full min-h-0 min-w-0", split().direction === "row" ? "flex-row" : "flex-col"]}
        >
          <div class="min-h-0 min-w-0 overflow-hidden" style={styles.splitFlex(split().ratio)}>
            <LayoutTreeView node={split().first} focusedGroupId={props.focusedGroupId} defaultCwd={props.defaultCwd} />
          </div>
          <SplitDivider split={split()} container={() => splitContainer} />
          <div class="min-h-0 min-w-0 overflow-hidden" style={styles.splitFlex(1 - split().ratio)}>
            <LayoutTreeView node={split().second} focusedGroupId={props.focusedGroupId} defaultCwd={props.defaultCwd} />
          </div>
        </div>
      )}
    </Show>
  );
}

export function TerminalPage() {
  const repos = useRepos();
  const core = useCore();
  const sideWidth = usePaneWidth("terminal-side", 248, 180, 400);

  const repoList = () => ready(repos, []);
  const repoGroups = () => workspaceFoldersOf(repoList(), core()?.issues ?? [], core()?.sessions ?? []);
  const workspace = () => terminalWorkspace.get();
  const tabs = () => allTabs(workspace().root);
  const defaultCwd = () => lastTerminalCwd.get() || repoGroups()[0]?.path || "";

  const activeTabId = () => {
    const root = workspace().root;
    if (!root) return "";
    const group = findGroup(root, workspace().focusedGroupId) ?? firstGroup(root);
    return group.activeTabId;
  };

  useInterval(() => {
    void pollActiveTerminals();
  }, 2500);

  onSettled(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!currentHost().terminal) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        openTerminalIn(defaultCwd());
        return;
      }
      if (key === "d") {
        const root = workspace().root;
        if (!root) return;
        e.preventDefault();
        const group = findGroup(root, workspace().focusedGroupId) ?? firstGroup(root);
        splitTerminalGroup(group.id, e.shiftKey ? "col" : "row", defaultCwd());
        return;
      }
      if (key === "w" && !e.shiftKey) {
        const id = activeTabId();
        if (!id) return;
        e.preventDefault();
        closeTerminalTab(id);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <Show
      when={currentHost().terminal}
      fallback={
        <div data-testid="terminal-unavailable" class="grid h-full place-content-center gap-2 bg-page p-6 text-center">
          <div class="mx-auto flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-side text-muted">
            <Icon name="terminal" size={20} />
          </div>
          <h2 class="text-base font-semibold text-ink">{t("web.terminal.unavailableTitle")}</h2>
          <p class="max-w-md text-sm text-muted">{t("web.terminal.unavailableBody")}</p>
        </div>
      }
    >
      <div data-testid="terminal-page" class="flex h-full min-h-0 min-w-0 bg-page">
        <aside
          data-testid="terminal-sidebar"
          style={styles.paneWidth(sideWidth())}
          class="relative flex min-h-0 shrink-0 flex-col border-r border-line bg-side"
        >
          <div class="flex h-9 shrink-0 items-center justify-between border-b border-line px-3">
            <span class="truncate text-xs font-semibold text-muted">{t("web.terminal.sidebar")}</span>
            <button
              type="button"
              data-testid="terminal-new"
              title={t("web.terminal.newShell")}
              aria-label={t("web.terminal.newShell")}
              onClick={() => openTerminalIn(defaultCwd())}
              class="cursor-pointer rounded-sm p-1 text-muted hover:bg-hover hover:text-ink"
            >
              <Icon name="add" size={14} />
            </button>
          </div>
          <div class="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
            <Show
              when={repoGroups().length > 0}
              fallback={
                <div class="flex flex-col gap-1.5">
                  <p class="px-2 py-1 text-xs text-muted">{t("web.terminal.noRepos")}</p>
                  <div class="flex h-7 items-center justify-between rounded-md px-2 hover:bg-hover">
                    <span class="flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink">
                      <Icon name="folder" size={14} />
                      <span class="truncate">{t("web.terminal.homeFolder")}</span>
                    </span>
                    <button
                      type="button"
                      data-testid="terminal-new-home"
                      title={t("web.terminal.newInFolder", { name: t("web.terminal.homeFolder") })}
                      aria-label={t("web.terminal.newInFolder", { name: t("web.terminal.homeFolder") })}
                      onClick={() => openTerminalIn("", t("web.terminal.homeFolder"))}
                      class="cursor-pointer rounded-sm p-0.5 text-muted hover:bg-hover hover:text-ink"
                    >
                      <Icon name="add" size={14} />
                    </button>
                  </div>
                  <For each={tabs().filter((item) => item.cwd === "")}>{(tab) => <SidebarTabRow tab={tab} active={tab.id === activeTabId()} />}</For>
                </div>
              }
            >
              <For each={repoGroups()}>
                {(repo) => {
                  const worktreeSet = () => new Set(repo.worktrees.map((w) => w.cwd));
                  const repoTabs = () => tabs().filter((item) => item.cwd === repo.path && !worktreeSet().has(item.cwd));
                  return (
                    <div data-testid="terminal-repo-group" class="flex flex-col gap-0.5">
                      <div class="group/repo flex h-7 items-center justify-between gap-1 rounded-md px-2 hover:bg-hover">
                        <button
                          type="button"
                          onClick={() => openTerminalIn(repo.path, repo.name)}
                          class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs font-semibold text-ink"
                        >
                          <Icon name="repos" size={14} />
                          <span class="truncate">{repo.name}</span>
                        </button>
                        <button
                          type="button"
                          data-testid="terminal-new-repo"
                          title={t("web.terminal.newInFolder", { name: repo.name })}
                          aria-label={t("web.terminal.newInFolder", { name: repo.name })}
                          onClick={() => openTerminalIn(repo.path, repo.name)}
                          class="cursor-pointer rounded-sm p-0.5 text-muted hover:bg-hover hover:text-ink"
                        >
                          <Icon name="add" size={14} />
                        </button>
                      </div>
                      <For each={repoTabs()}>{(tab) => <SidebarTabRow tab={tab} active={tab.id === activeTabId()} />}</For>
                      <For each={repo.worktrees}>
                        {(wt) => {
                          const wtLabel = `#${wt.number} ${wt.title}`;
                          const wtTabs = () => tabs().filter((item) => item.cwd === wt.cwd);
                          return (
                            <div class="mt-0.5 flex flex-col gap-0.5 pl-2">
                              <div class="flex h-7 items-center justify-between gap-1 rounded-md px-2 hover:bg-hover">
                                <button
                                  type="button"
                                  onClick={() => openTerminalIn(wt.cwd, wtLabel)}
                                  class="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-xs text-muted hover:text-ink"
                                >
                                  <Icon name="folder" size={12} />
                                  <span class="truncate">{wtLabel}</span>
                                </button>
                                <button
                                  type="button"
                                  data-testid="terminal-new-worktree"
                                  title={t("web.terminal.newInFolder", { name: wtLabel })}
                                  aria-label={t("web.terminal.newInFolder", { name: wtLabel })}
                                  onClick={() => openTerminalIn(wt.cwd, wtLabel)}
                                  class="cursor-pointer rounded-sm p-0.5 text-muted hover:bg-hover hover:text-ink"
                                >
                                  <Icon name="add" size={14} />
                                </button>
                              </div>
                              <For each={wtTabs()}>{(tab) => <SidebarTabRow tab={tab} active={tab.id === activeTabId()} />}</For>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  );
                }}
              </For>
            </Show>
          </div>
          <Splitter pane="terminal-side" side="right" width={sideWidth()} min={180} max={400} label={t("web.terminal.sidebarSplitter")} />
        </aside>
        <div class="min-h-0 min-w-0 flex-1">
          <Show
            when={workspace().root}
            fallback={
              <div data-testid="terminal-empty" class="grid h-full place-content-center justify-items-center gap-3 p-6 text-center">
                <p class="text-sm text-muted">{t("web.terminal.emptyTitle")}</p>
                <Button icon="terminal" data-testid="terminal-empty-open" onClick={() => openTerminalIn(defaultCwd())}>
                  {t("web.terminal.emptyAction")}
                </Button>
              </div>
            }
          >
            {(root) => <LayoutTreeView node={root()} focusedGroupId={workspace().focusedGroupId} defaultCwd={defaultCwd()} />}
          </Show>
        </div>
      </div>
    </Show>
  );
}
