// The file tree: nsh's Tree over the frame Rust keeps (directories load as
// they expand), with git status colors.
import { Clipboard, computed, Text, View } from "nsh";
import { ContextMenu, MenuItem, MenuSeparator, Tree, type TreeItem } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../design/Icon";
import { motionClass } from "../design/motion";
import { SkeletonBar, SkeletonLines, useDelayedBusy } from "../design/Skeleton";
import { act, hostApi } from "../infra/bridge";
import { gitToneIconTone, gitToneTextClass, menuItemClass, menuPopupClass, menuSeparatorClass, PanelEmpty, SectionHead, ShellIconButton } from "./chrome";

export type FileItem = TreeItem & { tone?: string; hidden?: boolean; loading?: boolean; children?: FileItem[] };
export type FilesFrame = { root?: string; name?: string; items: FileItem[]; expanded?: string[]; selected?: string | null; loading?: boolean };

function index(items: FileItem[], into: Map<string, FileItem>) {
  for (const i of items) {
    into.set(i.id, i);
    if (i.children) index(i.children, into);
  }
  return into;
}

export function FileTree(props: { frame: FilesFrame | null }) {
  const byId = computed(() => index(props.frame?.items ?? [], new Map()));
  const hasItems = computed(() => (props.frame?.items.length ?? 0) > 0);
  const isLoadingTree = computed(() => !props.frame || (props.frame.items.length === 0 && props.frame.loading === true));
  const showLoading = useDelayedBusy(isLoadingTree);
  const relPath = (abs: string) => {
    const root = props.frame?.root?.replace(/\/+$/u, "");
    return root && abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
  };
  const dirOf = (abs: string, folder: boolean) => {
    if (folder) return abs;
    const i = abs.lastIndexOf("/");
    return i > 0 ? abs.slice(0, i) : (props.frame?.root ?? abs);
  };
  return (
    <View class="flex-1">
      <SectionHead
        title={props.frame?.name ?? t("web.shell.fileTree.title")}
        borderBottom
        right={
          <If when={(props.frame?.expanded?.length ?? 0) > 0}>
            <ShellIconButton
              label={t("web.shell.fileTree.collapseAllDirs")}
              icon="collapseAll"
              onPress={() => {
                for (const dir of [...(props.frame?.expanded ?? [])].toReversed()) {
                  act({ type: "collapse_dir", path: dir });
                }
              }}
            />
          </If>
        }
      />
      <If
        when={hasItems()}
        else={
          <If when={isLoadingTree()} else={<PanelEmpty text={t("web.shell.fileTree.empty")} />}>
            <If when={showLoading()} else={<View class="flex-1" />}>
              <SkeletonLines
                testID="file-tree-skeleton"
                accessibilityLabel={t("web.shell.fileTree.loading")}
                surface="side"
                rows={["58%", "74%", "64%", "48%", "70%"]}
                indent={[0, 14, 14, 28, 0]}
                class="px-3 py-2.5"
              />
            </If>
          </If>
        }
      >
        <Tree
          items={props.frame?.items ?? []}
          expanded={props.frame?.expanded ?? []}
          selected={props.frame?.selected ?? null}
          accessibilityLabel={t("web.shell.fileTree.title")}
          class="flex-1"
          listClass="px-1.5 py-1.5"
          itemClass="group h-6.5 rounded-md hover:bg-hover selected:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
          onExpand={({ id }) => act({ type: "expand_dir", path: id })}
          onCollapse={({ id }) => act({ type: "collapse_dir", path: id })}
          onSelectedChange={({ selected }) => {
            const item = byId().get(selected);
            if (item && !item.children && item.tone !== "placeholder" && item.loading !== true) act({ type: "open_file", path: selected });
          }}
          onAction={({ id }) => {
            const item = byId().get(id);
            if (item && !item.children && item.tone !== "placeholder" && item.loading !== true) act({ type: "open_file", path: id });
          }}
          renderItem={(entry) => {
            const item = () => byId().get(entry.id);
            const isPlaceholder = () => item()?.tone === "placeholder";
            const isLoadingRow = () => item()?.loading === true || (isPlaceholder() && entry.id.endsWith("/__loading"));
            const labelClass = () => {
              const cur = item();
              if (cur?.tone === "placeholder") return "text-xs italic text-faint";
              const weight = entry.folder ? "font-medium" : "font-normal";
              if (cur?.hidden === true && cur.tone === "clean") return `text-sm ${weight} text-muted`;
              return `text-sm ${weight} ${gitToneTextClass(cur?.tone)}`;
            };
            const iconTone = () => {
              const tone = item()?.tone;
              if (entry.folder) {
                if (tone === "dirty") return "warn-ink";
                if (tone === "ignored") return "faint";
                return "muted";
              }
              if (tone && tone !== "clean") return gitToneIconTone(tone);
              return "muted";
            };
            const renderRow = () => (
              <View class="h-6.5 flex-row items-center gap-1.5 pr-2" style={{ paddingLeft: 6 + entry.depth * 14 }}>
                <View class="size-3.5 shrink-0 items-center justify-center">
                  <If when={entry.folder}>
                    <View
                      class={`size-3.5 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")} group-aria-expanded:rotate-90`}
                    >
                      <Icon name="expand" size={10} tone="muted" />
                    </View>
                  </If>
                </View>
                <If when={!isPlaceholder() && !isLoadingRow()}>
                  <View class="size-3.5 shrink-0 items-center justify-center">
                    <Icon name={entry.folder ? "folder" : "file"} size={13} tone={iconTone()} />
                  </View>
                </If>
                <If when={isLoadingRow()} else={<Text class={`min-w-0 flex-1 truncate ${labelClass()}`}>{entry.label}</Text>}>
                  <SkeletonBar testID="file-tree-row-skeleton" surface="side" class="h-3 w-24" />
                </If>
                <If when={entry.folder && item()?.tone === "dirty"}>
                  <View class="size-1.5 shrink-0 rounded-full bg-wheat" />
                </If>
              </View>
            );
            return (
              <If
                when={isPlaceholder() || isLoadingRow()}
                else={
                  <ContextMenu trigger={renderRow()} popupClass={menuPopupClass}>
                    <MenuItem onSelect={() => void Clipboard.writeText(relPath(entry.id))} class={menuItemClass}>
                      <Text class="text-xs text-ink">{t("web.shell.fileTree.copyRelPath")}</Text>
                    </MenuItem>
                    <MenuItem onSelect={() => void Clipboard.writeText(entry.id)} class={menuItemClass}>
                      <Text class="text-xs text-ink">{t("web.shell.fileTree.copyAbsPath")}</Text>
                    </MenuItem>
                    <MenuSeparator class={menuSeparatorClass} />
                    <MenuItem onSelect={() => void hostApi.reveal(entry.id)} class={menuItemClass}>
                      <Text class="text-xs text-ink">{t("web.shell.fileTree.revealInFinder")}</Text>
                    </MenuItem>
                    <MenuItem onSelect={() => act({ type: "new_terminal_at", path: dirOf(entry.id, entry.folder) })} class={menuItemClass}>
                      <Text class="text-xs text-ink">{t("web.shell.fileTree.newTerminalInDir")}</Text>
                    </MenuItem>
                  </ContextMenu>
                }
              >
                {renderRow()}
              </If>
            );
          }}
        />
      </If>
    </View>
  );
}
