import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { TextArea } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { Markdown } from "../../../design/Markdown";
import { Dot } from "../../../design/Tag";
import { toast } from "../../../design/toasts";
import { shortMomentText } from "../../../infra/base/format";
import { createIssueActs } from "../model/acts";
import { stageTone } from "../model/overview";
import { ActLines } from "./ActLines";
import { IssueSheet, Property, SheetLabel } from "./Sheet";

export function FamilyDetail(props: { issue: Issue; children: Issue[]; onOpen: (id: string) => void; onClose: (review: boolean) => void }) {
  const acts = createIssueActs(() => props.issue, {
    act: createAct(),
    complete: () => props.onClose(true),
    close: () => props.onClose(false),
    told: (title, description) => toast(t("shared.join.labeled", { label: title, text: description })),
  });
  const tone = () => stageTone[props.issue.stage.state];
  const needsBox = () =>
    Boolean(acts.box()) || props.issue.stage.acts.some((action) => action.act === "reopen" && action.does === "move" && action.words === "required");

  const heading = (
    <View>
      <View class="mb-1.5 flex-row flex-wrap items-center gap-1">
        <Text class="text-xs text-muted">{props.issue.repo || t("web.issue.detail.noRepo")}</Text>
        <Icon name="next" size={12} tone="muted" />
        <Text class="shrink-0 font-mono text-xs text-muted tabular-nums">{`#${props.issue.number}`}</Text>
      </View>
      <Text role="header" class="text-lg font-semibold text-ink">
        {props.issue.title}
      </Text>
      <View class="mt-2 flex-row items-center gap-2">
        <Dot tone={tone()} size={8} ring={false} />
        <Text class="text-sm text-muted">{t(`shared.stage.${props.issue.stage.state}`)}</Text>
      </View>
    </View>
  );

  const main = (
    <>
      <ActLines issue={props.issue.id} />
      <If when={needsBox()}>
        <View class="mb-4">
          <TextArea accessibilityLabel={t("shared.act.tell")} value={acts.text()} onInput={acts.setText} />
        </View>
      </If>
      <If when={props.issue.description}>
        <View>
          <SheetLabel first>{t("web.issue.detail.full")}</SheetLabel>
          <Markdown size="sm" text={props.issue.description} />
        </View>
      </If>
      <SheetLabel first={!props.issue.description}>{t("web.issue.family.children")}</SheetLabel>
      <View class="overflow-hidden rounded-lg border border-line bg-page">
        <Each of={props.children}>
          {(child, i) => (
            <View
              role="button"
              testID="child-issue"
              accessibilityLabel={child().title}
              class={`w-full flex-row items-center gap-3 px-3.5 py-2.5 transition duration-120 ease-out hover:bg-hover ${i() < props.children.length - 1 ? "border-b border-line" : ""}`}
              onPress={() => props.onOpen(child().id)}
            >
              <Text class="w-10 shrink-0 font-mono text-xs text-muted tabular-nums">{`#${child().number}`}</Text>
              <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{child().title}</Text>
              <Text class="shrink-0 text-xs text-muted">{t(`shared.status.${child().status}`)}</Text>
            </View>
          )}
        </Each>
      </View>
    </>
  );

  const side = (
    <>
      <SheetLabel first>{t("web.issue.detail.properties")}</SheetLabel>
      <Property label={t("web.issue.detail.status")}>
        <View class="flex-row items-center gap-2">
          <Dot tone={tone()} size={8} ring={false} />
          <Text class="text-sm text-ink">{t(`shared.stage.${props.issue.stage.state}`)}</Text>
        </View>
      </Property>
      <If when={props.issue.repo}>{(repo) => <Property label={t("web.issue.detail.repo")}>{repo()}</Property>}</If>
      <Property label={t("web.issue.family.children")}>
        <Text class="text-sm text-ink tabular-nums">{String(props.children.length)}</Text>
      </Property>
      <If when={props.issue.stage.acts.length > 0}>
        <View class="mt-3 flex-row flex-wrap gap-2">
          <Each of={props.issue.stage.acts}>
            {(action) => (
              <Button
                testID={`act-${action().act}`}
                disabled={acts.disabled(action().act)}
                tone={action().act === props.issue.stage.lead ? "primary" : action().act === "close" ? "danger" : "plain"}
                onPress={() => acts.go(action().act)}
              >
                {acts.label(action().act)}
              </Button>
            )}
          </Each>
        </View>
      </If>
      <SheetLabel divider>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.detail.opened")}>
        <Text class="text-sm text-ink tabular-nums">{shortMomentText(props.issue.createdAt)}</Text>
      </Property>
      <If when={props.issue.closedAt}>
        {(at) => (
          <Property label={t("web.issue.detail.closedAt")}>
            <Text class="text-sm text-ink tabular-nums">{shortMomentText(at())}</Text>
          </Property>
        )}
      </If>
    </>
  );

  return (
    <View testID="issue-family" class="min-h-0 flex-1">
      <IssueSheet heading={heading} main={main} side={side} />
    </View>
  );
}
