import { effect, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { PhaseView, SessionEvent, SessionPermissionDecision, SessionView } from "@vibevalley/protocol";

import type { IconName } from "../../design/icons";
import { Icon } from "../design/Icon";
import type { MobileLayout } from "../design/layout";
import { EmptyPanel, FieldInput, PillButton, SectionCard, SplitPane, StatusTag, TopBar, type TagTone } from "../design/ui";
import { hapticImpact, hapticNotification, type RemoteSession } from "../infra/session";

function phaseTone(phase: PhaseView): TagTone {
  switch (phase._tag) {
    case "working":
      return "info";
    case "done":
      return "ok";
    case "failed":
      return "bad";
    case "resting":
      return "wait";
    case "closed":
      return "neutral";
  }
}

function eventIcon(type: SessionEvent["type"]): IconName {
  switch (type) {
    case "tool/call":
    case "tool/result":
      return "terminal";
    case "assistant/thinking":
      return "idea";
    case "assistant/message":
    case "user/message":
      return "chat";
    case "permission/request":
    case "permission/resolved":
      return "lock";
    case "interaction/request":
    case "interaction/resolved":
      return "reply";
    case "run/error":
      return "warn";
    case "run/start":
    case "run/end":
    case "memory/recalled":
    case "llm/retry":
    case "llm/usage":
      return "bolt";
  }
}

function phaseSubtitle(session: SessionView): string {
  if (session.phase._tag === "working") {
    return session.phase.doing.label || session.phase.doing.actionText || session.brief;
  }
  return session.brief || session.runtime;
}

export function SessionsTab(props: {
  readonly session: RemoteSession;
  readonly layout: () => MobileLayout;
  readonly selectedSessionId: () => string | undefined;
  readonly onSelectSession: (id: string | undefined) => void;
}) {
  const promptDraft = signal("");
  const sending = signal(false);
  const stopping = signal(false);
  const busyAction = signal<string | undefined>(undefined);
  const interactionDrafts = signal<Readonly<Record<string, string>>>({});
  const actionError = signal<string | undefined>(undefined);
  const isDual = () => props.layout().mode === "dual_pane";

  const sessionList = () => props.session.sessions()?.sessions ?? [];
  const machineLabelOf = (machineId: string | undefined): string | undefined => {
    if (machineId === undefined || machineId === "") return undefined;
    const found = (props.session.sessions()?.machines ?? []).find((m) => m.id === machineId);
    return found ? found.name : machineId;
  };
  const selectedView = () => {
    const id = props.selectedSessionId();
    if (id === undefined) return undefined;
    return sessionList().find((s) => s.id === id);
  };

  effect(() => {
    if (!isDual()) return;
    const list = sessionList();
    const current = props.selectedSessionId();
    if (list.length > 0 && (current === undefined || !list.some((s) => s.id === current))) {
      const preferred = list.find((s) => s.phase._tag === "working") ?? list[0];
      props.onSelectSession(preferred?.id);
    }
  });

  effect(() => {
    const id = props.selectedSessionId();
    actionError.set(undefined);
    if (id === undefined) return;
    return props.session.ensureSessionWatch(id);
  });

  const watchState = () => {
    const id = props.selectedSessionId();
    return id !== undefined ? props.session.sessionWatchState(id) : undefined;
  };

  const isWorking = () => {
    const livePhase = watchState()?.session?.phase._tag;
    if (livePhase !== undefined) return livePhase === "working";
    return selectedView()?.phase._tag === "working";
  };

  const sendPrompt = async () => {
    const id = props.selectedSessionId();
    const text = promptDraft().trim();
    if (id === undefined || text === "" || sending()) return;
    sending.set(true);
    actionError.set(undefined);
    try {
      const env = await props.session.call("session.send", { id, text });
      if (env.bizCode !== 0) {
        actionError.set(env.message);
        hapticNotification("error");
      } else {
        promptDraft.set("");
        hapticImpact("light");
      }
    } finally {
      sending.set(false);
    }
  };

  const stopSession = async () => {
    const id = props.selectedSessionId();
    if (id === undefined || stopping()) return;
    stopping.set(true);
    actionError.set(undefined);
    try {
      const env = await props.session.call("session.stop", { id });
      if (env.bizCode !== 0) {
        actionError.set(env.message);
        hapticNotification("error");
      } else {
        hapticNotification("warning");
      }
    } finally {
      stopping.set(false);
    }
  };

  const respondPermission = async (requestId: string, decision: SessionPermissionDecision) => {
    const id = props.selectedSessionId();
    if (id === undefined || busyAction() === requestId) return;
    busyAction.set(requestId);
    actionError.set(undefined);
    try {
      const env = await props.session.call("session.respondPermission", { id, requestId, decision });
      if (env.bizCode !== 0) {
        actionError.set(env.message);
        hapticNotification("error");
      } else {
        hapticNotification(decision === "deny" ? "warning" : "success");
      }
    } finally {
      busyAction.set(undefined);
    }
  };

  const respondInteraction = async (requestId: string, payload: { readonly optionId?: string; readonly text?: string }) => {
    const id = props.selectedSessionId();
    if (id === undefined || busyAction() === requestId) return;
    busyAction.set(requestId);
    actionError.set(undefined);
    try {
      const env = await props.session.call("session.respondInteraction", { id, requestId, ...payload });
      if (env.bizCode !== 0) {
        actionError.set(env.message);
        hapticNotification("error");
      } else {
        interactionDrafts.update((prev) => ({ ...prev, [requestId]: "" }));
        hapticImpact("light");
      }
    } finally {
      busyAction.set(undefined);
    }
  };

  const renderMaster = () => (
    <If when={sessionList().length > 0} else={<EmptyPanel testID="sessions-empty" icon="terminal" message={t("web.remote.session.empty")} />}>
      <Scroll class="flex-1" contentClass="gap-2.5 p-3.5">
        <Each of={sessionList()} key={(s) => s.id}>
          {(s) => {
            const active = () => isDual() && props.selectedSessionId() === s().id;
            return (
              <SectionCard
                testID={`session-row-${s().id}`}
                onPress={() => {
                  hapticImpact("light");
                  props.onSelectSession(s().id);
                }}
                class={`gap-2 ${active() ? "border-focus bg-selected" : ""}`}
              >
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{s().name}</Text>
                  <StatusTag label={s().phaseText || s().phase._tag} tone={phaseTone(s().phase)} dot />
                </View>
                <Text class="truncate text-xs text-muted">{phaseSubtitle(s())}</Text>
                <View class="flex-row flex-wrap items-center gap-2">
                  <View class="flex-row items-center gap-1.5">
                    <Icon name="runtimes" size={12} tone="faint" />
                    <Text class="font-mono text-2xs text-faint">{s().runtime}</Text>
                  </View>
                  <If when={machineLabelOf(s().machine)}>
                    {(label) => <StatusTag testID={`session-machine-${s().id}`} label={label()} icon="devices" tone="neutral" />}
                  </If>
                </View>
              </SectionCard>
            );
          }}
        </Each>
      </Scroll>
    </If>
  );

  const renderDetail = () => (
    <View testID="session-detail" class="min-h-0 flex-1">
      <TopBar
        testID="session-detail-bar"
        backTestID="session-back"
        title={selectedView()?.name ?? watchState()?.session?.name ?? props.selectedSessionId() ?? ""}
        subtitle={selectedView()?.runtime ?? watchState()?.session?.runtime}
        onBack={isDual() ? undefined : () => props.onSelectSession(undefined)}
        right={
          <If when={isWorking()}>
            <PillButton
              testID="session-stop-button"
              tone="danger"
              size="sm"
              icon="stop"
              label={t("web.remote.session.stop")}
              disabled={stopping()}
              onPress={() => {
                void stopSession();
              }}
            />
          </If>
        }
      />

      <If when={actionError()}>
        {(msg) => (
          <View testID="session-error" class="mx-4 mt-2 rounded-lg border border-berry bg-bad-soft px-3 py-2">
            <Text class="text-xs font-medium text-berry">{msg()}</Text>
          </View>
        )}
      </If>

      <Scroll class="flex-1" contentClass="gap-3 p-4">
        <If when={machineLabelOf(selectedView()?.machine ?? watchState()?.session?.machine)}>
          {(label) => (
            <View class="flex-row items-center gap-2">
              <StatusTag testID="session-detail-machine" label={label()} icon="devices" tone="info" />
            </View>
          )}
        </If>

        <Each of={watchState()?.pendingPermissions ?? []} key={(req) => req.requestId}>
          {(req) => (
            <SectionCard testID={`session-permission-${req().requestId}`} class="gap-2.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="text-xs font-semibold text-warn-ink">{req().tool}</Text>
                <StatusTag label={req().tool} tone="wait" icon="lock" />
              </View>
              <Text class="text-sm text-ink">{req().summary}</Text>
              <View class="flex-row items-center gap-2">
                <PillButton
                  testID={`session-approve-${req().requestId}`}
                  tone="ok"
                  size="sm"
                  icon="check"
                  label={t("web.remote.inbox.approve")}
                  disabled={busyAction() === req().requestId}
                  onPress={() => {
                    void respondPermission(req().requestId, "allowOnce");
                  }}
                  class="flex-1"
                />
                <PillButton
                  testID={`session-deny-${req().requestId}`}
                  tone="danger"
                  size="sm"
                  icon="cross"
                  label={t("web.remote.inbox.deny")}
                  disabled={busyAction() === req().requestId}
                  onPress={() => {
                    void respondPermission(req().requestId, "deny");
                  }}
                  class="flex-1"
                />
              </View>
            </SectionCard>
          )}
        </Each>

        <Each of={watchState()?.pendingInteractions ?? []} key={(req) => req.requestId}>
          {(req) => {
            const draft = () => interactionDrafts()[req().requestId] ?? "";
            return (
              <SectionCard testID={`session-interaction-${req().requestId}`} class="gap-2.5">
                <Text class="text-sm font-medium text-ink">{req().question}</Text>
                <If when={req().options.length > 0}>
                  <View class="flex-row flex-wrap gap-2">
                    <Each of={req().options} key={(opt) => opt.id}>
                      {(opt) => (
                        <PillButton
                          testID={`session-option-${req().requestId}-${opt().id}`}
                          tone="plain"
                          size="sm"
                          label={opt().label}
                          disabled={busyAction() === req().requestId}
                          onPress={() => {
                            void respondInteraction(req().requestId, { optionId: opt().id });
                          }}
                        />
                      )}
                    </Each>
                  </View>
                </If>
                <If when={req().allowCustom}>
                  <View class="flex-row items-center gap-2">
                    <FieldInput
                      testID={`session-interaction-input-${req().requestId}`}
                      placeholder={t("web.remote.inbox.answer")}
                      value={draft()}
                      onInput={(v) => interactionDrafts.update((prev) => ({ ...prev, [req().requestId]: v }))}
                      class="min-w-0 flex-1"
                    />
                    <PillButton
                      testID={`session-interaction-send-${req().requestId}`}
                      tone="primary"
                      size="sm"
                      label={t("web.remote.inbox.answer")}
                      disabled={busyAction() === req().requestId || draft().trim() === ""}
                      onPress={() => {
                        void respondInteraction(req().requestId, { text: draft().trim() });
                      }}
                    />
                  </View>
                </If>
              </SectionCard>
            );
          }}
        </Each>

        <Text class="text-xs font-semibold tracking-wide text-muted">{t("web.remote.session.events")}</Text>

        <If
          when={(watchState()?.events.length ?? 0) > 0}
          else={<EmptyPanel testID="session-events-empty" icon="log" message={t("web.remote.session.empty")} />}
        >
          <View class="gap-2">
            <Each of={watchState()?.events ?? []} key={(ev) => ev.seq}>
              {(ev) => (
                <SectionCard testID={`session-event-${String(ev().seq)}`} class="gap-1.5">
                  <View class="flex-row items-center gap-2">
                    <Icon name={eventIcon(ev().type)} size={14} tone="muted" />
                    <Text class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-muted">{ev().tool ?? ev().actionText ?? ev().type}</Text>
                    <Text class="font-mono text-2xs text-faint">#{String(ev().seq)}</Text>
                  </View>
                  <If when={ev().text}>{(text) => <Text class="text-sm text-ink">{text()}</Text>}</If>
                  <If when={ev().output}>
                    {(output) => (
                      <View class="rounded-md bg-code-bg px-2.5 py-2">
                        <Text class="font-mono text-xs text-code-ink">{output()}</Text>
                      </View>
                    )}
                  </If>
                </SectionCard>
              )}
            </Each>
          </View>
        </If>
      </Scroll>

      <View class="flex-row items-center gap-2 border-t border-line bg-side px-3.5 py-2.5">
        <FieldInput
          testID="session-prompt-input"
          placeholder={t("web.remote.session.promptPlaceholder")}
          value={promptDraft()}
          onInput={(v) => promptDraft.set(v)}
          onSubmit={() => {
            void sendPrompt();
          }}
          disabled={sending()}
          class="min-w-0 flex-1"
        />
        <PillButton
          testID="session-prompt-send"
          tone="primary"
          size="sm"
          icon="send"
          label={t("web.remote.session.send")}
          disabled={sending() || promptDraft().trim() === ""}
          onPress={() => {
            void sendPrompt();
          }}
        />
      </View>
    </View>
  );

  return (
    <SplitPane
      testID="sessions-tab"
      layout={props.layout}
      hasSelection={() => props.selectedSessionId() !== undefined}
      master={renderMaster}
      detail={renderDetail}
      emptyDetail={() => <EmptyPanel testID="session-detail-empty" icon="terminal" message={t("web.remote.session.empty")} />}
    />
  );
}
