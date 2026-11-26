import { Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { TextArea } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { Markdown } from "../../../design/Markdown";
import { toast } from "../../../design/toasts";
import { shortMomentText } from "../../../infra/base/format";
import { createIssueActs } from "../model/acts";
import { stageTone } from "../model/overview";
import { ActLines } from "./ActLines";
import { StatusMark } from "./Marks";
import { IssueNumberPill, IssueSheet, Property, SheetLabel, StagePill } from "./Sheet";

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
      <View class="mb-2 flex-row flex-wrap items-center gap-1.5">
        <If when={props.issue.repo}>
          {(repo) => (
            <>
              <View class="flex-row items-center gap-1 rounded-md bg-side px-1.5 py-0.5">
                <Icon name="folder" size={12} tone="muted" />
                <Text class="text-xs font-medium text-muted">{repo()}</Text>
              </View>
              <Icon name="next" size={12} tone="faint" />
            </>
          )}
        </If>
        <IssueNumberPill number={props.issue.number} />
      </View>
      <Text role="header" class="text-2xl leading-snug font-semibold text-ink">
        {props.issue.title}
      </Text>
      <View class="mt-2.5 flex-row flex-wrap items-center gap-2">
        <StagePill tone={tone()} label={t(`shared.stage.${props.issue.stage.state}`)} />
      </View>
    </View>
  );

  const main = (
    <>
      <ActLines issue={props.issue.id} />
      <If when={needsBox()}>
        <View class="mb-5">
          <TextArea accessibilityLabel={t("shared.act.tell")} value={acts.text()} onInput={acts.setText} />
        </View>
      </If>
      <If when={props.issue.description}>
        <View>
          <SheetLabel first>{t("web.issue.detail.full")}</SheetLabel>
          <Markdown size="sm" text={props.issue.description} />
        </View>
      </If>
      <View class={props.issue.description ? "mt-7 border-t border-line pt-5" : ""}>
        <SheetLabel first>{t("web.issue.family.children")}</SheetLabel>
        <View class="overflow-hidden rounded-lg border border-line bg-page">
          <Each of={props.children} key={(child) => child.id}>
            {(child, i) => (
              <View
                role="button"
                testID="child-issue"
                accessibilityLabel={child().title}
                class={`w-full flex-row items-center gap-3 px-3.5 py-2.5 hover:bg-hover ${i() < props.children.length - 1 ? "border-b border-line" : ""}`}
                onPress={() => props.onOpen(child().id)}
              >
                <StatusMark status={child().status} size={13} />
                <Text class="w-10 shrink-0 font-mono text-xs text-faint tabular-nums">{`#${child().number}`}</Text>
                <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{child().title}</Text>
                <Text class="shrink-0 text-xs text-muted">{t(`shared.status.${child().status}`)}</Text>
              </View>
            )}
          </Each>
        </View>
      </View>
    </>
  );

  const side = (
    <>
      <SheetLabel first>{t("web.issue.detail.properties")}</SheetLabel>
      <Property label={t("web.issue.detail.status")} icon={<StatusMark status={props.issue.status} size={13} />}>
        {t(`shared.stage.${props.issue.stage.state}`)}
      </Property>
      <If when={props.issue.repo}>
        {(repo) => (
          <Property label={t("web.issue.detail.repo")} icon={<Icon name="folder" size={13} tone="muted" />}>
            {repo()}
          </Property>
        )}
      </If>
      <Property label={t("web.issue.family.children")} icon={<Icon name="issues" size={13} tone="muted" />}>
        <Text class="text-sm text-ink tabular-nums">{String(props.children.length)}</Text>
      </Property>
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
      <If when={props.issue.stage.acts.length > 0}>
        <View class="mt-4 flex-row flex-wrap gap-2 border-t border-line pt-4">
          <Each of={props.issue.stage.acts} key={(action) => action.act}>
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
    </>
  );

  return (
    <View testID="issue-family" class="min-h-0 flex-1">
      <IssueSheet heading={heading} main={main} side={side} />
    </View>
  );
}
