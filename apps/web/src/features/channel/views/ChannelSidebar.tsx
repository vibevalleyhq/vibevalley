import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Channel, defaultOrchestrator, type SessionView } from "@vibevalley/protocol";

import { aria, useNow } from "#/base/dom.tsx";
import { tookText } from "#/base/format.ts";
import { useMarkedChat } from "#/features/channel/model/marks.ts";
import { archivedOf, channelName, chatPath, directsOf, groupsOf, sessionThreadOf, topsOf, unreadIn, unreadUnder } from "#/features/channel/model/places.ts";
import { useAgent } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { orchestratorMood, orchestratorSession, type OrchestratorMood, useCore } from "#/infra/frame.ts";
import { ready, useAgents } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { createAct } from "#/ui/act.ts";
import { OrchestratorFace } from "#/ui/domain/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";

import { Count, Dot, HelperFace, PhaseGlyph, ThinkingDots, phaseDot, phaseText } from "./presence";
import { switcher } from "./QuickSwitcher";

const popIn = stylex.keyframes({
  from: { opacity: 0, scale: 0.98 },
});

const styles = stylex.create({
  sidebarDiv: {
    flex: "1",
    WebkitMaskImage: "linear-gradient(to bottom, transparent, black var(--fade-top), black calc(100% - var(--fade-bottom)), transparent)",
    maskImage: "linear-gradient(to bottom, transparent, black var(--fade-top), black calc(100% - var(--fade-bottom)), transparent)",
    animationName: "scroll-fade-y",
    animationDuration: "0s",
    animationTimingFunction: "linear",
    animationFillMode: "both",
    animationTimeline: "scroll(self y)",
    overflowY: "auto",
    padding: "0.75rem",
  },
  directPickerDiv: {
    position: "absolute",
    top: "100%",
    right: "0",
    zIndex: 30,
    marginTop: "0.25rem",
    display: "flex",
    maxHeight: "20rem",
    width: "14rem",
    transformOrigin: "100% 0",
    animationName: { default: popIn, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "280ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    flexDirection: "column",
    gap: "0.125rem",
    overflowY: "auto",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    padding: "0.25rem",
    boxShadow: "var(--shadow-float)",
  },
  sessionRowButton: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.625rem",
    paddingBlock: "0.25rem",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    cursor: {
      default: null,
      ":enabled": "pointer",
    },
  },
  sessionRowButtonPrimary: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  sessionRowButtonSecondary: {
    backgroundColor: "var(--wb-selected)",
  },
  sidebarDiv2: {
    display: "flex",
    height: "66px",
    flexShrink: "0",
    alignItems: "center",
    gap: "0.5rem",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "1.25rem",
  },
  sidebarButton: {
    display: "inline-flex",
    width: "2rem",
    height: "2rem",
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
        ":hover": "var(--color-hover)",
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
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.625rem",
    paddingBlock: "0.25rem",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  channelRowButtonPrimary: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  channelRowButtonSecondary: {
    backgroundColor: "var(--color-selected)",
  },
  channelRowButtonStateA: {
    boxShadow: null,
  },
  channelRowButtonStateB: {
    boxShadow: "inset 0 2px 0 var(--color-accent)",
  },
  channelRowSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  channelRowSpanPrimary: {
    fontWeight: null,
  },
  channelRowSpanSecondary: {
    fontWeight: "var(--font-weight-semibold)",
  },
  channelRowSpanStateA: {
    color: null,
  },
  channelRowSpanStateB: {
    color: "var(--color-muted)",
  },
  sectionIcon: {
    opacity: ".6",
    transitionProperty: "rotate",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "120ms",
  },
  sectionIconTone: {
    rotate: "90deg",
  },
  sectionIconAlt: {},
  sectionSection: {},
  sectionSectionTone: {
    marginTop: "0.25rem",
    marginBottom: "0.25rem",
  },
  sectionSectionAlt: {
    marginBottom: "1rem",
  },
  helperDot: { position: "absolute", right: "-0.125rem", bottom: "-0.125rem" },
  typingDot: { marginLeft: "0.25rem" },
  channelsSide: {
    display: "flex",
    width: "100%",
    flexDirection: "column",
    borderRightStyle: "solid",
    borderRightWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
  },
  sidebarSpan: {
    flex: "1",
    fontSize: "var(--text-xl)",
    lineHeight: "var(--leading-xl)",
    fontWeight: "var(--font-weight-semibold)",
  },
  switcherOpen: {
    marginBottom: "0.75rem",
    display: "flex",
    height: "2rem",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: "var(--color-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
    paddingInline: "0.625rem",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  sidebarSpan2: {
    flex: "1",
  },
  sidebarSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  sidebarDiv3: {
    position: "relative",
  },
  sidebarP: {
    paddingInline: "0.75rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  directPickerP: {
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  directPickerP2: {
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  directPickerButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
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
    paddingInline: "0.25rem",
    paddingBottom: "0.25rem",
  },
  sideSectionToggle: {
    display: "flex",
    flex: "1",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.25rem",
    textAlign: "left",
  },
  sectionSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  sectionDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "0.125rem",
  },
  channelRowSpan2: {
    color: "var(--color-faint)",
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
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  channelOrchestratorLine: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "1rem",
    paddingBlock: "0.75rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  orchestratorLineSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
});

const channelStyles = stylex.create({
  iconButton: {
    display: "inline-flex",
    width: "2rem",
    height: "2rem",
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
});

export const channelIconButtonStyles = channelStyles.iconButton;

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
    <aside aria-label={t("web.channel.side")} data-testid="channels-side" {...stylex.attrs(styles.channelsSide)}>
      <div {...stylex.attrs(styles.sidebarDiv2)}>
        <span {...stylex.attrs(styles.sidebarSpan)}>{t("web.channel.tab.chat")}</span>
        <button
          type="button"
          {...stylex.attrs(styles.sidebarButton)}
          data-testid="farm-search-open"
          aria-label={t("web.channel.farmSearch.open")}
          title={t("web.channel.farmSearch.open")}
          onClick={() => props.onSearch()}
        >
          <Icon name="search" size={16} />
        </button>
      </div>
      <div {...stylex.attrs(styles.sidebarDiv)}>
        <button type="button" data-testid="switcher-open" onClick={() => switcher.show()} {...stylex.attrs(styles.switcherOpen)}>
          <span {...stylex.attrs(styles.sidebarSpan2)}>{t("web.channel.switcher.open")}</span>
          <span {...stylex.attrs(styles.sidebarSpan3)}>{t("web.channel.switcher.keys", { mac: /Mac|iPhone|iPad/u.test(navigator.userAgent) })}</span>
        </button>
        <Section
          item="channels"
          title={t("web.channel.channelsTitle")}
          count={Math.max(1, channels().length)}
          action={
            <button
              type="button"
              {...stylex.attrs(styles.sidebarButton)}
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
            <div {...stylex.attrs(styles.sidebarDiv3)}>
              <button
                type="button"
                {...stylex.attrs(styles.sidebarButton)}
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
            <p {...stylex.attrs(styles.sidebarP)}>{t("web.channel.noHelpers")}</p>
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
    <div role="menu" data-testid="direct-picker" aria-label={t("web.channel.direct.pick")} {...stylex.attrs(styles.directPickerDiv)}>
      <p {...stylex.attrs(styles.directPickerP)}>{t("web.channel.direct.pick")}</p>
      <Show when={all.status() === "success" && agents().length === 0}>
        <p {...stylex.attrs(styles.directPickerP2)}>{t("web.channel.direct.none")}</p>
      </Show>
      <For each={agents()} keyed={(a) => a.id}>
        {(a) => (
          <button type="button" role="menuitem" data-key={a().id} {...stylex.attrs(styles.directPickerButton)} onClick={() => void open(a().id)}>
            <Show when={a().role === "orchestrator"} fallback={<HelperFace agent={a().id} runtime={a().runtime} size={20} />}>
              <OrchestratorFace size={20} agent={a().id} />
            </Show>
            <span {...stylex.attrs(styles.directPickerSpan)}>{a().name}</span>
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
      {...stylex.attrs(styles.sectionSection, props.nested === true ? styles.sectionSectionTone : styles.sectionSectionAlt)}
      aria-label={props.title}
      data-testid="side-section"
      data-key={props.item}
    >
      <div {...stylex.attrs(styles.sectionDiv)}>
        <button
          type="button"
          data-testid="side-section-toggle"
          aria-expanded={aria(open())}
          onClick={() => setOpen(!open())}
          {...stylex.attrs(styles.sideSectionToggle)}
        >
          <Icon name="expand" size={10} styles={[styles.sectionIcon, open() ? styles.sectionIconTone : styles.sectionIconAlt]} />
          <span {...stylex.attrs(styles.sectionSpan)}>{props.title}</span>
          <span {...stylex.attrs(styles.sidebarSpan3)}>{props.count}</span>
        </button>
        {props.action}
      </div>
      <Show when={open()}>
        <div {...stylex.attrs(styles.sectionDiv2)}>{props.children}</div>
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
        styles.channelRowButton,
        props.here ? styles.channelRowButtonSecondary : styles.channelRowButtonPrimary,
        over() ? styles.channelRowButtonStateB : styles.channelRowButtonStateA,
      )}
    >
      <span {...stylex.attrs(styles.channelRowSpan2)} aria-hidden="true">
        {markOf(props.channel)}
      </span>
      <span
        {...stylex.attrs(
          styles.channelRowSpan,
          props.here || props.unread > 0 ? styles.channelRowSpanSecondary : styles.channelRowSpanPrimary,
          quiet() && !props.here ? styles.channelRowSpanStateB : styles.channelRowSpanStateA,
        )}
      >
        {channelName(props.channel)}
      </span>
      <Show when={props.channel.notify && props.channel.notify !== "all"}>
        <span {...stylex.attrs(styles.sidebarSpan3)}>
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
      {...stylex.attrs(styles.sessionRowButton, props.active ? styles.sessionRowButtonSecondary : styles.sessionRowButtonPrimary)}
    >
      <span {...stylex.attrs(styles.sessionRowSpan)}>
        <HelperFace agent={props.h.agent} runtime={props.h.runtime} size={24} />
        <Dot tone={phaseDot(props.h.phase)} styles={styles.helperDot} />
      </span>
      <span {...stylex.attrs(styles.sessionRowSpan2)}>{props.h.name}</span>
      <PhaseGlyph phase={props.h.phase} />
      <span {...stylex.attrs(styles.sessionRowSpan3)}>{phase()}</span>
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
      {...stylex.attrs(styles.channelOrchestratorLine)}
      aria-label={t("web.channel.orchestrator")}
    >
      <OrchestratorFace size={32} agent={props.agent} />
      {profile()?.name || t("web.channel.orchestrator")}
      <Dot tone={now() === "idle" ? "idle" : now() === "thinking" ? "wheat" : "leaf"} size={8} styles={styles.typingDot} />
      <span {...stylex.attrs(styles.orchestratorLineSpan)}>{orchestratorMoodLabels[now()]}</span>
      <Show when={since()}>{(at) => <span {...stylex.attrs(styles.sidebarSpan3)}>{tookText(Math.max(0, clock() - at()))}</span>}</Show>
      <Show when={now() === "thinking"}>
        <ThinkingDots />
      </Show>
    </div>
  );
}
