import { cleanup, Clipboard, computed, effect, host, Image, Scroll, signal, Text, untracked, View, type JSX } from "nsh";
import { Button, ContextMenu, Menu, MenuItem, MenuSeparator } from "nsh/base";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { isFreeUserSession, isOrchestratorSession, sessionBranch, sessionIssueId, sessionRepo, sessionWorktree } from "@vibevalley/protocol/rules";
import { HostRailRunningState as HostRailRunningStateSchema } from "@vibevalley/protocol/schema";

import { engineLogoUrl } from "../design/art";
import { Icon } from "../design/Icon";
import type { IconName } from "../design/icons";
import { ActiveBar } from "../design/layout";
import { motionClass, motionOff, popupTransition } from "../design/motion";
import { Bubble } from "../design/Tip";
import { mix } from "../design/tone";
import { useInterval } from "../infra/base/timer";
import { act, callDecoded, frame, hostApi, sliceFrame } from "../infra/bridge";
import { readHostParams } from "../infra/hostParams";
import { menuDangerItemClass, menuItemClass, menuPopupClass, menuSeparatorClass, ShellIconButton } from "./chrome";
import { FileTree, filesFrameSchema } from "./FileTree";
import { GitPanel, gitFrameSchema, type GitTab } from "./GitPanel";
import { RepoDetailPanel, type RepoDetailTarget } from "./RepoDetailPanel";

type RailRunningState = z.infer<typeof HostRailRunningStateSchema>;

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

type VvRepo = {
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

const railFrameSchema: z.ZodType<RailFrame> = z.object({
  projects: z.array(railProjectSchema),
  panel: z.string(),
  inspectorOpen: z.exactOptional(z.boolean()),
});

const vvRepoSchema: z.ZodType<VvRepo> = z.object({
  name: z.string(),
  path: z.string(),
  git: z.exactOptional(z.boolean()),
  external: z.exactOptional(z.boolean()),
  last: z.exactOptional(z.number()),
  maxSessions: z.exactOptional(z.number()),
  pullRequest: z.exactOptional(z.object({ available: z.boolean(), reason: z.string() })),
});

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
// Depth 0 (Repo):     chevron @ 6,  icon @ 30, label @ 50
// Depth 1 (Tab):      icon @ 30,    label @ 50
// Depth 1 (Worktree): chevron @ 18, icon @ 42, label @ 62
// Depth 2 (Tab):      icon @ 42,    label @ 62
const ROW_BASE_PAD = 18;
const INDENT_STEP = 12;

function formatDisplayPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/u, "~");
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
      <If when={props.logoSrc} else={<Icon name={props.fallbackIcon} size={14} tone={props.iconTone} />}>
        {(src) => <Image src={src()} class="size-4 object-contain" />}
      </If>
      <If when={props.state === "working"}>
        <View
          testID={`sidebar-tab-working-${props.tabId}`}
          class="pointer-events-none absolute -bottom-1 left-0 h-0.5 w-4 overflow-hidden rounded-full"
          style={{ backgroundColor: mix("leaf", 0.24) }}
        >
          <If
            when={motionOff()}
            else={
              <View
                class={`h-full w-2 rounded-full bg-leaf ${motionClass("transition-transform duration-280 ease-in-out")}`}
                style={{ transform: [{ translateX: props.sweepPhase ? 8 : 0 }] }}
              />
            }
          >
            <View class="h-full w-full rounded-full bg-leaf" />
          </If>
        </View>
      </If>
      <If
        when={props.attention}
        else={
          <If when={props.state === "ready"}>
            <View
              testID={`sidebar-tab-ready-${props.tabId}`}
              class="pointer-events-none absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full border bg-side"
              style={{ borderColor: mix("leaf", 0.72) }}
            />
          </If>
        }
      >
        <View
          testID={`sidebar-tab-attention-${props.tabId}`}
          class={`pointer-events-none absolute -right-0.5 ${props.state === "working" ? "-top-0.5" : "-bottom-0.5"} size-1.5 rounded-full bg-wheat`}
        />
      </If>
    </View>
  );
}

