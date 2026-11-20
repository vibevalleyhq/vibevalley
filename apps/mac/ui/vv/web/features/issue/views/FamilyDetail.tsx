import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { createAct } from "../../../ui/act";
import { Button } from "../../../ui/Button";
import { TextArea } from "../../../ui/Field";
import { Markdown } from "../../../ui/Markdown";
import { toast } from "../../../ui/toasts";
import { createIssueActs } from "../model/acts";
import { ActLines } from "./ActLines";

export function FamilyDetail(props: { issue: Issue; children: Issue[]; onOpen: (id: string) => void; onClose: (review: boolean) => void }) {
  const acts = createIssueActs(() => props.issue, {
    act: createAct(),
    complete: () => props.onClose(true),
    close: () => props.onClose(false),
    told: (title, description) => toast(t("shared.join.labeled", { label: title, text: description })),
  });
  return (
    <View testID="issue-family">
      <View class="flex-row items-start gap-3 pr-10">
        <Text role="header" class="flex-1 text-xl font-semibold text-ink">
          {props.issue.title}
        </Text>
        <Text class="text-xs text-muted">{t(`shared.stage.${props.issue.stage.state}`)}</Text>
      </View>
      <View class="mt-3">
        <ActLines issue={props.issue.id} />
      </View>
      <View class="mt-3 flex-row flex-wrap gap-2">
        <Each of={props.issue.stage.acts}>
          {(action) => (
            <Button
              testID={`act-${action().act}`}
              disabled={acts.disabled(action().act)}
              tone={action().act === props.issue.stage.lead ? "primary" : "plain"}
              onPress={() => acts.go(action().act)}
            >
              {acts.label(action().act)}
            </Button>
          )}
        </Each>
      </View>
      <If when={acts.box() || props.issue.stage.acts.some((action) => action.act === "reopen" && action.does === "move" && action.words === "required")}>
        <View class="mt-3">
          <TextArea accessibilityLabel={t("shared.act.tell")} value={acts.text()} onInput={acts.setText} />
        </View>
      </If>
      <If when={props.issue.description}>
        <View class="mt-4">
          <Markdown text={props.issue.description} />
        </View>
      </If>
      <Text role="header" class="mt-5 mb-2 text-sm font-semibold text-ink">
        {t("web.issue.family.children")}
      </Text>
      <View class="rounded-lg border border-line">
        <Each of={props.children}>
          {(child, i) => (
            <View
              role="button"
              testID="child-issue"
              accessibilityLabel={child().title}
              class={`w-full flex-row items-center gap-3 px-3 py-3 hover:bg-hover ${i() < props.children.length - 1 ? "border-b border-line" : ""}`}
              onPress={() => props.onOpen(child().id)}
            >
              <Text class="text-xs text-muted">{`#${child().number}`}</Text>
              <Text class="min-w-0 flex-1 text-sm text-ink">{child().title}</Text>
              <Text class="text-xs text-muted">{t(`shared.status.${child().status}`)}</Text>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}
