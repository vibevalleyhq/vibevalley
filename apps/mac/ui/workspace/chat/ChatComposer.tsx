import { computed, Text, View } from "nsh";
import { Input, Menu, MenuItem, MenuSeparator } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { ChatTelemetry, TodoChecklist } from "@vibevalley/protocol";

import { Icon } from "../../design/Icon";
import { motionClass, popupTransition } from "../../design/motion";
import { Dot } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import type { ChatPhase, ComposerFile, RuntimeModelOption, SessionSwarmState, ThoughtLevel, WorkspaceRuntimeOption } from "../chatSession";
import { menuPopupClass, menuSeparatorClass, ShellIconButton } from "../chrome";
import { thoughtLabel, TodoProgressPanel } from "./ActivityWidgets";
import { TelemetryPopover } from "./TelemetryPopover";

export function ChatComposer(props: {
  readonly errorText: string | undefined;
  readonly onClearError: () => void;
  readonly latestTodos: TodoChecklist | undefined;
  readonly effectivePhase: ChatPhase;
  readonly composerFocused: boolean;
  readonly onComposerFocusChange: (focused: boolean) => void;
  readonly attachedFiles: readonly ComposerFile[];
  readonly onRemoveAttachment: (path: string) => void;
  readonly onPickAttachment: () => void;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly canSend: boolean;
  readonly onSend: () => void;
  readonly onStop: () => void;
  readonly sessionId: string;
  readonly runtime: string;
  readonly runtimes: readonly WorkspaceRuntimeOption[];
  readonly currentRuntime: WorkspaceRuntimeOption | undefined;
  readonly currentRuntimeLabel: string;
  readonly model: string;
  readonly currentModels: readonly RuntimeModelOption[];
  readonly modelTriggerLabel: string;
  readonly effortOptions: readonly ThoughtLevel[];
  readonly effectiveThoughtLevel: ThoughtLevel | undefined;
  readonly onSelectRuntime: (nextRt: string) => void;
  readonly onSelectModel: (nextModel: string) => void;
  readonly onSelectEffort: (next: ThoughtLevel) => void;
  readonly swarm: SessionSwarmState | undefined;
  readonly swarmOpen: boolean;
  readonly onToggleSwarm: () => void;
  readonly telemetry: ChatTelemetry;
  readonly telemetryOpen: boolean;
  readonly onTelemetryOpenChange: (open: boolean) => void;
}) {
  const runtimeOptions = computed((): readonly { value: string; label: string; disabled?: boolean }[] =>
    props.runtimes.map((r) => ({ value: r.id, label: r.name, disabled: !r.available })),
  );
  const modelOptions = computed(() => props.currentModels.map((m) => ({ value: m.id, label: m.label })));
  const composerMenuClass = `${menuPopupClass} ${motionClass("transition-opacity duration-120 ease-out")}`;
  const composerMenuItemClass = "h-7 flex-row items-center justify-between gap-2 rounded-md px-2 hover:bg-hover focus:bg-hover";

  return (
    <View class="shrink-0 gap-1.5 border-t border-line bg-page px-3 pt-2 pb-2.5">
      <If when={props.errorText}>
        {(err) => (
          <View testID="chat-error" class="flex-row items-center gap-1.5 rounded-md bg-bad-soft px-2.5 py-1">
            <Icon name="cross" size={12} tone="berry" />
            <Text class="min-w-0 flex-1 text-xs text-berry">{err()}</Text>
            <ShellIconButton compact icon="close" size={10} label={t("web.shell.palette.footer.close")} onPress={props.onClearError} />
          </View>
        )}
      </If>

      <If when={props.latestTodos}>{(todo) => <TodoProgressPanel checklist={todo()} working={props.effectivePhase === "working"} />}</If>

      <View testID="chat-composer-card" class={`rounded-xl border bg-page ${props.composerFocused ? "border-focus" : "border-line"}`}>
        <If when={props.attachedFiles.length > 0}>
          <View testID="chat-composer-attachments" class="flex-row flex-wrap items-center gap-1.5 border-b border-line px-3 pt-2.5 pb-2">
            <Each of={props.attachedFiles} key={(f) => f.path}>
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
                    onPress={() => props.onRemoveAttachment(file().path)}
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
            props.effectivePhase === "working"
              ? t("web.shell.chat.steerPlaceholder")
              : t("web.shell.chat.composerPlaceholder", { runtime: props.currentRuntimeLabel })
          }
          value={props.draft}
          onChange={(e) => props.onDraftChange(e.value)}
          onSubmit={props.onSend}
          onFocus={() => props.onComposerFocusChange(true)}
          onBlur={() => props.onComposerFocusChange(false)}
          class="max-h-36 min-h-12 w-full px-3 pt-2.5 pb-1 text-sm text-ink placeholder:text-faint"
        />

        <View class="h-9 flex-row items-center gap-1 px-2 pb-1.5">
          <View class="min-w-0 flex-1 flex-row items-center gap-1 overflow-hidden">
            <View
              role="button"
              testID="chat-attach-file"
              accessibilityLabel={t("web.shell.chat.attachFile")}
              tooltip={<Bubble text={t("web.shell.chat.attachFile")} />}
              onPress={props.onPickAttachment}
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
                  <Text class="min-w-0 shrink truncate text-xs font-medium text-muted">{props.modelTriggerLabel}</Text>
                  <View class="shrink-0" style={{ transform: [{ rotate: "90deg" }] }}>
                    <Icon name="expand" size={9} tone="faint" />
                  </View>
                </View>
              }
            >
              <If when={props.sessionId.length === 0}>
                <Text class="px-2 pt-1 pb-0.5 text-2xs font-semibold text-faint">{t("web.shell.chat.runtime")}</Text>
                <Each of={runtimeOptions()} key={(opt) => opt.value}>
                  {(opt) => (
                    <MenuItem
                      testID={`chat-runtime-option-${opt().value}`}
                      disabled={opt().disabled === true}
                      onSelect={() => props.onSelectRuntime(opt().value)}
                      class={composerMenuItemClass}
                    >
                      <Text class="min-w-0 flex-1 truncate text-xs text-ink">{opt().label}</Text>
                      <If when={props.runtime === opt().value}>
                        <Icon name="check" size={12} tone="accent" />
                      </If>
                    </MenuItem>
                  )}
                </Each>
              </If>
              <If when={modelOptions().length > 0}>
                <If when={props.sessionId.length === 0}>
                  <MenuSeparator class={menuSeparatorClass} />
                </If>
                <Text class="px-2 pt-1 pb-0.5 text-2xs font-semibold text-faint">{t("web.shell.chat.model")}</Text>
                <Each of={modelOptions()} key={(opt) => opt.value}>
                  {(opt) => (
                    <MenuItem testID={`chat-model-option-${opt().value}`} onSelect={() => props.onSelectModel(opt().value)} class={composerMenuItemClass}>
                      <Text class="min-w-0 flex-1 truncate text-xs text-ink">{opt().label}</Text>
                      <If when={props.model === opt().value}>
                        <Icon name="check" size={12} tone="accent" />
                      </If>
                    </MenuItem>
                  )}
                </Each>
              </If>
            </Menu>

            <If when={props.effortOptions.length > 0}>
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
                    <Text class="text-xs font-medium text-muted">{thoughtLabel(props.effectiveThoughtLevel ?? props.effortOptions[0] ?? "medium")}</Text>
                    <View class="shrink-0" style={{ transform: [{ rotate: "90deg" }] }}>
                      <Icon name="expand" size={9} tone="faint" />
                    </View>
                  </View>
                }
              >
                <Each of={props.effortOptions} key={(lvl) => lvl}>
                  {(lvl) => (
                    <MenuItem testID={`chat-thought-level-${lvl()}`} onSelect={() => props.onSelectEffort(lvl())} class={composerMenuItemClass}>
                      <Text class="text-xs text-ink">{thoughtLabel(lvl())}</Text>
                      <If when={props.effectiveThoughtLevel === lvl()}>
                        <Icon name="check" size={12} tone="accent" />
                      </If>
                    </MenuItem>
                  )}
                </Each>
              </Menu>
            </If>
          </View>

          <View class="shrink-0 flex-row items-center gap-1">
            <If when={props.swarm}>
              {(sw) => (
                <View
                  role="button"
                  testID="chat-swarm-pill"
                  accessibilityLabel={props.swarmOpen ? t("web.shell.swarm.closeDrawer") : t("web.shell.swarm.openDrawer")}
                  accessibilityState={{ expanded: props.swarmOpen }}
                  tooltip={<Bubble text={sw().title ?? t("web.shell.swarm.openDrawer")} />}
                  onPress={props.onToggleSwarm}
                  class={`h-6 shrink-0 flex-row items-center gap-1 rounded-md border border-line px-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus ${
                    props.swarmOpen ? "bg-selected" : "bg-side"
                  }`}
                >
                  <Dot tone={sw().workingCount > 0 ? "leaf" : "idle"} size={6} ring={false} />
                  <Text class="font-mono text-2xs font-medium text-ink tabular-nums">
                    {t("web.shell.swarm.pill", { working: sw().workingCount, active: sw().activeCount })}
                  </Text>
                </View>
              )}
            </If>

            <TelemetryPopover
              telemetry={props.telemetry}
              currentRuntime={props.currentRuntime}
              open={props.telemetryOpen}
              onOpenChange={props.onTelemetryOpenChange}
            />

            <If when={props.effectivePhase === "working"}>
              <View
                role="button"
                testID="chat-stop"
                accessibilityLabel={t("web.shell.chat.stop")}
                tooltip={<Bubble text={t("web.shell.chat.stop")} />}
                onPress={props.onStop}
                class={`h-7 w-7 shrink-0 items-center justify-center rounded-md border border-line hover:bg-bad-soft ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
              >
                <Icon name="stop" size={14} tone="berry" />
              </View>
            </If>

            <View
              role="button"
              testID="chat-send"
              accessibilityLabel={props.effectivePhase === "working" ? t("web.shell.chat.steer") : t("web.shell.chat.send")}
              tooltip={<Bubble text={props.effectivePhase === "working" ? t("web.shell.chat.steer") : t("web.shell.chat.send")} />}
              disabled={!props.canSend}
              onPress={props.onSend}
              class={`h-7 w-7 shrink-0 items-center justify-center rounded-md border ${
                props.canSend
                  ? `border-accent bg-accent hover:bg-accent-hover ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px`
                  : "border-transparent bg-hover opacity-50"
              } focus-visible:outline-2 focus-visible:outline-focus`}
            >
              <Icon name="send" size={14} tone={props.canSend ? "page" : "muted"} />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}
