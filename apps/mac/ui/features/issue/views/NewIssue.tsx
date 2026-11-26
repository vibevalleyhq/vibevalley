import { cleanup, computed, effect, keymap, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ActorRef, Attachment, RuntimeInfo } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Dialog } from "../../../design/Dialog";
import { AgentReadinessNote, AgentSelect } from "../../../design/domain/AgentSelect";
import { Select, TextArea } from "../../../design/Field";
import { IconButton } from "../../../design/IconButton";
import { Banner } from "../../../design/layout";
import { toast } from "../../../design/toasts";
import { useWorkAgentReadiness, useWorkAgents } from "../../../infra/agents";
import { newSendKey } from "../../../infra/api";
import { useSessionsSlice } from "../../../infra/frame";
import { ready, useRepos, useRuntimes } from "../../../infra/query";
import { useRouter } from "../../../infra/router";
import { prefsNow } from "../../../infra/state/prefs";
import { canSubmitDraft, type DraftSubmitEvent, type DraftSubmitState, draftSubmitTransition, initialDraftSubmit } from "../model/draftSubmit";
import { useIssues } from "../model/history";
import { createAttachmentUploader, IssueAttachmentStrip } from "./IssueAttachments";
import { DatePropertyEditor, OwnerPicker, ParentPicker, TagEditor } from "./IssueMetaControls";

const isRuntimeReady = (runtime: RuntimeInfo) => runtime.installation.status === "available" && runtime.settings.enabled;

/** The repo, helper, owner, optional execution machine, parent issue, starter template text, tags, attachment ids, or schedule dates for a new issue. */
export interface NewIssueAt {
  readonly repo?: string;
  readonly agent?: string;
  readonly owner?: ActorRef | undefined;
  readonly machineId?: string;
  readonly parent?: string;
  readonly text?: string;
  readonly attachments?: readonly string[];
  readonly attachmentFiles?: readonly Attachment[];
  readonly tags?: readonly string[];
  readonly startAt?: number;
  readonly dueAt?: number;
}

