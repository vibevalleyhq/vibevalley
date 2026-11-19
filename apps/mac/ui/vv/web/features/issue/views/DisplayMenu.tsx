// Ported from VibeValley apps/web/src/features/issue/views/DisplayMenu.tsx:
// base-ui's Popover becomes nsh/base's, the same panel. Its pop-in
// animation is not carried.
import { Text, View } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../../ui/Icon";
import { Segmented } from "../../../ui/Segmented";
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
      popupClass="w-85 rounded-lg border border-line bg-page p-3 shadow-float"
      trigger={
        <View
          testID="display"
          role="button"
          accessibilityLabel={t("web.issue.display.show")}
          class="h-7 flex-row items-center gap-1.5 rounded-md border border-transparent px-2.5 hover:bg-hover"
        >
          <Icon name="settings" size={14} tone="ink" />
          <Text class="text-sm text-ink">{t("web.issue.display.show")}</Text>
        </View>
      }
    >
      <View testID="display-menu" accessibilityLabel={t("web.issue.display.show")}>
        <View class="flex-row items-center gap-2">
          <Text class="w-10 shrink-0 text-sm text-muted">{t("web.issue.display.group")}</Text>
          <View class="flex-1">
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
        <View class="mt-2.5 flex-row items-center gap-2">
          <Text class="w-10 shrink-0 text-sm text-muted">{t("web.issue.display.order")}</Text>
          <View class="flex-1">
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
          <Text class="mt-2.5 text-xs leading-relaxed text-muted">{notes().join("\n")}</Text>
        </If>
        <If when={changed()}>
          <View
            role="button"
            testID="display-reset"
            class="mt-2 self-start"
            onPress={() => props.onChange({ ...props.look, grouping: defaultLook.grouping, ordering: defaultLook.ordering })}
          >
            <Text class="text-sm text-water">{t("web.issue.display.reset")}</Text>
          </View>
        </If>
      </View>
    </Popover>
  );
}
