import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
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
import { archivedOf, channelName, chatPath, directsOf, groupsOf, sessionThreadOf, topsOf, unreadIn, unreadUnder } from "./places";
import { Count, Dot, HelperFace, PhaseGlyph, ThinkingDots, phaseDot, phaseText } from "./presence";
import { switcher } from "./QuickSwitcher";

const recipeStyles = stylex.create({
  sidebarDiv: {
    display: "flex",
    height: "66px",
    flexShrink: "0",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--wb-line)",
    paddingInline: "calc(var(--spacing) * 5)",
  },
  sidebarButton: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  channelRowButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "var(--spacing)",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  channelRowButtonVariant1Case1: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  channelRowButtonVariant1Case2: {
    backgroundColor: "var(--wb-selected)",
  },
  channelRowButtonVariant2Case1: {
    boxShadow: null,
  },
  channelRowButtonVariant2Case2: {
    boxShadow: "0 0 transparent, 0 0 transparent, 0 0 transparent, 0 0 transparent, inset 0 2px 0 var(--color-accent)",
  },
  channelRowSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  channelRowSpanVariant1Case1: {
    fontWeight: null,
  },
  channelRowSpanVariant1Case2: {
    fontWeight: "var(--font-weight-semibold)",
  },
  channelRowSpanVariant2Case1: {
    color: null,
  },
  channelRowSpanVariant2Case2: {
    color: "var(--wb-muted)",
  },
});

const variantStyles2 = stylex.create({
  sectionIcon: {
    opacity: ".6",
    transitionProperty: "transform,translate,scale,rotate",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
  },
  sectionIconVariant: {
    rotate: "90deg",
  },
  sectionIconVariant2: {},
});

const variantStyles = stylex.create({
  sectionSection: {},
  sectionSectionVariant: {
    marginTop: "var(--spacing)",
    marginBottom: "var(--spacing)",
  },
  sectionSectionVariant2: {
    marginBottom: "calc(var(--spacing) * 4)",
  },
});

const viewStyles = stylex.create({
  helperDot: { position: "absolute", right: "calc(var(--spacing) * -0.5)", bottom: "calc(var(--spacing) * -0.5)" },
  typingDot: { marginLeft: "var(--spacing)" },
  channelsSide: {
    display: "flex",
    width: "100%",
    flexDirection: "column",
    borderRightStyle: "solid",
    borderRightWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-side)",
  },
  sidebarSpan: {
    flex: "1",
    fontSize: "var(--text-xl)",
    lineHeight: "var(--text-xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  switcherOpen: {
    marginBottom: "calc(var(--spacing) * 3)",
    display: "flex",
    height: "calc(var(--spacing) * 8)",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: {
      default: "var(--wb-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 2.5)",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  sidebarSpan2: {
    flex: "1",
  },
  sidebarSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
  },
  sidebarDiv: {
    position: "relative",
  },
  sidebarP: {
    paddingInline: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  directPickerP: {
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-muted)",
  },
  directPickerP2: {
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-muted)",
  },
  directPickerButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  directPickerSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  sectionDiv: {
    display: "flex",
    alignItems: "center",
    paddingInline: "var(--spacing)",
    paddingBottom: "var(--spacing)",
  },
  sideSectionToggle: {
    display: "flex",
    flex: "1",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    textAlign: "left",
  },
  sectionSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-muted)",
  },
  sectionDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  channelRowSpan: {
    color: "var(--wb-faint)",
  },
  sessionRowSpan: {
    position: "relative",
    flexShrink: "0",
  },
  sessionRowSpan2: {
    flexShrink: "0",
  },
  sessionRowSpan3: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  channelOrchestratorLine: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--wb-line)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  orchestratorLineSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
});

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
    <aside aria-label={t("web.channel.side")} data-testid="channels-side" {...stylex.attrs(viewStyles.channelsSide)}>
      <div {...stylex.attrs(recipeStyles.sidebarDiv)}>
        <span {...stylex.attrs(viewStyles.sidebarSpan)}>{t("web.channel.tab.chat")}</span>
        <button
          type="button"
          {...stylex.attrs(recipeStyles.sidebarButton)}
          data-testid="farm-search-open"
          aria-label={t("web.channel.farmSearch.open")}
          title={t("web.channel.farmSearch.open")}
          onClick={() => props.onSearch()}
        >
          <Icon name="search" size={16} />
        </button>
      </div>
      <div class="flex-1 scroll-fade-y overflow-y-auto p-3">
        <button type="button" data-testid="switcher-open" onClick={() => switcher.show()} {...stylex.attrs(viewStyles.switcherOpen)}>
          <span {...stylex.attrs(viewStyles.sidebarSpan2)}>{t("web.channel.switcher.open")}</span>
          <span {...stylex.attrs(viewStyles.sidebarSpan3)}>{t("web.channel.switcher.keys", { mac: /Mac|iPhone|iPad/u.test(navigator.userAgent) })}</span>
        </button>
        <Section
          item="channels"
          title={t("web.channel.channelsTitle")}
          count={Math.max(1, channels().length)}
          action={
            <button
              type="button"
              {...stylex.attrs(recipeStyles.sidebarButton)}
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
            <div {...stylex.attrs(viewStyles.sidebarDiv)}>
              <button
                type="button"
                {...stylex.attrs(recipeStyles.sidebarButton)}
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
            <p {...stylex.attrs(viewStyles.sidebarP)}>{t("web.channel.noHelpers")}</p>
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
      <p {...stylex.attrs(viewStyles.directPickerP)}>{t("web.channel.direct.pick")}</p>
      <Show when={all.status() === "success" && agents().length === 0}>
        <p {...stylex.attrs(viewStyles.directPickerP2)}>{t("web.channel.direct.none")}</p>
      </Show>
      <For each={agents()} keyed={(a) => a.id}>
        {(a) => (
          <button type="button" role="menuitem" data-key={a().id} {...stylex.attrs(viewStyles.directPickerButton)} onClick={() => void open(a().id)}>
            <Show when={a().role === "orchestrator"} fallback={<HelperFace agent={a().id} runtime={a().runtime} size={20} />}>
              <OrchestratorFace size={20} agent={a().id} />
            </Show>
            <span {...stylex.attrs(viewStyles.directPickerSpan)}>{a().name}</span>
          </button>
        )}
      </For>
    </div>
  );
}