function StatusDots(props: { state: RailRunningState; attention?: boolean; readyRing?: boolean }) {
  const showWorking = () => props.state === "working";
  const showReady = () => props.state === "ready" && props.readyRing !== false;
  const showAttention = () => Boolean(props.attention);
  return (
    <View class="shrink-0 flex-row items-center gap-1">
      <If when={showWorking()}>
        <View class="size-1.5 rounded-full bg-leaf" />
      </If>
      <If when={showReady()}>
        <View class="size-1.5 rounded-full border" style={{ borderColor: mix("leaf", 0.62) }} />
      </If>
      <If when={showAttention()}>
        <View class="size-1.5 rounded-full bg-wheat" />
      </If>
    </View>
  );
}

function CollapsedSummary(props: { summary: ActivitySummary; testID?: string }) {
  const s = () => props.summary;
  const hasAny = () => s().tabs > 0 || s().working > 0 || s().ready > 0 || s().attention > 0;
  return (
    <If when={hasAny()}>
      <View testID={props.testID} class="h-4.5 shrink-0 flex-row items-center gap-1 rounded-full border border-line bg-page px-1.5">
        <If when={s().working > 0}>
          <View class="size-1.5 rounded-full bg-leaf" />
        </If>
        <If when={s().working === 0 && s().ready > 0}>
          <View class="size-1.5 rounded-full border" style={{ borderColor: mix("leaf", 0.62) }} />
        </If>
        <If when={s().attention > 0}>
          <View class="size-1.5 rounded-full bg-wheat" />
        </If>
        <If when={s().tabs > 0}>
          <Text class={`text-2xs font-medium tabular-nums ${s().working > 0 ? "text-leaf" : "text-muted"}`}>{String(s().tabs)}</Text>
        </If>
      </View>
    </If>
  );
}

