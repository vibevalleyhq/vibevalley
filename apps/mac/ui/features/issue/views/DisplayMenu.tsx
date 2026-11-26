import { Text, View, windowSize } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../../design/Icon";
import { motionClass } from "../../../design/motion";
import { Segmented } from "../../../design/Segmented";
import { Bubble } from "../../../design/Tip";
import { type BoardLook, defaultLook, groupingLabel, groupings, orderingLabel, orderings } from "../model/display";

/** Display: a small panel under its button with how the list groups and how both views order. */
export function DisplayMenu(props: { look: BoardLook; onChange: (l: BoardLook) => void }) {
  const changed = () => props.look.grouping !== defaultLook.grouping || props.look.ordering !== defaultLook.ordering;
  const notes = () =>
    [
      props.look.view === "board" && t("web.issue.display.boardNote"),
      props.look.ordering !== "manual" && t("web.issue.display.orderNote"),
      props.look.view !== "board" && props.look.ordering === "manual" && t("web.issue.display.defaultNote"),
    ].filter(Boolean);
  return (
    <Popover
      placement="bottom"
      align="end"
      offset={6}
      popupClass="w-85 rounded-lg border border-line bg-elevated p-3 shadow-float"
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
            <View class="h-1.5 w-1.5 rounded-full bg-leaf" />
          </If>
        </View>
      }
    >
      <View testID="display-menu" accessibilityLabel={t("web.issue.display.show")}>
        <View class="flex-row items-center gap-2.5">
          <Text class="w-12 shrink-0 text-xs font-medium text-muted">{t("web.issue.display.group")}</Text>
          <View class="min-w-0 flex-1">
            <Segmented
              label={t("web.issue.display.group")}
              testid="grouping"
              block
              value={props.look.grouping}
              onChange={(grouping) => props.onChange({ ...props.look, grouping })}
              options={groupings.map((g) => ({ value: g, label: groupingLabel[g] }))}
            />
          </View>
        </View>
        <View class="mt-2.5 flex-row items-center gap-2.5">
          <Text class="w-12 shrink-0 text-xs font-medium text-muted">{t("web.issue.display.order")}</Text>
          <View class="min-w-0 flex-1">
            <Segmented
              label={t("web.issue.display.order")}
              testid="ordering"
              block
              value={props.look.ordering}
              onChange={(ordering) => props.onChange({ ...props.look, ordering })}
              options={orderings.map((o) => ({ value: o, label: orderingLabel[o] }))}
            />
          </View>
        </View>
        <If when={notes().length > 0}>
          <View class="mt-3 border-t border-line pt-2.5">
            <Text class="text-xs leading-relaxed text-muted">{notes().join("\n")}</Text>
          </View>
        </If>
        <If when={changed()}>
          <View
            role="button"
            testID="display-reset"
            class={`mt-2 self-start rounded-md px-2 py-1 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
            onPress={() => props.onChange({ ...props.look, grouping: defaultLook.grouping, ordering: defaultLook.ordering })}
          >
            <Text class="text-xs font-medium text-water">{t("web.issue.display.reset")}</Text>
          </View>
        </If>
      </View>
    </Popover>
  );
}
