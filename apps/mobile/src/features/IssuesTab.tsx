import { computed, effect, List, platform, Scroll, signal, Text, untracked, View } from "nsh";
import { isAvailable as mobileAvailable, SegmentedControl } from "nsh/mobile";

import { t } from "@vibevalley/i18n";
import type { Issue, IssueStatus } from "@vibevalley/protocol";

import type { MobileLayout } from "../design/layout";
import { EmptyPanel, FieldInput, MarkdownText, PillButton, SectionCard, SplitPane, StatusTag, TopBar, type TagTone } from "../design/ui";
import { hapticImpact, hapticNotification, hapticSelection, type RemoteSession } from "../infra/session";

type IssueFilterKind = "all" | "active" | "review" | "done";

const FILTERS: readonly IssueFilterKind[] = ["all", "active", "review", "done"];

function filterLabel(kind: IssueFilterKind): string {
  switch (kind) {
    case "all":
      return t("web.remote.issue.filter.all");
    case "active":
      return t("web.remote.issue.filter.active");
    case "review":
      return t("web.remote.issue.filter.review");
    case "done":
      return t("web.remote.issue.filter.done");
  }
}

function matchesFilter(issue: Issue, filter: IssueFilterKind): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return issue.status === "backlog" || issue.status === "todo" || issue.status === "in_progress";
    case "review":
      return issue.status === "in_review";
    case "done":
      return issue.status === "done" || issue.status === "canceled";
  }
}

function statusTone(status: IssueStatus): TagTone {
  switch (status) {
    case "done":
      return "ok";
    case "in_review":
      return "wait";
    case "in_progress":
      return "info";
    case "canceled":
      return "bad";
    case "backlog":
    case "todo":
      return "neutral";
  }
}

