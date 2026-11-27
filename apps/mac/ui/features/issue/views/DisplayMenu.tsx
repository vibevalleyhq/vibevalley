import { computed, Text, View, windowSize } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Select } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { motionClass } from "../../../design/motion";
import { Segmented } from "../../../design/Segmented";
import { Bubble } from "../../../design/Tip";
import {
  type BoardDensity,
  type BoardLook,
  boardDensities,
  defaultFields,
  groupBys,
  groupings,
  hierarchyModes,
  isLookCustomized,
  issueFieldKeys,
  orderings,
  resetBoardLook,
  toggleBoardField,
} from "../model/display";

/** Unified Notion/Linear-style Display panel controlling grouping, hierarchy, ordering, density, and visible card/row properties. */
export function DisplayMenu(props: { look: BoardLook; onChange: (l: BoardLook) => void }) {
  const changed = computed(() => isLookCustomized(props.look));
  const currentGroupBy = () => props.look.groupBy ?? "none";
  const currentHierarchy = () => props.look.hierarchy ?? "all";
  const currentDensity = (): BoardDensity => props.look.density ?? "comfortable";
  const currentFields = () => props.look.fields ?? defaultFields;
  const groupByOptions = computed(() => groupBys.map((g) => ({ value: g, label: t(`web.issue.groupBy.${g}`) })));
  const groupingOptions = computed(() => groupings.map((g) => ({ value: g, label: t(`web.issue.boardLabels.grouping.${g}`) })));
  const hierarchyOptions = computed(() => hierarchyModes.map((m) => ({ value: m, label: t(`web.issue.hierarchy.${m}`) })));
  const orderingOptions = computed(() => orderings.map((o) => ({ value: o, label: t(`web.issue.boardLabels.ordering.${o}`) })));
  const densityOptions = computed(() => boardDensities.map((d) => ({ value: d, label: t(`web.issue.display.densities.${d}`) })));
  const notes = computed(() =>
    [
      props.look.view === "board" && currentGroupBy() === "none" && t("web.issue.display.boardNote"),
      props.look.ordering !== "manual" && t("web.issue.display.orderNote"),
      props.look.view !== "board" && props.look.ordering === "manual" && t("web.issue.display.defaultNote"),
    ].filter(Boolean),
  );
  return (
    <Popover
      placement="bottom"
      align="end"
      offset={6}
      popupClass="w-96 rounded-lg border border-line bg-elevated p-3 shadow-float"
      popupStyle={{ maxWidth: Math.max(240, windowSize().width - 24) }}
      trigger={
        <View
          testID="display"
          role="button"
          accessibilityLabel={t("web.issue.display.show")}
          tooltip={<Bubble text={t("web.issue.display.show")} />}
          class={`h-7 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2.5 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
        >
          <Icon name="settings" size={14} tone="muted" />
          <Text class="text-sm text-ink">{t("web.issue.display.show")}</Text>
          <If when={changed()}>
            <View testID="display-active-dot" class="h-1.5 w-1.5 rounded-full bg-leaf" />
          </If>
        </View>
      }
    >
      <View testID="display-menu" accessibilityLabel={t("web.issue.display.show")} class="gap-2.5">
        <View class="flex-row items-center gap-2.5">
          <Text class="w-16 shrink-0 text-xs font-medium text-muted">{t("web.issue.groupBy.label")}</Text>
          <View class="min-w-0 flex-1">
            <Select
              size="control"
              class="w-full"
              label={t("web.issue.groupBy.label")}
              testid="group-by"
              value={currentGroupBy()}
              options={groupByOptions()}
              renderOption={(entry) => (
                <Text testID={`group-by-option-${entry.value}`} class="min-w-0 truncate text-sm text-ink group-selected:font-medium">
                  {entry.title}
                </Text>
              )}
              onChange={(groupBy) => props.onChange({ ...props.look, groupBy })}
            />
          </View>
        </View>
        <View class="flex-row items-center gap-2.5">
          <Text class="w-16 shrink-0 text-xs font-medium text-muted">{t("web.issue.display.listGroup")}</Text>
          <View class="min-w-0 flex-1">
            <Segmented
              label={t("web.issue.display.listGroup")}
              testid="grouping"
              block
              value={props.look.grouping}
              onChange={(grouping) => props.onChange({ ...props.look, grouping })}
              options={groupingOptions()}
            />
          </View>
        </View>
        <View class="flex-row items-center gap-2.5">
          <Text class="w-16 shrink-0 text-xs font-medium text-muted">{t("web.issue.hierarchy.label")}</Text>
          <View class="min-w-0 flex-1">
            <Segmented
              label={t("web.issue.hierarchy.label")}
              testid="hierarchy-mode"
              block
              value={currentHierarchy()}
              onChange={(hierarchy) => props.onChange({ ...props.look, hierarchy })}
              options={hierarchyOptions()}
            />
          </View>
        </View>
        <View class="flex-row items-center gap-2.5">
          <Text class="w-16 shrink-0 text-xs font-medium text-muted">{t("web.issue.display.order")}</Text>
          <View class="min-w-0 flex-1">
            <Segmented
              label={t("web.issue.display.order")}
              testid="ordering"
              block
              value={props.look.ordering}
              onChange={(ordering) => props.onChange({ ...props.look, ordering })}
              options={orderingOptions()}
            />
          </View>
        </View>
        <View class="flex-row items-center gap-2.5">
          <Text class="w-16 shrink-0 text-xs font-medium text-muted">{t("web.issue.display.density")}</Text>
          <View class="min-w-0 flex-1">
            <Segmented
              label={t("web.issue.display.density")}
              testid="density"
              block
              value={currentDensity()}
              onChange={(density) => props.onChange({ ...props.look, density })}
              options={densityOptions()}
            />
          </View>
        </View>
        <View class="gap-1.5 border-t border-line pt-2.5">
          <Text class="text-xs font-medium text-muted">{t("web.issue.display.fields")}</Text>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Each of={issueFieldKeys} key={(k) => k}>
              {(k) => {
                const active = () => currentFields()[k()] !== false;
                return (
                  <View
                    role="button"
                    testID={`display-field-${k()}`}
                    accessibilityState={{ selected: active() }}
                    onPress={() => props.onChange(toggleBoardField(props.look, k()))}
                    class={`rounded-sm border px-2 py-0.5 ${
                      active() ? "border-accent bg-selected" : "border-line bg-page hover:border-line-strong hover:bg-hover"
                    }`}
                  >
                    <Text class={`text-2xs font-medium ${active() ? "text-ink" : "text-muted"}`}>{t(`web.issue.display.field.${k()}`)}</Text>
                  </View>
                );
              }}
            </Each>
          </View>
        </View>
        <If when={notes().length > 0}>
          <View class="border-t border-line pt-2.5">
            <Text class="text-xs leading-relaxed text-muted">{notes().join("\n")}</Text>
          </View>
        </If>
        <If when={changed()}>
          <View
            role="button"
            testID="display-reset"
            class={`self-start rounded-md px-2 py-1 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
            onPress={() => props.onChange(resetBoardLook(props.look))}
          >
            <Text class="text-xs font-medium text-water">{t("web.issue.display.reset")}</Text>
          </View>
        </If>
      </View>
    </Popover>
  );
}
