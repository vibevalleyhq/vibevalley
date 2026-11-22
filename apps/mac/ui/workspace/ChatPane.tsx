import { effect, host, keymap, Scroll, signal, Text, untracked, View } from "nsh";
import { Input, Menu, MenuItem, MenuSeparator, TextView } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Button } from "../design/Button";
import { TextInput } from "../design/Field";
import { Icon } from "../design/Icon";
import { actionIcon, type IconName } from "../design/icons";
import { motionClass, popupTransition } from "../design/motion";
import { Dot } from "../design/Tag";
import { Bubble } from "../design/Tip";
import { mix } from "../design/tone";
import { act, hostApi } from "../infra/bridge";
import { richNative } from "../infra/rich";
import {
  asThoughtLevel,
  clampThoughtLevel,
  computeTelemetry,
  defaultThoughtLevelFor,
  deriveChatTitle,
  extractToolTarget,
  fetchWorkspaceRuntimes,
  formatTokens,
  mergeChatSteps,
  openWorkspaceSession,
  pickWorkspaceFile,
  preferredModelFor,
  respondWorkspaceInteraction,
  respondWorkspacePermission,
  runtimeDisplayName,
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
  type SessionPermissionMode,
  type SessionPermissionRequest,
  type SessionSwarmState,
  type ThoughtLevel,
  type WorkspaceRuntimeOption,
} from "./chatSession";
import { menuPopupClass, menuSeparatorClass, ShellIconButton } from "./chrome";
import { SwarmPanel } from "./SwarmPanel";

function actionIconFor(action: SessionEvent["action"]): IconName {
  if (action !== undefined && action in actionIcon) return actionIcon[action];
  return "bolt";
}

function phaseFromSessionTag(tag: string): ChatPhase {
  switch (tag) {
    case "working":
      return "working";
    case "failed":
      return "error";
    case "done":
    case "resting":
    case "closed":
      return "ready";
    default:
      return "ready";
  }
}

function phaseTone(phase: ChatPhase): "leaf" | "water" | "wheat" | "berry" | "idle" {
  switch (phase) {
    case "working":
      return "water";
    case "waiting":
      return "wheat";
    case "error":
      return "berry";
    case "ready":
      return "leaf";
    case "starting":
      return "idle";
  }
}

function phaseLabel(phase: ChatPhase): string {
  switch (phase) {
    case "starting":
      return t("web.shell.chat.statusStarting");
    case "ready":
      return t("web.shell.chat.statusReady");
    case "working":
      return t("web.shell.chat.statusWorking");
    case "waiting":
      return t("web.shell.chat.statusWaiting");
    case "error":
      return t("web.shell.chat.statusError");
  }
}

function thoughtLabel(level: ThoughtLevel): string {
  switch (level) {
    case "minimal":
      return "Min";
    case "low":
      return t("web.shell.chat.thoughtLow");
    case "medium":
      return t("web.shell.chat.thoughtMedium");
    case "high":
      return t("web.shell.chat.thoughtHigh");
    case "xhigh":
    case "max":
      return t("web.shell.chat.thoughtMax");
  }
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/u, "");
  return trimmed.split("/").pop() || trimmed || "/";
}

function ChatMarkdown(props: { text: string; streaming?: boolean }) {
  const native = richNative();
  const openLink = (url: string) => {
    if (url.startsWith("/")) {
      act({ type: "open_route", path: url });
    } else if (url.startsWith("file://")) {
      act({ type: "open_file_adjacent", path: decodeURI(url.slice("file://".length)) });
    } else {
      void hostApi.openUrl(url);
    }
  };
  if (native) {
    const VvMarkdown = native.VvMarkdown;
    return <VvMarkdown text={props.text} size="sm" streaming={props.streaming === true} selectable onLinkPress={(e) => openLink(e.url)} />;
  }
  return <TextView markdown={props.text} selectable onLinkPress={(e) => openLink(e.url)} />;
}

