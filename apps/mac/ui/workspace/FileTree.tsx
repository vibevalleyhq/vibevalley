// The file tree: nsh's Tree over the frame Rust keeps (directories load as
// they expand), with git status colors.
import { Clipboard, Text, View } from "nsh";
import { ContextMenu, MenuItem, MenuSeparator, Tree, type TreeItem } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { contextMenuItemStyle, contextMenuPopupStyle, Empty, IconButton, SectionHead, SurfaceIcon, toneColor } from "../design/surface";
import { tok } from "../design/tokens";
import { act, hostApi } from "../infra/bridge";

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
  const p = () => tok();
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
  const itemStyle = contextMenuItemStyle;
  return (
    <View style={{ flex: 1 }}>
      <SectionHead
        title={props.frame?.name ?? t("web.shell.fileTree.title")}
        borderBottom
        right={
          (props.frame?.expanded?.length ?? 0) > 0 ? (
            <IconButton
              label={t("web.shell.fileTree.collapseAllDirs")}
              icon="collapse-all"
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
        <Empty text={props.frame?.loading === true || !props.frame ? t("web.shell.fileTree.loading") : t("web.shell.fileTree.empty")} />
      ) : (
        <Tree
          items={props.frame.items}
          expanded={props.frame.expanded ?? []}
          selected={props.frame.selected ?? null}
          accessibilityLabel={t("web.shell.fileTree.title")}
          class="flex-1"
          listClass="px-1.5 py-1.5"
          itemClass="group rounded-md hover:bg-hover selected:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
          itemStyle={{ height: 26 }}
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
            const labelColor = () => {
              const cur = item();
              if (cur?.tone === "placeholder") return p().faint;
              if (cur?.hidden === true && cur.tone === "clean") return p().text;
              return toneColor(p(), cur?.tone);
            };
            const iconColor = () => {
              const tone = item()?.tone;
              if (entry.folder) {
                if (tone === "dirty") return p().alert;
                if (tone === "ignored") return p().faint;
                return p().text;
              }
              if (tone && tone !== "clean") return toneColor(p(), tone);
              return p().muted;
            };
            const row = (
              <View
                style={{
                  height: 26,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: 5,
                  paddingLeft: 6 + entry.depth * 14,
                  paddingRight: 8,
                }}
              >
                <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  {entry.folder ? (
                    <View
                      class="transition-transform duration-120 ease-out group-aria-expanded:rotate-90"
                      style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center" }}
                    >
                      <SurfaceIcon name="chevron-right" size={10} color={p().muted} />
                    </View>
                  ) : null}
                </View>
                {!isPlaceholder() ? (
                  <View style={{ width: 14, height: 14, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <SurfaceIcon name={entry.folder ? "folder" : "file"} size={13} color={iconColor()} />
                  </View>
                ) : null}
                <Text
                  style={{
                    fontSize: isPlaceholder() ? 12 : 13,
                    lineHeight: 18,
                    fontWeight: entry.folder ? "500" : "400",
                    color: labelColor(),
                    numberOfLines: 1,
                    flex: 1,
                    minWidth: 0,
                    fontStyle: isPlaceholder() ? "italic" : "normal",
                  }}
                >
                  {entry.label}
                </Text>
                {entry.folder && item()?.tone === "dirty" ? (
                  <View style={{ width: 5, height: 5, borderRadius: 3, backgroundColor: p().alert, flexShrink: 0 }} />
                ) : null}
              </View>
            );
            if (isPlaceholder()) return row;
            return (
              <ContextMenu trigger={row} popupStyle={contextMenuPopupStyle(p())}>
                <MenuItem onSelect={() => void Clipboard.writeText(relPath(entry.id))} style={itemStyle} hoverStyle={{ backgroundColor: p().subtle }}>
                  <Text style={{ fontSize: 12, color: p().ink }}>{t("web.shell.fileTree.copyRelPath")}</Text>
                </MenuItem>
                <MenuItem onSelect={() => void Clipboard.writeText(entry.id)} style={itemStyle} hoverStyle={{ backgroundColor: p().subtle }}>
                  <Text style={{ fontSize: 12, color: p().ink }}>{t("web.shell.fileTree.copyAbsPath")}</Text>
                </MenuItem>
                <MenuSeparator style={{ height: 1, marginVertical: 4, backgroundColor: p().border }} />
                <MenuItem onSelect={() => void hostApi.reveal(entry.id)} style={itemStyle} hoverStyle={{ backgroundColor: p().subtle }}>
                  <Text style={{ fontSize: 12, color: p().ink }}>{t("web.shell.fileTree.revealInFinder")}</Text>
                </MenuItem>
                <MenuItem
                  onSelect={() => act({ type: "new_terminal_at", path: dirOf(entry.id, entry.folder) })}
                  style={itemStyle}
                  hoverStyle={{ backgroundColor: p().subtle }}
                >
                  <Text style={{ fontSize: 12, color: p().ink }}>{t("web.shell.fileTree.newTerminalInDir")}</Text>
                </MenuItem>
              </ContextMenu>
            );
          }}
        />
      )}
    </View>
  );
}
