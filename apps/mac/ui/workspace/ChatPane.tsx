import { computed, effect, host, keymap, Scroll, signal, Text, untracked, View, windowSize } from "nsh";
import { Input, Menu, MenuItem, MenuSeparator, Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { PhaseView } from "@vibevalley/protocol";

import { Icon } from "../design/Icon";
import { motionClass, popupTransition } from "../design/motion";
import { RichPreviewModal, type RichPreviewPayload } from "../design/RichPreviewModal";
import { Dot } from "../design/Tag";
import { Bubble } from "../design/Tip";
import { mix } from "../design/tone";
import { variant } from "../infra/base/dom";
import { act } from "../infra/bridge";
import { readChatPaneParams } from "../infra/hostParams";
import { formatGenUiAction } from "../infra/rich";
import {
  ActivityGroup,
  ChatMarkdown,
  ContextBar,
  InteractionCard,
  MemoryRecalledRow,
  PermissionCard,
  ThinkingBlock,
  thoughtLabel,
  TodoProgressPanel,
  ToolCallCard,
} from "./chat/ActivityWidgets";
import {
  asThoughtLevel,
  clampThoughtLevel,
  computeTelemetry,
  defaultThoughtLevelFor,
  fetchWorkspaceRuntimes,
  formatTokens,
  groupChatSteps,
  latestSessionTodos,
  mergeChatSteps,
  openWorkspaceSession,
  pickWorkspaceFile,
  preferredModelFor,
  respondWorkspaceInteraction,
  respondWorkspacePermission,
  sendWorkspaceMessage,
  setWorkspaceConfig,
  stopWorkspaceSession,
  visibleChatSteps,
  watchWorkspaceSession,
  type ChatPhase,
  type ComposerFile,
  type EventTokens,
  type SessionEvent,
  type SessionInteractionRequest,
  type SessionPermissionDecision,
  type SessionPermissionRequest,
  type SessionSwarmState,
  type ThoughtLevel,
  type WorkspaceRuntimeOption,
} from "./chatSession";
import { menuPopupClass, menuSeparatorClass, ShellIconButton } from "./chrome";
import { SwarmPanel } from "./SwarmPanel";

function phaseFromSessionTag(tag: PhaseView["_tag"]): ChatPhase {
  switch (tag) {
    case "working":
      return "working";
    case "failed":
      return "error";
    case "done":
    case "resting":
    case "closed":
      return "ready";
  }
}

export function WorkspaceChatPane() {
  const { tabId, cwd, repo, sessionId: initialSessionId, runtime: initialRuntime } = readChatPaneParams();

  const runtimes = signal<readonly WorkspaceRuntimeOption[]>([]);
  const sessionId = signal<string>(initialSessionId);
  const runtime = signal<string>(initialRuntime);
  const model = signal<string>("");
  const thoughtLevel = signal<ThoughtLevel | undefined>(undefined);
  const phase = signal<ChatPhase>(initialSessionId ? "starting" : "ready");
  const steps = signal<SessionEvent[]>([]);
  const steeredSeqs = signal<ReadonlySet<number>>(new Set());
  const latestTokens = signal<EventTokens | undefined>(undefined);
  const pendingInteractions = signal<SessionInteractionRequest[]>([]);
  const pendingPermissions = signal<SessionPermissionRequest[]>([]);
  const draft = signal("");
  const attachedFiles = signal<readonly ComposerFile[]>([]);
  const composerFocused = signal(false);
  const swarm = signal<SessionSwarmState | undefined>(undefined);
  const swarmOpen = signal(false);
  const sending = signal(false);
  const responding = signal(false);
  const errorText = signal<string | undefined>(undefined);
  const telemetryOpen = signal(false);
  const richPreview = signal<RichPreviewPayload | undefined>(undefined);
  let localSeq = 0;
  const inFlightOptimistic = new Map<number, string>();

  const hasDraft = computed(() => draft().trim().length > 0);
  const canSend = computed(() => !sending() && (hasDraft() || attachedFiles().length > 0));
  const currentRuntime = computed(() => runtimes().find((r) => r.id === runtime()));
  const currentRuntimeLabel = computed(() => currentRuntime()?.name || runtime());
  const currentModels = computed(() => currentRuntime()?.models ?? []);
  const currentModelInfo = computed(() => currentModels().find((m) => m.id === model()));
  const modelTriggerLabel = computed(() => currentModelInfo()?.label ?? currentRuntimeLabel());
  const effortOptions = computed((): readonly ThoughtLevel[] => currentModelInfo()?.effortLevels ?? []);
  const effectiveThoughtLevel = computed((): ThoughtLevel | undefined => clampThoughtLevel(currentModelInfo(), thoughtLevel()));
  const hasAttention = computed(() => pendingInteractions().length > 0 || pendingPermissions().length > 0);
  const effectivePhase = computed((): ChatPhase => (hasAttention() ? "waiting" : phase()));
  const shownSteps = computed(() => visibleChatSteps(steps()));
  const feedItems = computed(() => groupChatSteps(shownSteps()));
  const latestTodos = computed(() => latestSessionTodos(shownSteps()));
  const telemetry = computed(() => computeTelemetry(steps(), latestTokens()));

  if (host.available()) {
    void fetchWorkspaceRuntimes().then((list) => {
      runtimes.set(list);
      const active = list.find((r) => r.id === untracked(runtime));
      const curModel = untracked(model);
      if (curModel === "") {
        const chosen = preferredModelFor(active);
        if (chosen !== undefined) {
          model.set(chosen.id);
          thoughtLevel.set(defaultThoughtLevelFor(chosen));
        }
      } else {
        const chosen = active?.models.find((m) => m.id === curModel);
        thoughtLevel.set(clampThoughtLevel(chosen, untracked(thoughtLevel)));
      }
    });
  }

  effect(() => {
    const sid = sessionId();
    if (!sid || !host.available()) return;
    return watchWorkspaceSession(sid, (ev) => {
      switch (ev.kind) {
        case "state": {
          phase.set(phaseFromSessionTag(ev.session.phase._tag));
          if (ev.model !== undefined) model.set(ev.model);
          const activeModelId = ev.model ?? untracked(model);
          const info = untracked(currentModels).find((m) => m.id === activeModelId);
          const nextEffort = asThoughtLevel(ev.effort);
          if (nextEffort !== undefined) {
            thoughtLevel.set(info !== undefined ? clampThoughtLevel(info, nextEffort) : nextEffort);
          } else if (ev.effort === undefined || (info !== undefined && info.effortLevels.length === 0)) {
            thoughtLevel.set(undefined);
          }
          pendingPermissions.set(ev.pendingPermissions);
          pendingInteractions.set(ev.pendingInteractions);
          if (ev.tokens !== undefined) latestTokens.set(ev.tokens);
          swarm.set(ev.swarm);
          if (ev.swarm === undefined) swarmOpen.set(false);
          break;
        }
        case "history": {
          // Drop completed optimistic local placeholders once canonical history arrives, but keep still-in-flight ones unless echoed.
          const canonical = untracked(steps).filter((s) => s.seq > 0);
          const knownSeqs = new Set(canonical.map((s) => s.seq));
          const incomingUserTexts = new Set(ev.events.filter((e) => e.type === "user/message" && !knownSeqs.has(e.seq)).map((e) => e.text));
          const preserved = untracked(steps).filter((s) => {
            if (s.seq > 0) return true;
            if (!inFlightOptimistic.has(s.seq)) return false;
            return !incomingUserTexts.has(s.text);
          });
          steps.set(mergeChatSteps(preserved, ev.events));
          break;
        }
        case "event": {
          const step = ev.event;
          const prev = untracked(steps).filter((s) => {
            if (s.seq < 0 && step.type === "user/message" && s.text === step.text) {
              inFlightOptimistic.delete(s.seq);
              return false;
            }
            return true;
          });
          steps.set(mergeChatSteps(prev, [step]));
          switch (step.type) {
            case "run/start":
              phase.set("working");
              break;
            case "run/end":
              phase.set("ready");
              break;
            case "run/error":
              phase.set("error");
              break;
            case "interaction/request":
              if (step.interaction !== undefined) {
                const req = step.interaction;
                pendingInteractions.set([...untracked(pendingInteractions).filter((i) => i.requestId !== req.requestId), req]);
              }
              break;
            case "interaction/resolved":
              if (step.interactionResolution !== undefined) {
                const rid = step.interactionResolution.requestId;
                pendingInteractions.set(untracked(pendingInteractions).filter((i) => i.requestId !== rid));
              }
              break;
            case "permission/request":
              if (step.permission !== undefined) {
                const req = step.permission;
                pendingPermissions.set([...untracked(pendingPermissions).filter((p) => p.requestId !== req.requestId), req]);
              }
              break;
            case "permission/resolved":
              if (step.permission !== undefined) {
                const rid = step.permission.requestId;
                pendingPermissions.set(untracked(pendingPermissions).filter((p) => p.requestId !== rid));
              }
              break;
            default:
              break;
          }
          break;
        }
        case "missing": {
          sessionId.set("");
          swarm.set(undefined);
          swarmOpen.set(false);
          phase.set("ready");
          if (host.available() && tabId > 0) {
            act({ type: "bind_chat_session", tab_id: tabId, session_id: "", runtime: untracked(runtime) });
          }
          break;
        }
      }
    });
  });

  const ensureSession = async (): Promise<string | undefined> => {
    const existing = untracked(sessionId);
    if (existing) return existing;
    phase.set("starting");
    const effort = untracked(effectiveThoughtLevel);
    const res = await openWorkspaceSession({
      cwd,
      repo,
      runtime: untracked(runtime),
      model: untracked(model) || undefined,
      ...(effort !== undefined ? { effort } : {}),
      permissionMode: "bypass",
    });
    if (!res.ok) {
      phase.set("error");
      errorText.set(t("web.shell.chat.sendFailed", { why: res.reason }));
      return undefined;
    }
    const ws = res.workspace;
    if (ws.model !== undefined) model.set(ws.model);
    const activeModelId = ws.model ?? untracked(model);
    const info = untracked(currentModels).find((m) => m.id === activeModelId);
    const wsEffort = asThoughtLevel(ws.effort);
    if (wsEffort !== undefined) {
      thoughtLevel.set(info !== undefined ? clampThoughtLevel(info, wsEffort) : wsEffort);
    } else if (info !== undefined && info.effortLevels.length === 0) {
      thoughtLevel.set(undefined);
    }
    sessionId.set(ws.id);
    if (host.available() && tabId > 0) {
      act({ type: "bind_chat_session", tab_id: tabId, session_id: ws.id, runtime: ws.session.runtime });
    }
    return ws.id;
  };

  const pickAttachment = async () => {
    const picked = await pickWorkspaceFile();
    if (!picked) return;
    const prev = untracked(attachedFiles);
    if (prev.some((f) => f.path === picked.path)) return;
    attachedFiles.set([...prev, picked]);
  };

  const send = async () => {
    const rawDraft = untracked(draft);
    const text = rawDraft.trim();
    const files = untracked(attachedFiles);
    if ((text.length === 0 && files.length === 0) || untracked(sending)) return;
    errorText.set(undefined);
    sending.set(true);
    const isSteer = untracked(effectivePhase) === "working";
    draft.set("");
    attachedFiles.set([]);
    const seq = --localSeq;
    const displayText = text.length > 0 ? text : `[${files.map((f) => f.name).join(", ")}]`;
    inFlightOptimistic.set(seq, displayText);
    if (isSteer) {
      const next = new Set(untracked(steeredSeqs));
      next.add(seq);
      steeredSeqs.set(next);
    }
    steps.set(
      mergeChatSteps(untracked(steps), [
        {
          seq,
          revision: 1,
          time: Date.now(),
          type: "user/message",
          text: displayText,
        },
      ]),
    );
    phase.set(untracked(sessionId) ? "working" : "starting");

    const rollbackOptimistic = () => {
      inFlightOptimistic.delete(seq);
      steps.set(untracked(steps).filter((s) => s.seq !== seq));
      if (isSteer) {
        const prevSteered = untracked(steeredSeqs);
        if (prevSteered.has(seq)) {
          const next = new Set(prevSteered);
          next.delete(seq);
          steeredSeqs.set(next);
        }
      }
      if (untracked(draft) === "") draft.set(rawDraft);
      if (untracked(attachedFiles).length === 0 && files.length > 0) attachedFiles.set(files);
    };

    try {
      const sid = await ensureSession();
      if (!sid) {
        rollbackOptimistic();
        return;
      }
      phase.set("working");
      const res = await sendWorkspaceMessage(
        sid,
        text,
        files.map((f) => ({ path: f.path })),
      );
      if (!res.ok) {
        rollbackOptimistic();
        errorText.set(t("web.shell.chat.sendFailed", { why: res.reason }));
        if (!isSteer) phase.set("error");
        return;
      }
      inFlightOptimistic.delete(seq);
    } catch (e) {
      rollbackOptimistic();
      errorText.set(t("web.shell.chat.sendFailed", { why: e instanceof Error ? e.message : String(e) }));
      if (!isSteer) phase.set("error");
    } finally {
      inFlightOptimistic.delete(seq);
      sending.set(false);
    }
  };

  const stop = async () => {
    const sid = untracked(sessionId);
    if (!sid) return;
    const res = await stopWorkspaceSession(sid);
    if (!res.ok) errorText.set(t("web.shell.chat.stopFailed", { why: res.reason }));
    else phase.set("ready");
  };

  const applyConfig = async (patch: { model?: string; effort?: ThoughtLevel }) => {
    const sid = untracked(sessionId);
    if (!sid) return;
    const res = await setWorkspaceConfig(sid, patch);
    if (!res.ok) errorText.set(t("web.shell.chat.configFailed", { why: res.reason }));
  };

  const answerInteraction = async (
    requestId: string,
    decision: { kind: "select"; optionId: string } | { kind: "custom"; text: string } | { kind: "cancel" },
  ) => {
    const sid = untracked(sessionId);
    if (!sid || untracked(responding)) return;
    responding.set(true);
    try {
      const res = await respondWorkspaceInteraction(sid, requestId, decision);
      if (!res.ok) {
        errorText.set(t("web.shell.chat.respondFailed", { why: res.reason }));
      } else {
        pendingInteractions.set(untracked(pendingInteractions).filter((i) => i.requestId !== requestId));
        phase.set("working");
      }
    } finally {
      responding.set(false);
    }
  };

  const answerPermission = async (requestId: string, decision: SessionPermissionDecision) => {
    const sid = untracked(sessionId);
    if (!sid || untracked(responding)) return;
    responding.set(true);
    try {
      const res = await respondWorkspacePermission(sid, requestId, decision);
      if (!res.ok) {
        errorText.set(t("web.shell.chat.respondFailed", { why: res.reason }));
      } else {
        pendingPermissions.set(untracked(pendingPermissions).filter((p) => p.requestId !== requestId));
      }
    } finally {
      responding.set(false);
    }
  };

  const runtimeOptions = computed((): readonly { value: string; label: string; disabled?: boolean }[] =>
    runtimes().map((r) => ({ value: r.id, label: r.name, disabled: !r.available })),
  );

  const modelOptions = computed(() => currentModels().map((m) => ({ value: m.id, label: m.label })));

  const hasSessionTelemetry = computed(() => telemetry().turns > 0 || telemetry().contextUsed > 0);
  const hasTelemetry = computed(() => hasSessionTelemetry() || currentRuntime()?.quotaPct !== undefined);
  const quotaPct = computed(() => {
    const q = currentRuntime()?.quotaPct;
    return q === undefined ? undefined : Math.max(0, Math.min(100, Math.round(q)));
  });
  const showQuotaPill = computed(() => telemetry().contextUsed === 0 && quotaPct() !== undefined);
  const telemetryWarn = computed(() => {
    const q = quotaPct();
    return telemetry().contextPct >= 85 || (q !== undefined && q <= 15);
  });
  const telemetryTooltip = computed(() => {
    const parts: string[] = [];
    if (telemetry().contextUsed > 0 || telemetry().turns > 0) {
      parts.push(t("web.shell.chat.telemetryContext", { pct: telemetry().contextPct }));
    }
    const q = quotaPct();
    if (q !== undefined) {
      parts.push(t("web.shell.chat.telemetryQuota", { pct: q }));
    }
    return parts.join(" · ") || t("web.shell.chat.telemetryDetails");
  });
  const cachedBarPercent = computed(() => {
    const tel = telemetry();
    return Math.min(100, Math.round((tel.cachedRead / tel.contextWindow) * 100));
  });
  const uncachedBarPercent = computed(() => {
    const tel = telemetry();
    return Math.min(100 - cachedBarPercent(), Math.round((tel.uncachedInput / tel.contextWindow) * 100));
  });

  effect(() => {
    if (!swarmOpen()) return;
    return keymap.bind("escape", () => swarmOpen.set(false), { when: "always" });
  });

  const composerMenuClass = `${menuPopupClass} ${motionClass("transition-opacity duration-120 ease-out")}`;
  const composerMenuItemClass = "h-7 flex-row items-center justify-between gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";

  return (
    <View testID="workspace-chat-pane" class="min-h-0 flex-1 bg-page">
      <If when={swarmOpen() && swarm() !== undefined}>
        <SwarmPanel sessionId={sessionId()} swarm={swarm()!} onClose={() => swarmOpen.set(false)} />
      </If>

      <Scroll testID="chat-stream" class="min-h-0 flex-1" contentClass="gap-3 px-4 py-4">
        <If when={shownSteps().length === 0 && pendingInteractions().length === 0 && pendingPermissions().length === 0}>
          <View testID="chat-empty" class="items-center justify-center gap-1.5 py-14">
            <Icon name="chat" size={24} tone="faint" />
            <Text class="text-sm font-semibold text-ink">{t("web.shell.chat.emptyTitle")}</Text>
            <Text class="max-w-md text-center text-xs text-muted">{t("web.shell.chat.emptyHint")}</Text>
          </View>
        </If>

        <Each of={feedItems()} key={(item) => item.key}>
          {(item) => (
            <If
              when={variant(item(), "kind", "activity")}
              else={
                <If when={variant(item(), "kind", "step")}>
                  {(single) => (
                    <View testID={`chat-step-${single().step.seq}`} class="gap-1.5">
                      <If when={single().step.type === "user/message"}>
                        <View
                          class="gap-1 rounded-lg border border-line bg-side px-3 py-2"
                          style={steeredSeqs().has(single().step.seq) ? { borderLeftColor: mix("water", 0.9), backgroundColor: mix("water", 0.08) } : undefined}
                        >
                          <If when={steeredSeqs().has(single().step.seq)}>
                            <View class="flex-row items-center gap-1.5">
                              <View class="rounded-sm px-1.5 py-px" style={{ backgroundColor: mix("water", 0.14) }}>
                                <Text class="text-2xs font-medium text-water">{t("web.shell.chat.steerTag")}</Text>
                              </View>
                            </View>
                          </If>
                          <Text class="text-sm text-ink select-text">{single().step.text}</Text>
                        </View>
                      </If>

                      <If when={single().step.type === "assistant/thinking"}>
                        <ThinkingBlock step={single().step} durationMs={single().durationMs} running={single().trailing && effectivePhase() === "working"} />
                      </If>

                      <If when={single().step.type === "tool/call"}>
                        <ToolCallCard step={single().step} durationMs={single().durationMs} />
                      </If>

                      <If when={single().step.type === "memory/recalled"}>
                        <MemoryRecalledRow step={single().step} />
                      </If>

                      <If when={single().step.type === "assistant/message"}>
                        <View class="rounded-lg px-1 py-0.5">
                          <ChatMarkdown
                            text={single().step.text}
                            streaming={effectivePhase() === "working"}
                            onDiagramPress={(ev) => richPreview.set({ kind: "mermaid", source: ev.source })}
                            onGenUiAction={(ev) => {
                              const action = ev.action.trim();
                              const payload = ev.payload.trim();
                              if (action === "navigate" && payload.startsWith("/")) {
                                act({ type: "open_route", path: payload });
                                return;
                              }
                              if (action !== "state_change") {
                                const text = formatGenUiAction(ev);
                                if (text) {
                                  draft.set(text);
                                  void send();
                                }
                              }
                            }}
                          />
                        </View>
                      </If>

                      <If when={single().step.type === "interaction/resolved"}>
                        <View class="flex-row items-center gap-2 rounded-md border border-line bg-side px-3 py-1.5">
                          <View
                            class={`h-5 items-center justify-center rounded-sm px-1.5 ${single().step.interactionResolution?.accepted === false ? "bg-bad-soft" : "bg-ok-soft"}`}
                          >
                            <Text class={`text-2xs font-semibold ${single().step.interactionResolution?.accepted === false ? "text-berry" : "text-ok-ink"}`}>
                              {single().step.interactionResolution?.accepted === false
                                ? t("web.shell.chat.interactionDeclined")
                                : t("web.shell.chat.interactionAnswered")}
                            </Text>
                          </View>
                          <Text class="min-w-0 flex-1 truncate text-xs text-muted">{single().step.interactionResolution?.choice ?? single().step.text}</Text>
                        </View>
                      </If>

                      <If when={single().step.type === "run/error"}>
                        <View class="flex-row items-start gap-2 rounded-md border border-berry bg-bad-soft px-3 py-2">
                          <Icon name="cross" size={14} tone="berry" />
                          <Text class="min-w-0 flex-1 text-xs text-berry select-text">{single().step.text}</Text>
                        </View>
                      </If>

                      <If when={single().step.type === "llm/retry"}>
                        <View class="flex-row items-center gap-2 rounded-md bg-warn-soft px-3 py-1.5">
                          <Icon name="retry" size={12} tone="warn-ink" />
                          <Text class="min-w-0 flex-1 text-xs text-warn-ink">{single().step.text}</Text>
                        </View>
                      </If>
                    </View>
                  )}
                </If>
              }
            >
              {(activity) => <ActivityGroup item={activity()} working={effectivePhase() === "working"} />}
            </If>
          )}
        </Each>

        <Each of={pendingPermissions()} key={(p) => p.requestId}>
          {(perm) => <PermissionCard permission={perm()} busy={responding()} onRespond={(d) => void answerPermission(perm().requestId, d)} />}
        </Each>

        <Each of={pendingInteractions()} key={(i) => i.requestId}>
          {(inter) => <InteractionCard interaction={inter()} busy={responding()} onRespond={(d) => void answerInteraction(inter().requestId, d)} />}
        </Each>
      </Scroll>

      <View class="shrink-0 gap-1.5 border-t border-line bg-page px-3 pt-2 pb-2.5">
        <If when={errorText()}>
          {(err) => (
            <View testID="chat-error" class="flex-row items-center gap-1.5 rounded-md bg-bad-soft px-2.5 py-1">
              <Icon name="cross" size={12} tone="berry" />
              <Text class="min-w-0 flex-1 text-xs text-berry">{err()}</Text>
              <ShellIconButton compact icon="close" size={10} label={t("web.shell.palette.footer.close")} onPress={() => errorText.set(undefined)} />
            </View>
          )}
        </If>

        <If when={latestTodos()}>{(todo) => <TodoProgressPanel checklist={todo()} working={effectivePhase() === "working"} />}</If>

        <View testID="chat-composer-card" class={`rounded-xl border bg-page ${composerFocused() ? "border-focus" : "border-line"}`}>
          <If when={attachedFiles().length > 0}>
            <View testID="chat-composer-attachments" class="flex-row flex-wrap items-center gap-1.5 border-b border-line px-3 pt-2.5 pb-2">
              <Each of={attachedFiles()} key={(f) => f.path}>
                {(file) => (
                  <View
                    testID={`chat-attachment-${file().name}`}
                    tooltip={<Bubble text={file().path} />}
                    class="h-6 max-w-44 flex-row items-center gap-1.5 rounded-md border border-line bg-side pr-1 pl-2"
                  >
                    <View class="shrink-0">
                      <Icon name={file().mime.startsWith("image/") ? "media" : "file"} size={12} tone="muted" />
                    </View>
                    <Text class="min-w-0 shrink truncate font-mono text-2xs text-ink">{file().name}</Text>
                    <View
                      role="button"
                      testID={`chat-attachment-remove-${file().name}`}
                      accessibilityLabel={t("web.shell.chat.removeFile", { name: file().name })}
                      onPress={() => attachedFiles.set(attachedFiles().filter((item) => item.path !== file().path))}
                      class="size-4 shrink-0 items-center justify-center rounded-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <Icon name="close" size={10} tone="muted" />
                    </View>
                  </View>
                )}
              </Each>
            </View>
          </If>

          <Input
            multiline
            submitBehavior="submit"
            pasteBehavior="insert"
            testID="chat-composer-input"
            accessibilityLabel={t("web.shell.chat.title")}
            placeholder={
              effectivePhase() === "working"
                ? t("web.shell.chat.steerPlaceholder")
                : t("web.shell.chat.composerPlaceholder", { runtime: currentRuntimeLabel() })
            }
            value={draft()}
            onChange={(e) => draft.set(e.value)}
            onSubmit={() => void send()}
            onFocus={() => composerFocused.set(true)}
            onBlur={() => composerFocused.set(false)}
            class="max-h-36 min-h-12 w-full px-3 pt-2.5 pb-1 text-sm text-ink placeholder:text-faint"
          />

          <View class="h-9 flex-row items-center gap-1 px-2 pb-1.5">
            <View class="min-w-0 flex-1 flex-row items-center gap-1 overflow-hidden">
              <View
                role="button"
                testID="chat-attach-file"
                accessibilityLabel={t("web.shell.chat.attachFile")}
                tooltip={<Bubble text={t("web.shell.chat.attachFile")} />}
                onPress={() => void pickAttachment()}
                class={`h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-hover ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
              >
                <Icon name="attach" size={15} tone="muted" />
              </View>

              <Menu
                placement="top"
                align="start"
                offset={6}
                popupClass={composerMenuClass}
                popupStartingClass={popupTransition("opacity-0")}
                popupEndingClass={popupTransition("opacity-0")}
                trigger={
                  <View
                    testID="chat-model-select"
                    accessibilityLabel={t("web.shell.chat.chooseModel")}
                    tooltip={<Bubble text={t("web.shell.chat.chooseModel")} />}
                    class="h-7 min-w-0 max-w-44 shrink flex-row items-center gap-1 overflow-hidden rounded-md px-2 hover:bg-hover aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
                  >
                    <Text class="min-w-0 shrink truncate text-xs font-medium text-muted">{modelTriggerLabel()}</Text>
                    <View class="shrink-0" style={{ transform: [{ rotate: "90deg" }] }}>
                      <Icon name="expand" size={9} tone="faint" />
                    </View>
                  </View>
                }
              >
                <If when={sessionId().length === 0}>
                  <Text class="px-2 pt-1 pb-0.5 text-2xs font-semibold text-faint">{t("web.shell.chat.runtime")}</Text>
                  <Each of={runtimeOptions()} key={(opt) => opt.value}>
                    {(opt) => (
                      <MenuItem
                        testID={`chat-runtime-option-${opt().value}`}
                        disabled={opt().disabled === true}
                        onSelect={() => {
                          const nextRt = opt().value;
                          runtime.set(nextRt);
                          const found = runtimes().find((r) => r.id === nextRt);
                          const nextModel = preferredModelFor(found);
                          model.set(nextModel?.id ?? "");
                          thoughtLevel.set(defaultThoughtLevelFor(nextModel));
                          if (host.available() && tabId > 0) {
                            act({ type: "bind_chat_session", tab_id: tabId, session_id: untracked(sessionId), runtime: nextRt });
                          }
                        }}
                        class={composerMenuItemClass}
                      >
                        <Text class="min-w-0 flex-1 truncate text-xs text-ink">{opt().label}</Text>
                        <If when={runtime() === opt().value}>
                          <Icon name="check" size={12} tone="accent" />
                        </If>
                      </MenuItem>
                    )}
                  </Each>
                </If>
                <If when={modelOptions().length > 0}>
                  <If when={sessionId().length === 0}>
                    <MenuSeparator class={menuSeparatorClass} />
                  </If>
                  <Text class="px-2 pt-1 pb-0.5 text-2xs font-semibold text-faint">{t("web.shell.chat.model")}</Text>
                  <Each of={modelOptions()} key={(opt) => opt.value}>
                    {(opt) => (
                      <MenuItem
                        testID={`chat-model-option-${opt().value}`}
                        onSelect={() => {
                          const nextModel = opt().value;
                          model.set(nextModel);
                          const info = currentModels().find((m) => m.id === nextModel);
                          thoughtLevel.set(defaultThoughtLevelFor(info));
                          void applyConfig({ model: nextModel });
                        }}
                        class={composerMenuItemClass}
                      >
                        <Text class="min-w-0 flex-1 truncate text-xs text-ink">{opt().label}</Text>
                        <If when={model() === opt().value}>
                          <Icon name="check" size={12} tone="accent" />
                        </If>
                      </MenuItem>
                    )}
                  </Each>
                </If>
              </Menu>

              <If when={effortOptions().length > 0}>
                <Menu
                  placement="top"
                  align="start"
                  offset={6}
                  popupClass={composerMenuClass}
                  popupStartingClass={popupTransition("opacity-0")}
                  popupEndingClass={popupTransition("opacity-0")}
                  trigger={
                    <View
                      testID="chat-thought-level"
                      accessibilityLabel={t("web.shell.chat.thoughtLevel")}
                      tooltip={<Bubble text={t("web.shell.chat.thoughtLevel")} />}
                      class="h-7 shrink-0 flex-row items-center gap-1 rounded-md px-2 hover:bg-hover aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
                    >
                      <Icon name="idea" size={12} tone="faint" />
                      <Text class="text-xs font-medium text-muted">{thoughtLabel(effectiveThoughtLevel() ?? effortOptions()[0] ?? "medium")}</Text>
                      <View class="shrink-0" style={{ transform: [{ rotate: "90deg" }] }}>
                        <Icon name="expand" size={9} tone="faint" />
                      </View>
                    </View>
                  }
                >
                  <Each of={effortOptions()} key={(lvl) => lvl}>
                    {(lvl) => (
                      <MenuItem
                        testID={`chat-thought-level-${lvl()}`}
                        onSelect={() => {
                          const next = lvl();
                          thoughtLevel.set(next);
                          void applyConfig({ effort: next });
                        }}
                        class={composerMenuItemClass}
                      >
                        <Text class="text-xs text-ink">{thoughtLabel(lvl())}</Text>
                        <If when={effectiveThoughtLevel() === lvl()}>
                          <Icon name="check" size={12} tone="accent" />
                        </If>
                      </MenuItem>
                    )}
                  </Each>
                </Menu>
              </If>
            </View>

            <View class="shrink-0 flex-row items-center gap-1">
              <If when={swarm()}>
                {(sw) => (
                  <View
                    role="button"
                    testID="chat-swarm-pill"
                    accessibilityLabel={swarmOpen() ? t("web.shell.swarm.closeDrawer") : t("web.shell.swarm.openDrawer")}
                    accessibilityState={{ expanded: swarmOpen() }}
                    tooltip={<Bubble text={sw().title ?? t("web.shell.swarm.openDrawer")} />}
                    onPress={() => swarmOpen.set(!swarmOpen())}
                    class={`h-6 shrink-0 flex-row items-center gap-1 rounded-md border border-line px-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${
                      swarmOpen() ? "bg-selected" : "bg-side"
                    }`}
                  >
                    <Dot tone={sw().workingCount > 0 ? "leaf" : "idle"} size={6} ring={false} />
                    <Text class="font-mono text-2xs font-medium text-ink tabular-nums">
                      {t("web.shell.swarm.pill", { working: sw().workingCount, active: sw().activeCount })}
                    </Text>
                  </View>
                )}
              </If>
              <If when={hasTelemetry()}>
                <Popover
                  open={telemetryOpen()}
                  onOpenChange={(e) => telemetryOpen.set(e.open)}
                  placement="top"
                  align="end"
                  offset={8}
                  popupClass={`w-72 flex-col overflow-hidden rounded-xl border border-line bg-elevated p-2.5 shadow-float ${motionClass("transition-opacity duration-120 ease-out")}`}
                  popupStyle={{ maxHeight: Math.min(420, Math.max(200, Math.round(windowSize().height * 0.7))) }}
                  popupStartingClass={popupTransition("opacity-0")}
                  trigger={
                    <View
                      role="button"
                      testID="chat-telemetry-toggle"
                      tooltip={
                        <If when={!telemetryOpen()}>
                          <Bubble text={telemetryTooltip()} />
                        </If>
                      }
                      accessibilityLabel={telemetryOpen() ? t("web.shell.chat.telemetryHide") : t("web.shell.chat.telemetryDetails")}
                      accessibilityState={{ expanded: telemetryOpen() }}
                      class={`h-6 shrink-0 flex-row items-center gap-1.5 rounded-full border border-line bg-side px-2 shadow-raise hover:bg-hover aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus ${
                        telemetryOpen() ? "bg-selected" : ""
                      }`}
                    >
                      <If
                        when={showQuotaPill()}
                        else={
                          <ContextBar
                            cached={cachedBarPercent()}
                            uncached={uncachedBarPercent()}
                            class="h-1.5 w-6 shrink-0 flex-row overflow-hidden rounded-full bg-selected"
                          />
                        }
                      >
                        <View class="h-1.5 w-6 shrink-0 overflow-hidden rounded-full bg-selected">
                          <View class={(quotaPct() ?? 100) <= 15 ? "h-full bg-wheat" : "h-full bg-accent"} style={{ width: `${quotaPct() ?? 0}%` }} />
                        </View>
                      </If>
                      <Text class={`font-mono text-2xs tabular-nums ${telemetryWarn() ? "text-warn-ink" : "text-muted"}`}>
                        {`${showQuotaPill() ? (quotaPct() ?? 0) : telemetry().contextPct}%`}
                      </Text>
                    </View>
                  }
                >
                  <Scroll class="min-h-0 shrink">
                    <View testID="chat-telemetry-drawer" class="gap-2">
                      <View class="gap-1.5 rounded-lg border border-line bg-side p-2.5">
                        <View class="flex-row items-center justify-between gap-2">
                          <Text class="min-w-0 truncate text-xs font-medium text-muted">{t("web.shell.chat.telemetryQuotaTitle")}</Text>
                          <If when={quotaPct() !== undefined}>
                            <Text class={`shrink-0 font-mono text-xs tabular-nums ${(quotaPct() ?? 100) <= 15 ? "font-semibold text-warn-ink" : "text-ink"}`}>
                              {t("web.shell.chat.telemetryQuota", { pct: quotaPct() ?? 0 })}
                            </Text>
                          </If>
                        </View>
                        <If when={quotaPct() !== undefined} else={<Text class="text-2xs text-faint">{t("web.shell.chat.telemetryQuotaUnavailable")}</Text>}>
                          <View class="gap-1">
                            <View class="h-1.5 overflow-hidden rounded-full bg-selected">
                              <View class={(quotaPct() ?? 100) <= 15 ? "h-full bg-wheat" : "h-full bg-accent"} style={{ width: `${quotaPct() ?? 0}%` }} />
                            </View>
                            <If when={currentRuntime()?.quotaText}>{(label) => <Text class="text-2xs text-faint">{label()}</Text>}</If>
                          </View>
                        </If>
                      </View>

                      <If when={hasSessionTelemetry()}>
                        <View class="gap-1.5 rounded-lg border border-line bg-side p-2.5">
                          <View class="flex-row items-center justify-between gap-2">
                            <Text class="min-w-0 truncate text-xs font-medium text-muted">{t("web.shell.chat.telemetryContextTitle")}</Text>
                            <Text class="shrink-0 font-mono text-xs text-ink tabular-nums">
                              {`${telemetry().contextPct}% · ${formatTokens(telemetry().contextUsed)}/${formatTokens(telemetry().contextWindow)}`}
                            </Text>
                          </View>
                          <ContextBar
                            cached={cachedBarPercent()}
                            uncached={uncachedBarPercent()}
                            class="h-1.5 flex-row overflow-hidden rounded-full bg-selected"
                          />
                          <View class="flex-row flex-wrap gap-2">
                            <Text class="font-mono text-2xs text-ok-ink">{`${t("web.shell.chat.telemetryCached")} ${formatTokens(telemetry().cachedRead)}`}</Text>
                            <Text class="font-mono text-2xs text-water">{`${t("web.shell.chat.telemetryUncached")} ${formatTokens(telemetry().uncachedInput)}`}</Text>
                            <Text class="font-mono text-2xs text-muted">{`${t("web.shell.chat.telemetryOutput")} ${formatTokens(telemetry().output)}`}</Text>
                            <If when={telemetry().reasoning > 0}>
                              <Text class="font-mono text-2xs text-warn-ink">{`${t("web.shell.chat.telemetryReasoning")} ${formatTokens(telemetry().reasoning)}`}</Text>
                            </If>
                          </View>
                        </View>

                        <View class="flex-row items-center justify-between gap-2 rounded-lg border border-line bg-side px-2.5 py-2">
                          <View class="min-w-0 gap-0.5">
                            <Text class="truncate text-xs font-medium text-muted">{t("web.shell.chat.telemetryCacheTitle")}</Text>
                            <Text class="font-mono text-xs font-semibold text-ink tabular-nums">
                              {t("web.shell.chat.telemetryTurns", { turns: telemetry().turns, tools: telemetry().toolCount })}
                            </Text>
                          </View>
                          <Text class="shrink-0 font-mono text-xs font-semibold text-ok-ink tabular-nums">
                            {t("web.shell.chat.telemetryCache", { pct: telemetry().cacheHitPct })}
                          </Text>
                        </View>
                      </If>
                    </View>
                  </Scroll>
                </Popover>
              </If>

              <If when={effectivePhase() === "working"}>
                <View
                  role="button"
                  testID="chat-stop"
                  accessibilityLabel={t("web.shell.chat.stop")}
                  tooltip={<Bubble text={t("web.shell.chat.stop")} />}
                  onPress={() => void stop()}
                  class={`h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line hover:bg-bad-soft ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
                >
                  <Icon name="stop" size={14} tone="berry" />
                </View>
              </If>

              <View
                role="button"
                testID="chat-send"
                accessibilityLabel={effectivePhase() === "working" ? t("web.shell.chat.steer") : t("web.shell.chat.send")}
                tooltip={<Bubble text={effectivePhase() === "working" ? t("web.shell.chat.steer") : t("web.shell.chat.send")} />}
                disabled={!canSend()}
                onPress={() => void send()}
                class={`h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
                  canSend()
                    ? `border-accent bg-accent hover:bg-accent-hover ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px`
                    : "border-transparent bg-hover opacity-50"
                } focus-visible:outline-2 focus-visible:outline-focus`}
              >
                <Icon name="send" size={14} tone={canSend() ? "page" : "muted"} />
              </View>
            </View>
          </View>
        </View>
      </View>
      <RichPreviewModal payload={richPreview()} onClose={() => richPreview.set(undefined)} />
    </View>
  );
}