export function IssuesTab(props: {
  readonly session: RemoteSession;
  readonly layout: () => MobileLayout;
  readonly selectedIssueId: () => string | undefined;
  readonly onSelectIssue: (id: string | undefined) => void;
}) {
  const filter = signal<IssueFilterKind>("all");
  const commentDrafts = signal<Readonly<Record<string, string>>>({});
  const busy = signal(false);
  const actionError = signal<string | undefined>(undefined);
  const isDual = computed(() => props.layout().mode === "dual_pane");
  // `SegmentedControl` in nsh/mobile maps to UISegmentedControl (iOS only); Android uses the pill filter bar.
  const useNativeSegmented = mobileAvailable && platform.os === "ios";

  const allIssues = computed(() => props.session.board()?.issues ?? []);
  const machineNames = computed(() => new Map((props.session.sessions()?.machines ?? []).map((m) => [m.id, m.name] as const)));
  const machineLabelOf = (machineId: string | undefined): string | undefined => {
    if (machineId === undefined || machineId === "") return undefined;
    return machineNames().get(machineId) ?? machineId;
  };
  const filteredIssues = computed(() => allIssues().filter((issue) => matchesFilter(issue, filter())));
  const hasFilteredIssues = computed(() => filteredIssues().length > 0);
  const selectedIssue = computed(() => {
    const id = props.selectedIssueId();
    if (id === undefined) return undefined;
    return allIssues().find((issue) => issue.id === id);
  });
  const currentCommentDraft = computed(() => {
    const id = props.selectedIssueId();
    return id !== undefined ? (commentDrafts()[id] ?? "") : "";
  });
  const hasCommentDraft = computed(() => currentCommentDraft().trim() !== "");
  const canSend = computed(() => !busy() && hasCommentDraft());
  const filterItems = computed(() => FILTERS.map((kind) => ({ title: filterLabel(kind) })));
  const selectedFilterIndex = computed(() => FILTERS.indexOf(filter()));

  const setCommentDraft = (issueId: string, value: string) => {
    if ((untracked(commentDrafts)[issueId] ?? "") === value) return;
    commentDrafts.update((prev) => ({ ...prev, [issueId]: value }));
  };

  effect(() => {
    if (!isDual()) return;
    const list = filteredIssues();
    const current = props.selectedIssueId();
    if (list.length > 0 && (current === undefined || !list.some((issue) => issue.id === current))) {
      props.onSelectIssue(list[0]?.id);
    }
  });

  const updateStatus = async (issueId: string, status: IssueStatus) => {
    if (untracked(busy)) return;
    busy.set(true);
    actionError.set(undefined);
    try {
      const env = await props.session.call("issue.status.update", { id: issueId, status });
      if (env.bizCode !== 0) {
        actionError.set(env.message);
        hapticNotification("error");
      } else {
        hapticImpact("light");
      }
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      busy.set(false);
    }
  };

  const submitReview = async (issueId: string, pass: boolean) => {
    if (untracked(busy)) return;
    busy.set(true);
    actionError.set(undefined);
    try {
      const notes = (untracked(commentDrafts)[issueId] ?? "").trim();
      const payload = notes ? { id: issueId, pass, text: notes } : { id: issueId, pass };
      const env = await props.session.call("issue.review", payload);
      if (env.bizCode !== 0) {
        actionError.set(env.message);
        hapticNotification("error");
      } else {
        if (notes) setCommentDraft(issueId, "");
        hapticNotification(pass ? "success" : "warning");
      }
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      busy.set(false);
    }
  };

  const submitComment = async (issueId: string) => {
    const text = (untracked(commentDrafts)[issueId] ?? "").trim();
    if (text === "" || untracked(busy)) return;
    setCommentDraft(issueId, "");
    busy.set(true);
    actionError.set(undefined);
    const rollback = (message: string) => {
      actionError.set(message);
      hapticNotification("error");
      if ((untracked(commentDrafts)[issueId] ?? "") === "") setCommentDraft(issueId, text);
    };
    try {
      const env = await props.session.call("issue.comment.create", { id: issueId, text });
      if (env.bizCode !== 0) {
        rollback(env.message);
      } else {
        hapticImpact("light");
      }
    } catch (err: unknown) {
      rollback(err instanceof Error ? err.message : String(err));
    } finally {
      busy.set(false);
    }
  };

  const renderMaster = () => (
    <View class="min-h-0 flex-1">
      <View class="border-b border-line bg-side px-3.5 py-2.5">
        <If
          when={useNativeSegmented}
          else={
            <View testID="issue-filter-bar" class="flex-row items-center gap-1.5">
              <Each of={FILTERS} key={(kind) => kind}>
                {(kind) => (
                  <PillButton
                    testID={`issue-filter-${kind()}`}
                    size="sm"
                    tone={filter() === kind() ? "primary" : "plain"}
                    label={filterLabel(kind())}
                    onPress={() => {
                      hapticSelection();
                      filter.set(kind());
                    }}
                    class="flex-1"
                  />
                )}
              </Each>
            </View>
          }
        >
          <SegmentedControl
            testID="issue-filter-segmented"
            class="w-full"
            items={filterItems()}
            selectedIndex={selectedFilterIndex()}
            onChange={(e) => {
              const next = FILTERS[e.index];
              if (next !== undefined) {
                hapticSelection();
                filter.set(next);
              }
            }}
          />
        </If>
      </View>

      <If when={hasFilteredIssues()} else={<EmptyPanel testID="issues-empty" icon="issues" message={t("web.remote.issue.empty")} />}>
        <List
          testID="issues-list"
          each={filteredIssues()}
          keyExtractor={(issue) => issue.id}
          estimatedItemSize={96}
          class="min-h-0 flex-1"
          contentClass="gap-2.5 p-3.5"
        >
          {(issue) => {
            const active = computed(() => isDual() && props.selectedIssueId() === issue().id);
            return (
              <SectionCard
                testID={`issue-row-${issue().id}`}
                onPress={() => {
                  hapticImpact("light");
                  actionError.set(undefined);
                  props.onSelectIssue(issue().id);
                }}
                class={`gap-2 ${active() ? "border-focus bg-selected" : ""}`}
              >
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="font-mono text-xs text-muted">#{String(issue().number)}</Text>
                  <View class="flex-row items-center gap-1.5">
                    <If when={machineLabelOf(issue().machineId)}>
                      {(label) => <StatusTag testID={`issue-machine-${issue().id}`} label={label()} icon="devices" tone="info" />}
                    </If>
                    <StatusTag label={issue().status} tone={statusTone(issue().status)} />
                  </View>
                </View>
                <Text class="text-sm font-semibold text-ink">{issue().title}</Text>
                <If when={issue().description}>{(desc) => <Text class="truncate text-xs text-muted">{desc()}</Text>}</If>
              </SectionCard>
            );
          }}
        </List>
      </If>
    </View>
  );

  const renderDetail = () => (
    <If when={selectedIssue()}>
      {(issue) => (
        <View testID="issue-detail" class="min-h-0 flex-1">
          <TopBar
            testID="issue-detail-bar"
            backTestID="issue-back"
            title={`#${String(issue().number)} ${issue().title}`}
            subtitle={issue().repo}
            onBack={isDual() ? undefined : () => props.onSelectIssue(undefined)}
          />

          <If when={actionError()}>
            {(msg) => (
              <View testID="issue-error" class="mx-4 mt-2 rounded-lg border border-berry bg-bad-soft px-3 py-2">
                <Text class="text-xs font-medium text-berry">{msg()}</Text>
              </View>
            )}
          </If>

          <Scroll class="flex-1" contentClass="gap-3.5 p-4">
            <SectionCard class="gap-2.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-xs font-semibold text-muted">{t("web.remote.issue.status")}</Text>
                <View class="flex-row items-center gap-1.5">
                  <If when={machineLabelOf(issue().machineId)}>
                    {(label) => <StatusTag testID="issue-detail-machine" label={label()} icon="devices" tone="info" />}
                  </If>
                  <StatusTag testID="issue-detail-status" label={issue().status} tone={statusTone(issue().status)} />
                </View>
              </View>
              <If when={issue().description}>{(desc) => <MarkdownText testID="issue-detail-description" text={desc()} size="sm" />}</If>
              <If when={issue().moves.length > 0}>
                <View class="flex-row flex-wrap gap-2 pt-1">
                  <Each of={issue().moves} key={(status) => status}>
                    {(status) => (
                      <PillButton
                        testID={`issue-move-${status()}`}
                        size="sm"
                        tone="plain"
                        label={status()}
                        disabled={busy()}
                        onPress={() => {
                          void updateStatus(issue().id, status());
                        }}
                      />
                    )}
                  </Each>
                </View>
              </If>
            </SectionCard>

            <SectionCard class="gap-2.5">
              <View class="flex-row items-center gap-2">
                <PillButton
                  testID="issue-review-approve"
                  tone="ok"
                  size="sm"
                  icon="check"
                  label={t("web.remote.issue.approve")}
                  disabled={busy()}
                  onPress={() => {
                    void submitReview(issue().id, true);
                  }}
                  class="flex-1"
                />
                <PillButton
                  testID="issue-review-changes"
                  tone="danger"
                  size="sm"
                  icon="cross"
                  label={t("web.remote.issue.changes")}
                  disabled={busy()}
                  onPress={() => {
                    void submitReview(issue().id, false);
                  }}
                  class="flex-1"
                />
              </View>
            </SectionCard>
          </Scroll>

          <View class="flex-row items-center gap-2 border-t border-line bg-side px-3.5 py-2.5">
            <FieldInput
              testID="issue-comment-input"
              placeholder={t("web.remote.issue.comment")}
              value={currentCommentDraft()}
              onInput={(v) => setCommentDraft(issue().id, v)}
              onSubmit={() => {
                void submitComment(issue().id);
              }}
              class="min-w-0 flex-1"
            />
            <PillButton
              testID="issue-comment-send"
              tone="primary"
              size="sm"
              icon="send"
              label={t("web.remote.issue.comment")}
              disabled={!canSend()}
              onPress={() => {
                void submitComment(issue().id);
              }}
            />
          </View>
        </View>
      )}
    </If>
  );

  return (
    <SplitPane
      testID="issues-tab"
      layout={props.layout}
      hasSelection={() => selectedIssue() !== undefined}
      master={renderMaster}
      detail={renderDetail}
      emptyDetail={() => <EmptyPanel testID="issue-detail-empty" icon="issues" message={t("web.remote.issue.empty")} />}
    />
  );
}