function SidebarHeaderButton(props: { testID?: string; icon: IconName; size?: number; label: string; tooltip?: string; onPress: () => void }) {
  const hovered = signal(false);
  return (
    <Button
      testID={props.testID}
      onPress={props.onPress}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      accessibilityLabel={props.label}
      tooltip={<Bubble text={props.tooltip ?? props.label} />}
      class={`size-5.5 shrink-0 items-center justify-center rounded-md ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
    >
      <Icon name={props.icon} size={props.size ?? 13} tone={hovered() ? "ink" : "muted"} />
    </Button>
  );
}

function ChevronButton(props: { testID?: string; expanded: boolean; label: string; onToggle: () => void }) {
  const hovered = signal(false);
  return (
    <Button
      testID={props.testID}
      onPress={props.onToggle}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      accessibilityLabel={props.label}
      tooltip={<Bubble text={props.label} />}
      class={`size-5 shrink-0 items-center justify-center rounded-sm ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
    >
      <Icon
        testID={props.testID ? `${props.testID}-${props.expanded ? "expanded" : "collapsed"}` : undefined}
        name={props.expanded ? "choose" : "expand"}
        size={14}
        tone={hovered() ? "ink" : props.expanded ? "ink" : "muted"}
      />
    </Button>
  );
}

function SweepTicker(props: { onTick: () => void }) {
  useInterval(() => props.onTick(), 420);
  return null;
}

const rowClass = (selected: boolean) => `relative h-7 flex-row items-center gap-1.5 rounded-md pr-1.5 ${selected ? "bg-selected" : "hover:bg-hover"}`;
const repoFoldKey = (repo: RepoNode) => `repo:${repo.path}`;
const groupFoldKey = (group: WorktreeGroup) => `wt:${group.path}`;
const isRepoExpandable = (repo: RepoNode) => repo.groups.length > 1 || (repo.groups[0]?.tabs.length ?? 0) > 0;
const isGroupExpandable = (group: WorktreeGroup) => group.tabs.length > 0;

interface SidebarTreeCtx {
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

function RepoContextMenu(props: { repo: RepoNode; ctx: SidebarTreeCtx; trigger: JSX.Element }) {
  return (
    <ContextMenu trigger={props.trigger} popupClass={menuPopupClass}>
      <MenuItem
        onSelect={() => {
          props.ctx.setFold(repoFoldKey(props.repo), true);
          act({ type: "new_chat_at", path: props.repo.path });
        }}
        class={menuItemClass}
      >
        <Text class="text-sm text-ink">{t("web.shell.sidebar.newChatHere")}</Text>
      </MenuItem>
      <MenuItem
        onSelect={() => {
          props.ctx.setFold(repoFoldKey(props.repo), true);
          act({ type: "new_terminal_at", path: props.repo.path });
        }}
        class={menuItemClass}
      >
        <Text class="text-sm text-ink">{t("web.shell.sidebar.newTerminalHere")}</Text>
      </MenuItem>
      <MenuSeparator class={menuSeparatorClass} />
      <MenuItem testID={`sidebar-repo-menu-details-${props.repo.name}`} onSelect={() => props.ctx.openRepoDetail(props.repo.path)} class={menuItemClass}>
        <Text class="text-sm text-ink">{t("web.shell.sidebar.repoDetails")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void hostApi.reveal(props.repo.path)} class={menuItemClass}>
        <Text class="text-sm text-ink">{t("web.shell.sidebar.revealInFinder")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void Clipboard.writeText(props.repo.path)} class={menuItemClass}>
        <Text class="text-sm text-ink">{t("web.shell.sidebar.copyPath")}</Text>
      </MenuItem>
      <If when={props.repo.projectId !== undefined && !props.repo.vibevalley}>
        <MenuSeparator class={menuSeparatorClass} />
        <MenuItem
          onSelect={() => {
            if (props.ctx.hoveredKey() === repoFoldKey(props.repo)) props.ctx.setHoveredKey(null);
            act({ type: "close_project", id: props.repo.projectId! });
          }}
          class={menuDangerItemClass}
        >
          <Text class="text-sm text-berry">{t("web.shell.sidebar.closeFolderMenu")}</Text>
        </MenuItem>
      </If>
    </ContextMenu>
  );
}

function WorktreeContextMenu(props: { group: WorktreeGroup; setFold: (key: string, expanded: boolean) => void; trigger: JSX.Element }) {
  return (
    <ContextMenu trigger={props.trigger} popupClass={menuPopupClass}>
      <MenuItem
        onSelect={() => {
          props.setFold(groupFoldKey(props.group), true);
          act({ type: "new_chat_at", path: props.group.path });
        }}
        class={menuItemClass}
      >
        <Text class="text-sm text-ink">{t("web.shell.sidebar.newChatHere")}</Text>
      </MenuItem>
      <MenuItem
        onSelect={() => {
          props.setFold(groupFoldKey(props.group), true);
          act({ type: "new_terminal_at", path: props.group.path });
        }}
        class={menuItemClass}
      >
        <Text class="text-sm text-ink">{t("web.shell.sidebar.newTerminalHere")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void hostApi.reveal(props.group.path)} class={menuItemClass}>
        <Text class="text-sm text-ink">{t("web.shell.sidebar.revealInFinder")}</Text>
      </MenuItem>
      <MenuItem onSelect={() => void Clipboard.writeText(props.group.path)} class={menuItemClass}>
        <Text class="text-sm text-ink">{t("web.shell.sidebar.copyPath")}</Text>
      </MenuItem>
      <If when={!props.group.isMain}>
        <MenuSeparator class={menuSeparatorClass} />
        <MenuItem onSelect={() => act({ type: "remove_worktree", path: props.group.path, force: false })} class={menuDangerItemClass}>
          <Text class="text-sm text-berry">{t("web.shell.sidebar.removeWorktree")}</Text>
        </MenuItem>
      </If>
    </ContextMenu>
  );
}

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

function NewAtMenu(props: { menuKey: string; name: string; path: string; foldKey: string; testKey: string; ctx: SidebarTreeCtx }) {
  const isOpen = () => props.ctx.openMenuKey() === props.menuKey;
  return (
    <Menu
      open={isOpen()}
      onOpenChange={(e) => {
        if (e.open) props.ctx.setOpenMenuKey(props.menuKey);
        else if (props.ctx.openMenuKey() === props.menuKey) props.ctx.setOpenMenuKey(null);
      }}
      placement="bottom"
      align="end"
      offset={4}
      popupClass={`${menuPopupClass} ${motionClass("transition-opacity duration-120 ease-out")}`}
      popupStartingClass={popupTransition("opacity-0")}
      popupEndingClass={popupTransition("opacity-0")}
      trigger={
        <View
          testID={`sidebar-new-${props.testKey}`}
          accessibilityLabel={t("web.shell.sidebar.newMenu", { name: props.name })}
          tooltip={<Bubble text={t("web.shell.sidebar.newMenu", { name: props.name })} />}
          class={`size-5 shrink-0 items-center justify-center rounded-sm ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-selected aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus`}
        >
          <Icon name="add" size={12} tone="muted" />
        </View>
      }
    >
      <MenuItem
        testID={`sidebar-new-chat-${props.testKey}`}
        onSelect={() => {
          props.ctx.setFold(props.foldKey, true);
          act({ type: "new_chat_at", path: props.path });
        }}
        class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
      >
        <Icon name="chat" size={13} tone="muted" />
        <Text class="text-sm text-ink">{t("web.shell.sidebar.newChatHere")}</Text>
      </MenuItem>
      <MenuItem
        testID={`sidebar-new-term-${props.testKey}`}
        onSelect={() => {
          props.ctx.setFold(props.foldKey, true);
          act({ type: "new_terminal_at", path: props.path });
        }}
        class="h-7 flex-row items-center gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover"
      >
        <Icon name="terminal" size={13} tone="muted" />
        <Text class="text-sm text-ink">{t("web.shell.sidebar.newTerminalHere")}</Text>
      </MenuItem>
    </Menu>
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

  return (
    <View class="gap-px">
      <WorktreeContextMenu
        group={props.group}
        setFold={props.ctx.setFold}
        trigger={
          <View
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
            <View class="size-5 shrink-0 items-center justify-center">
              <If when={expandable()}>
                <ChevronButton
                  testID={`sidebar-wt-toggle-${props.group.label}`}
                  expanded={expanded()}
                  label={
                    expanded()
                      ? t("web.shell.sidebar.collapseItem", { name: props.group.label })
                      : t("web.shell.sidebar.expandItem", { name: props.group.label })
                  }
                  onToggle={() => props.ctx.toggleFold(groupFoldKey(props.group), expanded())}
                />
              </If>
            </View>
            <Button
              onPress={() => act({ type: "activate_path", path: props.group.path })}
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

function RepoNodeRow(props: { repo: RepoNode; parentHint?: string | undefined; ctx: SidebarTreeCtx }) {
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

  return (
    <View class={`gap-px rounded-lg border py-0.5 ${showActiveCard() ? "border-line bg-elevated" : "border-transparent"}`}>
      <RepoContextMenu
        repo={props.repo}
        ctx={props.ctx}
        trigger={
          <View
            onMouseEnter={() => props.ctx.setHoveredKey(rowKey())}
            onMouseLeave={() => {
              if (props.ctx.hoveredKey() === rowKey()) props.ctx.setHoveredKey(null);
            }}
            tooltip={<Bubble text={repoTip()} />}
            class={`relative min-h-11 flex-row items-start gap-1 rounded-md py-1.5 pr-1.5 pl-1.5 ${isRepoSelected() ? "bg-selected" : "hover:bg-hover"}`}
          >
            <If when={isRepoSelected()}>
              <ActiveBar />
            </If>
            <View class="mt-0.5 size-5 shrink-0 items-center justify-center">
              <If when={expandable()}>
                <ChevronButton
                  testID={`sidebar-repo-toggle-${props.repo.name}`}
                  expanded={expanded()}
                  label={
                    expanded() ? t("web.shell.sidebar.collapseItem", { name: props.repo.name }) : t("web.shell.sidebar.expandItem", { name: props.repo.name })
                  }
                  onToggle={() => props.ctx.toggleFold(repoFoldKey(props.repo), expanded())}
                />
              </If>
            </View>
            <Button
              onPress={() => act({ type: "activate_path", path: props.repo.path })}
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
  const rail = frame("rail", railFrameSchema);
  const files = frame("files", filesFrameSchema);
  const git = frame("git", gitFrameSchema);
  const vvRepos = signal<VvRepo[]>([]);
  const hostParams = readHostParams();
  const isInspector = hostParams.role === "inspector";
  const board = isInspector ? () => null : sliceFrame("board");
  const sessionsSlice = isInspector ? () => null : sliceFrame("sessions");
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
    if (hostParams.role !== "inspector") {
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
  }

  const panel = () => rail()?.panel ?? "files";

  const engineLogoSrc = (agent: string | undefined) => {
    const dir = assetsDir();
    return dir ? engineLogoUrl(dir, agent) : undefined;
  };

  const gitTab = signal<GitTab>("changes");
  if (hostParams.role === "inspector") {
    const showFiles = computed(() => panel() === "files");
    const showGit = computed(() => panel() === "git");
    const conflictCount = computed(() => git()?.conflicts?.length ?? 0);
    const gitCount = computed(() => (git()?.staged?.length ?? 0) + (git()?.changes?.length ?? 0) + conflictCount());
    const currentView = computed(() => (panel() === "git" ? `git:${gitTab()}` : panel()));

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
          <Each of={inspectorTabs} key={(item) => item.id}>
            {(item) => {
              const isCur = () => currentView() === item().id;
              const count = () => item().badge?.() ?? 0;
              const isDanger = () => Boolean(item().danger?.());
              return (
                <Button
                  onPress={() => item().onSelect()}
                  selected={isCur()}
                  accessibilityLabel={count() > 0 ? `${item().label} (${count()})` : item().label}
                  tooltip={<Bubble text={item().tip} />}
                  class={`h-6 flex-row items-center justify-center gap-1 rounded-md px-2 ${motionClass("transition-opacity duration-120 ease-out")} active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus ${
                    isCur() ? "bg-selected" : "bg-transparent hover:bg-hover"
                  }`}
                >
                  <Text class={`text-xs font-medium ${isCur() ? "text-ink" : "text-muted"}`}>{item().label}</Text>
                  <If when={count() > 0}>
                    <View class={`h-4 min-w-4 items-center justify-center rounded-full px-1 ${isDanger() ? "bg-bad-soft" : "bg-hover"}`}>
                      <Text class={`text-2xs font-semibold tabular-nums ${isDanger() ? "text-berry" : isCur() ? "text-ink" : "text-muted"}`}>
                        {String(count())}
                      </Text>
                    </View>
                  </If>
                </Button>
              );
            }}
          </Each>
        </View>
        <If when={showFiles()}>
          <FileTree frame={files()} />
        </If>
        <If when={showGit()}>
          <GitPanel frame={git()} tab={gitTab()} />
        </If>
      </View>
    );
  }

  const activePath = computed(() => normPath(rail()?.projects.find((proj) => proj.active)?.path ?? files()?.root));

  const repoTree = computed((): RepoNode[] => {
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
  });

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

  const detailRepo = computed((): RepoDetailTarget | null => {
    const path = detailRepoPath();
    if (!path) return null;
    const repo = orderedRepos().find((r) => r.path === path);
    if (!repo) return null;
    const vv = vvRepoByPath().get(repo.path);
    const openIssues = issues().filter((i) => i.repo === repo.name && i.status !== "done" && i.status !== "canceled").length;
    const activeSessions = sessions().filter(
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
  });

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
