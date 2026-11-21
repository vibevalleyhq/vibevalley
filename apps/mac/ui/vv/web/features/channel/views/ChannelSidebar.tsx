import { cleanup, keymap, PanResponder, Scroll, signal, Text, View, type JSX, type ViewRef } from "nsh";
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
import { Link as A, useRouter } from "../../../infra/router";
import { createAct } from "../../../ui/act";
import { OrchestratorFace } from "../../../ui/domain/Face";
import { Icon } from "../../../ui/Icon";
import { ActiveBar, Kbd, SidebarSection } from "../../../ui/layout";
import { TextLink } from "../../../ui/TextLink";
import { Bubble } from "../../../ui/Tip";
import { runsHref } from "../../session";
import { useMarkedChat } from "../model/marks";
import { archivedOf, channelName, chatPath, directsOf, groupsOf, sessionThreadOf, topsOf, unreadTotal, unreadUnder } from "../model/places";
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
      class={`${box()} shrink-0 items-center justify-center rounded-md transition duration-120 ease-out hover:bg-hover ${
        props.pressed === true ? "bg-selected" : ""
      } ${props.disabled === true ? "opacity-50" : "active:translate-y-px"}`}
    >
      <Icon name={props.icon} size={iconSize()} tone={props.pressed === true ? "ink" : "muted"} />
    </View>
  );
}

