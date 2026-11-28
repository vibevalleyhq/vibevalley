import { computed, effect, List, signal, Text, untracked, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { type ChatMessage, localUserParticipant } from "@vibevalley/protocol";
import { channelLabel } from "@vibevalley/protocol/rules";
import { ChannelEvent as ChannelEventSchema, ChatMessage as ChatMessageSchema, messageId } from "@vibevalley/protocol/schema";

import { Icon } from "../design/Icon";
import type { MobileLayout } from "../design/layout";
import { EmptyPanel, FieldInput, MarkdownText, PillButton, SectionCard, SplitPane, StatusTag, TopBar } from "../design/ui";
import { errorMessage, hapticImpact, hapticNotification, type RemoteSession } from "../infra/session";

const ChatMessageListSchema = z.array(ChatMessageSchema);

interface OptimisticChannelMessage {
  readonly channelId: string;
  readonly sendKey: string;
  readonly message: ChatMessage;
}

function mergeMessages(existing: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const msg of existing) byId.set(msg.id, msg);
  for (const msg of incoming) {
    const prev = byId.get(msg.id);
    if (!prev || msg.revision >= prev.revision) {
      byId.set(msg.id, msg);
    }
  }
  return [...byId.values()].toSorted((a, b) => a.number - b.number);
}

