import { Clipboard, computed, Image, Text, View, type ViewRef } from "nsh";
import { Button, Menu, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import type { IconName } from "../../design/icons";
import { ActiveBar } from "../../design/layout";
import { motionClass, popupTransition } from "../../design/motion";
import { Bubble } from "../../design/Tip";
import { act, hostApi } from "../../infra/bridge";
import { useVdpNode } from "../../infra/vdpProbe";
import { menuPopupClass, menuSeparatorClass, ShellIconButton } from "../chrome";
import { NewAtMenu, RepoContextMenu, WorktreeContextMenu } from "./ContextMenus";
import {
  formatDisplayPath,
  formatSummaryTooltip,
  formatTabTooltip,
  groupFoldKey,
  INDENT_STEP,
  isGroupExpandable,
  isRepoExpandable,
  repoFoldKey,
  ROW_BASE_PAD,
  rowClass,
  summarizeGroup,
  summarizeRepo,
  tabRunningState,
  type RailTab,
  type RepoNode,
  type SidebarTreeCtx,
  type WorktreeGroup,
} from "./model";
import { CollapsedSummary, StatusDots, TabIconStatus } from "./StatusWidgets";

function TabRow(props: { group: WorktreeGroup; tab: RailTab; depth: number; ctx: SidebarTreeCtx }) {
  const rowKey = () => `tab:${props.group.path}:${props.tab.id}`;
  const isSelected = computed(() => props.group.active && props.tab.active);
  const isHovered = () => props.ctx.hoveredKey() === rowKey();
  const isMenuOpen = () => props.ctx.openMenuKey() === rowKey();
  const showMenu = computed(() => isHovered() || isMenuOpen());
  // Each terminal/chat tab displays strictly its own status (never polluted by group.sessionRunning).
  const state = computed(() => (props.tab.kind === "terminal" || props.tab.kind === "chat" ? tabRunningState(props.tab) : "idle"));
  const ownAgent = () => (props.tab.kind === "terminal" || props.tab.kind === "chat" ? props.tab.runningAgent : undefined);
  const logoSrc = () => props.ctx.engineLogoSrc(ownAgent() ?? undefined);
  const canClose = computed(() => props.tab.kind === "terminal" || props.tab.kind === "chat" || props.group.tabs.length > 1);
  const tabIconTone = () => (state() === "working" ? "leaf" : isSelected() ? "ink" : "muted");
  const fallbackIcon = (): IconName =>
    props.tab.kind === "chat" ? "chat" : props.tab.kind === "diff" ? "diff" : props.tab.kind === "file" ? "file" : "terminal";
  const tabMenuItemClass = "h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";
  const tabMenuDangerClass = "h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-bad-soft focus:bg-bad-soft";

  return (
    <View
      onMouseEnter={() => props.ctx.setHoveredKey(rowKey())}
      onMouseLeave={() => {
        if (props.ctx.hoveredKey() === rowKey()) props.ctx.setHoveredKey(null);
      }}
      tooltip={<Bubble text={formatTabTooltip(props.tab, props.group)} />}
      class={rowClass(isSelected())}
      style={{ paddingLeft: ROW_BASE_PAD + props.depth * INDENT_STEP }}
    >
      <If when={isSelected()}>
        <ActiveBar />
      </If>
      <Button
        onPress={() => act({ type: "activate_tab", path: props.group.path, tab_id: props.tab.id })}
        class="h-7 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
      >
        <TabIconStatus
          tabId={props.tab.id}
          logoSrc={logoSrc()}
          fallbackIcon={fallbackIcon()}
          iconTone={tabIconTone()}
          state={state()}
          attention={props.tab.attention === true}
          sweepPhase={props.ctx.sweepPhase()}
        />
        <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{props.tab.title}</Text>
      </Button>
      <If when={showMenu()}>
        <Menu
          open={isMenuOpen()}
          onOpenChange={(e) => {
            if (e.open) props.ctx.setOpenMenuKey(rowKey());
            else if (props.ctx.openMenuKey() === rowKey()) props.ctx.setOpenMenuKey(null);
          }}
          placement="bottom"
          align="end"
          offset={4}
          popupClass={`${menuPopupClass} ${motionClass("transition-opacity duration-120 ease-out")}`}
          popupStartingClass={popupTransition("opacity-0")}
          popupEndingClass={popupTransition("opacity-0")}
          trigger={
            <View
              testID={`sidebar-tab-more-${props.tab.id}`}
              accessibilityLabel={t("web.shell.sidebar.tabMore")}
              tooltip={<Bubble text={t("web.shell.sidebar.tabMore")} />}
              class={`size-5 shrink-0 items-center justify-center rounded-sm ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus`}
            >
              <Icon name="more" size={13} tone="muted" />
            </View>
          }
        >
          <MenuItem
            testID={`sidebar-tab-menu-chat-${props.tab.id}`}
            onSelect={() => {
              props.ctx.setFold(groupFoldKey(props.group), true);
              act({ type: "new_chat_at", path: props.group.path });
            }}
            class={tabMenuItemClass}
          >
            <Icon name="chat" size={13} tone="muted" />
            <Text class="text-sm text-ink">{t("web.shell.sidebar.newChatHere")}</Text>
          </MenuItem>
          <MenuItem
            testID={`sidebar-tab-menu-term-${props.tab.id}`}
            onSelect={() => {
              props.ctx.setFold(groupFoldKey(props.group), true);
              act({ type: "new_terminal_at", path: props.group.path });
            }}
            class={tabMenuItemClass}
          >
            <Icon name="terminal" size={13} tone="muted" />
            <Text class="text-sm text-ink">{t("web.shell.sidebar.newTerminalHere")}</Text>
          </MenuItem>
          <MenuItem testID={`sidebar-tab-menu-reveal-${props.tab.id}`} onSelect={() => void hostApi.reveal(props.group.path)} class={tabMenuItemClass}>
            <Icon name="folder" size={13} tone="muted" />
            <Text class="text-sm text-ink">{t("web.shell.sidebar.revealInFinder")}</Text>
          </MenuItem>
          <MenuItem testID={`sidebar-tab-menu-copy-${props.tab.id}`} onSelect={() => void Clipboard.writeText(props.group.path)} class={tabMenuItemClass}>
            <Icon name="copy" size={13} tone="muted" />
            <Text class="text-sm text-ink">{t("web.shell.sidebar.copyPath")}</Text>
          </MenuItem>
          <If when={canClose()}>
            <MenuSeparator class={menuSeparatorClass} />
            <MenuItem
              testID={`sidebar-tab-menu-close-${props.tab.id}`}
              onSelect={() => {
                if (props.ctx.hoveredKey() === rowKey()) props.ctx.setHoveredKey(null);
                if (props.ctx.openMenuKey() === rowKey()) props.ctx.setOpenMenuKey(null);
                act({ type: "close_tab_at", path: props.group.path, tab_id: props.tab.id });
              }}
              class={tabMenuDangerClass}
            >
              <Icon name="close" size={13} tone="berry" />
              <Text class="text-sm text-berry">{t("web.shell.sidebar.closeTab")}</Text>
            </MenuItem>
          </If>
        </Menu>
      </If>
    </View>
  );
}

function WorktreeGroupRow(props: { group: WorktreeGroup; ctx: SidebarTreeCtx }) {
  const rowKey = () => `wt:${props.group.path}`;
  const newMenuKey = () => `new:wt:${props.group.path}`;
  const expandable = computed(() => isGroupExpandable(props.group));
  const expanded = computed(() => props.ctx.isGroupExpanded(props.group));
  const isHovered = computed(() => props.ctx.hoveredKey() === rowKey());
  const isMenuOpen = computed(() => props.ctx.openMenuKey() === newMenuKey());
  const showActions = computed(() => isHovered() || isMenuOpen());
  const isSelected = computed(() => props.group.active && props.group.tabs.length === 0);
  const summary = computed(() => summarizeGroup(props.group));
  const sessionLogo = () => (props.group.sessionRunning ? props.ctx.engineLogoSrc(props.group.sessionAgent) : undefined);
  const tipText = () =>
    formatSummaryTooltip(
      props.group.isMain
        ? `${t("web.shell.sidebar.mainWorktree", { label: props.group.label })} · ${props.group.path}`
        : `${props.group.label} · ${props.group.path}`,
      summary(),
      expandable() && !expanded(),
    );
  let wtRowRef: ViewRef | undefined;
  useVdpNode({
    testId: `sidebar-wt-row-${props.group.label}`,
    role: "button",
    text: () => props.group.label,
    getRef: () => wtRowRef,
    onPress: () => {
      if (expandable()) props.ctx.toggleFold(groupFoldKey(props.group), expanded());
      act({ type: "activate_path", path: props.group.path });
    },
  });

  return (
    <View class="gap-px">
      <WorktreeContextMenu
        group={props.group}
        setFold={props.ctx.setFold}
        trigger={
          <View
            ref={(el) => {
              wtRowRef = el;
            }}
            onMouseEnter={() => props.ctx.setHoveredKey(rowKey())}
            onMouseLeave={() => {
              if (props.ctx.hoveredKey() === rowKey()) props.ctx.setHoveredKey(null);
            }}
            tooltip={<Bubble text={tipText()} />}
            class={`relative h-7 flex-row items-center gap-1 rounded-md pr-1.5 ${isSelected() ? "bg-selected" : "hover:bg-hover"}`}
            style={{ paddingLeft: ROW_BASE_PAD }}
          >
            <If when={isSelected()}>
              <ActiveBar />
            </If>
            <Button
              testID={`sidebar-wt-row-${props.group.label}`}
              onPress={() => {
                if (expandable()) props.ctx.toggleFold(groupFoldKey(props.group), expanded());
                act({ type: "activate_path", path: props.group.path });
              }}
              class="h-7 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
            >
              <View class="size-4 shrink-0 items-center justify-center">
                <Icon
                  name="branch"
                  size={14}
                  tone={props.group.sessionRunning ? "leaf" : props.group.active || (expandable() && expanded()) ? "ink" : "muted"}
                />
              </View>
              <View class="min-w-0 flex-1 flex-row items-center gap-1">
                <Text class={`shrink truncate text-sm font-medium ${expandable() && !expanded() && !props.group.active ? "text-muted" : "text-ink"}`}>
                  {props.group.label}
                </Text>
                <If when={props.group.isMain}>
                  <Text class="shrink-0 text-2xs font-medium text-faint">{t("web.shell.sidebar.mainLabel")}</Text>
                </If>
                <If when={expanded() && props.group.tabs.length > 0}>
                  <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{String(props.group.tabs.length)}</Text>
                </If>
              </View>
            </Button>
            <View class="shrink-0 flex-row items-center gap-1">
              <If
                when={showActions()}
                else={
                  <If
                    when={expandable() && !expanded()}
                    else={
                      <If when={props.group.sessionRunning}>
                        <View class="shrink-0 flex-row items-center gap-1">
                          <If when={sessionLogo()}>{(src) => <Image src={src()} class="size-3.5 object-contain" />}</If>
                          <StatusDots state="working" />
                        </View>
                      </If>
                    }
                  >
                    <CollapsedSummary testID={`sidebar-wt-summary-${props.group.label}`} summary={summary()} />
                  </If>
                }
              >
                <If
                  when={expandable() && !expanded()}
                  else={
                    <If when={props.group.sessionRunning}>
                      <StatusDots state="working" />
                    </If>
                  }
                >
                  <CollapsedSummary testID={`sidebar-wt-summary-${props.group.label}`} summary={summary()} />
                </If>
                <NewAtMenu
                  menuKey={newMenuKey()}
                  name={props.group.label}
                  path={props.group.path}
                  foldKey={groupFoldKey(props.group)}
                  testKey={`wt-${props.group.label}`}
                  ctx={props.ctx}
                />
              </If>
            </View>
          </View>
        }
      />
      <If when={expandable() && expanded()}>
        <View class="gap-px">
          <Each of={props.group.tabs} key={(tab) => tab.id}>
            {(tab) => <TabRow group={props.group} tab={tab()} depth={2} ctx={props.ctx} />}
          </Each>
        </View>
      </If>
    </View>
  );
}

export function RepoNodeRow(props: { repo: RepoNode; parentHint?: string | undefined; ctx: SidebarTreeCtx }) {
  const rowKey = () => `repo:${props.repo.path}`;
  const newMenuKey = () => `new:repo:${props.repo.path}`;
  const hasMultipleWorktrees = computed(() => props.repo.groups.length > 1);
  const mainGroup = () => props.repo.groups[0];
  const expandable = computed(() => isRepoExpandable(props.repo));
  const expanded = computed(() => props.ctx.isRepoExpanded(props.repo));
  const isHovered = computed(() => props.ctx.hoveredKey() === rowKey());
  const isMenuOpen = computed(() => props.ctx.openMenuKey() === newMenuKey());
  const showActions = computed(() => isHovered() || isMenuOpen());
  const summary = computed(() => summarizeRepo(props.repo));
  const showActiveCard = computed(() => props.repo.active && expandable() && expanded());
  const isRepoSelected = computed(() => props.repo.active && (!expandable() || !expanded()));
  const mainSessionRunning = computed(() => !hasMultipleWorktrees() && mainGroup().sessionRunning);
  const mainSessionLogo = () => (mainSessionRunning() ? props.ctx.engineLogoSrc(mainGroup().sessionAgent) : undefined);
  const repoTip = () => formatSummaryTooltip(props.repo.path, summary(), expandable() && !expanded());
  let repoRowRef: ViewRef | undefined;
  useVdpNode({
    testId: `sidebar-repo-row-${props.repo.name}`,
    role: "button",
    text: () => props.repo.name,
    getRef: () => repoRowRef,
    onPress: () => {
      if (expandable()) props.ctx.toggleFold(repoFoldKey(props.repo), expanded());
      act({ type: "activate_path", path: props.repo.path });
    },
  });

  return (
    <View class={`gap-px rounded-lg border py-0.5 ${showActiveCard() ? "border-line bg-elevated" : "border-transparent"}`}>
      <RepoContextMenu
        repo={props.repo}
        ctx={props.ctx}
        trigger={
          <View
            ref={(el) => {
              repoRowRef = el;
            }}
            onMouseEnter={() => props.ctx.setHoveredKey(rowKey())}
            onMouseLeave={() => {
              if (props.ctx.hoveredKey() === rowKey()) props.ctx.setHoveredKey(null);
            }}
            tooltip={<Bubble text={repoTip()} />}
            class={`relative min-h-11 flex-row items-start gap-1 rounded-md py-1.5 pr-1.5 pl-2 ${isRepoSelected() ? "bg-selected" : "hover:bg-hover"}`}
          >
            <If when={isRepoSelected()}>
              <ActiveBar />
            </If>
            <Button
              testID={`sidebar-repo-row-${props.repo.name}`}
              onPress={() => {
                if (expandable()) props.ctx.toggleFold(repoFoldKey(props.repo), expanded());
                act({ type: "activate_path", path: props.repo.path });
              }}
              class="min-w-0 flex-1 flex-row items-start gap-1.5 rounded-sm focus-visible:outline-2 focus-visible:outline-focus"
            >
              <View class="mt-0.5 size-4 shrink-0 items-center justify-center">
                <Icon
                  name={props.repo.vibevalley ? "repos" : "folder"}
                  size={14}
                  tone={props.repo.active ? "leaf" : expandable() && expanded() ? "ink" : "muted"}
                />
              </View>
              <View class="min-w-0 flex-1 gap-0.5">
                <View class="min-w-0 flex-row items-center gap-1">
                  <Text class={`shrink truncate text-sm font-semibold ${expandable() && !expanded() && !props.repo.active ? "text-muted" : "text-ink"}`}>
                    {props.repo.name}
                  </Text>
                  <If when={props.parentHint}>{(hint) => <Text class="shrink truncate text-2xs text-faint">{hint()}</Text>}</If>
                </View>
                <Text testID={`sidebar-repo-path-${props.repo.name}`} class="truncate font-mono text-2xs text-faint">
                  {formatDisplayPath(props.repo.path)}
                </Text>
              </View>
            </Button>

            <View class="mt-0.5 shrink-0 flex-row items-center gap-0.5">
              <If
                when={showActions()}
                else={
                  <If
                    when={expandable() && !expanded()}
                    else={
                      <View class="shrink-0 flex-row items-center gap-1">
                        <If when={mainSessionRunning()}>
                          <View class="shrink-0 flex-row items-center gap-1">
                            <If when={mainSessionLogo()}>{(src) => <Image src={src()} class="size-3.5 object-contain" />}</If>
                            <StatusDots state="working" />
                          </View>
                        </If>
                        <If when={!hasMultipleWorktrees() && props.repo.branch}>
                          {(branch) => (
                            <View class="max-w-21 shrink flex-row items-center gap-1">
                              <Icon name="branch" size={11} tone="faint" />
                              <Text class="shrink truncate font-mono text-2xs text-muted">{branch()}</Text>
                            </View>
                          )}
                        </If>
                      </View>
                    }
                  >
                    <CollapsedSummary testID={`sidebar-repo-summary-${props.repo.name}`} summary={summary()} />
                  </If>
                }
              >
                <NewAtMenu
                  menuKey={newMenuKey()}
                  name={props.repo.name}
                  path={props.repo.path}
                  foldKey={repoFoldKey(props.repo)}
                  testKey={`repo-${props.repo.name}`}
                  ctx={props.ctx}
                />
                <If when={props.repo.projectId !== undefined && !props.repo.vibevalley}>
                  <ShellIconButton
                    compact
                    icon="close"
                    size={11}
                    label={t("web.shell.sidebar.closeFolder", { name: props.repo.name })}
                    onPress={() => {
                      if (props.ctx.hoveredKey() === rowKey()) props.ctx.setHoveredKey(null);
                      act({ type: "close_project", id: props.repo.projectId! });
                    }}
                  />
                </If>
              </If>
            </View>
          </View>
        }
      />
      <If when={expandable() && expanded()}>
        <If
          when={!hasMultipleWorktrees()}
          else={
            <View class="gap-px">
              <Each of={props.repo.groups} key={(group) => group.id}>
                {(group) => <WorktreeGroupRow group={group()} ctx={props.ctx} />}
              </Each>
            </View>
          }
        >
          <View class="gap-px">
            <Each of={mainGroup().tabs} key={(tab) => tab.id}>
              {(tab) => <TabRow group={mainGroup()} tab={tab()} depth={1} ctx={props.ctx} />}
            </Each>
          </View>
        </If>
      </If>
    </View>
  );
}
