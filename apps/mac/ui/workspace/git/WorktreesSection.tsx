import { Clipboard, Text, View } from "nsh";
import { Button, ContextMenu, Input, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import { ActiveBar } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { Bubble } from "../../design/Tip";
import { mix } from "../../design/tone";
import { act, hostApi } from "../../infra/bridge";
import { menuDangerItemClass, menuItemClass, menuPopupClass, menuSeparatorClass, SectionHead, ShellIconButton, startEllipsis } from "../chrome";
import type { GitWorktree, WorktreesSectionCtx } from "./model";

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

export function WorktreesSection(props: { sectionKey: string; title: string; borderTop: boolean; showNotice: boolean; ctx: WorktreesSectionCtx }) {
  return (
    <View>
      <SectionHead
        title={props.title}
        count={props.ctx.worktreesCount()}
        collapsible
        expanded={props.ctx.isOpen(props.sectionKey)}
        onToggle={() => props.ctx.toggleSection(props.sectionKey)}
        borderTop={props.borderTop}
        borderBottom={props.ctx.isOpen(props.sectionKey) && props.ctx.worktreesCount() > 0 && !props.ctx.addingWt()}
        right={
          <ShellIconButton
            icon="add"
            label={props.ctx.creatingWt() ? t("web.shell.git.creatingWorktree") : t("web.shell.git.newWorktree")}
            disabled={props.ctx.creatingWt()}
            onPress={() => {
              const next = !props.ctx.addingWt();
              props.ctx.setAddingWt(next);
              if (next) props.ctx.ensureOpen(props.sectionKey);
            }}
          />
        }
      />
      <If when={props.ctx.isOpen(props.sectionKey)}>
        <View>
          <If when={props.ctx.addingWt()}>
            <View class="flex-row items-center gap-1.5 border-b border-line px-3 pt-0.5 pb-2">
              <Input
                value={props.ctx.newBranch()}
                onChange={({ value }) => props.ctx.setNewBranch(value)}
                onSubmit={props.ctx.submitNewWorktree}
                placeholder={t("web.shell.git.newBranchPlaceholder")}
                class="h-6.5 flex-1 rounded-md border border-line bg-elevated px-2 text-xs text-ink placeholder:text-faint hover:border-faint focus:border-focus"
              />
              <Button
                onPress={props.ctx.submitNewWorktree}
                disabled={!props.ctx.canCreate()}
                class={`h-6.5 justify-center rounded-md border px-2.5 ${
                  !props.ctx.canCreate()
                    ? "border-line bg-hover"
                    : "border-accent bg-accent hover:bg-accent-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus"
                }`}
              >
                <Text class={`text-2xs font-medium ${!props.ctx.canCreate() ? "text-muted" : "text-page"}`}>{t("web.shell.git.createBtn")}</Text>
              </Button>
            </View>
          </If>
          <If when={props.showNotice ? props.ctx.removeNotice() : null}>
            {(notice) => (
              <View class="border-b border-line bg-ok-soft px-3 py-1.5">
                <Text class="text-2xs text-ok-ink">{notice()}</Text>
              </View>
            )}
          </If>
          <Each of={props.ctx.worktrees()} key={(w) => w.path}>
            {(w) => {
              const meta = () => props.ctx.worktreeMeta(w().path);
              return (
                <WorktreeRow
                  w={w()}
                  badge={meta().badge}
                  running={meta().running}
                  pendingRemove={props.ctx.pendingRemove}
                  setPendingRemove={props.ctx.setPendingRemove}
                  removingPath={props.ctx.removingPath}
                  removeError={props.ctx.removeError}
                  onConfirmRemove={props.ctx.startRemove}
                />
              );
            }}
          </Each>
        </View>
      </If>
    </View>
  );
}
