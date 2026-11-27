import { Scroll, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ChatFeedItem, ChatToolStepProjection } from "@vibevalley/protocol";

import { Icon } from "../../design/Icon";
import { mix } from "../../design/tone";
import { variant } from "../../infra/base/dom";
import type { ChatPhase, SessionInteractionRequest, SessionPermissionDecision, SessionPermissionRequest } from "../chatSession";
import { ActivityGroup, ChatMarkdown, InteractionCard, MemoryRecalledRow, PermissionCard, ThinkingBlock, ToolCallCard } from "./ActivityWidgets";

export function ChatFeed(props: {
  readonly shownStepsCount: number;
  readonly feedItems: readonly ChatFeedItem[];
  readonly steeredSeqs: ReadonlySet<number>;
  readonly effectivePhase: ChatPhase;
  readonly toolEntriesBySeq: ReadonlyMap<number, ChatToolStepProjection>;
  readonly pendingPermissions: readonly SessionPermissionRequest[];
  readonly pendingInteractions: readonly SessionInteractionRequest[];
  readonly responding: boolean;
  readonly onDiagramPress: (ev: { source: string }) => void;
  readonly onGenUiAction: (ev: { action: string; payload: string; label?: string }) => void;
  readonly onRespondPermission: (requestId: string, decision: SessionPermissionDecision) => void;
  readonly onRespondInteraction: (
    requestId: string,
    decision: { kind: "select"; optionId: string } | { kind: "custom"; text: string } | { kind: "cancel" },
  ) => void;
}) {
  return (
    <Scroll testID="chat-stream" class="min-h-0 flex-1" contentClass="gap-3 px-4 py-4">
      <If when={props.shownStepsCount === 0 && props.pendingInteractions.length === 0 && props.pendingPermissions.length === 0}>
        <View testID="chat-empty" class="items-center justify-center gap-1.5 py-14">
          <Icon name="chat" size={24} tone="faint" />
          <Text class="text-sm font-semibold text-ink">{t("web.shell.chat.emptyTitle")}</Text>
          <Text class="max-w-md text-center text-xs text-muted">{t("web.shell.chat.emptyHint")}</Text>
        </View>
      </If>

      <Each of={props.feedItems} key={(item) => item.key}>
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
                        style={
                          props.steeredSeqs.has(single().step.seq) ? { borderLeftColor: mix("water", 0.9), backgroundColor: mix("water", 0.08) } : undefined
                        }
                      >
                        <If when={props.steeredSeqs.has(single().step.seq)}>
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
                      <ThinkingBlock step={single().step} durationMs={single().durationMs} running={single().trailing && props.effectivePhase === "working"} />
                    </If>

                    <If when={single().step.type === "tool/call"}>
                      <ToolCallCard step={single().step} durationMs={single().durationMs} projected={props.toolEntriesBySeq.get(single().step.seq)} />
                    </If>

                    <If when={single().step.type === "memory/recalled"}>
                      <MemoryRecalledRow step={single().step} />
                    </If>

                    <If when={single().step.type === "assistant/message"}>
                      <View class="rounded-lg px-1 py-0.5">
                        <ChatMarkdown
                          text={single().step.text}
                          streaming={props.effectivePhase === "working"}
                          onDiagramPress={props.onDiagramPress}
                          onGenUiAction={props.onGenUiAction}
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
            {(activity) => <ActivityGroup item={activity()} working={props.effectivePhase === "working"} toolEntries={props.toolEntriesBySeq} />}
          </If>
        )}
      </Each>

      <Each of={props.pendingPermissions} key={(p) => p.requestId}>
        {(perm) => <PermissionCard permission={perm()} busy={props.responding} onRespond={(d) => props.onRespondPermission(perm().requestId, d)} />}
      </Each>

      <Each of={props.pendingInteractions} key={(i) => i.requestId}>
        {(inter) => <InteractionCard interaction={inter()} busy={props.responding} onRespond={(d) => props.onRespondInteraction(inter().requestId, d)} />}
      </Each>
    </Scroll>
  );
}
