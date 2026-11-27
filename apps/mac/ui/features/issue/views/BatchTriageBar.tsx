import { computed, signal, Text, View } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Issue, type IssueStatus, type Priority, PriorityValues } from "@vibevalley/protocol";
import { IssueStatus as IssueStatusSchema } from "@vibevalley/protocol/schema";

import { Button } from "../../../design/Button";
import { Select } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { toast } from "../../../design/toasts";
import { useWorkAgents } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { ready, useRepos } from "../../../infra/query";
import { decodeActorRef } from "../model/display";
import { normalizeTagList } from "../model/meta";
import { TagEditor, useOwnerOptions } from "./IssueMetaControls";

const CLEAR_SENTINEL = "__clear__";

function asStatus(raw: string): IssueStatus | undefined {
  return IssueStatusSchema.options.find((s) => s === raw);
}

function asPriority(raw: string): Priority | undefined {
  return PriorityValues.find((p) => p === raw);
}

/** Floating bottom batch triage bar for multi-selected issues on `/issues`. */
export function BatchTriageBar(props: { selectedIssues: readonly Issue[]; allIssues: readonly Issue[]; onClear: () => void }) {
  const busy = signal(false);
  const tagsOpen = signal(false);
  const tagDraft = signal<string[]>([]);
  const workAgents = useWorkAgents(true);
  const repoList = useRepos();
  const ownerOptions = useOwnerOptions(() => props.allIssues);

  const statusOptions = computed(() => IssueStatusSchema.options.map((s) => ({ value: s, label: t(`shared.status.${s}`) })));
  const priorityOptions = computed(() => PriorityValues.map((p) => ({ value: p, label: t(`shared.priority.${p}`) })));
  const agentOptions = computed(() => [
    ...workAgents().map((a) => ({ value: a.id, label: a.name })),
    { value: CLEAR_SENTINEL, label: t("web.issue.triage.noAgent") },
  ]);
  const fullOwnerOptions = computed(() => [
    ...ownerOptions(),
    { value: CLEAR_SENTINEL, label: t("web.issue.triage.noOwner"), group: t("web.issue.owner.peopleGroup") },
  ]);
  const repoOptions = computed(() => {
    const names = new Set<string>(ready(repoList, []).map((r) => r.name));
    for (const i of props.allIssues) {
      if (i.repo) names.add(i.repo);
    }
    return [...[...names].toSorted().map((r) => ({ value: r, label: r })), { value: CLEAR_SENTINEL, label: t("web.issue.triage.noRepo") }];
  });

  const runBatch = async (tasks: readonly Promise<unknown>[]) => {
    if (tasks.length === 0 || busy()) return;
    busy.set(true);
    try {
      const results = await Promise.allSettled(tasks);
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const failed = results.length - ok;
      if (failed === 0 && ok > 0) toast(t("web.issue.triage.updated", { n: ok }));
      else if (failed > 0) toast(t("web.issue.triage.partial", { ok, failed }));
    } finally {
      busy.set(false);
    }
  };

  const applyStatus = (raw: string) => {
    const status = asStatus(raw);
    if (!status) return;
    const targets = props.selectedIssues.filter((issue) => issue.status !== status);
    void runBatch(targets.map((issue) => api.issue.status.update({ id: issue.id, status })));
  };

  const applyAgent = (raw: string) => {
    if (raw === "") return;
    const agent = raw === CLEAR_SENTINEL ? "" : raw;
    void runBatch(props.selectedIssues.map((issue) => api.issue.update({ id: issue.id, agent })));
  };

  const applyOwner = (raw: string) => {
    if (raw === "") return;
    const resolved = raw === CLEAR_SENTINEL ? { kind: "user" as const, id: "" } : decodeActorRef(raw);
    if (!resolved) return;
    void runBatch(props.selectedIssues.map((issue) => api.issue.update({ id: issue.id, owner: resolved })));
  };

  const applyRepo = (raw: string) => {
    if (raw === "") return;
    const repo = raw === CLEAR_SENTINEL ? "" : raw;
    void runBatch(props.selectedIssues.map((issue) => api.issue.update({ id: issue.id, repo })));
  };

  const applyPriority = (raw: string) => {
    const priority = asPriority(raw);
    if (!priority) return;
    void runBatch(props.selectedIssues.map((issue) => api.issue.update({ id: issue.id, priority })));
  };

  const applyTags = (mode: "add" | "replace") => {
    const picked = normalizeTagList(tagDraft());
    if (mode === "add" && picked.length === 0) return;
    tagsOpen.set(false);
    tagDraft.set([]);
    void runBatch(
      props.selectedIssues.map((issue) => {
        const nextTags = mode === "add" ? normalizeTagList([...(issue.tags ?? []), ...picked]) : picked;
        return api.issue.update({ id: issue.id, tags: nextTags });
      }),
    );
  };

  return (
    <View class="pointer-events-none absolute right-4 bottom-4 left-4 z-30 items-center">
      <View
        testID="batch-triage-bar"
        accessibilityLabel={t("web.issue.triage.selected", { n: props.selectedIssues.length })}
        class="pointer-events-auto max-w-full flex-row flex-wrap items-center gap-1.5 rounded-xl border border-line-strong bg-elevated px-3 py-2 shadow-float"
      >
        <View testID="batch-triage-count" class="flex-row items-center gap-1.5 rounded-md bg-selected px-2 py-1">
          <Icon name="check" size={12} tone="accent" />
          <Text class="text-xs font-semibold text-ink tabular-nums">{t("web.issue.triage.selected", { n: props.selectedIssues.length })}</Text>
        </View>
        <View class="mx-0.5 h-4 w-px bg-line" />
        <Select<string>
          size="control"
          text="xs"
          class="w-28"
          label={t("web.issue.triage.status")}
          testid="batch-triage-status"
          value=""
          placeholder={t("web.issue.triage.status")}
          disabled={busy()}
          options={statusOptions()}
          onChange={applyStatus}
        />
        <Select<string>
          size="control"
          text="xs"
          class="w-32"
          searchable
          label={t("web.issue.triage.agent")}
          testid="batch-triage-agent"
          value=""
          placeholder={t("web.issue.triage.agent")}
          disabled={busy()}
          options={agentOptions()}
          onChange={applyAgent}
        />
        <Select<string>
          size="control"
          text="xs"
          class="w-32"
          searchable
          label={t("web.issue.triage.owner")}
          testid="batch-triage-owner"
          value=""
          placeholder={t("web.issue.triage.owner")}
          disabled={busy()}
          options={fullOwnerOptions()}
          onChange={applyOwner}
        />
        <Select<string>
          size="control"
          text="xs"
          class="w-28"
          searchable
          label={t("web.issue.triage.repo")}
          testid="batch-triage-repo"
          value=""
          placeholder={t("web.issue.triage.repo")}
          disabled={busy()}
          options={repoOptions()}
          onChange={applyRepo}
        />
        <Select<string>
          size="control"
          text="xs"
          class="w-28"
          label={t("web.issue.triage.priority")}
          testid="batch-triage-priority"
          value=""
          placeholder={t("web.issue.triage.priority")}
          disabled={busy()}
          options={priorityOptions()}
          onChange={applyPriority}
        />
        <Popover
          open={tagsOpen()}
          onOpenChange={(e) => tagsOpen.set(e.open)}
          placement="top"
          align="start"
          offset={6}
          popupClass="w-72 gap-2.5 rounded-lg border border-line-strong bg-elevated p-3 shadow-float"
          trigger={
            <View
              role="button"
              testID="batch-triage-tags-trigger"
              accessibilityLabel={t("web.issue.triage.tags")}
              class="h-7 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2.5 hover:border-faint hover:bg-hover"
            >
              <Icon name="catalog" size={12} tone="muted" />
              <Text class="text-xs text-ink">{t("web.issue.triage.tags")}</Text>
            </View>
          }
        >
          <View testID="batch-triage-tags-popover" class="gap-2.5">
            <TagEditor compact tags={tagDraft()} disabled={busy()} onChange={(next) => tagDraft.set(next)} testid="batch-triage-tag-editor" />
            <View class="flex-row items-center justify-end gap-1.5 border-t border-line pt-2">
              <Button size="compact" tone="plain" testID="batch-triage-tags-replace" disabled={busy()} onPress={() => applyTags("replace")}>
                {t("web.issue.triage.replaceTags")}
              </Button>
              <Button
                size="compact"
                tone="primary"
                testID="batch-triage-tags-add"
                disabled={busy() || tagDraft().length === 0}
                onPress={() => applyTags("add")}
              >
                {t("web.issue.triage.addTags")}
              </Button>
            </View>
          </View>
        </Popover>
        <View class="mx-0.5 h-4 w-px bg-line" />
        <Button size="compact" tone="quiet" icon="close" testID="batch-triage-clear" onPress={() => props.onClear()}>
          {t("web.issue.triage.clear")}
        </Button>
      </View>
    </View>
  );
}