export function ChannelsTab(props: {
  readonly session: RemoteSession;
  readonly layout: () => MobileLayout;
  readonly selectedChannelId: () => string | undefined;
  readonly onSelectChannel: (id: string | undefined) => void;
}) {
  const messages = signal<readonly ChatMessage[]>([]);
  const pendingMessages = signal<readonly OptimisticChannelMessage[]>([]);
  const loading = signal(false);
  const draft = signal("");
  const sending = signal(false);
  const sendError = signal<string | undefined>(undefined);
  let localSendSeq = 0;
  let retrySend: { readonly channelId: string; readonly text: string; readonly sendKey: string } | undefined;

  const isDual = computed(() => props.layout().mode === "dual_pane");

  const channels = computed(() => {
    const list = props.session.collab()?.chat?.channels ?? [];
    const active = list.filter((c) => c.archived === undefined);
    return active.length > 0 ? active : list;
  });

  const selectedChannel = computed(() => {
    const id = props.selectedChannelId();
    if (id === undefined) return undefined;
    return channels().find((c) => c.id === id);
  });

  const hasDraft = computed(() => draft().trim() !== "");
  const canSend = computed(() => props.selectedChannelId() !== undefined && !sending() && hasDraft());

  const displayedMessages = computed((): readonly ChatMessage[] => {
    const channelId = props.selectedChannelId();
    const canonical = messages();
    if (channelId === undefined) return canonical;
    const canonicalKeys = new Set<string>();
    for (const msg of canonical) {
      if (msg.sendKey !== undefined) canonicalKeys.add(msg.sendKey);
    }
    const pending = pendingMessages()
      .filter((item) => item.channelId === channelId && !canonicalKeys.has(item.sendKey))
      .map((item) => item.message);
    if (pending.length === 0) return canonical;
    return [...canonical, ...pending];
  });

  const isEmptyFeed = computed(() => !loading() && displayedMessages().length === 0);
  const detailTitle = computed(() => (selectedChannel() ? channelLabel(selectedChannel()) : (props.selectedChannelId() ?? "")));

  effect(() => {
    if (!isDual()) return;
    const list = channels();
    const current = props.selectedChannelId();
    if (list.length > 0 && (current === undefined || !list.some((c) => c.id === current))) {
      props.onSelectChannel(list[0]?.id);
    }
  });

  effect(() => {
    const channelId = props.selectedChannelId();
    if (channelId === undefined) {
      messages.set([]);
      sendError.set(undefined);
      return;
    }

    const controller = new AbortController();
    let stopFollow: (() => void) | undefined;
    messages.set([]);
    sendError.set(undefined);
    loading.set(true);

    const applyReloadedMessages = (data: unknown) => {
      const reloaded = ChatMessageListSchema.safeParse(data);
      if (!reloaded.success) {
        console.error("[ChannelsTab] invalid channel.message.list reload payload", { channelId, issues: reloaded.error.issues });
        sendError.set(reloaded.error.message);
        return;
      }
      const ordered = mergeMessages([], reloaded.data);
      messages.set(ordered);
      const reloadedKeys = new Set(ordered.map((m) => m.sendKey).filter((k): k is string => k !== undefined));
      if (reloadedKeys.size > 0) {
        pendingMessages.update((prev) => prev.filter((item) => item.channelId !== channelId || !reloadedKeys.has(item.sendKey)));
      }
    };

    const loadAndFollow = async () => {
      let env;
      try {
        env = await props.session.call("channel.message.list", { id: channelId, limit: 50 }, { signal: controller.signal });
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        loading.set(false);
        sendError.set(errorMessage(err));
        return;
      }
      if (controller.signal.aborted) return;
      loading.set(false);
      let maxRevision = 0;
      if (env.bizCode === 0) {
        const parsed = ChatMessageListSchema.safeParse(env.data);
        if (parsed.success) {
          const ordered = mergeMessages([], parsed.data);
          messages.set(ordered);
          for (const msg of ordered) {
            if (msg.revision > maxRevision) maxRevision = msg.revision;
          }
        } else {
          console.error("[ChannelsTab] invalid channel.message.list payload", { channelId, issues: parsed.error.issues });
          sendError.set(parsed.error.message);
        }
      } else {
        sendError.set(env.message);
      }

      if (controller.signal.aborted) return;
      stopFollow = props.session.subscribe(
        "channel.follow",
        { id: channelId, after: maxRevision },
        (raw) => {
          if (controller.signal.aborted) return;
          const parsed = ChannelEventSchema.safeParse(raw);
          if (!parsed.success) {
            console.error("[ChannelsTab] dropped malformed channel.follow event", { channelId, issues: parsed.error.issues });
            return;
          }
          const ev = parsed.data;
          switch (ev._tag) {
            case "Message": {
              const incoming = ev.message;
              messages.update((prev) => mergeMessages(prev, [incoming]));
              pendingMessages.update((prev) => {
                let matched = false;
                return prev.filter((item) => {
                  if (matched || item.channelId !== incoming.channel) return true;
                  const matchesKey = incoming.sendKey !== undefined && incoming.sendKey === item.sendKey;
                  const matchesText = incoming.sendKey === undefined && incoming.text === item.message.text;
                  if (matchesKey || matchesText) {
                    matched = true;
                    return false;
                  }
                  return true;
                });
              });
              break;
            }
            case "Reset":
              void props.session
                .call("channel.message.list", { id: channelId, limit: 50 }, { signal: controller.signal })
                .then((reloadEnv) => {
                  if (controller.signal.aborted) return;
                  if (reloadEnv.bizCode === 0) {
                    applyReloadedMessages(reloadEnv.data);
                  } else {
                    console.error("[ChannelsTab] channel reset reload failed", { channelId, bizCode: reloadEnv.bizCode, message: reloadEnv.message });
                    sendError.set(reloadEnv.message);
                  }
                })
                .catch((err: unknown) => {
                  if (controller.signal.aborted) return;
                  const message = errorMessage(err);
                  console.error("[ChannelsTab] channel reset reload error", { channelId, error: message });
                  sendError.set(message);
                });
              break;
          }
        },
        () => {
          // Follow stream closed; loaded history remains visible.
        },
      );
    };

    void loadAndFollow();

    return () => {
      controller.abort();
      stopFollow?.();
    };
  });

  const sendReply = async () => {
    const channelId = untracked(props.selectedChannelId);
    const text = untracked(draft).trim();
    if (channelId === undefined || text === "" || untracked(sending)) return;

    const sendKey =
      retrySend !== undefined && retrySend.channelId === channelId && retrySend.text === text ? retrySend.sendKey : `mobile-${Date.now()}-${++localSendSeq}`;
    retrySend = undefined;

    let maxNumber = 0;
    for (const m of untracked(messages)) {
      if (m.number > maxNumber) maxNumber = m.number;
    }
    for (const item of untracked(pendingMessages)) {
      if (item.channelId === channelId && item.message.number > maxNumber) maxNumber = item.message.number;
    }

    const senderName = untracked(props.session.credentials)?.deviceName ?? "You";
    const optimisticMessage: ChatMessage = {
      id: messageId(`pending:${sendKey}`),
      number: maxNumber + 1,
      channel: channelId,
      from: localUserParticipant,
      actor: { kind: "user", id: localUserParticipant, name: senderName },
      name: senderName,
      kind: "chat",
      text,
      mentions: [],
      outcome: null,
      spoken: false,
      sendKey,
      at: Date.now(),
      revision: 0,
      reactions: [],
      attachments: [],
      embeds: [],
    };

    draft.set("");
    sending.set(true);
    sendError.set(undefined);
    pendingMessages.update((prev) => [...prev, { channelId, sendKey, message: optimisticMessage }]);

    const rollback = (message: string) => {
      pendingMessages.update((prev) => prev.filter((item) => item.sendKey !== sendKey));
      retrySend = { channelId, text, sendKey };
      sendError.set(message);
      hapticNotification("error");
      if (untracked(draft) === "") draft.set(text);
    };

    try {
      const env = await props.session.call("channel.message.send", { id: channelId, text, sendKey });
      if (env.bizCode !== 0) {
        rollback(env.message);
      } else {
        hapticImpact("light");
      }
    } catch (err: unknown) {
      rollback(errorMessage(err));
    } finally {
      sending.set(false);
    }
  };

  const renderMaster = () => (
    <If when={channels().length > 0} else={<EmptyPanel testID="channels-empty" icon="chat" message={t("web.remote.channel.empty")} />}>
      <List testID="channels-list" each={channels()} keyExtractor={(ch) => ch.id} estimatedItemSize={72} class="min-h-0 flex-1" contentClass="gap-2.5 p-3.5">
        {(ch) => {
          const active = computed(() => isDual() && props.selectedChannelId() === ch().id);
          return (
            <SectionCard
              testID={`channel-row-${ch().id}`}
              onPress={() => {
                hapticImpact("light");
                props.onSelectChannel(ch().id);
              }}
              class={`gap-1.5 ${active() ? "border-focus bg-selected" : ""}`}
            >
              <View class="flex-row items-center justify-between gap-2">
                <View class="min-w-0 flex-1 flex-row items-center gap-2">
                  <Icon name="chat" size={16} tone="accent" />
                  <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{channelLabel(ch())}</Text>
                </View>
                <If when={(ch().unread ?? 0) > 0}>
                  <StatusTag label={String(ch().unread ?? 0)} tone="info" />
                </If>
              </View>
              <If when={ch().last}>
                {(last) => (
                  <Text class="truncate text-xs text-muted">
                    {last().name}: {last().text}
                  </Text>
                )}
              </If>
            </SectionCard>
          );
        }}
      </List>
    </If>
  );

  const renderDetail = () => (
    <View testID="channel-detail" class="min-h-0 flex-1">
      <TopBar
        testID="channel-detail-bar"
        backTestID="channel-back"
        title={detailTitle()}
        subtitle={selectedChannel()?.description || undefined}
        onBack={isDual() ? undefined : () => props.onSelectChannel(undefined)}
      />

      <If when={sendError()}>
        {(msg) => (
          <View testID="channel-error" class="mx-4 mt-2 rounded-lg border border-berry bg-bad-soft px-3 py-2">
            <Text class="text-xs font-medium text-berry">{msg()}</Text>
          </View>
        )}
      </If>

      <If
        when={isEmptyFeed()}
        else={
          <List
            testID="channel-messages-list"
            each={displayedMessages()}
            keyExtractor={(msg) => msg.id}
            estimatedItemSize={88}
            alignment="bottom"
            initialScrollAtEnd
            maintainVisibleContentPosition={{ autoscrollToBottomThreshold: 64 }}
            keyboardDismissMode="on-drag"
            class="min-h-0 flex-1"
            contentClass="gap-2.5 p-4"
          >
            {(msg) => (
              <SectionCard testID={`channel-message-${msg().id}`} class="gap-1.5">
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="text-xs font-semibold text-accent">{msg().name}</Text>
                  <Text class="font-mono text-2xs text-faint">#{String(msg().number)}</Text>
                </View>
                <MarkdownText testID={`channel-message-body-${msg().id}`} text={msg().text} size="sm" />
              </SectionCard>
            )}
          </List>
        }
      >
        <EmptyPanel testID="channel-messages-empty" icon="chat" message={t("web.remote.channel.empty")} />
      </If>

      <View class="flex-row items-center gap-2 border-t border-line bg-side px-3.5 py-2.5">
        <FieldInput
          testID="channel-reply-input"
          placeholder={t("web.remote.channel.replyPlaceholder")}
          value={draft()}
          onInput={(v) => draft.set(v)}
          onSubmit={() => {
            void sendReply();
          }}
          class="min-w-0 flex-1"
        />
        <PillButton
          testID="channel-reply-send"
          tone="primary"
          size="sm"
          icon="send"
          label={t("web.remote.channel.send")}
          disabled={!canSend()}
          onPress={() => {
            void sendReply();
          }}
        />
      </View>
    </View>
  );

  return (
    <SplitPane
      testID="channels-tab"
      layout={props.layout}
      hasSelection={() => props.selectedChannelId() !== undefined}
      master={renderMaster}
      detail={renderDetail}
      emptyDetail={() => <EmptyPanel testID="channel-detail-empty" icon="chat" message={t("web.remote.channel.empty")} />}
    />
  );
}
