import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../../design/Icon";
import { motionClass } from "../../../design/motion";
import { laneLabel } from "../model/cards";
import { workflowGuideCollapsed, workflowStages } from "../model/onboarding";
import { StatusMark } from "./Marks";

export function WorkflowGuide() {
  const collapsed = workflowGuideCollapsed.get;
  const toggle = () => workflowGuideCollapsed.set(!collapsed());

  return (
    <View testID="workflow-guide" class="mx-3 mb-2 shrink-0 rounded-lg border border-line bg-side">
      <View class="flex-row items-center justify-between gap-2 px-3 py-1.5">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
          <Icon name="info" size={13} tone="muted" />
          <Text class="shrink-0 text-xs font-semibold text-ink">{t("web.issue.guide.title")}</Text>
          <If when={!collapsed()}>
            <Text class="min-w-0 flex-1 truncate text-xs text-muted">{t("web.issue.guide.summary")}</Text>
          </If>
        </View>
        <View
          role="button"
          testID="workflow-guide-toggle"
          accessibilityLabel={collapsed() ? t("web.issue.guide.expand") : t("web.issue.guide.collapse")}
          accessibilityState={{ expanded: !collapsed() }}
          onPress={toggle}
          class={`group shrink-0 flex-row items-center gap-1 rounded-md px-2 py-0.5 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
        >
          <Text class="text-xs font-medium text-muted group-hover:text-ink">{collapsed() ? t("web.issue.guide.expand") : t("web.issue.guide.collapse")}</Text>
          <Icon name={collapsed() ? "expand" : "collapse"} size={12} tone="muted" />
        </View>
      </View>
      <If when={!collapsed()}>
        <View testID="workflow-guide-body" class="flex-row flex-wrap items-stretch gap-1.5 border-t border-line px-2.5 py-2">
          <Each of={workflowStages} key={(stage) => stage.lane}>
            {(stage, index) => (
              <>
                <View testID={`workflow-stage-${stage().lane}`} class="min-w-36 flex-1 rounded-md border border-line bg-elevated px-2.5 py-1.5">
                  <View class="flex-row items-center gap-1.5">
                    <StatusMark status={stage().status} size={12} />
                    <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{laneLabel[stage().lane]}</Text>
                  </View>
                  <Text class="mt-1 text-2xs leading-snug text-muted">{t(stage().descKey)}</Text>
                </View>
                <If when={index() < workflowStages.length - 1}>
                  <View class="hidden shrink-0 items-center justify-center md:flex">
                    <Icon name="next" size={11} tone="faint" />
                  </View>
                </If>
              </>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}
