import { computed, effect, keymap, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../../design/Icon";
import { Kbd } from "../../../design/layout";
import { filterSlashCommands, groupSlashCommands, slashCommandDesc, slashCommandLabel, type SlashCommandItem } from "./docOps";

export interface SlashMenuProps {
  readonly open: boolean;
  readonly query: string;
  readonly placement?: "bottom" | "top" | undefined;
  readonly testID?: string | undefined;
  readonly onSelect: (item: SlashCommandItem) => void;
  readonly onClose: () => void;
}

export function SlashMenu(props: SlashMenuProps) {
  const activeIndex = signal(0);

  const filtered = computed(() => filterSlashCommands(props.query));
  const grouped = computed(() => groupSlashCommands(filtered()));
  const flatItems = computed(() => grouped().flatMap((g) => g.items));

  effect(() => {
    const len = flatItems().length;
    if (len === 0) {
      activeIndex.set(0);
    } else if (untracked(activeIndex) >= len) {
      activeIndex.set(0);
    }
  });

  effect(() => {
    const _q = props.query;
    void _q;
    activeIndex.set(0);
  });

  const isNavActive = computed(() => props.open && flatItems().length > 0);
  effect(() => {
    if (!isNavActive()) return;
    return keymap.bind(
      {
        up: () => {
          const list = untracked(flatItems);
          if (list.length === 0) return;
          activeIndex.set((untracked(activeIndex) - 1 + list.length) % list.length);
        },
        down: () => {
          const list = untracked(flatItems);
          if (list.length === 0) return;
          activeIndex.set((untracked(activeIndex) + 1) % list.length);
        },
        enter: () => {
          const list = untracked(flatItems);
          const chosen = list[untracked(activeIndex)];
          if (chosen !== undefined) props.onSelect(chosen);
        },
        escape: () => props.onClose(),
      },
      { when: "always" },
    );
  });

  const isOpenOnly = computed(() => props.open && flatItems().length === 0);
  effect(() => {
    if (!isOpenOnly()) return;
    return keymap.bind({ escape: () => props.onClose() }, { when: "always" });
  });

  return (
    <If when={props.open}>
      <View
        testID={props.testID ?? "doc-slash-menu"}
        class={
          props.placement === "top"
            ? "absolute bottom-full left-0 z-30 mb-1 w-96 overflow-hidden rounded-lg border border-line-strong bg-elevated shadow-float"
            : "z-20 mt-1 w-96 overflow-hidden rounded-lg border border-line-strong bg-elevated shadow-float"
        }
      >
        <View class="flex-row items-center justify-between border-b border-line px-2.5 py-1.5">
          <Text class="text-2xs font-semibold text-muted">{t("web.note.doc.addBlock")}</Text>
          <If when={props.query.trim().length > 0}>
            <Text class="font-mono text-2xs text-accent">{`/${props.query}`}</Text>
          </If>
        </View>
        <Scroll class="max-h-72" contentClass="gap-1 p-1.5">
          <If
            when={grouped().length > 0}
            else={
              <View class="items-center px-3 py-4">
                <Text class="text-xs text-faint">{t("web.base.table.empty")}</Text>
              </View>
            }
          >
            <Each of={grouped()} key={(group) => group.category}>
              {(group) => (
                <View testID={`doc-slash-group-${group().category}`} class="gap-0.5">
                  <Text class="px-2 pt-1 pb-0.5 text-2xs font-semibold text-faint">{group().label}</Text>
                  <Each of={group().items} key={(item) => item.key}>
                    {(item) => {
                      const isActive = computed(() => flatItems()[activeIndex()]?.key === item().key);
                      return (
                        <View
                          role="button"
                          testID={`doc-slash-item-${item().key}`}
                          accessibilityState={{ selected: isActive() }}
                          onPress={() => props.onSelect(item())}
                          class={`flex-row items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-hover ${isActive() ? "bg-selected" : ""}`}
                        >
                          <View class="size-7 shrink-0 items-center justify-center rounded-sm border border-line bg-page">
                            <Icon name={item().icon} size={14} tone={isActive() ? "accent" : "muted"} />
                          </View>
                          <View class="min-w-0 flex-1 gap-0.5">
                            <Text class="truncate text-xs font-medium text-ink">{slashCommandLabel(item().key)}</Text>
                            <Text class="line-clamp-2 text-2xs text-faint">{slashCommandDesc(item().key)}</Text>
                          </View>
                          <If when={item().shortcut}>{(sc) => <Kbd size="sm">{sc()}</Kbd>}</If>
                        </View>
                      );
                    }}
                  </Each>
                </View>
              )}
            </Each>
          </If>
        </Scroll>
      </View>
    </If>
  );
}