function Section(props: { title: string; item: string; count: number; action?: JSX.Element; nested?: boolean; closed?: boolean; children: JSX.Element }) {
  const [open, setOpen] = createSignal(untrack(() => props.closed !== true));
  return (
    <section
      {...stylex.attrs(variantStyles.sectionSection, props.nested === true ? variantStyles.sectionSectionVariant : variantStyles.sectionSectionVariant2)}
      aria-label={props.title}
      data-testid="side-section"
      data-key={props.item}
    >
      <div {...stylex.attrs(viewStyles.sectionDiv)}>
        <button
          type="button"
          data-testid="side-section-toggle"
          aria-expanded={aria(open())}
          onClick={() => setOpen(!open())}
          {...stylex.attrs(viewStyles.sideSectionToggle)}
        >
          <Icon
            name="expand"
            size={10}
            styles={[variantStyles2.sectionIcon, open() ? variantStyles2.sectionIconVariant : variantStyles2.sectionIconVariant2]}
          />
          <span {...stylex.attrs(viewStyles.sectionSpan)}>{props.title}</span>
          <span {...stylex.attrs(viewStyles.sidebarSpan3)}>{props.count}</span>
        </button>
        {props.action}
      </div>
      <Show when={open()}>
        <div {...stylex.attrs(viewStyles.sectionDiv2)}>{props.children}</div>
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
      {...stylex.attrs(
        recipeStyles.channelRowButton,
        props.here ? recipeStyles.channelRowButtonVariant1Case2 : recipeStyles.channelRowButtonVariant1Case1,
        over() ? recipeStyles.channelRowButtonVariant2Case2 : recipeStyles.channelRowButtonVariant2Case1,
      )}
    >
      <span {...stylex.attrs(viewStyles.channelRowSpan)} aria-hidden="true">
        {markOf(props.channel)}
      </span>
      <span
        {...stylex.attrs(
          recipeStyles.channelRowSpan,
          props.here || props.unread > 0 ? recipeStyles.channelRowSpanVariant1Case2 : recipeStyles.channelRowSpanVariant1Case1,
          quiet() && !props.here ? recipeStyles.channelRowSpanVariant2Case2 : recipeStyles.channelRowSpanVariant2Case1,
        )}
      >
        {channelName(props.channel)}
      </span>
      <Show when={props.channel.notify && props.channel.notify !== "all"}>
        <span {...stylex.attrs(viewStyles.sidebarSpan3)}>
          {props.channel.notify === "none" ? t("web.channel.manage.muted") : t("web.channel.manage.mentionsOnly")}
        </span>
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
      <span {...stylex.attrs(viewStyles.sessionRowSpan)}>
        <HelperFace agent={props.h.agent} runtime={props.h.runtime} size={24} />
        <Dot tone={phaseDot(props.h.phase)} styles={viewStyles.helperDot} />
      </span>
      <span {...stylex.attrs(viewStyles.sessionRowSpan2)}>{props.h.name}</span>
      <PhaseGlyph phase={props.h.phase} />
      <span {...stylex.attrs(viewStyles.sessionRowSpan3)}>{phase()}</span>
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
      {...stylex.attrs(viewStyles.channelOrchestratorLine)}
      aria-label={t("web.channel.orchestrator")}
    >
      <OrchestratorFace size={32} agent={props.agent} />
      {profile()?.name || t("web.channel.orchestrator")}
      <Dot tone={now() === "idle" ? "idle" : now() === "thinking" ? "wheat" : "leaf"} size={8} styles={viewStyles.typingDot} />
      <span {...stylex.attrs(viewStyles.orchestratorLineSpan)}>{orchestratorMoodLabels[now()]}</span>
      <Show when={since()}>{(at) => <span {...stylex.attrs(viewStyles.sidebarSpan3)}>{tookText(Math.max(0, clock() - at()))}</span>}</Show>
      <Show when={now() === "thinking"}>
        <ThinkingDots />
      </Show>
    </div>
  );
}
