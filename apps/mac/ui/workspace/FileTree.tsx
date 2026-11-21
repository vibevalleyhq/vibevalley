// The file tree: nsh's Tree over the frame Rust keeps (directories load as
// they expand), with git status colors.
import { Clipboard, Text, View } from "nsh";
import { ContextMenu, MenuItem, MenuSeparator, Tree, type TreeItem } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../design/Icon";
import { act, hostApi } from "../infra/bridge";
import { gitToneIconTone, gitToneTextClass, menuItemClass, menuPopupClass, menuSeparatorClass, PanelEmpty, SectionHead, ShellIconButton } from "./chrome";

export type FileItem = TreeItem & { tone?: string; hidden?: boolean; children?: FileItem[] };
export type FilesFrame = { root?: string; name?: string; items: FileItem[]; expanded?: string[]; selected?: string | null; loading?: boolean };

function index(items: FileItem[], into: Map<string, FileItem>) {
  for (const i of items) {
    into.set(i.id, i);
    if (i.children) index(i.children, into);
  }
  return into;
}

export function FileTree(props: { frame: FilesFrame | null }) {
  const byId = () => index(props.frame?.items ?? [], new Map());
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
          (props.frame?.expanded?.length ?? 0) > 0 ? (
            <ShellIconButton
              label={t("web.shell.fileTree.collapseAllDirs")}
              icon="collapseAll"
              onPress={() => {
                for (const dir of [...(props.frame?.expanded ?? [])].toReversed()) {
                  act({ type: "collapse_dir", path: dir });
                }
              }}
            />
          ) : undefined
        }
      />
      {!props.frame || props.frame.items.length === 0 ? (
        <PanelEmpty text={props.frame?.loading === true || !props.frame ? t("web.shell.fileTree.loading") : t("web.shell.fileTree.empty")} />
      ) : (
        <Tree
          items={props.frame.items}
          expanded={props.frame.expanded ?? []}
          selected={props.frame.selected ?? null}
          accessibilityLabel={t("web.shell.fileTree.title")}
          class="flex-1"
          listClass="px-1.5 py-1.5"
          itemClass="group h-6.5 rounded-md hover:bg-hover selected:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
          onExpand={({ id }) => act({ type: "expand_dir", path: id })}
          onCollapse={({ id }) => act({ type: "collapse_dir", path: id })}
          onSelectedChange={({ selected }) => {
            const item = byId().get(selected);
            if (item && !item.children && item.tone !== "placeholder") act({ type: "open_file", path: selected });
          }}
          onAction={({ id }) => {
            const item = byId().get(id);
            if (item && !item.children) act({ type: "open_file", path: id });
          }}
          renderItem={(entry) => {
            const item = () => byId().get(entry.id);
            const isPlaceholder = () => item()?.tone === "placeholder";
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
            const row = (
              <View class="h-6.5 flex-row items-center gap-1.5 pr-2" style={{ paddingLeft: 6 + entry.depth * 14 }}>
                <View class="size-3.5 shrink-0 items-center justify-center">
                  {entry.folder ? (
                    <View class="size-3.5 items-center justify-center transition-transform duration-120 ease-out group-aria-expanded:rotate-90">
                      <Icon name="expand" size={10} tone="muted" />
                    </View>
                  ) : null}
                </View>
                {!isPlaceholder() ? (
                  <View class="size-3.5 shrink-0 items-center justify-center">
                    <Icon name={entry.folder ? "folder" : "file"} size={13} tone={iconTone()} />
                  </View>
                ) : null}
                <Text class={`min-w-0 flex-1 truncate ${labelClass()}`}>{entry.label}</Text>
                {entry.folder && item()?.tone === "dirty" ? <View class="size-1.5 shrink-0 rounded-full bg-wheat" /> : null}
              </View>
            );
            if (isPlaceholder()) return row;
            return (
              <ContextMenu trigger={row} popupClass={menuPopupClass}>
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
            );
          }}
        />
      )}
    </View>
  );
}
