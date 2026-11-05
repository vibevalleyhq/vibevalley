import type { JSX } from "@solidjs/web";
import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Channel, defaultOrchestrator, type SessionView } from "@vibevalley/protocol";

import { aria, useNow } from "#/base/dom.tsx";
import { tookText } from "#/base/format.ts";
import { useAgent } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { orchestratorMood, orchestratorSession, type OrchestratorMood, useCore } from "#/infra/frame.ts";
import { ready, useAgents } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { OrchestratorFace } from "#/ui/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";

import { useMarkedChat } from "./marks";
import {
  archivedOf,
  channelName,
  chatPath,
  directsOf,
  groupsOf,
  sessionThreadOf,
  topsOf,
  unreadIn,
  unreadUnder,
} from "./places";
import { Count, Dot, HelperFace, PhaseGlyph, ThinkingDots, phaseDot, phaseText } from "./presence";
import { switcher } from "./QuickSwitcher";

export const channelHeadClass = "flex h-[66px] shrink-0 items-center border-b border-line";

export const channelIconButtonClass =
  "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-hover disabled:cursor-default disabled:opacity-50";

export const markOf = (c: Channel | undefined) => (c?.type === "direct" ? "@" : "#");

export const orchestratorMoodLabels: Record<OrchestratorMood, string> = {
  idle: t("web.channel.mood.idle"),
  listening: t("web.channel.mood.listening"),
  thinking: t("web.channel.mood.thinking"),
  speaking: t("web.channel.mood.speaking"),
};

