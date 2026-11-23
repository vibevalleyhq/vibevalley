import { effect, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { InboxItem, SessionPermissionDecision } from "@vibevalley/protocol";

import type { MobileLayout } from "../design/layout";
import { EmptyPanel, FieldInput, PillButton, SectionCard, SplitPane, StatusTag, TopBar, type TagTone } from "../design/ui";
import { hapticImpact, hapticNotification, type PendingInteractionItem, type PendingPermissionItem, type RemoteSession } from "../infra/session";

type InboxEntry =
  | { readonly kind: "permission"; readonly key: string; readonly item: PendingPermissionItem }
  | { readonly kind: "interaction"; readonly key: string; readonly item: PendingInteractionItem }
  | { readonly kind: "inbox"; readonly key: string; readonly item: InboxItem };

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
  const actionError = signal<string | undefined>(undefined);
  let userPicked = false;

  const items = () => props.session.inbox()?.items ?? [];
  const permissions = () => props.session.pendingPermissions();
  const interactions = () => props.session.pendingInteractions();
  const isDual = () => props.layout().mode === "dual_pane";

  const entries = (): readonly InboxEntry[] => [
    ...permissions().map((item) => ({ kind: "permission" as const, key: `perm:${item.sessionId}:${item.request.requestId}`, item })),
    ...interactions().map((item) => ({ kind: "interaction" as const, key: `inter:${item.sessionId}:${item.request.requestId}`, item })),
    ...items().map((item) => ({ kind: "inbox" as const, key: `item:${item.id}`, item })),
  ];

  const selectedEntry = () => {
    const key = props.selectedKey();
    if (key === undefined) return undefined;
    return entries().find((entry) => entry.key === key);
  };

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
    answerDrafts.update((prev) => ({ ...prev, [key]: value }));
  };

  const respondPermission = async (sessionId: string, requestId: string, decision: SessionPermissionDecision) => {
    const key = `perm:${requestId}`;
    if (busyKey() === key) return;
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
    } finally {
      busyKey.set(undefined);
    }
  };

  const respondInteraction = async (sessionId: string, requestId: string, payload: { readonly optionId?: string; readonly text?: string }) => {
    const key = `inter:${requestId}`;
    if (busyKey() === key) return;
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
    } finally {
      busyKey.set(undefined);
    }
  };

  const renderPermissionCard = (entry: () => PendingPermissionItem) => {
    const req = () => entry().request;
    const isBusy = () => busyKey() === `perm:${req().requestId}`;
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
    const req = () => entry().request;
    const isBusy = () => busyKey() === `inter:${req().requestId}`;
    const draft = () => answerDrafts()[req().requestId] ?? "";
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
              disabled={isBusy() || draft().trim() === ""}
              onPress={() => {
                void respondInteraction(entry().sessionId, req().requestId, { text: draft().trim() });
              }}
            />
          </View>
        </If>
      </SectionCard>
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

      <If when={entries().length > 0} else={<EmptyPanel testID="inbox-empty" icon="inbox" message={t("web.remote.inbox.empty")} />}>
        <If
          when={isDual()}
          else={
            <Scroll class="flex-1" contentClass="gap-3 p-4">
              <Each of={permissions()} key={(entry) => `${entry.sessionId}:${entry.request.requestId}`}>
                {(entry) => renderPermissionCard(entry)}
              </Each>
              <Each of={interactions()} key={(entry) => `${entry.sessionId}:${entry.request.requestId}`}>
                {(entry) => renderInteractionCard(entry)}
              </Each>
              <Each of={items()} key={(item) => item.id}>
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
                  </SectionCard>
                )}
              </Each>
            </Scroll>
          }
        >
          <Scroll class="flex-1" contentClass="gap-2.5 p-3">
            <Each of={entries()} key={(entry) => entry.key}>
              {(entry) => {
                const selected = () => props.selectedKey() === entry().key;
                const title = () => {
                  const current = entry();
                  switch (current.kind) {
                    case "permission":
                    case "interaction":
                      return current.item.sessionName;
                    case "inbox":
                      return current.item.words.title || current.item.who;
                  }
                };
                const subtitle = () => {
                  const current = entry();
                  switch (current.kind) {
                    case "permission":
                      return current.item.request.summary;
                    case "interaction":
                      return current.item.request.question;
                    case "inbox":
                      return current.item.words.body || current.item.text;
                  }
                };
                const badge = (): { readonly label: string; readonly tone: TagTone } => {
                  const current = entry();
                  switch (current.kind) {
                    case "permission":
                      return { label: current.item.request.tool, tone: "wait" };
                    case "interaction":
                      return { label: t("web.remote.inbox.answer"), tone: "info" };
                    case "inbox":
                      return { label: current.item.words.label || current.item.kind, tone: inboxKindTone(current.item.kind) };
                  }
                };

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
            </Each>
          </Scroll>
        </If>
      </If>
    </View>
  );

  const selectedPermission = () => {
    const current = selectedEntry();
    return current?.kind === "permission" ? current.item : undefined;
  };
  const selectedInteraction = () => {
    const current = selectedEntry();
    return current?.kind === "interaction" ? current.item : undefined;
  };
  const selectedInboxItem = () => {
    const current = selectedEntry();
    return current?.kind === "inbox" ? current.item : undefined;
  };

  const renderDetail = () => (
    <If when={selectedEntry()}>
      {(entry) => {
        const title = () => {
          const current = entry();
          switch (current.kind) {
            case "permission":
            case "interaction":
              return current.item.sessionName;
            case "inbox":
              return current.item.words.title || current.item.who;
          }
        };
        return (
          <View testID="inbox-detail" class="min-h-0 flex-1">
            <TopBar testID="inbox-detail-bar" backTestID="inbox-back" title={title()} onBack={isDual() ? undefined : () => props.onSelectKey(undefined)} />
            <Scroll class="flex-1" contentClass="gap-3 p-4">
              <If when={selectedPermission()}>{(item) => renderPermissionCard(item)}</If>
              <If when={selectedInteraction()}>{(item) => renderInteractionCard(item)}</If>
              <If when={selectedInboxItem()}>
                {(item) => (
                  <SectionCard testID={`inbox-item-${item().id}`} class="gap-3">
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="min-w-0 flex-1 text-base font-semibold text-ink">{item().words.title || item().who}</Text>
                      <StatusTag label={item().words.label || item().kind} tone={inboxKindTone(item().kind)} />
                    </View>
                    <Text class="text-sm text-ink">{item().words.body || item().text}</Text>
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
