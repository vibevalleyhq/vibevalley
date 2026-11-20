import { cleanup, keymap, PanResponder, Scroll, signal, Text, untracked, View, type JSX, type ViewRef } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Channel, defaultOrchestrator, type SessionView } from "@vibevalley/protocol";

import { useNow } from "../../../base/dom";
import { tookText } from "../../../base/format";
import { useAgent } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { orchestratorMood, orchestratorSession, type OrchestratorMood, useCore } from "../../../infra/frame";
import { ready, settingsQuery, useAgents, useQuery } from "../../../infra/query";
import { fixOf } from "../../../infra/readiness";
import { useRouter } from "../../../infra/router";
import { createAct } from "../../../ui/act";
import { OrchestratorFace } from "../../../ui/domain/Face";
import { Icon } from "../../../ui/Icon";
import { TextLink } from "../../../ui/TextLink";
import { Bubble } from "../../../ui/Tip";
import { useMarkedChat } from "../model/marks";
import { archivedOf, channelName, chatPath, directsOf, groupsOf, sessionThreadOf, topsOf, unreadIn, unreadUnder } from "../model/places";
import { Count, Dot, HelperFace, PhaseGlyph, ThinkingDots, phaseDot, phaseText } from "./presence";
import { switcher } from "./QuickSwitcher";

export const markOf = (c: Channel | undefined) => (c?.type === "direct" ? "@" : "#");

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
  size?: 14 | 16 | 20;
  pressed?: boolean;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <View
      role="button"
      testID={props.testid}
      accessibilityLabel={props.label}
      accessibilityState={props.pressed === undefined ? undefined : { selected: props.pressed }}
      tooltip={<Bubble text={props.label} />}
      disabled={props.disabled}
      onPress={() => props.onPress()}
      class={`h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-hover ${props.pressed === true ? "bg-selected" : ""} ${props.disabled === true ? "opacity-50" : ""}`}
    >
      <Icon name={props.icon} size={props.size ?? 20} tone="ink" />
    </View>
  );
}

