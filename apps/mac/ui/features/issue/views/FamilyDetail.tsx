import { computed, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { TextArea } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { Markdown } from "../../../design/Markdown";
import { toast } from "../../../design/toasts";
import { shortMomentText } from "../../../infra/base/format";
import { createMemo } from "../../../infra/solid";
import { useIntents } from "../../../infra/state/intent";
import { createIssueActs } from "../model/acts";
import { useIssues } from "../model/history";
import { stageTone } from "../model/overview";
import { issueSet, labeledIssue, sendLabel } from "../model/write";
import { ActLines } from "./ActLines";
import { DatePropertyEditor, OwnerMark, OwnerPicker, ParentPicker, SubIssuesSection, TagEditor } from "./IssueMetaControls";
import { StatusMark } from "./Marks";
import { IssueSheet, IssueTrail, Property, SheetLabel, StagePill } from "./Sheet";

export function FamilyDetail(props: { issue: Issue; children: Issue[]; onOpen: (id: string) => void; onClose: (review: boolean) => void }) {
  const allIssues = useIssues();
  const sets = useIntents(issueSet);
  const labeled = createMemo(() => labeledIssue(allIssues().find((item) => item.id === props.issue.id) ?? props.issue, sets.list()));
  const live = () => labeled().issue;
  const open = computed(() => live().status !== "done" && live().status !== "canceled");
  const setLabel = (label: Omit<Parameters<typeof sendLabel>[1], "id">) => void sendLabel(sets, { id: props.issue.id, ...label });
  const parent = createMemo(() => (live().parent ? allIssues().find((item) => item.id === live().parent) : undefined));
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
      <IssueTrail number={live().number} repo={live().repo} parentId={live().parent} parent={parent()} onOpenParent={props.onOpen} />
      <Text role="header" testID="issue-title" class="text-2xl leading-snug font-semibold text-ink">
        {live().title}
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
      <If when={live().description}>
        <View>
          <SheetLabel first>{t("web.issue.detail.full")}</SheetLabel>
          <Markdown size="sm" text={live().description} />
        </View>
      </If>
      <SubIssuesSection
        issueId={live().id}
        allIssues={allIssues().length > 0 ? allIssues() : props.children}
        onOpen={props.onOpen}
        bordered={Boolean(live().description)}
      />
    </>
  );

  const side = (
    <>
      <SheetLabel first>{t("web.issue.detail.properties")}</SheetLabel>
      <Property label={t("web.issue.detail.status")} icon={<StatusMark status={live().status} size={13} />}>
        {t(`shared.stage.${props.issue.stage.state}`)}
      </Property>
      <If when={live().repo}>
        {(repo) => (
          <Property label={t("web.issue.detail.repo")} icon={<Icon name="folder" size={13} tone="muted" />}>
            {repo()}
          </Property>
        )}
      </If>
      <Property label={t("web.issue.family.children")} icon={<Icon name="issues" size={13} tone="muted" />}>
        <Text class="text-sm text-ink tabular-nums">{String(props.children.length)}</Text>
      </Property>
      <Property label={t("web.issue.owner.label")} icon={<OwnerMark owner={live().owner} size={15} />} inset>
        <OwnerPicker
          owner={live().owner}
          allIssues={allIssues()}
          disabled={!open()}
          state={labeled().state("owner")}
          testid="issue-owner"
          onChange={(owner) => setLabel({ owner: owner ?? { kind: "user", id: "" } })}
        />
      </Property>
      <Property label={t("web.issue.family.parent")} icon={<Icon name="indent" size={13} tone="muted" />} inset>
        <ParentPicker
          issueId={live().id}
          parentId={live().parent ?? ""}
          allIssues={allIssues()}
          disabled={!open()}
          state={labeled().state("parent")}
          onChange={(parent) => setLabel({ parent })}
        />
      </Property>
      <Property align="start" label={t("web.issue.tags.label")} icon={<Icon name="catalog" size={13} tone="muted" />} inset>
        <TagEditor tags={live().tags ?? []} disabled={!open()} onChange={(tags) => setLabel({ tags })} />
      </Property>
      <SheetLabel divider>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.dates.startAt")} icon={<Icon name="calendar" size={13} tone="muted" />} inset>
        <DatePropertyEditor
          label={t("web.issue.dates.startAt")}
          value={live().startAt}
          disabled={!open()}
          testid="issue-start-at"
          maxMs={live().dueAt}
          onCommit={(startAt) => setLabel({ startAt })}
        />
      </Property>
      <Property label={t("web.issue.dates.dueAt")} icon={<Icon name="calendar" size={13} tone="muted" />} inset>
        <DatePropertyEditor
          label={t("web.issue.dates.dueAt")}
          value={live().dueAt}
          disabled={!open()}
          testid="issue-due-at"
          minMs={live().startAt}
          onCommit={(dueAt) => setLabel({ dueAt })}
        />
      </Property>
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
