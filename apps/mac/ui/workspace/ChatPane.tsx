import { computed, effect, host, keymap, signal, untracked, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ChatFeedItem, ChatSessionProjection, ChatToolStepProjection, PhaseView } from "@vibevalley/protocol";

import { RichPreviewModal, type RichPreviewPayload } from "../design/RichPreviewModal";
import { act } from "../infra/bridge";
import { readChatPaneParams } from "../infra/hostParams";
import { formatGenUiAction } from "../infra/rich";
import { ChatComposer } from "./chat/ChatComposer";
import { ChatFeed } from "./chat/ChatFeed";
import {
  asThoughtLevel,
  clampThoughtLevel,
  computeTelemetry,
  defaultThoughtLevelFor,
  fetchWorkspaceRuntimes,
  mergeChatSteps,
  openWorkspaceSession,
  pickWorkspaceFile,
  preferredModelFor,
  projectChatSession,
  respondWorkspaceInteraction,
  respondWorkspacePermission,
  sendWorkspaceMessage,
  setWorkspaceConfig,
  stopWorkspaceSession,
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
  const serverProjection = signal<ChatSessionProjection | undefined>(undefined);
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
  const activeProjection = computed(() => serverProjection() ?? projectChatSession(steps(), latestTokens()));
  const shownSteps = computed(() => activeProjection()?.visibleSteps ?? []);
  const feedItems = computed((): readonly ChatFeedItem[] => {
    const base = activeProjection()?.feedItems;
    if (base !== undefined) {
      if (serverProjection() !== undefined) {
        const localOnly = steps().filter((s) => s.seq < 0);
        if (localOnly.length > 0) {
          return [
            ...base.map((item) => ({ ...item, trailing: false })),
            ...localOnly.map((step, idx): ChatFeedItem => ({ kind: "step", key: `s:${step.seq}`, step, trailing: idx === localOnly.length - 1 })),
          ];
        }
      }
      return base;
    }
    const localOnly = steps().filter((s) => s.seq < 0);
    return localOnly.map((step, idx): ChatFeedItem => ({ kind: "step", key: `s:${step.seq}`, step, trailing: idx === localOnly.length - 1 }));
  });
  const latestTodos = computed(() => activeProjection()?.latestTodos);
  const telemetry = computed(() => activeProjection()?.telemetry ?? computeTelemetry(steps(), latestTokens()));
  const toolEntriesBySeq = computed((): ReadonlyMap<number, ChatToolStepProjection> => new Map((activeProjection()?.toolEntries ?? []).map((e) => [e.seq, e])));

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
          serverProjection.set(preserved.length === 0 ? ev.projection : undefined);
          steps.set(preserved.length === 0 && ev.projection !== undefined ? ev.events : mergeChatSteps(preserved, ev.events));
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
          serverProjection.set(ev.projection);
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
      ...(cwd ? { cwd } : {}),
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

  const handleGenUiAction = (ev: { action: string; payload: string; label?: string }) => {
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
  };

  const selectRuntime = (nextRt: string) => {
    runtime.set(nextRt);
    const found = runtimes().find((r) => r.id === nextRt);
    const nextModel = preferredModelFor(found);
    model.set(nextModel?.id ?? "");
    thoughtLevel.set(defaultThoughtLevelFor(nextModel));
    if (host.available() && tabId > 0) {
      act({ type: "bind_chat_session", tab_id: tabId, session_id: untracked(sessionId), runtime: nextRt });
    }
  };

  const selectModel = (nextModel: string) => {
    model.set(nextModel);
    const info = currentModels().find((m) => m.id === nextModel);
    thoughtLevel.set(defaultThoughtLevelFor(info));
    void applyConfig({ model: nextModel });
  };

  const selectEffort = (next: ThoughtLevel) => {
    thoughtLevel.set(next);
    void applyConfig({ effort: next });
  };

  effect(() => {
    if (!swarmOpen()) return;
    return keymap.bind("escape", () => swarmOpen.set(false), { when: "always" });
  });

  return (
    <View testID="workspace-chat-pane" class="min-h-0 flex-1 bg-page">
      <If when={swarmOpen() && swarm() !== undefined}>
        <SwarmPanel sessionId={sessionId()} swarm={swarm()!} onClose={() => swarmOpen.set(false)} />
      </If>

      <ChatFeed
        shownStepsCount={shownSteps().length}
        feedItems={feedItems()}
        steeredSeqs={steeredSeqs()}
        effectivePhase={effectivePhase()}
        toolEntriesBySeq={toolEntriesBySeq()}
        pendingPermissions={pendingPermissions()}
        pendingInteractions={pendingInteractions()}
        responding={responding()}
        onDiagramPress={(ev) => richPreview.set({ kind: "mermaid", source: ev.source })}
        onGenUiAction={handleGenUiAction}
        onRespondPermission={(requestId, decision) => void answerPermission(requestId, decision)}
        onRespondInteraction={(requestId, decision) => void answerInteraction(requestId, decision)}
      />

      <ChatComposer
        errorText={errorText()}
        onClearError={() => errorText.set(undefined)}
        latestTodos={latestTodos()}
        effectivePhase={effectivePhase()}
        composerFocused={composerFocused()}
        onComposerFocusChange={(focused) => composerFocused.set(focused)}
        attachedFiles={attachedFiles()}
        onRemoveAttachment={(path) => attachedFiles.set(attachedFiles().filter((item) => item.path !== path))}
        onPickAttachment={() => void pickAttachment()}
        draft={draft()}
        onDraftChange={(value) => draft.set(value)}
        canSend={canSend()}
        onSend={() => void send()}
        onStop={() => void stop()}
        sessionId={sessionId()}
        runtime={runtime()}
        runtimes={runtimes()}
        currentRuntime={currentRuntime()}
        currentRuntimeLabel={currentRuntimeLabel()}
        model={model()}
        currentModels={currentModels()}
        modelTriggerLabel={modelTriggerLabel()}
        effortOptions={effortOptions()}
        effectiveThoughtLevel={effectiveThoughtLevel()}
        onSelectRuntime={selectRuntime}
        onSelectModel={selectModel}
        onSelectEffort={selectEffort}
        swarm={swarm()}
        swarmOpen={swarmOpen()}
        onToggleSwarm={() => swarmOpen.set(!swarmOpen())}
        telemetry={telemetry()}
        telemetryOpen={telemetryOpen()}
        onTelemetryOpenChange={(open) => telemetryOpen.set(open)}
      />

      <RichPreviewModal payload={richPreview()} onClose={() => richPreview.set(undefined)} />
    </View>
  );
}
