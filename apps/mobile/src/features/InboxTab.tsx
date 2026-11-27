import { computed, effect, List, Scroll, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { InboxItem, SessionPermissionDecision } from "@vibevalley/protocol";

import type { MobileLayout } from "../design/layout";
import { EmptyPanel, FieldInput, MarkdownText, PillButton, SectionCard, SplitPane, StatusTag, TopBar, type TagTone } from "../design/ui";
import { hapticImpact, hapticNotification, type PendingInteractionItem, type PendingPermissionItem, type RemoteSession } from "../infra/session";

type InboxEntry =
  | { readonly kind: "permission"; readonly key: string; readonly item: PendingPermissionItem }
  | { readonly kind: "interaction"; readonly key: string; readonly item: PendingInteractionItem }
  | { readonly kind: "inbox"; readonly key: string; readonly item: InboxItem };

function permissionOf(entry: InboxEntry): PendingPermissionItem | undefined {
  return entry.kind === "permission" ? entry.item : undefined;
}

function interactionOf(entry: InboxEntry): PendingInteractionItem | undefined {
  return entry.kind === "interaction" ? entry.item : undefined;
}

function inboxItemOf(entry: InboxEntry): InboxItem | undefined {
  return entry.kind === "inbox" ? entry.item : undefined;
}

function entryTitle(entry: InboxEntry): string {
  switch (entry.kind) {
    case "permission":
    case "interaction":
      return entry.item.sessionName;
    case "inbox":
      return entry.item.words.title || entry.item.who;
  }
}

function inboxKindTone(kind: InboxItem["kind"]): TagTone {
  switch (kind) {
    case "ask":
    case "cron-ask":
      return "wait";
    case "review":
      return "info";
    case "fix":
    case "conflict":
    case "interrupted":
    case "budget_reached":
      return "bad";
    case "quiet":
    case "mention":
      return "neutral";
  }
}

function targetTabLabel(target: InboxItem["target"]): string {
  switch (target.kind) {
    case "issue":
      return t("web.remote.tabs.issues");
    case "chat":
      return t("web.remote.tabs.channels");
    case "session":
    case "runtime":
      return t("web.remote.tabs.sessions");
  }
}

export function InboxTab(props: {
  readonly session: RemoteSession;
  readonly layout: () => MobileLayout;
  readonly selectedKey: () => string | undefined;
  readonly onSelectKey: (key: string | undefined) => void;
  readonly onNavigateTarget: (target: InboxItem["target"]) => void;
}) {
  const busyKey = signal<string | undefined>(undefined);
  const answerDrafts = signal<Readonly<Record<string, string>>>({});
  const rejectOpenId = signal<string | undefined>(undefined);
  const rejectDrafts = signal<Readonly<Record<string, string>>>({});
  const actionError = signal<string | undefined>(undefined);
  let userPicked = false;

  const items = computed(() => props.session.inbox()?.items ?? []);
  const permissions = () => props.session.pendingPermissions();
  const interactions = () => props.session.pendingInteractions();
  const isDual = computed(() => props.layout().mode === "dual_pane");

  const entries = computed((): readonly InboxEntry[] => [
    ...permissions().map((item) => ({ kind: "permission" as const, key: `perm:${item.sessionId}:${item.request.requestId}`, item })),
    ...interactions().map((item) => ({ kind: "interaction" as const, key: `inter:${item.sessionId}:${item.request.requestId}`, item })),
    ...items().map((item) => ({ kind: "inbox" as const, key: `item:${item.id}`, item })),
  ]);
  const hasEntries = computed(() => entries().length > 0);

  const selectedEntry = computed(() => {
    const key = props.selectedKey();
    if (key === undefined) return undefined;
    return entries().find((entry) => entry.key === key);
  });

  effect(() => {
    const list = entries();
    const current = props.selectedKey();
    if (isDual()) {
      if (list.length === 0) {
        userPicked = false;
        if (current !== undefined) props.onSelectKey(undefined);
      } else if (current === undefined || !list.some((entry) => entry.key === current)) {
        userPicked = false;
        props.onSelectKey(list[0]?.key);
      } else if (!userPicked && list[0]?.key !== current) {
        // Before the user manually picks a row, keep focus on the highest-priority item as permissions load in.
        props.onSelectKey(list[0]?.key);
      }
    } else if (current !== undefined && !list.some((entry) => entry.key === current)) {
      userPicked = false;
      props.onSelectKey(undefined);
    }
  });

  const setDraft = (key: string, value: string) => {
    if ((untracked(answerDrafts)[key] ?? "") === value) return;
    answerDrafts.update((prev) => ({ ...prev, [key]: value }));
  };

  const setRejectDraft = (itemId: string, value: string) => {
    if ((untracked(rejectDrafts)[itemId] ?? "") === value) return;
    rejectDrafts.update((prev) => ({ ...prev, [itemId]: value }));
  };

  const issueIdOf = (item: InboxItem): string | undefined => {
    switch (item.target.kind) {
      case "issue":
        return item.target.id;
      case "session": {
        const sessId = item.target.id;
        const fromBinding = (props.session.sessions()?.sessions ?? []).find((s) => s.id === sessId)?.bindings.find((b) => b.kind === "issue")?.id;
        if (fromBinding !== undefined) return fromBinding;
        return (props.session.board()?.issues ?? []).find((issue) => issue.assignments.some((a) => a.executions.some((e) => e.session === sessId)))?.id;
      }
      case "chat":
      case "runtime":
        return undefined;
    }
  };

  const acceptReview = async (itemId: string, issueId: string) => {
    const key = `review:${itemId}`;
    if (untracked(busyKey) === key) return;
    busyKey.set(key);
    actionError.set(undefined);
    try {
      const res = await props.session.call("issue.status.update", {
        id: issueId,
        status: "done",
      });
      if (res.bizCode !== 0) {
        actionError.set(res.message);
        hapticNotification("error");
      } else {
        if (untracked(rejectOpenId) === itemId) rejectOpenId.set(undefined);
        hapticNotification("success");
      }
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      busyKey.set(undefined);
    }
  };

  const submitRejectReview = async (itemId: string, issueId: string) => {
    const text = (untracked(rejectDrafts)[itemId] ?? "").trim();
    const key = `review:${itemId}`;
    if (text === "" || untracked(busyKey) === key) return;
    busyKey.set(key);
    actionError.set(undefined);
    try {
      const res = await props.session.call("issue.review", {
        id: issueId,
        pass: false,
        text,
      });
      if (res.bizCode !== 0) {
        actionError.set(res.message);
        hapticNotification("error");
      } else {
        setRejectDraft(itemId, "");
        rejectOpenId.set(undefined);
        hapticNotification("warning");
      }
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      busyKey.set(undefined);
    }
  };

  const retryOrResumeIssue = async (itemId: string, issueId: string) => {
    const key = `retry:${itemId}`;
    if (untracked(busyKey) === key) return;
    busyKey.set(key);
    actionError.set(undefined);
    try {
      const res = await props.session.call("issue.status.update", {
        id: issueId,
        status: "todo",
      });
      if (res.bizCode !== 0) {
        actionError.set(res.message);
        hapticNotification("error");
      } else {
        hapticImpact("light");
      }
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      busyKey.set(undefined);
    }
  };

  const respondPermission = async (sessionId: string, requestId: string, decision: SessionPermissionDecision) => {
    const key = `perm:${requestId}`;
    if (untracked(busyKey) === key) return;
    busyKey.set(key);
    actionError.set(undefined);
    try {
      const res = await props.session.call("session.respondPermission", {
        id: sessionId,
        requestId,
        decision,
      });
      if (res.bizCode !== 0) {
        actionError.set(res.message);
        hapticNotification("error");
      } else {
        hapticNotification(decision === "deny" ? "warning" : "success");
      }
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      busyKey.set(undefined);
    }
  };

  const respondInteraction = async (sessionId: string, requestId: string, payload: { readonly optionId?: string; readonly text?: string }) => {
    const key = `inter:${requestId}`;
    if (untracked(busyKey) === key) return;
    busyKey.set(key);
    actionError.set(undefined);
    try {
      const res = await props.session.call("session.respondInteraction", {
        id: sessionId,
        requestId,
        ...payload,
      });
      if (res.bizCode !== 0) {
        actionError.set(res.message);
        hapticNotification("error");
      } else {
        setDraft(requestId, "");
        hapticImpact("light");
      }
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      busyKey.set(undefined);
    }
  };

  const renderPermissionCard = (entry: () => PendingPermissionItem) => {
    const req = computed(() => entry().request);
    const isBusy = computed(() => busyKey() === `perm:${req().requestId}`);
    return (
      <SectionCard testID={`inbox-permission-${req().requestId}`} class="gap-3">
        <View class="flex-row items-center justify-between gap-2">
          <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{entry().sessionName}</Text>
          <StatusTag label={req().tool} tone="wait" icon="lock" />
        </View>
        <Text class="text-sm text-ink">{req().summary}</Text>
        <If when={req().input}>
          {(inputText) => (
            <View class="rounded-md bg-code-bg px-2.5 py-2">
              <Text class="font-mono text-xs text-code-ink">{inputText()}</Text>
            </View>
          )}
        </If>
        <View class="flex-row items-center gap-2">
          <PillButton
            testID={`inbox-approve-${req().requestId}`}
            tone="ok"
            size="sm"
            icon="check"
            label={t("web.remote.inbox.approve")}
            disabled={isBusy()}
            onPress={() => {
              void respondPermission(entry().sessionId, req().requestId, "allowOnce");
            }}
            class="flex-1"
          />
          <PillButton
            testID={`inbox-deny-${req().requestId}`}
            tone="danger"
            size="sm"
            icon="cross"
            label={t("web.remote.inbox.deny")}
            disabled={isBusy()}
            onPress={() => {
              void respondPermission(entry().sessionId, req().requestId, "deny");
            }}
            class="flex-1"
          />
        </View>
      </SectionCard>
    );
  };

  const renderInteractionCard = (entry: () => PendingInteractionItem) => {
    const req = computed(() => entry().request);
    const isBusy = computed(() => busyKey() === `inter:${req().requestId}`);
    const draft = computed(() => answerDrafts()[req().requestId] ?? "");
    const canSubmit = computed(() => !isBusy() && draft().trim() !== "");
    return (
      <SectionCard testID={`inbox-interaction-${req().requestId}`} class="gap-3">
        <View class="flex-row items-center justify-between gap-2">
          <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{entry().sessionName}</Text>
          <StatusTag label={t("web.remote.inbox.answer")} tone="info" icon="chat" />
        </View>
        <Text class="text-sm text-ink">{req().question}</Text>
        <If when={req().options.length > 0}>
          <View class="flex-row flex-wrap gap-2">
            <Each of={req().options} key={(opt) => opt.id}>
              {(opt) => (
                <PillButton
                  testID={`inbox-option-${req().requestId}-${opt().id}`}
                  tone="plain"
                  size="sm"
                  label={opt().label}
                  disabled={isBusy()}
                  onPress={() => {
                    void respondInteraction(entry().sessionId, req().requestId, { optionId: opt().id });
                  }}
                />
              )}
            </Each>
          </View>
        </If>
        <If when={req().allowCustom}>
          <View class="flex-row items-center gap-2">
            <FieldInput
              testID={`inbox-answer-input-${req().requestId}`}
              placeholder={t("web.remote.inbox.answer")}
              value={draft()}
              onInput={(v) => setDraft(req().requestId, v)}
              disabled={isBusy()}
              class="min-w-0 flex-1"
            />
            <PillButton
              testID={`inbox-answer-submit-${req().requestId}`}
              tone="primary"
              size="sm"
              label={t("web.remote.inbox.answer")}
              disabled={!canSubmit()}
              onPress={() => {
                void respondInteraction(entry().sessionId, req().requestId, { text: draft().trim() });
              }}
            />
          </View>
        </If>
      </SectionCard>
    );
  };

  const renderInboxQuickActions = (item: () => InboxItem) => {
    const issueId = computed(() => issueIdOf(item()));
    const isReview = computed(() => item().kind === "review" && issueId() !== undefined);
    const isFix = computed(() => item().kind === "fix" && issueId() !== undefined);
    const isInterrupted = computed(() => item().kind === "interrupted" && issueId() !== undefined);
    const hasQuickActions = computed(() => isReview() || isFix() || isInterrupted());
    const isRejectOpen = computed(() => rejectOpenId() === item().id);
    const rejectDraft = computed(() => rejectDrafts()[item().id] ?? "");
    const isReviewBusy = computed(() => busyKey() === `review:${item().id}`);
    const isRetryBusy = computed(() => busyKey() === `retry:${item().id}`);
    const canSubmitReject = computed(() => !isReviewBusy() && rejectDraft().trim() !== "");
    return (
      <If when={hasQuickActions()}>
        <View class="gap-2 pt-1">
          <If when={isReview()}>
            <View class="gap-2">
              <View class="flex-row items-center gap-2">
                <PillButton
                  testID={`inbox-accept-${item().id}`}
                  tone="ok"
                  size="sm"
                  icon="check"
                  label={t("web.remote.inbox.accept")}
                  disabled={isReviewBusy()}
                  onPress={() => {
                    const targetIssue = issueId();
                    if (targetIssue !== undefined) void acceptReview(item().id, targetIssue);
                  }}
                  class="flex-1"
                />
                <PillButton
                  testID={`inbox-reject-${item().id}`}
                  tone="danger"
                  size="sm"
                  icon="cross"
                  label={t("web.remote.inbox.reject")}
                  disabled={isReviewBusy()}
                  onPress={() => {
                    hapticImpact("light");
                    rejectOpenId.set(untracked(rejectOpenId) === item().id ? undefined : item().id);
                  }}
                  class="flex-1"
                />
              </View>
              <If when={isRejectOpen()}>
                <View class="flex-row items-center gap-2">
                  <FieldInput
                    testID={`inbox-reject-input-${item().id}`}
                    placeholder={t("web.remote.inbox.rejectReasonPlaceholder")}
                    value={rejectDraft()}
                    onInput={(v) => setRejectDraft(item().id, v)}
                    onSubmit={() => {
                      const targetIssue = issueId();
                      if (targetIssue !== undefined) void submitRejectReview(item().id, targetIssue);
                    }}
                    disabled={isReviewBusy()}
                    class="min-w-0 flex-1"
                  />
                  <PillButton
                    testID={`inbox-reject-submit-${item().id}`}
                    tone="danger"
                    size="sm"
                    icon="send"
                    label={t("web.remote.inbox.reject")}
                    disabled={!canSubmitReject()}
                    onPress={() => {
                      const targetIssue = issueId();
                      if (targetIssue !== undefined) void submitRejectReview(item().id, targetIssue);
                    }}
                  />
                  <PillButton
                    testID={`inbox-reject-cancel-${item().id}`}
                    tone="plain"
                    size="sm"
                    label={t("web.remote.controlPlane.cancel")}
                    disabled={isReviewBusy()}
                    onPress={() => rejectOpenId.set(undefined)}
                  />
                </View>
              </If>
            </View>
          </If>
          <If when={isFix()}>
            <PillButton
              testID={`inbox-retry-${item().id}`}
              tone="primary"
              size="sm"
              icon="retry"
              label={t("web.remote.inbox.retry")}
              disabled={isRetryBusy()}
              onPress={() => {
                const targetIssue = issueId();
                if (targetIssue !== undefined) void retryOrResumeIssue(item().id, targetIssue);
              }}
            />
          </If>
          <If when={isInterrupted()}>
            <PillButton
              testID={`inbox-resume-${item().id}`}
              tone="primary"
              size="sm"
              icon="play"
              label={t("web.remote.inbox.resume")}
              disabled={isRetryBusy()}
              onPress={() => {
                const targetIssue = issueId();
                if (targetIssue !== undefined) void retryOrResumeIssue(item().id, targetIssue);
              }}
            />
          </If>
        </View>
      </If>
    );
  };

  const renderMaster = () => (
    <View class="min-h-0 flex-1">
      <If when={actionError()}>
        {(msg) => (
          <View testID="inbox-error" class="mx-4 mt-3 rounded-lg border border-berry bg-bad-soft px-3 py-2">
            <Text class="text-xs font-medium text-berry">{msg()}</Text>
          </View>
        )}
      </If>

      <If when={hasEntries()} else={<EmptyPanel testID="inbox-empty" icon="inbox" message={t("web.remote.inbox.empty")} />}>
        <If
          when={isDual()}
          else={
            <List
              testID="inbox-list"
              each={entries()}
              keyExtractor={(entry) => entry.key}
              estimatedItemSize={120}
              class="min-h-0 flex-1"
              contentClass="gap-3 p-4"
            >
              {(entry) => (
                <View>
                  <If when={permissionOf(entry())}>{(item) => renderPermissionCard(item)}</If>
                  <If when={interactionOf(entry())}>{(item) => renderInteractionCard(item)}</If>
                  <If when={inboxItemOf(entry())}>
                    {(item) => (
                      <SectionCard
                        testID={`inbox-item-${item().id}`}
                        onPress={() => {
                          hapticImpact("light");
                          props.onNavigateTarget(item().target);
                        }}
                        class="gap-2"
                      >
                        <View class="flex-row items-center justify-between gap-2">
                          <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{item().words.title || item().who}</Text>
                          <StatusTag label={item().words.label || item().kind} tone={inboxKindTone(item().kind)} />
                        </View>
                        <Text class="text-xs text-muted">{item().words.body || item().text}</Text>
                        {renderInboxQuickActions(item)}
                      </SectionCard>
                    )}
                  </If>
                </View>
              )}
            </List>
          }
        >
          <List
            testID="inbox-list"
            each={entries()}
            keyExtractor={(entry) => entry.key}
            estimatedItemSize={76}
            class="min-h-0 flex-1"
            contentClass="gap-2.5 p-3"
          >
            {(entry) => {
              const selected = computed(() => props.selectedKey() === entry().key);
              const title = computed(() => entryTitle(entry()));
              const subtitle = computed(() => {
                const current = entry();
                switch (current.kind) {
                  case "permission":
                    return current.item.request.summary;
                  case "interaction":
                    return current.item.request.question;
                  case "inbox":
                    return current.item.words.body || current.item.text;
                }
              });
              const badge = computed((): { readonly label: string; readonly tone: TagTone } => {
                const current = entry();
                switch (current.kind) {
                  case "permission":
                    return { label: current.item.request.tool, tone: "wait" };
                  case "interaction":
                    return { label: t("web.remote.inbox.answer"), tone: "info" };
                  case "inbox":
                    return { label: current.item.words.label || current.item.kind, tone: inboxKindTone(current.item.kind) };
                }
              });

              return (
                <SectionCard
                  testID={`inbox-row-${entry().key}`}
                  onPress={() => {
                    hapticImpact("light");
                    userPicked = true;
                    props.onSelectKey(entry().key);
                  }}
                  class={`gap-1.5 ${selected() ? "border-focus bg-selected" : ""}`}
                >
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{title()}</Text>
                    <StatusTag label={badge().label} tone={badge().tone} />
                  </View>
                  <Text class="truncate text-xs text-muted">{subtitle()}</Text>
                </SectionCard>
              );
            }}
          </List>
        </If>
      </If>
    </View>
  );

  const renderDetail = () => (
    <If when={selectedEntry()}>
      {(entry) => {
        const title = computed(() => entryTitle(entry()));
        return (
          <View testID="inbox-detail" class="min-h-0 flex-1">
            <TopBar testID="inbox-detail-bar" backTestID="inbox-back" title={title()} onBack={isDual() ? undefined : () => props.onSelectKey(undefined)} />
            <Scroll class="flex-1" contentClass="gap-3 p-4">
              <If when={permissionOf(entry())}>{(item) => renderPermissionCard(item)}</If>
              <If when={interactionOf(entry())}>{(item) => renderInteractionCard(item)}</If>
              <If when={inboxItemOf(entry())}>
                {(item) => (
                  <SectionCard testID={`inbox-item-${item().id}`} class="gap-3">
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="min-w-0 flex-1 text-base font-semibold text-ink">{item().words.title || item().who}</Text>
                      <StatusTag label={item().words.label || item().kind} tone={inboxKindTone(item().kind)} />
                    </View>
                    <MarkdownText testID={`inbox-detail-body-${item().id}`} text={item().words.body || item().text} size="sm" />
                    {renderInboxQuickActions(item)}
                    <PillButton
                      testID={`inbox-jump-${item().id}`}
                      tone="primary"
                      size="sm"
                      icon="open"
                      label={targetTabLabel(item().target)}
                      onPress={() => {
                        hapticImpact("light");
                        props.onNavigateTarget(item().target);
                      }}
                    />
                  </SectionCard>
                )}
              </If>
            </Scroll>
          </View>
        );
      }}
    </If>
  );

  return (
    <SplitPane
      testID="inbox-tab"
      layout={props.layout}
      hasSelection={() => selectedEntry() !== undefined}
      master={renderMaster}
      detail={renderDetail}
      emptyDetail={() => <EmptyPanel testID="inbox-detail-empty" icon="inbox" message={t("web.remote.inbox.empty")} />}
    />
  );
}
