// The palette: commands (⌘K / ⇧⌘P), files (⌘P, answered by Rust's FileIndex)
// and project search (⇧⌘F), all on nsh's Command.
import { Text, View } from "nsh";
import { Command, type CommandItem } from "nsh/base";

import { act, frame } from "../bridge";
import { tok, type as ty } from "../tokens";
import { SurfaceIcon, type SurfaceIconName } from "./shared";

type PaletteMode = "commands" | "files" | "search";
type Item = CommandItem & { detail?: string };
type PaletteFrame = { mode: PaletteMode; query: string; items: Item[]; loading: boolean; note: string | null };

const placeholders: Record<PaletteMode, string> = {
  commands: "输入命令或跳转到任意页面…",
  files: "跳转到文件…",
  search: "在项目中搜索文本…",
};

const modeLabels: Record<PaletteMode, string> = {
  commands: "命令",
  files: "文件",
  search: "搜索",
};

const modeHints: readonly { mode: PaletteMode; keys: string; label: string }[] = [
  { mode: "commands", keys: "⌘K", label: "命令" },
  { mode: "files", keys: "⌘P", label: "文件" },
  { mode: "search", keys: "⇧⌘F", label: "搜索" },
];

const modeIcons: Record<PaletteMode, SurfaceIconName> = {
  commands: "commands",
  files: "file",
  search: "search",
};

function KeyCap(props: { label: string; surface?: "tile" | "surface"; active?: boolean }) {
  const p = () => tok();
  return (
    <View
      style={{
        height: 19,
        minWidth: 20,
        paddingHorizontal: 5,
        borderRadius: 4,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: props.surface === "surface" ? p().surface : p().tile,
        borderWidth: 1,
        borderColor: p().border,
        flexShrink: 0,
      }}
    >
      <Text style={{ ...ty.mono, fontSize: 10.5, color: props.active ? p().ink : p().muted }}>{props.label}</Text>
    </View>
  );
}

export function Palette() {
  const f = frame<PaletteFrame>("palette");
  const p = () => tok();
  const mode = (): PaletteMode => f()?.mode ?? "commands";

  const detailFor = (id: string): string => {
    const list = f()?.items;
    if (!list) return "";
    for (const item of list) {
      if (item.id === id) return item.detail ?? "";
    }
    return "";
  };

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: p().surface,
        borderWidth: 1,
        borderColor: p().border,
        borderRadius: 12,
        overflow: "hidden",
      }}
    >
      <Command
        items={f()?.items ?? []}
        query={mode() === "commands" ? undefined : (f()?.query ?? "")}
        filterable={mode() === "commands"}
        loading={f()?.loading ?? false}
        autoFocus
        placeholder={placeholders[mode()]}
        accessibilityLabel={mode() === "files" ? "Files" : mode() === "search" ? "Search results" : "Commands"}
        onQueryChange={({ query }) => {
          if (mode() !== "commands") act({ type: mode() === "search" ? "search" : "palette_query", query });
        }}
        onSelect={({ id }) => act({ type: "palette_select", id })}
        onCancel={() => act({ type: "palette_close" })}
        class="flex-1"
        searchPrefix={
          <View style={{ width: 20, height: 20, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <SurfaceIcon name={modeIcons[mode()]} size={15} color={p().muted} />
          </View>
        }
        searchSuffix={
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 0 }}>
            {f()?.loading ? <Text style={{ fontSize: 11, color: p().faint }}>搜索中…</Text> : null}
            <View
              style={{
                height: 20,
                paddingHorizontal: 7,
                borderRadius: 5,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: p().tile,
                borderWidth: 1,
                borderColor: p().border,
              }}
            >
              <Text style={{ fontSize: 11, fontWeight: "500", color: p().muted }}>{modeLabels[mode()]}</Text>
            </View>
          </View>
        }
        searchBarClass="flex-row items-center gap-2.5 px-3.5"
        searchStyle={{ height: 46, flex: 1, fontSize: 14, color: p().ink }}
        searchBarStyle={{ borderBottomWidth: 1, borderBottomColor: p().border }}
        listClass="flex-1 p-1.5"
        groupStyle={{ fontSize: 11, fontWeight: "600", color: p().faint, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 4 }}
        separator
        separatorStyle={{ height: 1, backgroundColor: p().border, marginVertical: 4, marginHorizontal: 8 }}
        itemClass="group h-9 w-full flex-row items-center rounded-md px-2.5 hover:bg-hover focus:bg-selected"
        empty={
          <View style={{ alignItems: "center", justifyContent: "center", paddingVertical: 36, paddingHorizontal: 20, gap: 8 }}>
            <SurfaceIcon name={modeIcons[mode()]} size={20} color={p().faint} />
            <Text style={{ fontSize: 13, color: p().muted, textAlign: "center" }}>
              {f()?.note ?? (mode() === "files" ? "没有匹配的文件。" : mode() === "search" ? "没有匹配结果。" : "没有匹配的命令。")}
            </Text>
          </View>
        }
        renderItem={(entry) => {
          const detail = () => detailFor(entry.id);
          return (
            <View style={{ flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%", minWidth: 0 }}>
              <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
                <View style={{ width: 18, height: 18, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <SurfaceIcon name={modeIcons[mode()]} size={13} color={p().faint} />
                </View>
                <Text
                  style={{
                    fontSize: 13,
                    fontWeight: "500",
                    color: p().ink,
                    numberOfLines: 1,
                    flexShrink: 1,
                    fontFamily: mode() === "search" ? ty.mono.fontFamily : undefined,
                  }}
                >
                  {entry.label}
                </Text>
                {detail() ? (
                  <Text style={{ fontSize: 11, color: p().muted, numberOfLines: 1, flexShrink: 1, textOverflow: "ellipsis-start" }}>{detail()}</Text>
                ) : null}
              </View>
              {entry.shortcutLabel ? <KeyCap label={entry.shortcutLabel} /> : null}
            </View>
          );
        }}
      />
      <View
        style={{
          height: 32,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 14,
          borderTopWidth: 1,
          borderTopColor: p().border,
          backgroundColor: p().canvas,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <KeyCap label="↑↓" surface="surface" />
            <Text style={{ fontSize: 11, color: p().muted }}>选择</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <KeyCap label="↵" surface="surface" />
            <Text style={{ fontSize: 11, color: p().muted }}>执行</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <KeyCap label="Esc" surface="surface" />
            <Text style={{ fontSize: 11, color: p().muted }}>关闭</Text>
          </View>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          {modeHints.map((hint) => {
            const active = () => mode() === hint.mode;
            return (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <KeyCap label={hint.keys} surface="surface" active={active()} />
                <Text style={{ fontSize: 11, fontWeight: active() ? "600" : "400", color: active() ? p().ink : p().faint }}>{hint.label}</Text>
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}
