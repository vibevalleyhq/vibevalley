// The palette: commands (⇧⌘P), files (⌘P, answered by Rust's FileIndex)
// and project search (⇧⌘F), all on nsh's Command.
import { Text, View } from "nsh";
import { Command, type CommandItem } from "nsh/base";

import { act, frame } from "../bridge";
import { tok, type as ty } from "../tokens";

type Item = CommandItem & { detail?: string };
type PaletteFrame = { mode: "commands" | "files" | "search"; query: string; items: Item[]; loading: boolean; note: string | null };

const placeholders = {
  commands: "Type a command…",
  files: "Go to file…",
  search: "Search in project…",
};

export function Palette() {
  const f = frame<PaletteFrame>("palette");
  const p = () => tok();
  const mode = () => f()?.mode ?? "commands";
  return (
    <View style={{ flex: 1, backgroundColor: p().surface }}>
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
        searchBarClass="flex-row items-center gap-2 px-3"
        searchStyle={{ height: 44, flex: 1, fontSize: 14, color: p().ink }}
        searchBarStyle={{ borderBottomWidth: 1, borderBottomColor: p().border }}
        listClass="flex-1 p-1"
        groupStyle={{ ...ty.label, color: p().muted, paddingHorizontal: 8, paddingVertical: 6 }}
        itemClass="group h-9 flex-row items-center rounded-md px-2 focus:bg-[#f0f0f0] dark:focus:bg-[#232326]"
        empty={
          <Text style={{ ...ty.body, color: p().muted, padding: 16, textAlign: "center" }}>
            {f()?.note ?? (mode() === "files" ? "No file matches." : mode() === "search" ? "No matches." : "No command matches.")}
          </Text>
        }
        renderItem={(entry) => (
          <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text
              style={{
                ...ty.body,
                fontSize: 13,
                color: p().ink,
                numberOfLines: 1,
                flexShrink: 1,
                fontFamily: mode() === "search" ? ty.mono.fontFamily : undefined,
              }}
            >
              {entry.label}
            </Text>
            <Text style={{ ...ty.label, color: p().muted, numberOfLines: 1, flex: 1, textOverflow: "ellipsis-start" }}>
              {f()?.items.find((i) => i.id === entry.id)?.detail ?? ""}
            </Text>
            <Text style={{ ...ty.label, color: p().muted }}>{entry.shortcutLabel ?? ""}</Text>
          </View>
        )}
      />
    </View>
  );
}