export function Sidebar(props: { channel: Channel | undefined; thread: Channel | undefined; onNew: () => void; onSearch: () => void; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const chat = useMarkedChat();
  const channels = () => topsOf(chat());
  const directs = () => directsOf(chat());
  const archived = () => archivedOf(chat());
  const sessions = () => core()?.sessions ?? [];
  const picking = signal(false);
  const go = (c: Channel) => {
    router.navigate(chatPath(c));
    props.onPick();
  };
  const act = createAct();
  const reorder = createReorder((id, onto) => void act.run(() => api.channel.update({ id, before: onto.id, category: onto.category })));
  const channelSummary = () => (chat() === core()?.chat ? core()?.channelSummary : undefined);
  const totalUnread = () => unreadTotal(chat(), channelSummary());
  const unreadOf = (c: Channel) => unreadUnder(chat(), c, channelSummary());
  const unreadSum = (list: readonly Channel[]) => list.reduce((sum, c) => sum + unreadOf(c), 0);
  const helpersUnread = () =>
    sessions().reduce((sum, h) => {
      const th = sessionThreadOf(chat(), h);
      return sum + (th ? unreadOf(th) : 0);
    }, 0);
  const row = (c: Channel) => <ChannelRow channel={c} here={c.id === props.channel?.id} unread={unreadOf(c)} onClick={() => go(c)} reorder={reorder} />;
  return (
    <View accessibilityLabel={t("web.channel.side")} testID="channels-side" class="w-full flex-1 border-r border-line bg-side">
      <View class="h-16.5 shrink-0 flex-row items-center gap-2 border-b border-line px-4">
        <Text role="header" class="min-w-0 flex-1 truncate text-xl font-semibold text-ink">
          {t("web.channel.tab.chat")}
        </Text>
        <If when={totalUnread() > 0}>
          <View testID="chat-unread-total">
            <Count n={totalUnread()} />
          </View>
        </If>
        <BarButton icon="search" size={16} testid="farm-search-open" label={t("web.channel.farmSearch.open")} onPress={() => props.onSearch()} />
      </View>
      <Scroll class="flex-1" contentClass="px-3 py-3">
        <View
          role="button"
          testID="switcher-open"
          onPress={() => switcher.show()}
          class="mb-3 h-8 w-full flex-row items-center gap-2 rounded-md border border-line bg-page px-2.5 transition duration-120 ease-out hover:bg-hover active:translate-y-px"
        >
          <Icon name="search" size={14} tone="faint" />
          <Text class="min-w-0 flex-1 truncate text-sm text-muted">{t("web.channel.switcher.open")}</Text>
          <Kbd>{keymap.label("mod+j")}</Kbd>
        </View>
        <Section
          item="channels"
          title={t("web.channel.channelsTitle")}
          count={Math.max(1, channels().length)}
          unread={unreadSum(channels())}
          action={<BarButton icon="add" size={14} compact testid="new-channel" label={t("web.channel.newChannel")} onPress={() => props.onNew()} />}
        >
          <Each of={groupsOf(channels())}>
            {(g) => (
              <If when={g().category} else={<Each of={g().channels}>{(c) => row(c())}</Each>}>
                {(name) => (
                  <Section title={name()} item={`category:${name()}`} count={g().channels.length} unread={unreadSum(g().channels)} nested>
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
          count={directs().length}
          unread={unreadSum(directs())}
          action={
            <Popover
              open={picking()}
              onOpenChange={(e) => picking.set(e.open)}
              placement="bottom"
              align="end"
              offset={4}
              popupClass="max-h-80 w-56 rounded-lg border border-line bg-elevated p-1 shadow-float"
              trigger={
                <View
                  testID="new-direct"
                  accessibilityLabel={t("web.channel.direct.add")}
                  tooltip={<Bubble text={t("web.channel.direct.add")} />}
                  class={`h-6 w-6 shrink-0 items-center justify-center rounded-md transition duration-120 ease-out hover:bg-hover active:translate-y-px ${
                    picking() ? "bg-selected" : ""
                  }`}
                >
                  <Icon name="add" size={14} tone={picking() ? "ink" : "muted"} />
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
          <Each of={directs()}>{(c) => row(c())}</Each>
        </Section>
        <Section title={t("web.channel.helpers")} item="helpers" count={sessions().length} unread={helpersUnread()}>
          <If when={sessions().length === 0}>
            <Text class="px-2 py-1 text-xs text-muted">{t("web.channel.noHelpers")}</Text>
          </If>
          <Each of={sessions()} key={(h) => h.id}>
            {(h) => <SessionRow h={h()} active={!!props.thread && sessionThreadOf(chat(), h())?.id === props.thread.id} onShow={go} />}
          </Each>
        </Section>
        <If when={archived().length > 0}>
          <Section title={t("web.channel.manage.archivedTitle")} item="archived" count={archived().length} unread={unreadSum(archived())} closed>
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

function Section(props: {
  title: string;
  item: string;
  count: number;
  unread?: number;
  action?: JSX.Element;
  nested?: boolean;
  closed?: boolean;
  children: JSX.Element;
}) {
  return (
    <SidebarSection
      title={props.title}
      count={props.count}
      collapsedBadge={
        <If when={(props.unread ?? 0) > 0}>
          <Count n={props.unread ?? 0} />
        </If>
      }
      action={props.action}
      closed={props.closed}
      testID={`side-section-${props.item}`}
      toggleTestID="side-section-toggle"
      class={props.nested === true ? "mt-1 mb-1 pl-2" : "mb-3"}
      listClass="mt-0.5 gap-0.5"
    >
      {props.children}
    </SidebarSection>
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
      class={`relative h-7 flex-row items-center gap-2 rounded-md px-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${props.here ? "bg-selected" : "hover:bg-hover"} ${
        props.reorder.dragged() === props.channel.id ? "opacity-40" : ""
      }`}
    >
      <If when={props.here}>
        <ActiveBar />
      </If>
      <If when={props.reorder.over() === props.channel.id}>
        <View testID="channel-drop-before" class="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full bg-accent" />
      </If>
      <Text class={`w-3.5 shrink-0 text-center font-mono text-sm ${props.here ? "text-muted" : "text-faint"}`}>{markOf(props.channel)}</Text>
      <Text
        class={`min-w-0 flex-1 truncate text-sm ${props.unread > 0 ? "font-semibold" : "font-medium"} ${quiet() && !props.here ? "text-muted" : "text-ink"}`}
      >
        {channelName(props.channel)}
      </Text>
      <If when={props.channel.notify && props.channel.notify !== "all"}>
        <Text class="shrink-0 text-2xs text-faint">
          {props.channel.notify === "none" ? t("web.channel.manage.muted") : t("web.channel.manage.mentionsOnly")}
        </Text>
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
    return current ? unreadUnder(core()?.chat, current, core()?.channelSummary) : 0;
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
      tooltip={<Bubble text={`${props.h.name} · ${phase()}`} />}
      class={`relative h-8 flex-row items-center gap-2 overflow-hidden rounded-md px-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${props.active ? "bg-selected" : "hover:bg-hover"}`}
    >
      <If when={props.active}>
        <ActiveBar />
      </If>
      <View class="min-w-0 flex-1 flex-row items-center gap-2">
        <View class="relative shrink-0">
          <HelperFace agent={props.h.agent} runtime={props.h.runtime} size={22} />
          <View class="absolute -right-0.5 -bottom-0.5">
            <Dot tone={phaseDot(props.h.phase)} size={6} />
          </View>
        </View>
        <Text class={`min-w-0 flex-1 truncate text-sm text-ink ${unread() > 0 ? "font-semibold" : "font-medium"}`}>{props.h.name}</Text>
      </View>
      <View class="min-w-0 shrink flex-row items-center gap-1.5 pr-1.5">
        <View class="min-w-0 max-w-24 flex-row items-center gap-1 overflow-hidden">
          <PhaseGlyph phase={props.h.phase} size={12} />
          <Text class="min-w-0 shrink truncate text-2xs text-muted">{phase()}</Text>
        </View>
        <If when={unread() > 0}>
          <Count n={unread()} />
        </If>
      </View>
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
  const dotTone = () => (lacks() ? "berry" : now() === "idle" ? "idle" : now() === "thinking" ? "wheat" : "leaf");
  return (
    <View
      testID="channel-orchestrator-line"
      accessibilityLabel={t("web.channel.orchestrator")}
      class="flex-row items-center gap-2 border-t border-line px-2 py-1.5"
    >
      <A
        href={runsHref({ session: props.agent })}
        testID="channel-orchestrator-runs"
        accessibilityLabel={t("web.channel.orchestratorRuns")}
        tooltip={<Bubble text={t("web.channel.orchestratorRuns")} />}
        class="group min-w-0 flex-1 flex-row items-center gap-2.5 rounded-md px-1.5 py-1 transition duration-120 ease-out hover:bg-hover active:translate-y-px"
      >
        <View class="relative shrink-0">
          <OrchestratorFace size={32} agent={props.agent} />
          <View class="absolute -right-0.5 -bottom-0.5">
            <Dot tone={dotTone()} size={7} />
          </View>
        </View>
        <View class="min-w-0 flex-1 gap-0.5">
          <View class="flex-row items-center gap-1.5">
            <Text class="min-w-0 truncate text-sm font-semibold text-ink">{profile()?.name || t("web.channel.orchestrator")}</Text>
            <If when={since()}>{(at) => <Text class="shrink-0 font-mono text-2xs text-faint">{tookText(Math.max(0, clock() - at()))}</Text>}</If>
          </View>
          <View class="flex-row items-center gap-1.5">
            <If
              when={lacks()}
              else={
                <>
                  <Text testID={`orchestrator-${now()}`} class="min-w-0 truncate text-xs text-muted">
                    {orchestratorMoodLabels[now()]}
                  </Text>
                  <If when={now() === "thinking"}>
                    <ThinkingDots />
                  </If>
                </>
              }
            >
              {(fix) => <Text class="min-w-0 flex-1 truncate text-xs text-berry">{t("web.channel.lacks", { why: fix().words })}</Text>}
            </If>
          </View>
        </View>
        <If when={!lacks()}>
          <Icon name="log" size={14} tone="faint" />
        </If>
      </A>
      <If when={lacks()}>
        {(fix) => (
          <View class="shrink-0 pr-1.5">
            <TextLink href={fix().href} testid="orchestrator-fix">
              {t("web.channel.lacksFix")}
            </TextLink>
          </View>
        )}
      </If>
    </View>
  );
}