export function Sidebar(props: { channel: Channel | undefined; thread: Channel | undefined; onNew: () => void; onSearch: () => void; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const chat = useMarkedChat();
  const channels = () => topsOf(chat());
  const archived = () => archivedOf(chat());
  const sessions = () => core()?.sessions ?? [];
  const picking = signal(false);
  const go = (c: Channel) => {
    router.navigate(chatPath(c));
    props.onPick();
  };
  const act = createAct();
  const reorder = createReorder((id, onto) => void act.run(() => api.channel.update({ id, before: onto.id, category: onto.category })));
  const row = (c: Channel) => (
    <ChannelRow channel={c} here={c.id === props.channel?.id} unread={unreadUnder(chat(), c)} onClick={() => go(c)} reorder={reorder} />
  );
  return (
    <View accessibilityLabel={t("web.channel.side")} testID="channels-side" class="w-full flex-1 border-r border-line bg-side">
      <View class="h-16.5 shrink-0 flex-row items-center gap-2 border-b border-line px-5">
        <Text role="header" class="flex-1 text-xl font-semibold text-ink">
          {t("web.channel.tab.chat")}
        </Text>
        <BarButton icon="search" size={16} testid="farm-search-open" label={t("web.channel.farmSearch.open")} onPress={() => props.onSearch()} />
      </View>
      <Scroll class="flex-1" contentClass="p-3">
        <View
          role="button"
          testID="switcher-open"
          onPress={() => switcher.show()}
          class="mb-3 h-8 w-full flex-row items-center gap-2 rounded-md border border-line bg-page px-2.5 hover:bg-hover"
        >
          <Text class="flex-1 text-sm text-muted">{t("web.channel.switcher.open")}</Text>
          <Text class="text-xs text-faint">{keymap.label("mod+k")}</Text>
        </View>
        <Section
          item="channels"
          title={t("web.channel.channelsTitle")}
          count={Math.max(1, channels().length)}
          action={<BarButton icon="add" size={14} testid="new-channel" label={t("web.channel.newChannel")} onPress={() => props.onNew()} />}
        >
          <Each of={groupsOf(channels())}>
            {(g) => (
              <If when={g().category} else={<Each of={g().channels}>{(c) => row(c())}</Each>}>
                {(name) => (
                  <Section title={name()} item={`category:${name()}`} count={g().channels.length} nested>
                    <Each of={g().channels}>{(c) => row(c())}</Each>
                  </Section>
                )}
              </If>
            )}
          </Each>
        </Section>
        <Section
          item="directs"
          title={t("web.channel.directsTitle")}
          count={directsOf(chat()).length}
          action={
            <Popover
              open={picking()}
              onOpenChange={(e) => picking.set(e.open)}
              placement="bottom"
              align="end"
              offset={4}
              popupClass="max-h-80 w-56 rounded-lg border border-line bg-page p-1 shadow-float"
              trigger={
                <View
                  testID="new-direct"
                  accessibilityLabel={t("web.channel.direct.add")}
                  tooltip={<Bubble text={t("web.channel.direct.add")} />}
                  class={`h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-hover ${picking() ? "bg-selected" : ""}`}
                >
                  <Icon name="add" size={14} />
                </View>
              }
            >
              <DirectPicker
                onPicked={(id) => {
                  picking.set(false);
                  router.navigate(`/chat/${id}`);
                  props.onPick();
                }}
              />
            </Popover>
          }
        >
          <Each of={directsOf(chat())}>{(c) => row(c())}</Each>
        </Section>
        <Section title={t("web.channel.helpers")} item="helpers" count={sessions().length}>
          <If when={sessions().length === 0}>
            <Text class="px-3 text-xs text-muted">{t("web.channel.noHelpers")}</Text>
          </If>
          <Each of={sessions()} key={(h) => h.id}>
            {(h) => <SessionRow h={h()} active={!!props.thread && sessionThreadOf(chat(), h())?.id === props.thread.id} onShow={go} />}
          </Each>
        </Section>
        <If when={archived().length > 0}>
          <Section title={t("web.channel.manage.archivedTitle")} item="archived" count={archived().length} closed>
            <Each of={archived()}>{(c) => row(c())}</Each>
          </Section>
        </If>
      </Scroll>
      <OrchestratorLine agent={(props.thread ?? props.channel)?.orchestrator ?? defaultOrchestrator} />
    </View>
  );
}

/** The profiles the user can talk with alone, the orchestrators first: picking one opens its direct channel, made the
 * first time. */
function DirectPicker(props: { onPicked: (channel: string) => void }) {
  const all = useAgents();
  const agents = () => [...ready(all, [])].toSorted((a, b) => (a.role === b.role ? 0 : a.role === "orchestrator" ? -1 : 1));
  const act = createAct();
  const open = async (agent: string) => {
    const id = await act.run(() => api.channel.direct.create({ agent }));
    if (id !== undefined) props.onPicked(id);
  };
  return (
    <Scroll testID="direct-picker" accessibilityLabel={t("web.channel.direct.pick")} contentClass="gap-0.5">
      <Text class="px-2 py-1 text-xs font-semibold text-muted">{t("web.channel.direct.pick")}</Text>
      <If when={all.status() === "success" && agents().length === 0}>
        <Text class="px-2 py-1 text-sm text-muted">{t("web.channel.direct.none")}</Text>
      </If>
      <Each of={agents()} key={(a) => a.id}>
        {(a) => (
          <View
            role="menuitem"
            testID={`direct-${a().id}`}
            class="flex-row items-center gap-2 rounded-md px-2 py-1 hover:bg-hover"
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

function Section(props: { title: string; item: string; count: number; action?: JSX.Element; nested?: boolean; closed?: boolean; children: JSX.Element }) {
  const open = signal(untracked(() => props.closed !== true));
  return (
    <View class={props.nested === true ? "mt-1 mb-1" : "mb-4"} accessibilityLabel={props.title} testID={`side-section-${props.item}`}>
      <View class="flex-row items-center px-1 pb-1">
        <View
          role="button"
          testID="side-section-toggle"
          accessibilityState={{ expanded: open() }}
          onPress={() => open.set(!open())}
          class="flex-1 flex-row items-center gap-1"
        >
          <View style={{ opacity: 0.6, transform: [{ rotate: open() ? "90deg" : "0deg" }] }}>
            <Icon name="expand" size={10} tone="muted" />
          </View>
          <Text class="text-xs font-semibold text-muted">{props.title}</Text>
          <Text class="text-xs text-faint">{String(props.count)}</Text>
        </View>
        {props.action}
      </View>
      <If when={open()}>
        <View class="gap-0.5">{props.children}</View>
      </If>
    </View>
  );
}

/** A channel's row being dragged onto another: dropped there, it is placed before it, in its group. */
function createReorder(place: (id: string, onto: Channel) => void) {
  const dragged = signal<string | undefined>(undefined);
  const over = signal<string | undefined>(undefined);
  const rows = new Map<string, { ref: ViewRef; channel: () => Channel }>();
  let rects: [Channel, { y: number; h: number }][] = [];
  // The pointer moves on while the rows are measured: where it is by then is what counts.
  let pointer = 0;
  const takes = (c: Channel) => c.type === "channel" && !c.default;
  const look = () => {
    const id = dragged();
    over.set(rects.find(([c, r]) => c.id !== id && takes(c) && pointer >= r.y && pointer <= r.y + r.h)?.[0].id);
  };
  return {
    dragged,
    over,
    takes,
    row: (id: string, ref: ViewRef, channel: () => Channel) => {
      rows.set(id, { ref, channel });
      cleanup(() => rows.get(id)?.ref === ref && rows.delete(id));
    },
    start: (id: string, y: number) => {
      dragged.set(id);
      pointer = y;
      rects = [];
      void Promise.all(
        [...rows.values()].map(async (row) => {
          const m = await row.ref.measure();
          return m ? ([row.channel(), { y: m.pagePosition.y, h: m.bounds.size.height }] as [Channel, { y: number; h: number }]) : undefined;
        }),
      ).then((measured) => {
        if (dragged() !== id) return;
        rects = measured.filter((r) => r !== undefined);
        look();
      });
    },
    move: (y: number) => {
      pointer = y;
      look();
    },
    end: (dropped: boolean) => {
      const id = dragged();
      const onto = rects.find(([c]) => c.id === over())?.[0];
      dragged.set(undefined);
      over.set(undefined);
      if (dropped && id !== undefined && onto) place(id, onto);
    },
  };
}

function ChannelRow(props: { channel: Channel; here: boolean; unread: number; onClick?: () => void; reorder: ReturnType<typeof createReorder> }) {
  const quiet = () => props.channel.notify === "none";
  const movable = () => props.reorder.takes(props.channel);
  const pan = PanResponder.create({
    // A press opens the channel; only a move of a few points starts a drag.
    onMoveShouldSetPanResponder: (_, g) => movable() && Math.abs(g.dx) + Math.abs(g.dy) > 4,
    onPanResponderGrant: (_, g) => props.reorder.start(props.channel.id, g.y0),
    onPanResponderMove: (_, g) => props.reorder.move(g.moveY),
    onPanResponderRelease: () => props.reorder.end(true),
    onPanResponderTerminate: () => props.reorder.end(false),
  });
  return (
    <View
      {...pan.panHandlers}
      ref={(r) => props.reorder.row(props.channel.id, r, () => props.channel)}
      tooltip={movable() ? <Bubble text={t("web.channel.manage.drag")} /> : undefined}
      role="button"
      testID={`channel-row-${props.channel.id}`}
      accessibilityLabel={channelName(props.channel)}
      accessibilityState={{ selected: props.here }}
      onPress={() => props.onClick?.()}
      class={`flex-row items-center gap-2 rounded-md px-2.5 py-1 ${props.here ? "bg-selected" : "hover:bg-hover"} ${props.reorder.dragged() === props.channel.id ? "opacity-40" : ""}`}
    >
      <If when={props.reorder.over() === props.channel.id}>
        <View testID="channel-drop-before" class="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full bg-accent" />
      </If>
      <Text class="text-sm text-faint">{markOf(props.channel)}</Text>
      <Text
        class={`min-w-0 flex-1 truncate text-sm ${props.here || props.unread > 0 ? "font-semibold" : ""} ${quiet() && !props.here ? "text-muted" : "text-ink"}`}
      >
        {channelName(props.channel)}
      </Text>
      <If when={props.channel.notify && props.channel.notify !== "all"}>
        <Text class="text-xs text-faint">{props.channel.notify === "none" ? t("web.channel.manage.muted") : t("web.channel.manage.mentionsOnly")}</Text>
      </If>
      <If when={props.unread > 0}>
        <Count n={props.unread} />
      </If>
    </View>
  );
}

function SessionRow(props: { h: SessionView; active: boolean; onShow: (c: Channel) => void }) {
  const core = useCore();
  const now = useNow();
  const thread = () => sessionThreadOf(core()?.chat, props.h);
  const unread = () => {
    const current = thread();
    return current ? unreadIn(current) : 0;
  };
  const phase = () => phaseText(props.h, now());
  return (
    <View
      role="button"
      testID={`session-row-${props.h.id}`}
      disabled={!thread()}
      onPress={() => {
        const current = thread();
        if (current) props.onShow(current);
      }}
      tooltip={<Bubble text={phase()} />}
      class={`flex-row items-center gap-2 rounded-md px-2.5 py-1 ${props.active ? "bg-selected" : "hover:bg-hover"}`}
    >
      <View class="shrink-0">
        <HelperFace agent={props.h.agent} runtime={props.h.runtime} size={24} />
        <View class="absolute -right-0.5 -bottom-0.5">
          <Dot tone={phaseDot(props.h.phase)} />
        </View>
      </View>
      <Text class="shrink-0 text-sm text-ink">{props.h.name}</Text>
      <PhaseGlyph phase={props.h.phase} />
      <Text class="min-w-0 flex-1 truncate text-xs text-muted">{phase()}</Text>
      <If when={unread() > 0}>
        <Count n={unread()} />
      </If>
    </View>
  );
}

/** The orchestrator that looks after the place open, and what it is doing. */
function OrchestratorLine(props: { agent: string }) {
  const core = useCore();
  const profile = useAgent(() => props.agent);
  const now = (): OrchestratorMood => orchestratorMood(core(), props.agent);
  const settings = useQuery(settingsQuery);
  // Listening is not a promise the orchestrator can keep without its model: then the line says what it lacks, and where that is set.
  const lacks = () => {
    const readiness = ready(settings, undefined)?.readiness.orchestrator;
    return readiness?.ready === false ? fixOf(readiness.missing) : undefined;
  };
  const clock = useNow();
  const since = () => {
    const phase = orchestratorSession(core(), props.agent)?.phase;
    return phase?._tag === "working" ? phase.since : undefined;
  };
  return (
    <View
      testID="channel-orchestrator-line"
      accessibilityLabel={t("web.channel.orchestrator")}
      class="flex-row flex-wrap items-center gap-2 border-t border-line px-4 py-3"
    >
      <OrchestratorFace size={32} agent={props.agent} />
      <Text class="shrink-0 text-sm text-ink">{profile()?.name || t("web.channel.orchestrator")}</Text>
      <If
        when={lacks()}
        else={
          <>
            <View class="ml-1">
              <Dot tone={now() === "idle" ? "idle" : now() === "thinking" ? "wheat" : "leaf"} size={8} />
            </View>
            <Text testID={`orchestrator-${now()}`} class="text-xs text-muted">
              {orchestratorMoodLabels[now()]}
            </Text>
          </>
        }
      >
        {(fix) => (
          <>
            <View class="ml-1">
              <Dot tone="berry" size={8} />
            </View>
            <Text class="min-w-0 shrink text-xs text-muted">{t("web.channel.lacks", { why: fix().words })}</Text>
            <TextLink href={fix().href} testid="orchestrator-fix">
              {t("web.channel.lacksFix")}
            </TextLink>
          </>
        )}
      </If>
      <If when={since()}>{(at) => <Text class="text-xs text-faint">{tookText(Math.max(0, clock() - at()))}</Text>}</If>
      <If when={now() === "thinking"}>
        <ThinkingDots />
      </If>
    </View>
  );
}
