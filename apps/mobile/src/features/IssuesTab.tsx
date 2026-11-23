import { effect, platform, Scroll, signal, Text, View } from "nsh";
import { isAvailable as mobileAvailable, SegmentedControl } from "nsh/mobile";

import { t } from "@vibevalley/i18n";
import type { Issue, IssueStatus } from "@vibevalley/protocol";

import type { MobileLayout } from "../design/layout";
import { EmptyPanel, FieldInput, PillButton, SectionCard, SplitPane, StatusTag, TopBar, type TagTone } from "../design/ui";
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
  const commentDraft = signal("");
  const busy = signal(false);
  const actionError = signal<string | undefined>(undefined);
  const isDual = () => props.layout().mode === "dual_pane";
  // `SegmentedControl` in nsh/mobile maps to UISegmentedControl (iOS only); Android uses the pill filter bar.
  const useNativeSegmented = mobileAvailable && platform.os === "ios";

  const allIssues = () => props.session.board()?.issues ?? [];
  const filteredIssues = () => allIssues().filter((issue) => matchesFilter(issue, filter()));
  const selectedIssue = () => {
    const id = props.selectedIssueId();
    if (id === undefined) return undefined;
    return allIssues().find((issue) => issue.id === id);
  };

  effect(() => {
    if (!isDual()) return;
    const list = filteredIssues();
    const current = props.selectedIssueId();
    if (list.length > 0 && (current === undefined || !list.some((issue) => issue.id === current))) {
      props.onSelectIssue(list[0]?.id);
    }
  });

  const quickStatuses = (issue: Issue): readonly IssueStatus[] => {
    if (issue.moves.length > 0) return issue.moves;
    const defaults: IssueStatus[] = ["todo", "in_progress", "in_review", "done"];
    return defaults.filter((status) => status !== issue.status);
  };

  const updateStatus = async (issueId: string, status: IssueStatus) => {
    if (busy()) return;
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
    } finally {
      busy.set(false);
    }
  };

  const submitReview = async (issueId: string, pass: boolean) => {
    if (busy()) return;
    busy.set(true);
    actionError.set(undefined);
    try {
      const notes = commentDraft().trim();
      const payload = notes ? { id: issueId, pass, text: notes } : { id: issueId, pass };
      const env = await props.session.call("issue.review", payload);
      if (env.bizCode !== 0) {
        actionError.set(env.message);
        hapticNotification("error");
      } else {
        if (notes) commentDraft.set("");
        hapticNotification(pass ? "success" : "warning");
      }
    } finally {
      busy.set(false);
    }
  };

  const submitComment = async (issueId: string) => {
    const text = commentDraft().trim();
    if (text === "" || busy()) return;
    busy.set(true);
    actionError.set(undefined);
    try {
      const env = await props.session.call("issue.comment.create", { id: issueId, text });
      if (env.bizCode !== 0) {
        actionError.set(env.message);
        hapticNotification("error");
      } else {
        commentDraft.set("");
        hapticImpact("light");
      }
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
            items={FILTERS.map((kind) => ({ title: filterLabel(kind) }))}
            selectedIndex={FILTERS.indexOf(filter())}
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

      <If when={filteredIssues().length > 0} else={<EmptyPanel testID="issues-empty" icon="issues" message={t("web.remote.issue.empty")} />}>
        <Scroll class="flex-1" contentClass="gap-2.5 p-3.5">
          <Each of={filteredIssues()} key={(issue) => issue.id}>
            {(issue) => {
              const active = () => isDual() && props.selectedIssueId() === issue().id;
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
                    <StatusTag label={issue().status} tone={statusTone(issue().status)} />
                  </View>
                  <Text class="text-sm font-semibold text-ink">{issue().title}</Text>
                  <If when={issue().description}>{(desc) => <Text class="truncate text-xs text-muted">{desc()}</Text>}</If>
                </SectionCard>
              );
            }}
          </Each>
        </Scroll>
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
                <StatusTag testID="issue-detail-status" label={issue().status} tone={statusTone(issue().status)} />
              </View>
              <If when={issue().description}>{(desc) => <Text class="text-sm text-ink">{desc()}</Text>}</If>
              <View class="flex-row flex-wrap gap-2 pt-1">
                <Each of={quickStatuses(issue())} key={(status) => status}>
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
              value={commentDraft()}
              onInput={(v) => commentDraft.set(v)}
              onSubmit={() => {
                void submitComment(issue().id);
              }}
              disabled={busy()}
              class="min-w-0 flex-1"
            />
            <PillButton
              testID="issue-comment-send"
              tone="primary"
              size="sm"
              icon="send"
              label={t("web.remote.issue.comment")}
              disabled={busy() || commentDraft().trim() === ""}
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
