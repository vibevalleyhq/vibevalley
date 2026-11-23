import { Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { InboxItem, SessionPermissionDecision } from "@vibevalley/protocol";

import { EmptyPanel, FieldInput, PillButton, SectionCard, StatusTag, type TagTone } from "../design/ui";
import { hapticImpact, hapticNotification, type RemoteSession } from "../infra/session";

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

export function InboxTab(props: { readonly session: RemoteSession; readonly onNavigateTarget: (target: InboxItem["target"]) => void }) {
  const busyKey = signal<string | undefined>(undefined);
  const answerDrafts = signal<Readonly<Record<string, string>>>({});
  const actionError = signal<string | undefined>(undefined);

  const items = () => props.session.inbox()?.items ?? [];
  const permissions = () => props.session.pendingPermissions();
  const interactions = () => props.session.pendingInteractions();
  const isEmpty = () => permissions().length === 0 && interactions().length === 0 && items().length === 0;

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

  return (
    <View testID="inbox-tab" class="flex-1 bg-page">
      <If when={actionError()}>
        {(msg) => (
          <View testID="inbox-error" class="mx-4 mt-3 rounded-lg border border-berry bg-bad-soft px-3 py-2">
            <Text class="text-xs font-medium text-berry">{msg()}</Text>
          </View>
        )}
      </If>

      <If when={!isEmpty()} else={<EmptyPanel testID="inbox-empty" icon="inbox" message={t("web.remote.inbox.empty")} />}>
        <Scroll class="flex-1" contentClass="gap-3 p-4">
          <Each of={permissions()} key={(entry) => `${entry.sessionId}:${entry.request.requestId}`}>
            {(entry) => {
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
            }}
          </Each>

          <Each of={interactions()} key={(entry) => `${entry.sessionId}:${entry.request.requestId}`}>
            {(entry) => {
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
            }}
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
      </If>
    </View>
  );
}
