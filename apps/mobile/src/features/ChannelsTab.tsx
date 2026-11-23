import { effect, Scroll, signal, Text, View } from "nsh";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import type { Channel, ChatMessage } from "@vibevalley/protocol";
import { ChannelEvent as ChannelEventSchema, ChatMessage as ChatMessageSchema } from "@vibevalley/protocol/schema";

import { Icon } from "../design/Icon";
import type { MobileLayout } from "../design/layout";
import { EmptyPanel, FieldInput, PillButton, SectionCard, SplitPane, StatusTag, TopBar } from "../design/ui";
import { hapticImpact, hapticNotification, type RemoteSession } from "../infra/session";

const ChatMessageListSchema = z.array(ChatMessageSchema);

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

function channelLabel(channel: Channel): string {
  if (channel.type === "direct") return `@${channel.name ?? channel.title}`;
  return `#${channel.name ?? channel.title}`;
}

export function ChannelsTab(props: {
  readonly session: RemoteSession;
  readonly layout: () => MobileLayout;
  readonly selectedChannelId: () => string | undefined;
  readonly onSelectChannel: (id: string | undefined) => void;
}) {
  const messages = signal<readonly ChatMessage[]>([]);
  const loading = signal(false);
  const draft = signal("");
  const sending = signal(false);
  const sendError = signal<string | undefined>(undefined);
  const isDual = () => props.layout().mode === "dual_pane";

  const channels = () => {
    const list = props.session.collab()?.chat?.channels ?? [];
    const active = list.filter((c) => c.archived === undefined);
    return active.length > 0 ? active : list;
  };

  const selectedChannel = () => {
    const id = props.selectedChannelId();
    if (id === undefined) return undefined;
    return channels().find((c) => c.id === id);
  };

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

    let cancelled = false;
    let stopFollow: (() => void) | undefined;
    messages.set([]);
    sendError.set(undefined);
    loading.set(true);

    const loadAndFollow = async () => {
      const env = await props.session.call("channel.message.list", { id: channelId, limit: 50 });
      if (cancelled) return;
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
        }
      } else {
        sendError.set(env.message);
      }

      if (cancelled) return;
      stopFollow = props.session.subscribe(
        "channel.follow",
        { id: channelId, after: maxRevision },
        (raw) => {
          if (cancelled) return;
          const parsed = ChannelEventSchema.safeParse(raw);
          if (!parsed.success) return;
          const ev = parsed.data;
          switch (ev._tag) {
            case "Message":
              messages.update((prev) => mergeMessages(prev, [ev.message]));
              break;
            case "Reset":
              void props.session.call("channel.message.list", { id: channelId, limit: 50 }).then((reloadEnv) => {
                if (cancelled || reloadEnv.bizCode !== 0) return;
                const reloaded = ChatMessageListSchema.safeParse(reloadEnv.data);
                if (reloaded.success) messages.set(mergeMessages([], reloaded.data));
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
      cancelled = true;
      stopFollow?.();
    };
  });

  const sendReply = async () => {
    const channelId = props.selectedChannelId();
    const text = draft().trim();
    if (channelId === undefined || text === "" || sending()) return;
    sending.set(true);
    sendError.set(undefined);
    try {
      const env = await props.session.call("channel.message.send", { id: channelId, text });
      if (env.bizCode !== 0) {
        sendError.set(env.message);
        hapticNotification("error");
      } else {
        draft.set("");
        hapticImpact("light");
      }
    } finally {
      sending.set(false);
    }
  };

  const renderMaster = () => (
    <If when={channels().length > 0} else={<EmptyPanel testID="channels-empty" icon="chat" message={t("web.remote.channel.empty")} />}>
      <Scroll class="flex-1" contentClass="gap-2.5 p-3.5">
        <Each of={channels()} key={(ch) => ch.id}>
          {(ch) => {
            const active = () => isDual() && props.selectedChannelId() === ch().id;
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
        </Each>
      </Scroll>
    </If>
  );

  const renderDetail = () => (
    <View testID="channel-detail" class="min-h-0 flex-1">
      <TopBar
        testID="channel-detail-bar"
        backTestID="channel-back"
        title={selectedChannel() ? channelLabel(selectedChannel()!) : (props.selectedChannelId() ?? "")}
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
        when={!loading() && messages().length === 0}
        else={
          <Scroll class="flex-1" contentClass="gap-2.5 p-4">
            <Each of={messages()} key={(msg) => msg.id}>
              {(msg) => (
                <SectionCard testID={`channel-message-${msg().id}`} class="gap-1">
                  <View class="flex-row items-center justify-between gap-2">
                    <Text class="text-xs font-semibold text-accent">{msg().name}</Text>
                    <Text class="font-mono text-2xs text-faint">#{String(msg().number)}</Text>
                  </View>
                  <Text class="text-sm text-ink">{msg().text}</Text>
                </SectionCard>
              )}
            </Each>
          </Scroll>
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
          disabled={sending()}
          class="min-w-0 flex-1"
        />
        <PillButton
          testID="channel-reply-send"
          tone="primary"
          size="sm"
          icon="send"
          label={t("web.remote.channel.send")}
          disabled={sending() || draft().trim() === ""}
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