export function Sidebar(props: { channel: Channel | undefined; thread: Channel | undefined; onNew: () => void; onSearch: () => void; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const chat = useMarkedChat();
  const act = createAct();
  const channels = () => topsOf(chat());
  const archived = () => archivedOf(chat());
  const sessions = () => core()?.sessions ?? [];
  const [picking, setPicking] = createSignal(false);
  const [dragged, setDragged] = createSignal<string>();
  const go = (c: Channel) => {
    router.navigate(chatPath(c));
    props.onPick();
  };
  // Dropped on a channel: placed before it, in its group.
  const drop = (onto: Channel) => {
    const id = dragged();
    setDragged(undefined);
    if (!id || id === onto.id || onto.default || onto.type !== "channel") return;
    void act.run(() => api.channel.update({ id, before: onto.id, category: onto.category }));
  };
  const row = (c: Channel) => (
    <ChannelRow
      channel={c}
      here={c.id === props.channel?.id}
      unread={unreadUnder(chat(), c)}
      onClick={() => go(c)}
      movable={c.type === "channel" && !c.default}
      onDragStart={() => setDragged(c.id)}
      onDragEnd={() => setDragged(undefined)}
      onDrop={() => drop(c)}
    />
  );
  return (
    <aside aria-label={t("web.channel.side")} data-testid="channels-side" class="flex w-full flex-col border-r border-line bg-side">
      <div class={[channelHeadClass, "gap-2 px-5"]}>
        <span class="flex-1 text-xl font-semibold">{t("web.channel.tab.chat")}</span>
        <button
          type="button"
          class={channelIconButtonClass}
          data-testid="farm-search-open"
          aria-label={t("web.channel.farmSearch.open")}
          title={t("web.channel.farmSearch.open")}
          onClick={() => props.onSearch()}
        >
          <Icon name="search" size={16} />
        </button>
      </div>
      <div class="flex-1 scroll-fade-y overflow-y-auto p-3">
        <button
          type="button"
          data-testid="switcher-open"
          onClick={() => switcher.show()}
          class="mb-3 flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-line bg-page px-2.5 text-left text-sm text-muted hover:bg-hover"
        >
          <span class="flex-1">{t("web.channel.switcher.open")}</span>
          <span class="text-xs text-faint">{t("web.channel.switcher.keys", { mac: /Mac|iPhone|iPad/u.test(navigator.userAgent) })}</span>
        </button>
        <Section
          item="channels"
          title={t("web.channel.channelsTitle")}
          count={Math.max(1, channels().length)}
          action={
            <button
              type="button"
              class={[channelIconButtonClass, "size-6"]}
              data-testid="new-channel"
              aria-label={t("web.channel.newChannel")}
              title={t("web.channel.newChannel")}
              onClick={() => props.onNew()}
            >
              <Icon name="add" size={14} />
            </button>
          }
        >
          <For each={groupsOf(channels())}>
            {(g) => (
              <Show when={g.category} fallback={<For each={g.channels}>{row}</For>}>
                {(name) => (
                  <Section title={name()} item={`category:${name()}`} count={g.channels.length} nested>
                    <For each={g.channels}>{row}</For>
                  </Section>
                )}
              </Show>
            )}
          </For>
        </Section>
        <Section
          item="directs"
          title={t("web.channel.directsTitle")}
          count={directsOf(chat()).length}
          action={
            <div class="relative">
              <button
                type="button"
                class={[channelIconButtonClass, "size-6"]}
                data-testid="new-direct"
                aria-label={t("web.channel.direct.add")}
                title={t("web.channel.direct.add")}
                aria-expanded={aria(picking())}
                onClick={() => setPicking(!picking())}
              >
                <Icon name="add" size={14} />
              </button>
              <Show when={picking()}>
                <DirectPicker
                  onPicked={(id) => {
                    setPicking(false);
                    router.navigate(`/chat/${id}`);
                    props.onPick();
                  }}
                />
              </Show>
            </div>
          }
        >
          <For each={directsOf(chat())}>{row}</For>
        </Section>
        <Section title={t("web.channel.helpers")} item="helpers" count={sessions().length}>
          <Show when={sessions().length === 0}>
            <p class="px-3 text-xs text-muted">{t("web.channel.noHelpers")}</p>
          </Show>
          <For each={sessions()}>{(h) => <SessionRow h={h} active={!!props.thread && sessionThreadOf(chat(), h)?.id === props.thread.id} onShow={go} />}</For>
        </Section>
        <Show when={archived().length > 0}>
          <Section title={t("web.channel.manage.archivedTitle")} item="archived" count={archived().length} closed>
            <For each={archived()}>{row}</For>
          </Section>
        </Show>
      </div>
      <OrchestratorLine agent={(props.thread ?? props.channel)?.orchestrator ?? defaultOrchestrator} />
    </aside>
  );
}

/** The profiles the owner can talk with alone, the orchestrators first: picking one opens its direct channel, made the
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
    <div
      role="menu"
      data-testid="direct-picker"
      aria-label={t("web.channel.direct.pick")}
      class="absolute top-full right-0 z-30 mt-1 flex max-h-80 w-56 origin-top-right animate-pop-in flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-page p-1 shadow-float"
    >
      <p class="px-2 py-1 text-xs font-semibold text-muted">{t("web.channel.direct.pick")}</p>
      <Show when={!all.isPending && agents().length === 0}>
        <p class="px-2 py-1 text-sm text-muted">{t("web.channel.direct.none")}</p>
      </Show>
      <For each={agents()} keyed={(a) => a.id}>
        {(a) => (
          <button
            type="button"
            role="menuitem"
            data-key={a().id}
            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-hover"
            onClick={() => void open(a().id)}
          >
            <Show when={a().role === "orchestrator"} fallback={<HelperFace agent={a().id} runtime={a().runtime} size={20} />}>
              <OrchestratorFace size={20} agent={a().id} />
            </Show>
            <span class="min-w-0 flex-1 truncate">{a().name}</span>
          </button>
        )}
      </For>
    </div>
  );
}

function Section(props: { title: string; item: string; count: number; action?: JSX.Element; nested?: boolean; closed?: boolean; children: JSX.Element }) {
  const [open, setOpen] = createSignal(untrack(() => props.closed !== true));
  return (
    <section class={props.nested === true ? "mt-1 mb-1" : "mb-4"} aria-label={props.title} data-testid="side-section" data-key={props.item}>
      <div class="flex items-center px-1 pb-1">
        <button
          type="button"
          data-testid="side-section-toggle"
          aria-expanded={aria(open())}
          onClick={() => setOpen(!open())}
          class="flex flex-1 cursor-pointer items-center gap-1 text-left"
        >
          <Icon name="expand" size={10} class={["opacity-60 transition-transform duration-120", { "rotate-90": open() }]} />
          <span class="text-xs font-semibold text-muted">{props.title}</span>
          <span class="text-xs text-faint">{props.count}</span>
        </button>
        {props.action}
      </div>
      <Show when={open()}>
        <div class="flex flex-col gap-0.5">{props.children}</div>
      </Show>
    </section>
  );
}

function ChannelRow(props: {
  channel: Channel;
  here: boolean;
  unread: number;
  onClick?: () => void;
  movable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDrop?: () => void;
}) {
  const [over, setOver] = createSignal(false);
  const quiet = () => props.channel.notify === "none";
  return (
    <button
      type="button"
      data-testid="channel-row"
      data-key={props.channel.id}
      data-type={props.channel.type}
      data-unread={props.unread}
      data-notify={props.channel.notify ?? "all"}
      onClick={() => props.onClick?.()}
      aria-current={props.here ? "page" : undefined}
      draggable={props.movable === true ? "true" : "false"}
      title={props.movable === true ? t("web.channel.manage.drag") : undefined}
      onDragStart={(e) => {
        e.dataTransfer?.setData("text/plain", props.channel.id);
        untrack(() => props.onDragStart)?.();
      }}
      onDragEnd={() => untrack(() => props.onDragEnd)?.()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        untrack(() => props.onDrop)?.();
      }}
      class={[
        "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm",
        props.here ? "bg-selected" : "hover:bg-hover",
        { "shadow-[inset_0_2px_0_var(--color-accent)]": over() },
      ]}
    >
      <span class="text-faint" aria-hidden="true">
        {markOf(props.channel)}
      </span>
      <span class={["min-w-0 flex-1 truncate", { "font-semibold": props.here || props.unread > 0, "text-muted": quiet() && !props.here }]}>
        {channelName(props.channel)}
      </span>
      <Show when={props.channel.notify && props.channel.notify !== "all"}>
        <span class="text-xs text-faint">{props.channel.notify === "none" ? t("web.channel.manage.muted") : t("web.channel.manage.mentionsOnly")}</span>
      </Show>
      <Show when={props.unread > 0}>
        <Count n={props.unread} />
      </Show>
    </button>
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
    <button
      type="button"
      disabled={!thread()}
      onClick={() => {
        const current = thread();
        if (current) props.onShow(current);
      }}
      title={phase()}
      class={["flex items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm enabled:cursor-pointer", props.active ? "bg-selected" : "hover:bg-hover"]}
    >
      <span class="relative shrink-0">
        <HelperFace agent={props.h.agent} runtime={props.h.runtime} size={24} />
        <Dot tone={phaseDot(props.h.phase)} class="absolute -right-0.5 -bottom-0.5" />
      </span>
      <span class="shrink-0">{props.h.name}</span>
      <PhaseGlyph phase={props.h.phase} />
      <span class="min-w-0 flex-1 truncate text-xs text-muted">{phase()}</span>
      <Show when={unread() > 0}>
        <Count n={unread()} />
      </Show>
    </button>
  );
}

/** The orchestrator that looks after the place open, and what it is doing. */
function OrchestratorLine(props: { agent: string }) {
  const core = useCore();
  const profile = useAgent(() => props.agent);
  const now = (): OrchestratorMood => orchestratorMood(core(), props.agent);
  const clock = useNow();
  const since = () => {
    const phase = orchestratorSession(core(), props.agent)?.phase;
    return phase?._tag === "working" ? phase.since : undefined;
  };
  return (
    <div
      data-testid="channel-orchestrator-line"
      data-key={props.agent}
      data-state={now()}
      class="flex items-center gap-2 border-t border-line px-4 py-3 text-sm"
      aria-label={t("web.channel.orchestrator")}
    >
      <OrchestratorFace size={32} agent={props.agent} />
      {profile()?.name || t("web.channel.orchestrator")}
      <Dot tone={now() === "idle" ? "idle" : now() === "thinking" ? "wheat" : "leaf"} size={8} class="ml-1" />
      <span class="text-xs text-muted">{orchestratorMoodLabels[now()]}</span>
      <Show when={since()}>{(at) => <span class="text-xs text-faint">{tookText(Math.max(0, clock() - at()))}</span>}</Show>
      <Show when={now() === "thinking"}>
        <ThinkingDots />
      </Show>
    </div>
  );
}
