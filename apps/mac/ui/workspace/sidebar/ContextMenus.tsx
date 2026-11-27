import { Clipboard, Text, View, type JSX } from "nsh";
import { ContextMenu, Menu, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import { motionClass, popupTransition } from "../../design/motion";
import { Bubble } from "../../design/Tip";
import { act, hostApi } from "../../infra/bridge";
import { menuDangerItemClass, menuItemClass, menuPopupClass, menuSeparatorClass } from "../chrome";
import { groupFoldKey, repoFoldKey, type RepoNode, type SidebarTreeCtx, type WorktreeGroup } from "./model";

export function RepoContextMenu(props: { repo: RepoNode; ctx: SidebarTreeCtx; trigger: JSX.Element }) {
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

export function WorktreeContextMenu(props: { group: WorktreeGroup; setFold: (key: string, expanded: boolean) => void; trigger: JSX.Element }) {
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

export function NewAtMenu(props: { menuKey: string; name: string; path: string; foldKey: string; testKey: string; ctx: SidebarTreeCtx }) {
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
