import { computed, Text, View } from "nsh";
import { Button, Input } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Button as DesignButton } from "../../design/Button";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { motionClass } from "../../design/motion";
import { Bubble } from "../../design/Tip";
import { mix } from "../../design/tone";
import { act } from "../../infra/bridge";
import { PanelEmpty, SectionHead, ShellIconButton } from "../chrome";
import { FileRow } from "./FileRow";
import type { GitFrame, WorktreesSectionCtx } from "./model";
import { WorktreesSection } from "./WorktreesSection";

export function ChangesTab(props: {
  frame: GitFrame | null;
  worktreesCtx: WorktreesSectionCtx;
  message: string;
  onMessageChange: (value: string) => void;
  onCommitFocusChange: (focused: boolean) => void;
  committing: boolean;
  canCommit: boolean;
  onCommit: () => void;
  commitNotice: string | null;
  fileQuery: string;
  onFileQueryChange: (value: string) => void;
  isOpen: (key: string) => boolean;
  toggleSection: (key: string) => void;
}) {
  const f = () => props.frame;
  const stagedCount = computed(() => f()?.staged?.length ?? 0);
  const changesCount = computed(() => f()?.changes?.length ?? 0);
  const conflictsCount = computed(() => f()?.conflicts?.length ?? 0);
  const totalDiffFiles = computed(() => stagedCount() + changesCount());
  const showFileFilter = computed(() => totalDiffFiles() >= 6);
  const normalizedFileQuery = computed(() => (showFileFilter() ? props.fileQuery.trim().toLowerCase() : ""));
  const filteredConflicts = computed(() => {
    const q = normalizedFileQuery();
    const list = f()?.conflicts ?? [];
    return q ? list.filter((r) => r.path.toLowerCase().includes(q)) : list;
  });
  const filteredStaged = computed(() => {
    const q = normalizedFileQuery();
    const list = f()?.staged ?? [];
    return q ? list.filter((r) => r.path.toLowerCase().includes(q)) : list;
  });
  const filteredChanges = computed(() => {
    const q = normalizedFileQuery();
    const list = f()?.changes ?? [];
    return q ? list.filter((r) => r.path.toLowerCase().includes(q)) : list;
  });

  return (
    <View>
      <If when={props.worktreesCtx.removeNotice()}>
        {(notice) => (
          <View class="border-b border-line bg-ok-soft px-3 py-1.5">
            <Text class="text-2xs text-ok-ink">{notice()}</Text>
          </View>
        )}
      </If>
      <If when={props.worktreesCtx.worktreesCount() > 1}>
        <WorktreesSection sectionKey="changes-worktrees" title={t("web.shell.git.worktrees")} borderTop={false} showNotice={false} ctx={props.worktreesCtx} />
      </If>
      <View class="gap-2 border-b border-line px-3 py-2.5">
        <Input
          value={props.message}
          onChange={({ value }) => props.onMessageChange(value)}
          onFocus={() => props.onCommitFocusChange(true)}
          onBlur={() => props.onCommitFocusChange(false)}
          placeholder={t("web.shell.git.commitPlaceholder")}
          multiline
          class="min-h-14 rounded-md border border-line bg-elevated px-2.5 py-1.5 text-xs leading-normal text-ink placeholder:text-faint hover:border-faint focus:border-focus"
        />
        <DesignButton
          tone="primary"
          class="px-3"
          disabled={!props.canCommit}
          tooltip={<Bubble text={`${stagedCount() > 0 ? t("web.shell.git.commitStaged", { count: stagedCount() }) : t("web.shell.git.noStaged")} (⌘↩)`} />}
          onPress={props.onCommit}
        >
          <View class="flex-row items-center gap-1.5">
            <Text class="min-w-0 truncate text-sm font-medium text-page">
              {props.committing
                ? t("web.shell.git.committing")
                : stagedCount() > 0
                  ? t("web.shell.git.commitStaged", { count: stagedCount() })
                  : t("web.shell.git.noStaged")}
            </Text>
            <If when={props.canCommit}>
              <View class="shrink-0 items-center justify-center rounded-xs px-1 py-px" style={{ backgroundColor: mix("page", 0.2) }}>
                <Text class="font-mono text-2xs font-medium text-page tabular-nums">⌘↩</Text>
              </View>
            </If>
          </View>
        </DesignButton>
        <If when={stagedCount() === 0 && changesCount() > 0}>
          <Button
            onPress={() => act({ type: "stage", paths: (f()?.changes ?? []).map((r) => r.path) })}
            class={`h-6.5 flex-row items-center justify-center gap-1 rounded-md border border-line bg-transparent px-2.5 ${motionClass("transition-opacity duration-120 ease-out")} hover:bg-hover active:opacity-80 focus-visible:outline-2 focus-visible:outline-focus`}
          >
            <Icon name="add" size={11} tone="ink" />
            <Text class="text-xs font-medium text-ink">{t("web.shell.git.stageAllCount", { count: changesCount().toLocaleString() })}</Text>
          </Button>
        </If>
        <If when={props.commitNotice}>{(notice) => <Text class="text-2xs text-ok-ink">{notice()}</Text>}</If>
        <If when={f()?.error}>
          {(err) => (
            <View class="rounded-md border bg-bad-soft px-2 py-1.5" style={{ borderColor: mix("berry", 0.25) }}>
              <Text class="text-2xs text-berry">{err()}</Text>
            </View>
          )}
        </If>
      </View>

      <If when={showFileFilter()}>
        <View class="border-b border-line px-3 py-2">
          <SearchField
            testid="git-files-filter"
            clearTestid="git-files-filter-clear"
            value={props.fileQuery}
            onInput={(v) => props.onFileQueryChange(v)}
            placeholder={t("web.shell.palette.placeholder.files")}
            label={t("web.issue.page.filter")}
            clearLabel={t("web.issue.page.clear")}
          />
        </View>
      </If>

      <If when={conflictsCount() > 0}>
        <View class="pb-1">
          <SectionHead
            title={t("web.shell.git.conflicts")}
            count={filteredConflicts().length}
            tone="danger"
            collapsible
            expanded={props.isOpen("conflicts")}
            onToggle={() => props.toggleSection("conflicts")}
            right={
              <If when={normalizedFileQuery().length > 0 && filteredConflicts().length !== conflictsCount()}>
                <Text class="mr-1 font-mono text-2xs text-faint tabular-nums">{`${filteredConflicts().length}/${conflictsCount()}`}</Text>
              </If>
            }
          />
          <If when={props.isOpen("conflicts")}>
            <If when={filteredConflicts().length > 0} else={<PanelEmpty text={t("web.shell.palette.empty.files")} compact />}>
              <View class="gap-px">
                <Each of={filteredConflicts()} key={(r) => r.path}>
                  {(row) => <FileRow row={row()} staged={false} />}
                </Each>
              </View>
            </If>
          </If>
        </View>
      </If>

      <View class="pb-1">
        <SectionHead
          title={t("web.shell.git.staged")}
          count={filteredStaged().length}
          collapsible
          expanded={props.isOpen("staged")}
          onToggle={() => props.toggleSection("staged")}
          borderTop={conflictsCount() > 0}
          right={
            <If when={stagedCount() > 0}>
              <View class="flex-row items-center gap-1">
                <If when={normalizedFileQuery().length > 0 && filteredStaged().length !== stagedCount()}>
                  <Text class="font-mono text-2xs text-faint tabular-nums">{`${filteredStaged().length}/${stagedCount()}`}</Text>
                </If>
                <ShellIconButton
                  label={t("web.shell.git.unstageAll")}
                  icon="minus"
                  onPress={() => act({ type: "unstage", paths: (f()?.staged ?? []).map((r) => r.path) })}
                />
              </View>
            </If>
          }
        />
        <If when={props.isOpen("staged")}>
          <If when={stagedCount() > 0} else={<PanelEmpty text={t("web.shell.git.stagedEmpty")} compact />}>
            <If when={filteredStaged().length > 0} else={<PanelEmpty text={t("web.shell.palette.empty.files")} compact />}>
              <View class="gap-px">
                <Each of={filteredStaged()} key={(r) => r.path}>
                  {(row) => <FileRow row={row()} staged />}
                </Each>
              </View>
            </If>
          </If>
        </If>
      </View>

      <View class="pb-1">
        <SectionHead
          title={t("web.shell.git.changes")}
          count={filteredChanges().length}
          collapsible
          expanded={props.isOpen("changes")}
          onToggle={() => props.toggleSection("changes")}
          borderTop
          right={
            <If when={changesCount() > 0}>
              <View class="flex-row items-center gap-1">
                <If when={normalizedFileQuery().length > 0 && filteredChanges().length !== changesCount()}>
                  <Text class="font-mono text-2xs text-faint tabular-nums">{`${filteredChanges().length}/${changesCount()}`}</Text>
                </If>
                <ShellIconButton
                  label={t("web.shell.git.stageAll")}
                  icon="add"
                  onPress={() => act({ type: "stage", paths: (f()?.changes ?? []).map((r) => r.path) })}
                />
              </View>
            </If>
          }
        />
        <If when={props.isOpen("changes")}>
          <If when={changesCount() > 0} else={<PanelEmpty text={t("web.shell.git.clean")} compact />}>
            <If when={filteredChanges().length > 0} else={<PanelEmpty text={t("web.shell.palette.empty.files")} compact />}>
              <View class="gap-px">
                <Each of={filteredChanges()} key={(r) => r.path}>
                  {(row) => <FileRow row={row()} staged={false} />}
                </Each>
              </View>
            </If>
          </If>
        </If>
      </View>
    </View>
  );
}