export function NewIssue(props: { at: NewIssueAt; onKeep: (words: string, where: NewIssueAt, requestKey: string) => Promise<boolean>; onClose: () => void }) {
  const router = useRouter();
  const last = prefsNow();
  const flow = signal<DraftSubmitState>(
    initialDraftSubmit({
      text: props.at.text ?? "",
      repo: props.at.repo ?? last.repo,
      agent: props.at.agent ?? (last.pick === "auto" ? "" : last.pick),
      attachments: [...(props.at.attachmentFiles ?? [])],
    }),
  );
  const machineId = signal(props.at.machineId ?? "");
  const owner = signal<ActorRef | undefined>(props.at.owner ?? { kind: "user", id: "self" });
  const parent = signal(props.at.parent ?? "");
  const tags = signal<string[]>([...(props.at.tags ?? [])]);
  const startAt = signal<number | undefined>(props.at.startAt);
  const dueAt = signal<number | undefined>(props.at.dueAt);
  const hasSchedule = computed(() => startAt() !== undefined || dueAt() !== undefined);
  const allIssues = useIssues();
  const dispatch = (event: DraftSubmitEvent): DraftSubmitState => {
    const next = draftSubmitTransition(untracked(flow), event, newSendKey);
    flow.set(next);
    return next;
  };
  const uploader = createAttachmentUploader((file) => {
    dispatch({ kind: "addAttachment", file });
  });
  const draft = () => flow().draft;
  const agents = useWorkAgents(true);
  const agentReadiness = useWorkAgentReadiness(true);
  const repoList = useRepos();
  const runtimeList = useRuntimes();
  const repos = computed(() => ready(repoList, []).map((p) => p.name));
  const sessions = useSessionsSlice();
  const machines = computed(() => sessions()?.machines ?? []);
  const hasMultipleMachines = computed(() => machines().length > 1 || machines().some((m) => !m.here));
  const noRepos = computed(() => repoList.status() === "success" && repos().length === 0);
  const noReadyRuntimes = computed(() => runtimeList.status() === "success" && ready(runtimeList, []).filter(isRuntimeReady).length === 0);
  const canSubmit = computed(() => canSubmitDraft(flow()));
  const repoOptions = computed(() => [...new Set([...repos(), ...(draft().repo ? [draft().repo] : [])])].map((p) => ({ value: p, label: p })));
  const machineOptions = computed(() => machines().map((m) => ({ value: m.id, label: m.name })));
  const goTo = (path: string) => {
    props.onClose();
    router.navigate(path);
  };
  const textFocused = signal(true);
  let mounted = true;
  cleanup(() => {
    mounted = false;
  });
  const keep = async () => {
    if (!canSubmitDraft(untracked(flow))) return;
    const started = dispatch({ kind: "submit" });
    if (started.kind !== "submitting") return;
    const { submitted, requestKey } = started;
    const pickedMachine = untracked(machineId);
    const pickedOwner = untracked(owner);
    const pickedParent = untracked(parent);
    const pickedTags = untracked(tags);
    const pickedStartAt = untracked(startAt);
    const pickedDueAt = untracked(dueAt);
    let kept = false;
    try {
      kept = await props.onKeep(
        submitted.words,
        {
          ...(submitted.repo ? { repo: submitted.repo } : {}),
          ...(submitted.agent ? { agent: submitted.agent } : {}),
          ...(pickedOwner ? { owner: pickedOwner } : {}),
          ...(pickedMachine ? { machineId: pickedMachine } : {}),
          ...(pickedParent ? { parent: pickedParent } : {}),
          ...(submitted.attachments.length > 0 ? { attachments: submitted.attachments.map((file) => file.id) } : {}),
          ...(pickedTags.length > 0 ? { tags: pickedTags } : {}),
          ...(pickedStartAt !== undefined ? { startAt: pickedStartAt } : {}),
          ...(pickedDueAt !== undefined ? { dueAt: pickedDueAt } : {}),
        },
        requestKey,
      );
    } catch (error) {
      if (mounted) dispatch({ kind: "rejected" });
      throw error;
    }
    if (!mounted) return;
    const settled = dispatch({ kind: kept ? "accepted" : "rejected" });
    switch (settled.kind) {
      case "committed":
        props.onClose();
        break;
      case "retainedDirty":
        toast(t("web.issue.new.editsKept"));
        break;
      case "editing":
      case "submitting":
      case "rejected":
        break;
    }
  };
  keymap.bind("mod+enter", () => void keep(), { when: "always" });
  effect(() => {
    if (textFocused()) return keymap.bind("escape", props.onClose, { when: "always" });
  });
  return (
    <Dialog open onClose={props.onClose} title={t("web.issue.new.title")} size="md" height="auto" scroll={false} testid="issue-new-dialog">
      <View class="min-h-0 shrink">
        <Scroll class="min-h-0 shrink" contentClass="gap-3 px-5 py-4">
          <TextArea
            testID="issue-new-text"
            accessibilityLabel={t("web.issue.new.words")}
            placeholder={t("web.issue.new.placeholder")}
            rows={4}
            value={draft().text}
            autoFocus
            onInput={(text) => dispatch({ kind: "setText", text })}
            onFocus={() => textFocused.set(true)}
            onBlur={() => textFocused.set(false)}
          />
          <IssueAttachmentStrip
            files={draft().attachments}
            uploading={uploader.uploading()}
            onRemove={(id) => dispatch({ kind: "removeAttachment", id })}
            testid="issue-new-attachments"
          />
          <View class="flex-row flex-wrap items-center gap-2">
            <If when={!noRepos()}>
              <Select
                quiet
                size="control"
                searchable
                searchPlaceholder={t("web.shell.palette.mode.search")}
                emptyText={t("web.base.table.empty")}
                label={t("web.issue.task.repo")}
                testid="issue-new-repo"
                value={draft().repo}
                placeholder={t("web.issue.todo.whichRepo")}
                onChange={(repo) => dispatch({ kind: "setRepo", repo })}
                options={repoOptions()}
              />
            </If>
            <If when={!noReadyRuntimes()}>
              <AgentSelect
                quiet
                size="control"
                label={t("web.issue.detail.helper")}
                testid="issue-new-helper"
                value={draft().agent}
                agents={agents()}
                readiness={agentReadiness}
                placeholder={t("web.issue.todo.pickForMe")}
                onChange={(agent) => dispatch({ kind: "setAgent", agent })}
              />
            </If>
            <OwnerPicker
              owner={owner()}
              allIssues={allIssues()}
              testid="issue-new-owner"
              clearable={false}
              class="min-w-32 shrink-0"
              onChange={(next) => owner.set(next)}
            />
            <If when={hasMultipleMachines()}>
              <Select
                quiet
                size="control"
                label={t("web.issue.new.machine")}
                testid="issue-new-machine"
                value={machineId()}
                placeholder={t("web.issue.new.machineAuto")}
                onChange={(id) => machineId.set(id)}
                options={machineOptions()}
              />
            </If>
          </View>
          <If when={!noReadyRuntimes() && draft().agent !== ""}>
            <AgentReadinessNote agentId={draft().agent} readiness={agentReadiness} testid="issue-new-helper-status" onNavigate={goTo} />
          </If>
          <View class="flex-row flex-wrap items-center gap-2">
            <If when={allIssues().length > 0}>
              <View class="min-w-44 flex-1">
                <ParentPicker issueId="" parentId={parent()} allIssues={allIssues()} testid="issue-new-parent" onChange={(next) => parent.set(next)} />
              </View>
            </If>
            <View testID={hasSchedule() ? "issue-new-dates" : undefined} class="flex-row flex-wrap items-center gap-2">
              <View class="w-36">
                <DatePropertyEditor
                  label={t("web.issue.dates.startAt")}
                  placeholder={t("web.issue.dates.startAt")}
                  value={startAt()}
                  testid="issue-new-start-at"
                  quiet={false}
                  maxMs={dueAt()}
                  onCommit={(ms) => startAt.set(ms > 0 ? ms : undefined)}
                />
              </View>
              <View class="w-36">
                <DatePropertyEditor
                  label={t("web.issue.dates.dueAt")}
                  placeholder={t("web.issue.dates.dueAt")}
                  value={dueAt()}
                  testid="issue-new-due-at"
                  quiet={false}
                  minMs={startAt()}
                  onCommit={(ms) => dueAt.set(ms > 0 ? ms : undefined)}
                />
              </View>
            </View>
          </View>
          <View class="gap-1">
            <Text class="text-xs font-medium text-muted">{t("web.issue.tags.label")}</Text>
            <TagEditor compact tags={tags()} onChange={(next) => tags.set(next)} testid="issue-new-tags" />
          </View>
          <If when={noRepos() || noReadyRuntimes()}>
            <View class="gap-2">
              <If when={noRepos()}>
                <Banner tone="warn" size="sm" icon="repos">
                  <View testID="issue-new-missing-repo" class="flex-row items-center justify-between gap-2">
                    <Text class="min-w-0 flex-1 text-xs leading-snug text-warn-ink">{t("web.issue.new.missingRepo")}</Text>
                    <Button size="compact" icon="repos" testID="issue-new-go-repos" onPress={() => goTo("/repos")}>
                      {t("web.issue.new.goRepos")}
                    </Button>
                  </View>
                </Banner>
              </If>
              <If when={noReadyRuntimes()}>
                <Banner tone="warn" size="sm" icon="runtimes">
                  <View testID="issue-new-missing-runtime" class="flex-row items-center justify-between gap-2">
                    <Text class="min-w-0 flex-1 text-xs leading-snug text-warn-ink">{t("web.issue.new.missingRuntime")}</Text>
                    <Button size="compact" icon="runtimes" testID="issue-new-go-runtimes" onPress={() => goTo("/runtimes")}>
                      {t("web.issue.new.goRuntimes")}
                    </Button>
                  </View>
                </Banner>
              </If>
            </View>
          </If>
        </Scroll>
        <View class="shrink-0 flex-row items-center justify-end gap-2 border-t border-line px-5 py-3">
          <IconButton icon="attach" size={14} label={t("web.issue.attachments.attachFile")} onClick={() => void uploader.pick()} testid="issue-new-attach" />
          <Text class="mr-auto text-xs text-faint">{t("web.issue.new.keys")}</Text>
          <Button tone="quiet" testID="issue-new-dialog-never" onPress={() => props.onClose()}>
            {t("web.base.form.never")}
          </Button>
          <Button tone="primary" testID="issue-new-keep" disabled={!canSubmit()} onPress={() => void keep()}>
            {t("web.issue.new.keep")}
          </Button>
        </View>
      </View>
    </Dialog>
  );
}
