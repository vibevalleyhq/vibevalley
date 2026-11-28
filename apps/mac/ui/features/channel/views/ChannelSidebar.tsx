import { computed, keymap, Scroll, signal, Text, View, windowSize } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Channel, isHumanParticipant, localUserParticipant, type SessionView } from "@vibevalley/protocol";
import { isFreeUserSession, sessionProfile } from "@vibevalley/protocol/rules";

import { OrchestratorFace, UserFace } from "../../../design/domain/Face";
import { Icon } from "../../../design/Icon";
import { ActiveBar, Kbd, SidebarSection } from "../../../design/layout";
import { motionClass } from "../../../design/motion";
import { Segmented } from "../../../design/Segmented";
import { type DotTone } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { createAct } from "../../../infra/act";
import { useAgent, useOrchestrators } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { useNow } from "../../../infra/base/dom";
import { orchestratorMood, type OrchestratorMood, useCollabSlice, useSessionsSlice } from "../../../infra/frame";
import { ready, settingsQuery, useAgents, useQuery } from "../../../infra/query";
import { fixOf } from "../../../infra/readiness";
import { useRouter } from "../../../infra/router";
import { localizeRuntimeError } from "../../../infra/runtimeError";
import { runsHref } from "../../session";
import { useMarkedChat } from "../model/marks";
import { archivedOf, type ChatFilter, channelName, channelTime, chatPath, directPeerOf, sidebarChannelsOf, unreadTotal, unreadUnder } from "../model/places";
import { Count, Dot, dutyShort, HelperFace, phaseDot, phaseText } from "./presence";
import { switcher } from "./QuickSwitcher";

export const orchestratorMoodLabels: Record<OrchestratorMood, string> = {
  idle: t("web.channel.mood.idle"),
  listening: t("web.channel.mood.listening"),
  thinking: t("web.channel.mood.thinking"),
  speaking: t("web.channel.mood.speaking"),
};

/** A square icon button of the chat's bars (VibeValley's channelIconButtonStyles). */
export function BarButton(props: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onPress: () => void;
  size?: 12 | 14 | 16 | 20;
  compact?: boolean;
  pressed?: boolean;
  disabled?: boolean;
  testid?: string;
}) {
  const box = () => (props.compact === true ? "h-6 w-6" : "h-7 w-7");
  const iconSize = () => props.size ?? (props.compact === true ? 14 : 16);
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityLabel={props.label}
      accessibilityState={props.pressed === undefined ? undefined : { selected: props.pressed }}
      tooltip={<Bubble text={props.label} />}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`${box()} shrink-0 items-center justify-center rounded-md hover:bg-hover ${
        props.pressed === true ? "bg-selected" : ""
      } ${props.disabled === true ? "opacity-50" : "active:translate-y-px"}`}
    >
      <Icon name={props.icon} size={iconSize()} tone={props.pressed === true ? "ink" : "muted"} />
    </View>
  );
}

type CollageSlot = { readonly kind: "user"; readonly id: string } | { readonly kind: "orchestrator"; readonly id: string };

/** Avatar for a chat row: agent face with presence dot for directs, or a compact member collage / chat icon for channels. */
export function ChannelAvatar(props: { channel: Channel | undefined; size?: number | undefined; dot?: DotTone | undefined }) {
  const orchestrators = useOrchestrators();
  const size = () => props.size ?? 36;
  const peerId = () => directPeerOf(props.channel);
  const isOrchestrator = () => {
    const id = peerId();
    return id !== undefined && orchestrators().some((a) => a.id === id);
  };
  const slots = computed((): readonly CollageSlot[] => {
    const ch = props.channel;
    if (!ch || ch.type === "direct") return [];
    const orcIds = new Set(orchestrators().map((a) => a.id));
    const explicit = (ch.members ?? []).filter((id) => orcIds.has(id));
    const fallback = ch.orchestrator && orcIds.has(ch.orchestrator) ? [ch.orchestrator] : [];
    const picked = (explicit.length > 0 ? explicit : fallback).slice(0, 3);
    if (picked.length === 0) return [];
    return [{ kind: "user", id: localUserParticipant }, ...picked.map((id): CollageSlot => ({ kind: "orchestrator", id }))];
  });
  return (
    <If
      when={props.channel?.type === "direct"}
      else={
        <If
          when={size() >= 32 && slots().length >= 2}
          else={
            <View class="shrink-0 items-center justify-center rounded-md border border-line bg-page" style={{ width: size(), height: size() }}>
              <Icon name="chat" size={size() >= 32 ? 16 : 14} tone="muted" />
            </View>
          }
        >
          <View
            class="shrink-0 flex-row flex-wrap items-center justify-center gap-0.5 overflow-hidden rounded-md border border-line bg-page p-0.5"
            style={{ width: size(), height: size() }}
          >
            <Each of={slots()} key={(slot) => `${slot.kind}:${slot.id}`}>
              {(slot) => (
                <If when={slot().kind === "user"} else={<OrchestratorFace size={14} agent={slot().id} />}>
                  <UserFace size={14} />
                </If>
              )}
            </Each>
          </View>
        </If>
      }
    >
      <View class="relative shrink-0" style={{ width: size(), height: size() }}>
        <If when={isOrchestrator()} else={<HelperFace agent={peerId() ?? ""} size={size()} />}>
          <OrchestratorFace size={size()} agent={peerId()} />
        </If>
        <If when={props.dot}>
          {(tone) => (
            <View class="absolute -right-0.5 -bottom-0.5">
              <Dot tone={tone()} size={size() >= 32 ? 7 : 5} />
            </View>
          )}
        </If>
      </View>
    </If>
  );
}