function ThinkingBlock(props: { step: SessionEvent }) {
  const open = signal(false);
  return (
    <View testID="chat-thinking" class="rounded-lg border border-line bg-side">
      <View
        role="button"
        testID={`chat-thinking-toggle-${props.step.seq}`}
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class="h-7 flex-row items-center gap-1.5 px-2.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <View
          class={`size-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <Icon name="idea" size={12} tone="muted" />
        <Text class="min-w-0 flex-1 truncate text-xs font-medium text-muted">{t("web.shell.chat.thinking")}</Text>
      </View>
      <If when={open()}>
        <View class="border-t border-line bg-page px-3 py-2">
          <Text class="text-xs text-muted select-text">{props.step.text}</Text>
        </View>
      </If>
    </View>
  );
}

function ToolCallCard(props: { step: SessionEvent }) {
  const open = signal(false);
  const target = () => extractToolTarget(props.step);
  const running = () => props.step.ok === undefined;
  const failed = () => props.step.ok === false;
  const statusText = () => (running() ? t("web.shell.chat.toolRunning") : failed() ? t("web.shell.chat.toolFailed") : t("web.shell.chat.toolOk"));

  return (
    <View testID={`chat-tool-${props.step.seq}`} class="rounded-lg border border-line bg-side">
      <View class="min-h-8 flex-row items-center gap-1.5 px-2 py-1">
        <View
          role="button"
          testID={`chat-tool-toggle-${props.step.seq}`}
          accessibilityState={{ expanded: open() }}
          onPress={() => open.set(!open())}
          class="min-w-0 flex-1 flex-row items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        >
          <View
            class={`size-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
            style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
          >
            <Icon name="expand" size={10} tone="muted" />
          </View>
          <Icon name={actionIconFor(props.step.action)} size={14} tone={failed() ? "berry" : running() ? "water" : "muted"} />
          <Text class={`shrink-0 text-xs font-medium ${failed() ? "text-berry" : "text-ink"}`}>{props.step.actionText ?? props.step.tool ?? ""}</Text>
          <Text class={`min-w-0 flex-1 truncate font-mono text-xs ${failed() ? "text-berry" : "text-muted"}`}>{target()?.path ?? props.step.text}</Text>
          <View class="shrink-0 flex-row items-center gap-1">
            <If when={running()} else={<Icon name={failed() ? "cross" : "check"} size={12} />}>
              <Dot tone="water" size={6} ring={false} />
            </If>
            <Text class={`text-2xs ${failed() ? "text-berry" : running() ? "text-water" : "text-faint"}`}>{statusText()}</Text>
          </View>
        </View>
        <If when={target()}>
          {(hit) => (
            <View class="shrink-0 flex-row items-center gap-1">
              <Button
                size="compact"
                icon="file"
                testID={`chat-tool-open-file-${props.step.seq}`}
                onPress={() =>
                  act({
                    type: "open_file_adjacent",
                    path: hit().path,
                    ...(hit().line !== undefined ? { line: hit().line } : {}),
                  })
                }
              >
                {t("web.shell.chat.toolOpenFile")}
              </Button>
              <If when={hit().canDiff}>
                <Button
                  size="compact"
                  icon="diff"
                  testID={`chat-tool-open-diff-${props.step.seq}`}
                  onPress={() => act({ type: "open_diff_adjacent", path: hit().path, staged: false })}
                >
                  {t("web.shell.chat.toolOpenDiff")}
                </Button>
              </If>
            </View>
          )}
        </If>
      </View>
      <If when={open()}>
        <View class="gap-1.5 border-t border-line bg-page p-2.5">
          <If when={props.step.input}>
            {(raw) => (
              <Scroll class="max-h-36 rounded-md border border-line bg-code-bg px-2.5 py-2">
                <Text class="font-mono text-xs text-code-ink select-text">{raw()}</Text>
              </Scroll>
            )}
          </If>
          <If
            when={props.step.output}
            else={<Text class="text-xs text-faint">{running() ? t("web.shell.chat.toolPending") : t("web.shell.chat.toolNoOutput")}</Text>}
          >
            {(out) => (
              <Scroll class={`max-h-48 rounded-md border px-2.5 py-2 ${failed() ? "border-berry bg-bad-soft" : "border-line bg-side"}`}>
                <Text class={`font-mono text-xs select-text ${failed() ? "text-berry" : "text-ink"}`}>{out()}</Text>
              </Scroll>
            )}
          </If>
        </View>
      </If>
    </View>
  );
}

function InteractionCard(props: {
  interaction: SessionInteractionRequest;
  busy: boolean;
  onRespond: (decision: { kind: "select"; optionId: string } | { kind: "custom"; text: string } | { kind: "cancel" }) => void;
}) {
  const selectedId = signal<string>(untracked(() => props.interaction.options[0]?.id ?? ""));
  const custom = signal("");
  const canConfirm = () => custom().trim().length > 0 || selectedId().length > 0;
  const submit = () => {
    const trimmed = custom().trim();
    if (trimmed.length > 0) {
      props.onRespond({ kind: "custom", text: trimmed });
      return;
    }
    if (selectedId().length > 0) {
      props.onRespond({ kind: "select", optionId: selectedId() });
    }
  };

  return (
    <View
      testID={`chat-interaction-${props.interaction.requestId}`}
      class="gap-2.5 rounded-lg border border-line bg-elevated p-3 shadow-raise"
      style={{ borderLeftColor: mix("wheat", 0.95) }}
    >
      <View class="flex-row flex-wrap items-center gap-2">
        <View class="h-5 flex-row items-center gap-1 rounded-sm bg-warn-soft px-2">
          <Icon name="warn" size={12} tone="warn-ink" />
          <Text class="text-2xs font-semibold text-warn-ink">{t("web.shell.chat.interactionBadge")}</Text>
        </View>
        <Text class="font-mono text-2xs text-faint">{props.interaction.requestId}</Text>
      </View>
      <Text class="text-sm font-semibold text-ink">{props.interaction.question}</Text>
      <If when={props.interaction.options.length > 0}>
        <View class="gap-1.5">
          <Each of={props.interaction.options} key={(o) => o.id}>
            {(opt) => {
              const chosen = () => custom().trim().length === 0 && selectedId() === opt().id;
              return (
                <View
                  role="button"
                  testID={`chat-interaction-option-${opt().id}`}
                  accessibilityState={{ selected: chosen() }}
                  onPress={() => {
                    selectedId.set(opt().id);
                    custom.set("");
                  }}
                  class={`gap-0.5 rounded-md border px-2.5 py-2 focus-visible:outline-2 focus-visible:outline-focus ${
                    chosen() ? "border-accent bg-ok-soft" : "border-line bg-page hover:bg-hover"
                  }`}
                >
                  <View class="flex-row items-center gap-2">
                    <Icon name={chosen() ? "ticked" : "choose"} size={12} tone={chosen() ? "accent" : "muted"} />
                    <Text class="min-w-0 flex-1 text-sm font-medium text-ink">{opt().label}</Text>
                  </View>
                  <If when={opt().description}>{(desc) => <Text class="pl-5 text-xs text-muted">{desc()}</Text>}</If>
                  <If when={opt().warning}>
                    {(warn) => (
                      <View class="mt-1 ml-5 flex-row items-center gap-1 rounded-sm bg-warn-soft px-1.5 py-0.5">
                        <Icon name="warn" size={12} tone="warn-ink" />
                        <Text class="min-w-0 flex-1 text-2xs text-warn-ink">{warn()}</Text>
                      </View>
                    )}
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
      <View class="flex-row items-center gap-2">
        <If when={props.interaction.allowCustom}>
          <TextInput
            testID={`chat-interaction-custom-${props.interaction.requestId}`}
            value={custom()}
            onInput={(v) => custom.set(v)}
            onSubmit={submit}
            placeholder={t("web.shell.chat.interactionCustomPlaceholder")}
            accessibilityLabel={t("web.shell.chat.interactionCustomPlaceholder")}
            class="min-w-0 flex-1"
            wide={false}
          />
        </If>
        <Button testID={`chat-interaction-decline-${props.interaction.requestId}`} disabled={props.busy} onPress={() => props.onRespond({ kind: "cancel" })}>
          {t("web.shell.chat.interactionDecline")}
        </Button>
        <Button tone="primary" testID={`chat-interaction-confirm-${props.interaction.requestId}`} disabled={props.busy || !canConfirm()} onPress={submit}>
          {t("web.shell.chat.interactionConfirm")}
        </Button>
      </View>
    </View>
  );
}

function PermissionCard(props: { permission: SessionPermissionRequest; busy: boolean; onRespond: (decision: SessionPermissionDecision) => void }) {
  return (
    <View
      testID={`chat-permission-${props.permission.requestId}`}
      class="gap-2 rounded-lg border border-line bg-elevated p-3 shadow-raise"
      style={{ borderLeftColor: mix("wheat", 0.95) }}
    >
      <View class="flex-row items-center gap-2">
        <View class="h-5 flex-row items-center gap-1 rounded-sm bg-warn-soft px-2">
          <Icon name="lock" size={12} tone="warn-ink" />
          <Text class="text-2xs font-semibold text-warn-ink">{t("web.shell.chat.permissionBadge")}</Text>
        </View>
        <Text class="font-mono text-xs font-semibold text-ink">{props.permission.tool}</Text>
      </View>
      <If when={props.permission.summary}>
        <Text class="text-sm text-ink">{props.permission.summary}</Text>
      </If>
      <If when={props.permission.input}>
        {(raw) => (
          <Scroll class="max-h-28 rounded-md border border-line bg-code-bg px-2.5 py-1.5">
            <Text class="font-mono text-xs text-code-ink select-text">{raw()}</Text>
          </Scroll>
        )}
      </If>
      <View class="flex-row items-center justify-end gap-1.5">
        <Button
          tone="danger"
          size="compact"
          testID={`chat-permission-deny-${props.permission.requestId}`}
          disabled={props.busy}
          onPress={() => props.onRespond("deny")}
        >
          {t("web.shell.chat.permissionDeny")}
        </Button>
        <Button
          size="compact"
          testID={`chat-permission-session-${props.permission.requestId}`}
          disabled={props.busy}
          onPress={() => props.onRespond("allowAlways")}
        >
          {t("web.shell.chat.permissionAllowSession")}
        </Button>
        <Button
          tone="primary"
          size="compact"
          testID={`chat-permission-once-${props.permission.requestId}`}
          disabled={props.busy}
          onPress={() => props.onRespond("allowOnce")}
        >
          {t("web.shell.chat.permissionAllowOnce")}
        </Button>
      </View>
    </View>
  );
}

export function WorkspaceChatPane() {
  const tabId = typeof host.params.tabId === "number" ? host.params.tabId : 0;
  const cwd = typeof host.params.cwd === "string" ? host.params.cwd : "";
  const repo = typeof host.params.repo === "string" ? host.params.repo : undefined;
  const initialSessionId = typeof host.params.sessionId === "string" ? host.params.sessionId : "";
  const initialRuntime = typeof host.params.runtime === "string" && host.params.runtime.length > 0 ? host.params.runtime : "antigravity";
  const initialTitle = typeof host.params.title === "string" && host.params.title.trim().length > 0 ? host.params.title.trim() : undefined;

  const runtimes = signal<readonly WorkspaceRuntimeOption[]>([]);
  const sessionId = signal<string>(initialSessionId);
  const sessionTitle = signal<string | undefined>(initialTitle);
  const runtime = signal<string>(initialRuntime);
  const model = signal<string>("");
  const thoughtLevel = signal<ThoughtLevel | undefined>(undefined);
  const permissionMode = signal<SessionPermissionMode>("acceptEdits");
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
  let localSeq = 0;

  const canSend = () => !sending() && (draft().trim().length > 0 || attachedFiles().length > 0);
  const currentRuntime = () => runtimes().find((r) => r.id === runtime());
  const currentModels = () => currentRuntime()?.models ?? [];
  const currentModelInfo = () => currentModels().find((m) => m.id === model());
  const modelTriggerLabel = () => currentModelInfo()?.label ?? runtimeDisplayName(runtime());
  const effortOptions = (): readonly ThoughtLevel[] => currentModelInfo()?.effortLevels ?? [];
  const effectiveThoughtLevel = (): ThoughtLevel | undefined => clampThoughtLevel(currentModelInfo(), thoughtLevel());
  const hasAttention = () => pendingInteractions().length > 0 || pendingPermissions().length > 0;
  const effectivePhase = (): ChatPhase => (hasAttention() ? "waiting" : phase());
  const firstUserMessage = () => steps().find((s) => s.type === "user/message" && s.under === undefined)?.text;
  const resolvedTitle = () => deriveChatTitle(sessionTitle(), swarm()?.title, firstUserMessage());
  const shownSteps = () => visibleChatSteps(steps());
  const telemetry = () => computeTelemetry(steps(), latestTokens());

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
    if (!host.available() || tabId <= 0) return;
    const sid = sessionId();
    const rt = runtime();
    const st = effectivePhase();
    const att = hasAttention();
    const title = resolvedTitle();
    act({
      type: "update_chat_tab",
      tab_id: tabId,
      ...(sid ? { session_id: sid } : {}),
      runtime: rt,
      ...(title ? { title } : {}),
      status: st === "working" ? "working" : "ready",
      attention: att,
    });
  });

  effect(() => {
    const sid = sessionId();
    if (!sid || !host.available()) return;
    return watchWorkspaceSession(sid, (ev) => {
      switch (ev.kind) {
        case "state": {
          phase.set(phaseFromSessionTag(ev.session.phase._tag));
          if (ev.title !== undefined) sessionTitle.set(ev.title.trim() || undefined);
          if (ev.model !== undefined) model.set(ev.model);
          const activeModelId = ev.model ?? untracked(model);
          const info = untracked(currentModels).find((m) => m.id === activeModelId);
          const nextEffort = asThoughtLevel(ev.effort);
          if (nextEffort !== undefined) {
            thoughtLevel.set(info !== undefined ? clampThoughtLevel(info, nextEffort) : nextEffort);
          } else if (ev.effort === undefined || (info !== undefined && info.effortLevels.length === 0)) {
            thoughtLevel.set(undefined);
          }
          permissionMode.set(ev.permissionMode);
          pendingPermissions.set(ev.pendingPermissions);
          pendingInteractions.set(ev.pendingInteractions);
          if (ev.tokens !== undefined) latestTokens.set(ev.tokens);
          swarm.set(ev.swarm);
          if (ev.swarm === undefined) swarmOpen.set(false);
          break;
        }
        case "history": {
          // Drop optimistic local placeholders (negative seq) once canonical history arrives.
          const canonical = untracked(steps).filter((s) => s.seq > 0);
          steps.set(mergeChatSteps(canonical, ev.events));
          break;
        }
        case "event": {
          const step = ev.event;
          const prev = untracked(steps).filter((s) => !(s.seq < 0 && step.type === "user/message" && s.text === step.text));
          steps.set(mergeChatSteps(prev, [step]));
          if (step.type === "run/start") phase.set("working");
          else if (step.type === "run/end") phase.set("ready");
          else if (step.type === "run/error") phase.set("error");
          else if (step.type === "interaction/request" && step.interaction !== undefined) {
            const req = step.interaction;
            pendingInteractions.set([...untracked(pendingInteractions).filter((i) => i.requestId !== req.requestId), req]);
          } else if (step.type === "interaction/resolved" && step.interactionResolution !== undefined) {
            const rid = step.interactionResolution.requestId;
            pendingInteractions.set(untracked(pendingInteractions).filter((i) => i.requestId !== rid));
          } else if (step.type === "permission/request" && step.permission !== undefined) {
            const req = step.permission;
            pendingPermissions.set([...untracked(pendingPermissions).filter((p) => p.requestId !== req.requestId), req]);
          } else if (step.type === "permission/resolved" && step.permission !== undefined) {
            const rid = step.permission.requestId;
            pendingPermissions.set(untracked(pendingPermissions).filter((p) => p.requestId !== rid));
          }
          break;
        }
        case "missing": {
          sessionId.set("");
          sessionTitle.set(undefined);
          swarm.set(undefined);
          swarmOpen.set(false);
          phase.set("ready");
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
      permissionMode: untracked(permissionMode),
    });
    if (!res.ok) {
      phase.set("error");
      errorText.set(t("web.shell.chat.sendFailed", { why: res.reason }));
      return undefined;
    }
    const ws = res.workspace;
    if (ws.title !== undefined) sessionTitle.set(ws.title.trim() || undefined);
    if (ws.model !== undefined) model.set(ws.model);
    const activeModelId = ws.model ?? untracked(model);
    const info = untracked(currentModels).find((m) => m.id === activeModelId);
    const wsEffort = asThoughtLevel(ws.effort);
    if (wsEffort !== undefined) {
      thoughtLevel.set(info !== undefined ? clampThoughtLevel(info, wsEffort) : wsEffort);
    } else if (info !== undefined && info.effortLevels.length === 0) {
      thoughtLevel.set(undefined);
    }
    permissionMode.set(ws.permissionMode);
    sessionId.set(ws.id);
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
    const text = untracked(draft).trim();
    const files = untracked(attachedFiles);
    if ((text.length === 0 && files.length === 0) || untracked(sending)) return;
    errorText.set(undefined);
    sending.set(true);
    const isSteer = untracked(effectivePhase) === "working";
    try {
      const sid = await ensureSession();
      if (!sid) return;
      draft.set("");
      attachedFiles.set([]);
      const seq = --localSeq;
      if (isSteer) {
        const next = new Set(untracked(steeredSeqs));
        next.add(seq);
        steeredSeqs.set(next);
      }
      const displayText = text.length > 0 ? text : `[${files.map((f) => f.name).join(", ")}]`;
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
      phase.set("working");
      const res = await sendWorkspaceMessage(
        sid,
        text,
        files.map((f) => ({ path: f.path })),
      );
      if (!res.ok) {
        errorText.set(t("web.shell.chat.sendFailed", { why: res.reason }));
        if (!isSteer) phase.set("error");
      }
    } finally {
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

  const applyConfig = async (patch: { model?: string; effort?: ThoughtLevel; permissionMode?: SessionPermissionMode }) => {
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

  const runtimeOptions = (): readonly { value: string; label: string; disabled?: boolean }[] => {
    const list = runtimes();
    if (list.length === 0) {
      return [
        { value: "antigravity", label: "Antigravity" },
        { value: "claude", label: "Claude Code" },
        { value: "codex", label: "Codex" },
      ];
    }
    return list.map((r) => ({ value: r.id, label: r.name, disabled: !r.available }));
  };

  const modelOptions = () => currentModels().map((m) => ({ value: m.id, label: m.label }));

  const permissionOptions: readonly { value: SessionPermissionMode; label: string }[] = [
    { value: "ask", label: t("web.shell.chat.modeAsk") },
    { value: "acceptEdits", label: t("web.shell.chat.modeAcceptEdits") },
    { value: "bypass", label: t("web.shell.chat.modeBypass") },
    { value: "readOnly", label: t("web.shell.chat.modeReadOnly") },
  ];

  const hasTelemetry = () => telemetry().turns > 0 || telemetry().contextUsed > 0 || currentRuntime()?.quotaPct !== undefined;
  const telemetryWarn = () => {
    const q = currentRuntime()?.quotaPct;
    return telemetry().contextPct >= 85 || (q !== undefined && q <= 15);
  };
  const cachedBarPercent = () => {
    const tel = telemetry();
    return Math.min(100, Math.round((tel.cachedRead / tel.contextWindow) * 100));
  };
  const uncachedBarPercent = () => {
    const tel = telemetry();
    return Math.min(100 - cachedBarPercent(), Math.round((tel.uncachedInput / tel.contextWindow) * 100));
  };

  effect(() => {
    if (!swarmOpen()) return;
    return keymap.bind("escape", () => swarmOpen.set(false), { when: "always" });
  });

  const composerMenuClass = `${menuPopupClass} ${motionClass("transition-opacity duration-120 ease-out")}`;
  const composerMenuItemClass = "h-7 flex-row items-center justify-between gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";

  const permissionLabel = () => permissionOptions.find((o) => o.value === permissionMode())?.label ?? permissionMode();

  return (
    <View testID="workspace-chat-pane" class="min-h-0 flex-1 bg-page">
      <View testID="chat-header" class="h-8 shrink-0 flex-row items-center justify-between gap-2 border-b border-line bg-page px-3">
        <View class="min-w-0 flex-1 flex-row items-center gap-1.5 overflow-hidden">
          <View class="h-5 shrink-0 flex-row items-center gap-1 rounded-sm border border-line bg-side px-1.5">
            <Dot tone={phaseTone(effectivePhase())} size={6} ring={false} />
            <Text testID="chat-phase-label" class="text-2xs font-medium text-muted">
              {phaseLabel(effectivePhase())}
            </Text>
          </View>
          <If when={cwd.length > 0}>
            <View
              testID="chat-cwd-chip"
              tooltip={<Bubble text={cwd} />}
              class="h-5 min-w-0 max-w-36 shrink flex-row items-center gap-1 overflow-hidden rounded-sm border border-line bg-side px-1.5"
            >
              <View class="shrink-0">
                <Icon name="folder" size={12} tone="faint" />
              </View>
              <Text class="min-w-0 shrink truncate font-mono text-2xs text-muted">{basenameOf(cwd)}</Text>
            </View>
          </If>
          <If when={swarm()}>
            {(sw) => (
              <View
                role="button"
                testID="chat-swarm-pill"
                accessibilityLabel={swarmOpen() ? t("web.shell.swarm.closeDrawer") : t("web.shell.swarm.openDrawer")}
                accessibilityState={{ expanded: swarmOpen() }}
                tooltip={<Bubble text={sw().title ?? t("web.shell.swarm.openDrawer")} />}
                onPress={() => swarmOpen.set(!swarmOpen())}
                class={`h-5 shrink-0 flex-row items-center gap-1 rounded-sm border border-line px-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${
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
        </View>
        <View class="shrink-0 flex-row items-center gap-1">
          <Menu
            placement="bottom"
            align="end"
            offset={4}
            popupClass={composerMenuClass}
            popupStartingClass={popupTransition("opacity-0")}
            popupEndingClass={popupTransition("opacity-0")}
            trigger={
              <View
                testID="chat-permission-mode"
                accessibilityLabel={t("web.shell.chat.permissionMode")}
                tooltip={<Bubble text={t("web.shell.chat.permissionMode")} />}
                class="h-6 shrink-0 flex-row items-center gap-1 rounded-md px-1.5 hover:bg-hover aria-expanded:bg-selected focus-visible:outline-2 focus-visible:outline-focus"
              >
                <Text class="text-xs font-medium text-muted">{permissionLabel()}</Text>
                <View class="shrink-0" style={{ transform: [{ rotate: "90deg" }] }}>
                  <Icon name="expand" size={9} tone="faint" />
                </View>
              </View>
            }
          >
            <Each of={permissionOptions} key={(opt) => opt.value}>
              {(opt) => (
                <MenuItem
                  testID={`chat-permission-mode-${opt().value}`}
                  onSelect={() => {
                    const next = opt().value;
                    permissionMode.set(next);
                    void applyConfig({ permissionMode: next });
                  }}
                  class={composerMenuItemClass}
                >
                  <Text class="text-xs text-ink">{opt().label}</Text>
                  <If when={permissionMode() === opt().value}>
                    <Icon name="check" size={12} tone="accent" />
                  </If>
                </MenuItem>
              )}
            </Each>
          </Menu>
          <If when={cwd.length > 0}>
            <ShellIconButton
              compact
              icon="terminal"
              size={13}
              label={t("web.shell.chat.openTerminal")}
              onPress={() => act({ type: "new_terminal_at", path: cwd })}
            />
          </If>
        </View>
      </View>

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

        <Each of={shownSteps()} key={(s) => s.seq}>
          {(step) => (
            <View testID={`chat-step-${step().seq}`} class="gap-1.5">
              <If when={step().type === "user/message"}>
                <View
                  class="gap-1 rounded-lg border border-line bg-side px-3 py-2"
                  style={steeredSeqs().has(step().seq) ? { borderLeftColor: mix("water", 0.9), backgroundColor: mix("water", 0.08) } : undefined}
                >
                  <View class="flex-row items-center gap-1.5">
                    <Text class="text-xs font-semibold text-ink">{t("web.shell.chat.you")}</Text>
                    <If when={steeredSeqs().has(step().seq)}>
                      <View class="rounded-sm px-1.5 py-px" style={{ backgroundColor: mix("water", 0.14) }}>
                        <Text class="text-2xs font-medium text-water">{t("web.shell.chat.steerTag")}</Text>
                      </View>
                    </If>
                  </View>
                  <Text class="text-sm text-ink select-text">{step().text}</Text>
                </View>
              </If>

              <If when={step().type === "assistant/thinking"}>
                <ThinkingBlock step={step()} />
              </If>

              <If when={step().type === "tool/call"}>
                <ToolCallCard step={step()} />
              </If>

              <If when={step().type === "assistant/message"}>
                <View class="rounded-lg px-1 py-0.5">
                  <ChatMarkdown text={step().text} streaming={effectivePhase() === "working"} />
                </View>
              </If>

              <If when={step().type === "interaction/resolved"}>
                <View class="flex-row items-center gap-2 rounded-md border border-line bg-side px-3 py-1.5">
                  <View
                    class={`h-5 items-center justify-center rounded-sm px-1.5 ${step().interactionResolution?.accepted === false ? "bg-bad-soft" : "bg-ok-soft"}`}
                  >
                    <Text class={`text-2xs font-semibold ${step().interactionResolution?.accepted === false ? "text-berry" : "text-ok-ink"}`}>
                      {step().interactionResolution?.accepted === false ? t("web.shell.chat.interactionDeclined") : t("web.shell.chat.interactionAnswered")}
                    </Text>
                  </View>
                  <Text class="min-w-0 flex-1 truncate text-xs text-muted">{step().interactionResolution?.choice ?? step().text}</Text>
                </View>
              </If>

              <If when={step().type === "run/error"}>
                <View class="flex-row items-start gap-2 rounded-md border border-berry bg-bad-soft px-3 py-2">
                  <Icon name="cross" size={14} tone="berry" />
                  <Text class="min-w-0 flex-1 text-xs text-berry select-text">{step().text}</Text>
                </View>
              </If>

              <If when={step().type === "llm/retry"}>
                <View class="flex-row items-center gap-2 rounded-md bg-warn-soft px-3 py-1.5">
                  <Icon name="retry" size={12} tone="warn-ink" />
                  <Text class="min-w-0 flex-1 text-xs text-warn-ink">{step().text}</Text>
                </View>
              </If>
            </View>
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

        <If when={effectivePhase() === "working"}>
          <View testID="chat-steering-banner" class="flex-row items-center gap-1.5 rounded-md px-2.5 py-1" style={{ backgroundColor: mix("water", 0.1) }}>
            <Dot tone="water" size={6} ring={false} />
            <Text class="min-w-0 flex-1 truncate text-xs font-medium text-water">{t("web.shell.chat.steeringBanner")}</Text>
          </View>
        </If>

        <If when={telemetryOpen() && hasTelemetry()}>
          <View testID="chat-telemetry-drawer" class="flex-row flex-wrap gap-2 rounded-lg border border-line bg-side p-2.5">
            <View class="min-w-48 flex-1 gap-1.5 rounded-lg border border-line bg-page p-2.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="min-w-0 truncate text-xs font-medium text-muted">{t("web.shell.chat.telemetryContextTitle")}</Text>
                <Text class="shrink-0 font-mono text-xs text-ink tabular-nums">
                  {`${telemetry().contextPct}% · ${formatTokens(telemetry().contextUsed)}/${formatTokens(telemetry().contextWindow)}`}
                </Text>
              </View>
              <View class="h-1.5 flex-row overflow-hidden rounded-full bg-selected">
                <If when={cachedBarPercent() > 0}>
                  <View class="h-full bg-leaf" style={{ width: `${cachedBarPercent()}%` }} />
                </If>
                <If when={uncachedBarPercent() > 0}>
                  <View class="h-full bg-water" style={{ width: `${uncachedBarPercent()}%` }} />
                </If>
              </View>
              <View class="flex-row flex-wrap gap-2">
                <Text class="font-mono text-2xs text-ok-ink">{`${t("web.shell.chat.telemetryCached")} ${formatTokens(telemetry().cachedRead)}`}</Text>
                <Text class="font-mono text-2xs text-water">{`${t("web.shell.chat.telemetryUncached")} ${formatTokens(telemetry().uncachedInput)}`}</Text>
                <Text class="font-mono text-2xs text-muted">{`${t("web.shell.chat.telemetryOutput")} ${formatTokens(telemetry().output)}`}</Text>
                <If when={telemetry().reasoning > 0}>
                  <Text class="font-mono text-2xs text-warn-ink">{`${t("web.shell.chat.telemetryReasoning")} ${formatTokens(telemetry().reasoning)}`}</Text>
                </If>
              </View>
            </View>

            <View class="min-w-48 flex-1 gap-1.5 rounded-lg border border-line bg-page p-2.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="min-w-0 truncate text-xs font-medium text-muted">{t("web.shell.chat.telemetryCacheTitle")}</Text>
                <Text class="shrink-0 font-mono text-xs font-semibold text-ok-ink tabular-nums">
                  {t("web.shell.chat.telemetryCache", { pct: telemetry().cacheHitPct })}
                </Text>
              </View>
              <Text class="font-mono text-sm font-semibold text-ink tabular-nums">
                {t("web.shell.chat.telemetryTurns", { turns: telemetry().turns, tools: telemetry().toolCount })}
              </Text>
            </View>

            <View class="min-w-48 flex-1 gap-1.5 rounded-lg border border-line bg-page p-2.5">
              <View class="flex-row items-center justify-between gap-2">
                <Text class="min-w-0 truncate text-xs font-medium text-muted">{t("web.shell.chat.telemetryQuotaTitle")}</Text>
                <If when={currentRuntime()?.quotaPct !== undefined}>
                  <Text class="shrink-0 font-mono text-xs text-ink tabular-nums">
                    {t("web.shell.chat.telemetryQuota", { pct: Math.round(currentRuntime()?.quotaPct ?? 0) })}
                  </Text>
                </If>
              </View>
              <If
                when={currentRuntime()?.quotaPct !== undefined}
                else={<Text class="text-2xs text-faint">{t("web.shell.chat.telemetryQuotaUnavailable")}</Text>}
              >
                <View class="gap-1">
                  <View class="h-1.5 overflow-hidden rounded-full bg-selected">
                    <View class="h-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, Math.round(currentRuntime()?.quotaPct ?? 0)))}%` }} />
                  </View>
                  <If when={currentRuntime()?.quotaText}>{(label) => <Text class="text-2xs text-faint">{label()}</Text>}</If>
                </View>
              </If>
            </View>
          </View>
        </If>

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
                : t("web.shell.chat.composerPlaceholder", { runtime: runtimeDisplayName(runtime()) })
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
              <If when={hasTelemetry()}>
                <View
                  role="button"
                  testID="chat-telemetry-toggle"
                  tooltip={<Bubble text={t("web.shell.chat.telemetryContext", { pct: telemetry().contextPct })} />}
                  accessibilityLabel={telemetryOpen() ? t("web.shell.chat.telemetryHide") : t("web.shell.chat.telemetryDetails")}
                  accessibilityState={{ expanded: telemetryOpen() }}
                  onPress={() => telemetryOpen.set(!telemetryOpen())}
                  class={`h-6 shrink-0 flex-row items-center gap-1.5 rounded-md px-2 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${
                    telemetryOpen() ? "bg-selected" : ""
                  }`}
                >
                  <View class="h-1.5 w-6 shrink-0 flex-row overflow-hidden rounded-full bg-selected">
                    <If when={cachedBarPercent() > 0}>
                      <View class="h-full bg-leaf" style={{ width: `${cachedBarPercent()}%` }} />
                    </If>
                    <If when={uncachedBarPercent() > 0}>
                      <View class="h-full bg-water" style={{ width: `${uncachedBarPercent()}%` }} />
                    </If>
                  </View>
                  <Text class={`font-mono text-2xs tabular-nums ${telemetryWarn() ? "text-warn-ink" : "text-faint"}`}>{`${telemetry().contextPct}%`}</Text>
                </View>
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
    </View>
  );
}
