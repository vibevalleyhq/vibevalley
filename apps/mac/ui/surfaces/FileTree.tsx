// The file tree: nsh's Tree over the frame Rust keeps (directories load as
// they expand), with git status colors.
import { Text, View } from "nsh";
import { Tree, type TreeItem } from "nsh/base";

import { act } from "../bridge";
import { tok, type as ty } from "../tokens";
import { Empty, SectionHead, toneColor } from "./shared";

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
  return (
    <View style={{ flex: 1 }}>
      <SectionHead title={props.frame?.name ?? "Files"} />
      {!props.frame || props.frame.items.length === 0 ? (
        <Empty text={props.frame?.loading || !props.frame ? "Reading the project…" : "This folder is empty."} />
      ) : (
        <Tree
          items={props.frame.items}
          expanded={props.frame.expanded ?? []}
          selected={props.frame.selected ?? null}
          accessibilityLabel="Files"
          class="flex-1"
          listClass="px-1 pb-2"
          itemClass="group h-6 rounded-md hover:bg-[#f0f0f0] dark:hover:bg-[#232326] selected:bg-[#e8eefb] dark:selected:bg-[#1e2a44] focus-visible:outline-2 focus-visible:outline-[#4d8dff]"
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
            const item = byId().get(entry.id);
            const color = toneColor(p(), item?.tone);
            return (
              <View style={{ height: 24, flexDirection: "row", alignItems: "center", gap: 4, paddingLeft: 6 + entry.depth * 14 }}>
                <Text class="transition-transform group-aria-expanded:rotate-90" style={{ width: 12, fontSize: 10, color: p().muted }}>
                  {entry.folder ? "›" : ""}
                </Text>
                <Text
                  style={{
                    ...ty.body,
                    fontSize: 13,
                    color: item?.hidden && item.tone === "clean" ? p().text : color,
                    numberOfLines: 1,
                    flex: 1,
                    fontStyle: item?.tone === "placeholder" ? "italic" : "normal",
                  }}
                >
                  {entry.label}
                </Text>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}
