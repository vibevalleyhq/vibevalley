import { Clipboard, computed, effect, List, signal, Text, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { PhaseView, SessionEvent, SessionPermissionDecision, SessionView } from "@vibevalley/protocol";

import type { IconName } from "../../design/icons";
import { Icon } from "../design/Icon";
import type { MobileLayout } from "../design/layout";
import {
  EmptyPanel,
  FieldInput,
  MarkdownText,
  PillButton,
  SearchInput,
  SectionCard,
  SplitPane,
  StatusTag,
  TopBar,
  useTimeout,
  type TagTone,
} from "../design/ui";
import { hapticImpact, hapticNotification, hapticSelection, type RemoteSession } from "../infra/session";

interface OptimisticSessionEvent {
  readonly sessionId: string;
  readonly knownSeqs: ReadonlySet<number>;
  readonly event: SessionEvent;
}

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

function isMarkdownEvent(type: SessionEvent["type"]): boolean {
  return type === "assistant/message" || type === "assistant/thinking" || type === "user/message";
}

export function SessionsTab(props: {
  readonly session: RemoteSession;
  readonly layout: () => MobileLayout;
  readonly selectedSessionId: () => string | undefined;
  readonly onSelectSession: (id: string | undefined) => void;
}) {
  const promptDrafts = signal<Readonly<Record<string, string>>>({});
  const searchQuery = signal("");
  const sending = signal(false);
  const stopping = signal(false);
  const busyAction = signal<string | undefined>(undefined);
  const interactionDrafts = signal<Readonly<Record<string, string>>>({});
  const actionError = signal<string | undefined>(undefined);
  const copiedSessionId = signal<string | undefined>(undefined);
  const resetCopied = useTimeout();
  const pendingEvents = signal<readonly OptimisticSessionEvent[]>([]);
  // Keyed by `${sessionId}:${seq}` so confirming seq N in one session never suppresses deduplication in another.
  const confirmedSeqKeys = new Set<string>();
  let localEventSeq = 0;

  const setPromptDraft = (sessionId: string, value: string) => {
    if ((untracked(promptDrafts)[sessionId] ?? "") === value) return;
    promptDrafts.update((prev) => ({ ...prev, [sessionId]: value }));
  };

  const setInteractionDraft = (requestId: string, value: string) => {
    if ((untracked(interactionDrafts)[requestId] ?? "") === value) return;
    interactionDrafts.update((prev) => ({ ...prev, [requestId]: value }));
  };

  const isDual = computed(() => props.layout().mode === "dual_pane");

  const sessionList = computed(() => props.session.sessions()?.sessions ?? []);
  const machineNames = computed(() => new Map((props.session.sessions()?.machines ?? []).map((m) => [m.id, m.name] as const)));
  const machineLabelOf = (machineId: string | undefined): string | undefined => {
    if (machineId === undefined || machineId === "") return undefined;
    return machineNames().get(machineId) ?? machineId;
  };
  const filteredSessions = computed(() => {
    const q = searchQuery().trim().toLowerCase();
    const list = sessionList();
    if (q === "") return list;
    return list.filter((s) => {
      const hay = [s.id, s.name, s.runtime, s.brief, s.phaseText, machineLabelOf(s.machine) ?? ""].join(" ").toLowerCase();
      return hay.includes(q);
    });
  });
  const hasSearchQuery = computed(() => searchQuery().trim() !== "");
  const clearSearch = () => {
    hapticSelection();
    searchQuery.set("");
  };
  const copySessionId = (id: string) => {
    void Clipboard.writeText(id).then(
      () => {
        hapticImpact("light");
        copiedSessionId.set(id);
        resetCopied(() => {
          if (untracked(copiedSessionId) === id) copiedSessionId.set(undefined);
        }, 1500);
      },
      () => undefined,
    );
  };
  const selectedView = computed(() => {
    const id = props.selectedSessionId();
    if (id === undefined) return undefined;
    return sessionList().find((s) => s.id === id);
  });

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

  const watchState = computed(() => {
    const id = props.selectedSessionId();
    return id !== undefined ? props.session.sessionWatchState(id) : undefined;
  });

  const isWorking = computed(() => {
    const livePhase = watchState()?.session?.phase._tag;
    if (livePhase !== undefined) return livePhase === "working";
    return selectedView()?.phase._tag === "working";
  });

  const pendingPermissions = computed(() => watchState()?.pendingPermissions ?? []);
  const pendingInteractions = computed(() => watchState()?.pendingInteractions ?? []);

  effect(() => {
    const id = props.selectedSessionId();
    const canonical = watchState()?.events ?? [];
    if (id === undefined || canonical.length === 0) return;
    const currentPending = untracked(pendingEvents);
    if (!currentPending.some((item) => item.sessionId === id)) return;
    const consumedSeqs = new Set<number>();
    const next = currentPending.filter((item) => {
      if (item.sessionId !== id) return true;
      const match = canonical.find(
        (ev) =>
          !confirmedSeqKeys.has(`${id}:${ev.seq}`) &&
          !consumedSeqs.has(ev.seq) &&
          !item.knownSeqs.has(ev.seq) &&
          ev.type === "user/message" &&
          ev.text === item.event.text,
      );
      if (match) {
        consumedSeqs.add(match.seq);
        confirmedSeqKeys.add(`${id}:${match.seq}`);
        return false;
      }
      return true;
    });
    if (next.length !== currentPending.length) {
      pendingEvents.set(next);
    }
  });

  const displayedEvents = computed((): readonly SessionEvent[] => {
    const id = props.selectedSessionId();
    const canonical = watchState()?.events ?? [];
    if (id === undefined) return canonical;
    const pendingForSession = pendingEvents().filter((item) => item.sessionId === id);
    if (pendingForSession.length === 0) return canonical;

    const consumedSeqs = new Set<number>();
    const remaining: SessionEvent[] = [];
    for (const opt of pendingForSession) {
      const match = canonical.find(
        (ev) =>
          !confirmedSeqKeys.has(`${id}:${ev.seq}`) &&
          !consumedSeqs.has(ev.seq) &&
          !opt.knownSeqs.has(ev.seq) &&
          ev.type === "user/message" &&
          ev.text === opt.event.text,
      );
      if (match) {
        consumedSeqs.add(match.seq);
      } else {
        remaining.push(opt.event);
      }
    }
    if (remaining.length === 0) return canonical;
    return [...canonical, ...remaining];
  });

  const currentPromptDraft = computed(() => {
    const id = props.selectedSessionId();
    return id !== undefined ? (promptDrafts()[id] ?? "") : "";
  });
  const hasPromptDraft = computed(() => currentPromptDraft().trim() !== "");
  const canSend = computed(() => props.selectedSessionId() !== undefined && !sending() && hasPromptDraft());
  const detailTitle = computed(() => selectedView()?.name ?? watchState()?.session?.name ?? props.selectedSessionId() ?? "");
  const detailSubtitle = computed(() => selectedView()?.runtime ?? watchState()?.session?.runtime);
  const detailMachine = computed(() => machineLabelOf(selectedView()?.machine ?? watchState()?.session?.machine));

  const sendPrompt = async () => {
    const id = untracked(props.selectedSessionId);
    const text = (id !== undefined ? (untracked(promptDrafts)[id] ?? "") : "").trim();
    if (id === undefined || text === "" || untracked(sending)) return;

    const canonical = untracked(watchState)?.events ?? [];
    const knownSeqs = new Set(canonical.map((ev) => ev.seq));
    const seq = --localEventSeq;
    const optEvent: SessionEvent = {
      seq,
      revision: 1,
      time: Date.now(),
      type: "user/message",
      text,
    };

    setPromptDraft(id, "");
    sending.set(true);
    actionError.set(undefined);
    pendingEvents.update((prev) => [...prev, { sessionId: id, knownSeqs, event: optEvent }]);

    const rollback = (message: string) => {
      pendingEvents.update((prev) => prev.filter((item) => item.event.seq !== seq));
      actionError.set(message);
      hapticNotification("error");
      if ((untracked(promptDrafts)[id] ?? "") === "") setPromptDraft(id, text);
    };

    try {
      const env = await props.session.call("session.send", { id, text });
      if (env.bizCode !== 0) {
        rollback(env.message);
      } else {
        hapticImpact("light");
      }
    } catch (err: unknown) {
      rollback(err instanceof Error ? err.message : String(err));
    } finally {
      sending.set(false);
    }
  };

  const stopSession = async () => {
    const id = untracked(props.selectedSessionId);
    if (id === undefined || untracked(stopping)) return;
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
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      stopping.set(false);
    }
  };

  const respondPermission = async (requestId: string, decision: SessionPermissionDecision) => {
    const id = untracked(props.selectedSessionId);
    if (id === undefined || untracked(busyAction) === requestId) return;
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
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      busyAction.set(undefined);
    }
  };

  const respondInteraction = async (requestId: string, payload: { readonly optionId?: string; readonly text?: string }) => {
    const id = untracked(props.selectedSessionId);
    if (id === undefined || untracked(busyAction) === requestId) return;
    busyAction.set(requestId);
    actionError.set(undefined);
    try {
      const env = await props.session.call("session.respondInteraction", { id, requestId, ...payload });
      if (env.bizCode !== 0) {
        actionError.set(env.message);
        hapticNotification("error");
      } else {
        setInteractionDraft(requestId, "");
        hapticImpact("light");
      }
    } catch (err: unknown) {
      actionError.set(err instanceof Error ? err.message : String(err));
      hapticNotification("error");
    } finally {
      busyAction.set(undefined);
    }
  };

  const renderMaster = () => (
    <If when={sessionList().length > 0} else={<EmptyPanel testID="sessions-empty" icon="terminal" message={t("web.remote.session.empty")} />}>
      <View class="min-h-0 flex-1">
        <View class="border-b border-line bg-side px-3.5 py-2.5">
          <SearchInput
            testID="session-search-input"
            clearTestID="session-search-clear"
            value={searchQuery()}
            onInput={(v) => searchQuery.set(v)}
            placeholder={t("web.session.hub.searchHint")}
            clearLabel={t("web.session.hub.clear")}
          />
        </View>
        <If
          when={filteredSessions().length > 0}
          else={
            <EmptyPanel
              testID="sessions-empty"
              icon="search"
              message={t("web.session.hub.emptyFiltered")}
              actionLabel={hasSearchQuery() ? t("web.session.hub.clearFilter") : undefined}
              actionIcon="refresh"
              actionTestID="sessions-clear-filters"
              onAction={clearSearch}
            />
          }
        >
          <List
            testID="sessions-list"
            each={filteredSessions()}
            keyExtractor={(s) => s.id}
            estimatedItemSize={88}
            class="min-h-0 flex-1"
            contentClass="gap-2.5 p-3.5"
          >
            {(s) => {
              const active = computed(() => isDual() && props.selectedSessionId() === s().id);
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
          </List>
        </If>
      </View>
    </If>
  );

  const renderTrajectoryHeader = () => (
    <View class="gap-3 pb-1">
      <If when={detailMachine()}>
        {(label) => (
          <View class="flex-row items-center gap-2">
            <StatusTag testID="session-detail-machine" label={label()} icon="devices" tone="info" />
          </View>
        )}
      </If>

      <Each of={pendingPermissions()} key={(req) => req.requestId}>
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

      <Each of={pendingInteractions()} key={(req) => req.requestId}>
        {(req) => {
          const draft = computed(() => interactionDrafts()[req().requestId] ?? "");
          const canAnswer = computed(() => busyAction() !== req().requestId && draft().trim() !== "");
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
                    onInput={(v) => setInteractionDraft(req().requestId, v)}
                    class="min-w-0 flex-1"
                  />
                  <PillButton
                    testID={`session-interaction-send-${req().requestId}`}
                    tone="primary"
                    size="sm"
                    label={t("web.remote.inbox.answer")}
                    disabled={!canAnswer()}
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
    </View>
  );

  const renderDetail = () => (
    <View testID="session-detail" class="min-h-0 flex-1">
      <TopBar
        testID="session-detail-bar"
        backTestID="session-back"
        title={detailTitle()}
        subtitle={detailSubtitle()}
        onBack={isDual() ? undefined : () => props.onSelectSession(undefined)}
        right={
          <View class="flex-row items-center gap-1.5">
            <PillButton
              testID="session-copy-id"
              size="sm"
              tone={copiedSessionId() === props.selectedSessionId() ? "ok" : "plain"}
              icon={copiedSessionId() === props.selectedSessionId() ? "check" : "copy"}
              label={copiedSessionId() === props.selectedSessionId() ? t("web.base.rich.copied") : t("web.base.rich.copy")}
              onPress={() => {
                const id = props.selectedSessionId();
                if (id !== undefined) copySessionId(id);
              }}
            />
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
          </View>
        }
      />

      <If when={actionError()}>
        {(msg) => (
          <View testID="session-error" class="mx-4 mt-2 rounded-lg border border-berry bg-bad-soft px-3 py-2">
            <Text class="text-xs font-medium text-berry">{msg()}</Text>
          </View>
        )}
      </If>

      <List
        testID="session-events-list"
        each={displayedEvents()}
        keyExtractor={(ev) => String(ev.seq)}
        estimatedItemSize={96}
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 64 }}
        keyboardDismissMode="on-drag"
        class="min-h-0 flex-1"
        contentClass="gap-2.5 p-4"
        header={renderTrajectoryHeader()}
        empty={<EmptyPanel testID="session-events-empty" icon="log" message={t("web.remote.session.empty")} />}
      >
        {(ev) => (
          <SectionCard testID={`session-event-${String(ev().seq)}`} class="gap-1.5">
            <View class="flex-row items-center gap-2">
              <Icon name={eventIcon(ev().type)} size={14} tone="muted" />
              <Text class="min-w-0 flex-1 truncate font-mono text-xs font-medium text-muted">{ev().tool ?? ev().actionText ?? ev().type}</Text>
              <Text class="font-mono text-2xs text-faint">#{String(ev().seq)}</Text>
            </View>
            <If when={ev().text}>
              {(text) => (
                <If when={isMarkdownEvent(ev().type)} else={<Text class="text-sm text-ink">{text()}</Text>}>
                  <MarkdownText testID={`session-event-md-${String(ev().seq)}`} text={text()} size="sm" />
                </If>
              )}
            </If>
            <If when={ev().output}>
              {(output) => (
                <View class="rounded-md bg-code-bg px-2.5 py-2">
                  <Text class="font-mono text-xs text-code-ink">{output()}</Text>
                </View>
              )}
            </If>
          </SectionCard>
        )}
      </List>

      <View class="flex-row items-center gap-2 border-t border-line bg-side px-3.5 py-2.5">
        <FieldInput
          testID="session-prompt-input"
          placeholder={t("web.remote.session.promptPlaceholder")}
          value={currentPromptDraft()}
          onInput={(v) => {
            const id = props.selectedSessionId();
            if (id !== undefined) setPromptDraft(id, v);
          }}
          onSubmit={() => {
            void sendPrompt();
          }}
          class="min-w-0 flex-1"
        />
        <PillButton
          testID="session-prompt-send"
          tone="primary"
          size="sm"
          icon="send"
          label={t("web.remote.session.send")}
          disabled={!canSend()}
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
