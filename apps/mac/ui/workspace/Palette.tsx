import { computed, Text, View } from "nsh";
import { Command, type CommandItem } from "nsh/base";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { HostPaletteMode as HostPaletteModeSchema } from "@vibevalley/protocol/schema";

import { Icon } from "../design/Icon";
import type { IconName } from "../design/icons";
import { SkeletonLines, useDelayedBusy } from "../design/Skeleton";
import { act, frame } from "../infra/bridge";
import { startEllipsis } from "./chrome";

type PaletteMode = z.infer<typeof HostPaletteModeSchema>;
type Item = CommandItem & { detail?: string };

const paletteItemSchema: z.ZodType<Item> = z.object({
  id: z.string(),
  label: z.string(),
  keywords: z.exactOptional(z.array(z.string())),
  group: z.exactOptional(z.string()),
  shortcut: z.exactOptional(z.string()),
  shortcutLabel: z.exactOptional(z.string()),
  disabled: z.exactOptional(z.boolean()),
  detail: z.exactOptional(z.string()),
});

const paletteFrameSchema = z.object({
  mode: HostPaletteModeSchema,
  query: z.string(),
  items: z.array(paletteItemSchema),
  loading: z.boolean(),
  note: z.string().nullable(),
});

const modeIcons: Record<PaletteMode, IconName> = {
  commands: "command",
  files: "file",
  search: "search",
};

const modeKeys: readonly { mode: PaletteMode; keys: string }[] = [
  { mode: "commands", keys: "⌘K" },
  { mode: "files", keys: "⌘P" },
  { mode: "search", keys: "⇧⌘F" },
];

function KeyCap(props: { label: string; surface?: "tile" | "surface"; active?: boolean }) {
  return (
    <View
      class={`h-5 min-w-5 shrink-0 items-center justify-center rounded-sm border border-line px-1.5 ${
        props.surface === "surface" ? "bg-elevated" : "bg-hover"
      }`}
    >
      <Text class={`font-mono text-2xs ${props.active === true ? "text-ink" : "text-muted"}`}>{props.label}</Text>
    </View>
  );
}

export function Palette() {
  const f = frame("palette", paletteFrameSchema);
  const mode = (): PaletteMode => f()?.mode ?? "commands";
  const showEmptySkeleton = useDelayedBusy(() => f()?.loading === true && (f()?.items.length ?? 0) === 0);

  const detailById = computed(() => {
    const map = new Map<string, string>();
    for (const item of f()?.items ?? []) {
      if (item.detail) map.set(item.id, item.detail);
    }
    return map;
  });
  const detailFor = (id: string): string => detailById().get(id) ?? "";

  return (
    <View testID="palette-root" class="flex-1 overflow-hidden rounded-xl border border-line bg-elevated">
      <View class="relative min-h-0 flex-1">
        <Command
          items={f()?.items ?? []}
          query={mode() === "commands" ? undefined : (f()?.query ?? "")}
          filterable={mode() === "commands"}
          loading={f()?.loading ?? false}
          autoFocus
          placeholder={t(`web.shell.palette.placeholder.${mode()}`)}
          accessibilityLabel={t(`web.shell.palette.a11y.${mode()}`)}
          onQueryChange={({ query }) => {
            if (mode() !== "commands") act({ type: mode() === "search" ? "search" : "palette_query", query });
          }}
          onSelect={({ id }) => act({ type: "palette_select", id })}
          onCancel={() => act({ type: "palette_close" })}
          class="flex-1"
          searchPrefix={
            <View class="size-5 shrink-0 items-center justify-center">
              <Icon name={modeIcons[mode()]} size={15} tone="muted" />
            </View>
          }
          searchSuffix={
            <View class="shrink-0 flex-row items-center gap-1.5">
              <If when={f()?.loading === true}>
                <Text class="text-2xs text-faint">{t("web.shell.palette.searching")}</Text>
              </If>
              <View class="h-5 items-center justify-center rounded-sm border border-line bg-hover px-1.5">
                <Text class="text-2xs font-medium text-muted">{t(`web.shell.palette.mode.${mode()}`)}</Text>
              </View>
            </View>
          }
          searchBarClass="flex-row items-center gap-2.5 border-b border-line px-3.5"
          searchClass="h-11 flex-1 text-base text-ink placeholder:text-faint"
          listClass="flex-1 p-1.5"
          groupClass="px-2.5 pt-2 pb-1 text-2xs font-semibold text-faint"
          separator
          separatorClass="mx-2 my-1 h-px bg-line"
          itemClass="group h-9 w-full flex-row items-center rounded-md px-2.5 hover:bg-hover focus:bg-selected"
          empty={
            <View class="items-center justify-center gap-2 px-5 py-9">
              <Icon name={modeIcons[mode()]} size={20} tone="faint" />
              <Text class="text-center text-sm text-muted">{f()?.note ?? t(`web.shell.palette.empty.${mode()}`)}</Text>
            </View>
          }
          renderItem={(entry) => {
            const detail = () => detailFor(entry.id);
            return (
              <View class="w-full min-w-0 flex-1 flex-row items-center justify-between gap-2.5">
                <View class="min-w-0 flex-1 flex-row items-center gap-2">
                  <View class="size-4.5 shrink-0 items-center justify-center">
                    <Icon name={modeIcons[mode()]} size={13} tone="faint" />
                  </View>
                  <Text class={`shrink truncate text-sm font-medium text-ink ${mode() === "search" ? "font-mono" : ""}`}>{entry.label}</Text>
                  <If when={detail()}>
                    {(d) => (
                      <Text class="shrink truncate text-2xs text-muted" style={startEllipsis}>
                        {d()}
                      </Text>
                    )}
                  </If>
                </View>
                <If when={entry.shortcutLabel}>{(label) => <KeyCap label={label()} />}</If>
              </View>
            );
          }}
        />
        <If when={showEmptySkeleton()}>
          <View class="pointer-events-none absolute top-12 right-0 bottom-0 left-0 px-4 py-3">
            <SkeletonLines testID="palette-skeleton" rows={["62%", "48%", "74%", "56%"]} gap="md" />
          </View>
        </If>
      </View>
      <View class="h-8 flex-row items-center justify-between border-t border-line bg-side px-3.5">
        <View class="flex-row items-center gap-2.5">
          <View class="flex-row items-center gap-1">
            <KeyCap label="↑↓" surface="surface" />
            <Text class="text-2xs text-muted">{t("web.shell.palette.footer.select")}</Text>
          </View>
          <View class="flex-row items-center gap-1">
            <KeyCap label="↵" surface="surface" />
            <Text class="text-2xs text-muted">{t("web.shell.palette.footer.run")}</Text>
          </View>
          <View class="flex-row items-center gap-1">
            <KeyCap label="Esc" surface="surface" />
            <Text class="text-2xs text-muted">{t("web.shell.palette.footer.close")}</Text>
          </View>
        </View>
        <View class="flex-row items-center gap-2.5">
          <Each of={modeKeys} key={(hint) => hint.mode}>
            {(hint) => {
              const active = () => mode() === hint().mode;
              return (
                <View class="flex-row items-center gap-1">
                  <KeyCap label={hint().keys} surface="surface" active={active()} />
                  <Text class={`text-2xs font-medium ${active() ? "text-ink" : "text-faint"}`}>{t(`web.shell.palette.mode.${hint().mode}`)}</Text>
                </View>
              );
            }}
          </Each>
        </View>
      </View>
    </View>
  );
}