export function Sidebar(props: { channel: Channel | undefined; thread: Channel | undefined; onNew: () => void; onSearch: () => void; onPick: () => void }) {
  const collab = useCollabSlice();
  const router = useRouter();
  const chat = useMarkedChat();
  const settings = useQuery(settingsQuery);
  const filter = signal<ChatFilter>("all");
  const menuOpen = signal(false);
  const items = computed(() => sidebarChannelsOf(chat(), filter()));
  const archived = computed(() => archivedOf(chat()));
  const channelSummary = computed(() => (chat() === collab()?.chat ? collab()?.channelSummary : undefined));
  const totalUnread = computed(() => unreadTotal(chat(), channelSummary()));
  const unreadOf = (c: Channel) => unreadUnder(chat(), c, channelSummary());
  const archivedUnread = computed(() => archived().reduce((sum, c) => sum + unreadOf(c), 0));
  const lacks = computed(() => {
    const readiness = ready(settings, undefined)?.readiness.orchestrator;
    return readiness?.ready === false ? fixOf(readiness.missing) : undefined;
  });
  const go = (c: Channel) => {
    router.navigate(chatPath(c));
    props.onPick();
  };
  return (
    <View accessibilityLabel={t("web.channel.side")} testID="channels-side" class="w-full flex-1 border-r border-line bg-side">
      <View desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-1.5 border-b border-line px-3.5">
        <Text role="header" class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {t("web.channel.tab.chat")}
        </Text>
        <If when={totalUnread() > 0}>
          <View testID="chat-unread-total">
            <Count n={totalUnread()} />
          </View>
        </If>
        <BarButton
          icon="log"
          size={14}
          compact
          testid="chat-open-runs"
          label={t("web.channel.runsEntry")}
          onPress={() => {
            router.navigate(runsHref());
            props.onPick();
          }}
        />
        <Popover
          open={menuOpen()}
          onOpenChange={(e) => menuOpen.set(e.open)}
          placement="bottom"
          align="end"
          offset={4}
          popupClass="w-56 flex-col overflow-hidden rounded-lg border border-line bg-elevated p-1 shadow-float"
          popupStyle={{ maxHeight: Math.min(352, Math.max(180, Math.round(windowSize().height * 0.7))) }}
          trigger={
            <View
              testID="chat-new"
              accessibilityLabel={t("web.channel.newChat")}
              tooltip={<Bubble text={t("web.channel.newChat")} />}
              class={`h-6 w-6 shrink-0 items-center justify-center rounded-md ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px ${
                menuOpen() ? "bg-selected" : ""
              }`}
            >
              <Icon name="add" size={14} tone={menuOpen() ? "ink" : "muted"} />
            </View>
          }
        >
          <View class="min-h-0 shrink gap-0.5">
            <View
              role="menuitem"
              testID="new-channel"
              class="shrink-0 flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
              onPress={() => {
                menuOpen.set(false);
                props.onNew();
              }}
            >
              <Icon name="chat" size={14} tone="muted" />
              <Text class="min-w-0 flex-1 truncate text-sm text-ink">{t("web.channel.newChannel")}</Text>
            </View>
            <View class="my-1 h-px shrink-0 bg-line" />
            <DirectPicker
              onPicked={(id) => {
                menuOpen.set(false);
                router.navigate(`/chat/${id}`);
                props.onPick();
              }}
            />
          </View>
        </Popover>
      </View>
      <View class="shrink-0 gap-2 px-3 pt-2.5 pb-2">
        <View
          role="button"
          testID="switcher-open"
          onPress={() => switcher.show()}
          class={`h-8 w-full flex-row items-center gap-2 rounded-md border border-line bg-page px-2.5 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
        >
          <Icon name="search" size={14} tone="faint" />
          <Text class="min-w-0 flex-1 truncate text-sm text-muted">{t("web.channel.switcher.open")}</Text>
          <Kbd>{keymap.label("mod+j")}</Kbd>
        </View>
        <Segmented
          block
          testid="chat-filter"
          label={t("web.channel.filter.label")}
          value={filter()}
          onChange={(v) => filter.set(v)}
          options={[
            { value: "all", label: t("web.channel.filter.all") },
            { value: "group", label: t("web.channel.filter.group") },
            { value: "direct", label: t("web.channel.filter.direct") },
          ]}
        />
      </View>
      <Scroll class="flex-1" contentClass="gap-0.5 px-2 pb-2">
        <If when={items().length === 0}>
          <Text testID="chat-empty" class="px-2 py-4 text-center text-xs text-muted">
            {t("web.channel.emptyList")}
          </Text>
        </If>
        <Each of={items()} key={(c) => c.id}>
          {(c) => <ChannelRow channel={c()} here={c().id === props.channel?.id} unread={unreadOf(c())} lacks={lacks()} onClick={() => go(c())} />}
        </Each>
        <If when={archived().length > 0}>
          <SidebarSection
            title={t("web.channel.manage.archivedTitle")}
            count={archived().length}
            collapsedBadge={
              <If when={archivedUnread() > 0}>
                <Count n={archivedUnread()} />
              </If>
            }
            closed
            testID="side-section-archived"
            toggleTestID="side-section-toggle"
            class="mt-2 px-1"
            listClass="mt-0.5 gap-0.5"
          >
            <Each of={archived()} key={(c) => c.id}>
              {(c) => <ChannelRow channel={c()} here={c().id === props.channel?.id} unread={unreadOf(c())} lacks={lacks()} onClick={() => go(c())} />}
            </Each>
          </SidebarSection>
        </If>
      </Scroll>
    </View>
  );
}

/** The profiles the user can talk with alone, the orchestrators first: picking one opens its direct channel, made the
 * first time. */
function DirectPicker(props: { onPicked: (channel: string) => void }) {
  const all = useAgents();
  const agents = computed(() => [...ready(all, [])].toSorted((a, b) => (a.role === b.role ? 0 : a.role === "orchestrator" ? -1 : 1)));
  const act = createAct();
  const open = async (agent: string) => {
    const id = await act.run(() => api.channel.direct.create({ agent }));
    if (id !== undefined) props.onPicked(id);
  };
  return (
    <Scroll testID="direct-picker" accessibilityLabel={t("web.channel.direct.pick")} class="min-h-0 shrink" contentClass="gap-0.5">
      <Text class="px-2 py-1 text-xs font-semibold text-muted">{t("web.channel.direct.pick")}</Text>
      <If when={all.status() === "success" && agents().length === 0}>
        <Text class="px-2 py-1 text-sm text-muted">{t("web.channel.direct.none")}</Text>
      </If>
      <Each of={agents()} key={(a) => a.id}>
        {(a) => (
          <View
            role="menuitem"
            testID={`direct-${a().id}`}
            class="flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover"
            onPress={() => void open(a().id)}
          >
            <If when={a().role === "orchestrator"} else={<HelperFace agent={a().id} runtime={a().runtime} size={20} />}>
              <OrchestratorFace size={20} agent={a().id} />
            </If>
            <Text class="min-w-0 flex-1 truncate text-sm text-ink">{a().name}</Text>
          </View>
        )}
      </Each>
    </Scroll>
  );
}

type PreviewLine = { readonly text: string; readonly tone: "muted" | "accent" | "berry" };

function ChannelRow(props: {
  channel: Channel;
  here: boolean;
  unread: number;
  lacks: { readonly words: string; readonly href: string } | undefined;
  onClick: () => void;
}) {
  const sessionsSlice = useSessionsSlice();
  const orchestrators = useOrchestrators();
  const now = useNow();
  const peerId = () => directPeerOf(props.channel);
  const isOrc = () => {
    const id = peerId();
    return id !== undefined && orchestrators().some((a) => a.id === id);
  };
  const peerAgent = useAgent(peerId);
  const mood = computed((): OrchestratorMood => {
    const id = peerId();
    return id !== undefined && isOrc() ? orchestratorMood(sessionsSlice()?.sessions, id) : "idle";
  });
  const workerSession = computed((): SessionView | undefined => {
    if (props.channel.type !== "direct" || isOrc()) return undefined;
    const id = peerId();
    if (!id) return undefined;
    const matching = (sessionsSlice()?.sessions ?? []).filter((h) => !isFreeUserSession(h) && h.role === "worker" && sessionProfile(h) === id);
    return matching.find((h) => h.phase._tag === "working") ?? matching.find((h) => h.phase._tag === "failed");
  });
  const dotTone = computed((): DotTone | undefined => {
    if (props.channel.type !== "direct") return undefined;
    if (isOrc()) {
      if (props.lacks) return "berry";
      if (mood() === "thinking") return "wheat";
      if (mood() === "listening" || mood() === "speaking") return "leaf";
      return "idle";
    }
    const session = workerSession();
    return session ? phaseDot(session.phase) : undefined;
  });
  const timeText = () => channelTime(props.channel.last?.at ?? props.channel.at, now());
  const preview = computed((): PreviewLine => {
    if (props.channel.type === "direct" && isOrc()) {
      if (mood() === "thinking" || mood() === "speaking") return { text: orchestratorMoodLabels[mood()], tone: "accent" };
    }
    const active = workerSession();
    if (active && active.phase._tag === "working") {
      return { text: phaseText(active, now()), tone: "accent" };
    }
    const last = props.channel.last;
    if (last) {
      const body = localizeRuntimeError(last.text.replace(/\s+/gu, " ").trim()).text;
      if (body) {
        const isUser = isHumanParticipant(last.from);
        const who = isUser ? t("web.channel.messages.user") : last.name;
        const formatted = props.channel.type === "channel" ? (who ? `${who}: ${body}` : body) : isUser ? `${who}: ${body}` : body;
        return { text: formatted, tone: "muted" };
      }
    }
    if (props.channel.type === "channel") {
      return { text: props.channel.description || t("web.channel.emptyPreview"), tone: "muted" };
    }
    if (isOrc()) {
      return { text: orchestratorMoodLabels[mood()], tone: "muted" };
    }
    const duty = peerAgent()?.duty;
    return { text: (duty ? dutyShort(duty) : "") || t("web.channel.emptyPreview"), tone: "muted" };
  });
  const quiet = () => props.channel.notify === "none";
  const previewToneClass = () => {
    switch (preview().tone) {
      case "berry":
        return "text-berry";
      case "accent":
        return "text-accent";
      case "muted":
        return "text-muted";
    }
  };
  return (
    <View
      role="button"
      testID={`channel-row-${props.channel.id}`}
      accessibilityLabel={channelName(props.channel)}
      accessibilityState={{ selected: props.here }}
      onPress={() => props.onClick()}
      class={`relative flex-row items-center gap-2.5 rounded-md px-2 py-2 focus-visible:outline-2 focus-visible:outline-focus ${
        props.here ? "bg-selected" : "hover:bg-hover"
      }`}
    >
      <If when={props.here}>
        <ActiveBar />
      </If>
      <ChannelAvatar channel={props.channel} size={36} dot={dotTone()} />
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-1.5">
          <Text
            class={`min-w-0 flex-1 truncate text-sm ${props.unread > 0 || props.here ? "font-semibold" : "font-medium"} ${
              quiet() && !props.here ? "text-muted" : "text-ink"
            }`}
          >
            {channelName(props.channel)}
          </Text>
          <If when={timeText()}>{(label) => <Text class="shrink-0 font-mono text-2xs text-faint">{label()}</Text>}</If>
        </View>
        <View class="flex-row items-center gap-1.5">
          <Text class={`min-w-0 flex-1 truncate text-xs ${previewToneClass()}`}>{preview().text}</Text>
          <View class="shrink-0 flex-row items-center gap-1">
            <If when={props.channel.notify === "none"}>
              <View tooltip={<Bubble text={t("web.channel.manage.muted")} />}>
                <Icon name="hide" size={12} tone="faint" />
              </View>
            </If>
            <If when={props.channel.notify === "mentions"}>
              <Text class="text-2xs text-faint">{t("web.channel.manage.mentionsOnly")}</Text>
            </If>
            <If when={props.unread > 0}>
              <Count n={props.unread} />
            </If>
          </View>
        </View>
      </View>
    </View>
  );
}
