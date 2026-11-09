import * as stylex from "@stylexjs/stylex";
import { Array as Arr } from "effect";
import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Channel, type ChatMessage, type MessageHit, ownerId } from "@vibevalley/protocol";
import { channelOf, defaultOf } from "@vibevalley/protocol/rules";

import { aria, autofocus, useNow } from "#/base/dom.tsx";
import { useOrchestrators } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { orchestratorMood, useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { useLatest } from "#/state/atom.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { Dialog } from "#/ui/Dialog.tsx";
import { OrchestratorFace } from "#/ui/Face.tsx";
import { Select } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { styleProps } from "#/ui/positioner.ts";
import { toast } from "#/ui/toasts.ts";

import { channelIconButtonStyles, orchestratorMoodLabels } from "./ChannelSidebar";
import { Composer, FileDrop } from "./Composer";
import { notifyOptions } from "./Dialogs";
import { archiveSet, markState, notifySet, sameMessage, setMark, useMarkedChat } from "./marks";
import { threadItem } from "./message.stylex";
import { MessageList } from "./MessageList";
import { chatPath, messagePath, threadOwnerOf, threadsIn, threadTitle, workbenchClock } from "./places";
import { HelperFace, PhaseGlyph, phaseText } from "./presence";

const threadStyles = stylex.create({
  thread: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-md)",
    paddingInline: "var(--spacing)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  action: {
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    opacity: {
      default: "0",
      ":focus-visible": "1",
      "@media (hover: hover)": {
        default: null,
        [stylex.when.ancestor(":hover", threadItem)]: 1,
      },
    },
  },
});

const recipeStyles2 = stylex.create({
  pinsDiv: {
    position: "absolute",
    top: "100%",
    right: "0",
    zIndex: 30,
    marginTop: "var(--spacing)",
    display: "flex",
    maxHeight: "calc(var(--spacing) * 96)",
    width: "calc(var(--spacing) * 80)",
    transformOrigin: "100% 0",
    animationName: { default: "pop-in", "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: ".28s",
    animationDelay: "0s",
    animationTimingFunction: "var(--ease-out)",
    animationIterationCount: "1",
    animationDirection: "normal",
    animationFillMode: "both",
    animationPlayState: "running",
    flexDirection: "column",
    gap: "var(--spacing)",
    overflowY: "auto",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    padding: "calc(var(--spacing) * 2)",
    boxShadow: "var(--shadow-float)",
  },
  threadListDiv: {
    position: "absolute",
    top: "100%",
    right: "0",
    zIndex: 30,
    marginTop: "var(--spacing)",
    display: "flex",
    maxHeight: "28rem",
    width: "calc(var(--spacing) * 96)",
    transformOrigin: "100% 0",
    animationName: { default: "pop-in", "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: ".28s",
    animationDelay: "0s",
    animationTimingFunction: "var(--ease-out)",
    animationIterationCount: "1",
    animationDirection: "normal",
    animationFillMode: "both",
    animationPlayState: "running",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
    overflowY: "auto",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    padding: "calc(var(--spacing) * 2)",
    boxShadow: "var(--shadow-float)",
  },
});

const recipeStyles = stylex.create({
  membersButton: {
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
        ":hover": "var(--color-hover)",
      },
    },
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  threadPaneHeader: {
    display: "flex",
    height: "66px",
    flexShrink: "0",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 4)",
  },
});

const variantStyles2 = stylex.create({
  threadListIcon: {
    opacity: ".6",
    transitionProperty: "transform,translate,scale,rotate",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: "var(--default-transition-duration)",
  },
  threadListIconVariant: {
    rotate: "90deg",
  },
  threadListIconVariant2: {},
});

const variantStyles = stylex.create({
  pinsSpan: {
    WebkitLineClamp: "3",
    WebkitBoxOrient: "vertical",
    display: "block",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  farmSearchBodySpan: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
});

const viewStyles = stylex.create({
  pinsP: {
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  pinsP2: {
    paddingInline: "var(--spacing)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  pinsFailed: {
    paddingInline: "var(--spacing)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  pin: {
    cursor: "pointer",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  pinsSpan: {
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  pinsSpan2: {
    fontWeight: "var(--font-weight-semibold)",
  },
  pinsSpan3: {
    color: "var(--color-muted)",
  },
  members: {
    display: {
      default: "none",
      "@media (width>=48rem)": "flex",
    },
    width: "calc(var(--spacing) * 60)",
    flexShrink: "0",
    flexDirection: "column",
    gap: "var(--spacing)",
    overflowY: "auto",
    borderLeftStyle: "solid",
    borderLeftWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-side)",
    padding: "calc(var(--spacing) * 3)",
  },
  membersP: {
    paddingInline: "var(--spacing)",
    paddingBottom: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  membersDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "var(--spacing)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  membersSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "2147483647px",
    backgroundColor: "var(--color-selected)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  membersSpan2: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  membersSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  membersSpan4: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  membersSpan5: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  membersP2: {
    paddingInline: "var(--spacing)",
    paddingTop: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  threadPaneSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
  },
  threadPaneSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  threadPaneSpan3: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  threadsArchived: {
    marginTop: "var(--spacing)",
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    paddingInline: "var(--spacing)",
    textAlign: "left",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  threadItemButton: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    cursor: "pointer",
    flexDirection: "column",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    paddingLeft: "var(--spacing)",
    textAlign: "left",
  },
  threadItemSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  threadItemSpan2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontWeight: "var(--font-weight-medium)",
  },
  threadItemSpan3: {
    flexShrink: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  threadName: {
    marginBlock: "var(--spacing)",
    minWidth: "0",
    flex: "1",
    borderRadius: "var(--radius-sm)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-focus)",
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
  },
  farmSearchBodyDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 3)",
  },
  farmSearchBodyLabel: {
    display: "flex",
    height: "calc(var(--spacing) * 9)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      ":focus-within": "var(--color-focus)",
    },
    paddingInline: "calc(var(--spacing) * 2)",
  },
  farmSearchInput: {
    minWidth: "0",
    flex: "1",
    backgroundColor: "transparent",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--color-faint)",
    },
  },
  farmSearchBodyP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-faint)",
  },
  farmSearchBodyP2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  searchFailed: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  farmSearchBodyDiv2: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  searchHit: {
    display: "flex",
    cursor: "pointer",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  farmSearchBodySpan: {
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-accent)",
  },
});

const bad = (reason: string) => toast(reason, "bad");

/** Newest pinned first. */
export function Pins(props: { channel: Channel; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const answer = useLatest(
    () => props.channel.id,
    (id) => api.channel.pin.list({ id }),
  );
  const pinned = (): readonly ChatMessage[] | undefined => {
    const a = answer();
    return a?.state === "done" ? a.value : undefined;
  };
  const failed = () => {
    const a = answer();
    return a?.state === "failed" ? a.reason : undefined;
  };
  return (
    <div role="dialog" data-testid="pins" aria-label={t("web.channel.pins.title")} {...stylex.attrs(recipeStyles2.pinsDiv)}>
      <p {...stylex.attrs(viewStyles.pinsP)}>{t("web.channel.pins.title")}</p>
      <Show when={pinned()?.length === 0}>
        <p {...stylex.attrs(viewStyles.pinsP2)}>{t("web.channel.pins.none")}</p>
      </Show>
      <Show when={failed()}>
        {(why) => (
          <p data-testid="pins-failed" {...stylex.attrs(viewStyles.pinsFailed)}>
            {t("web.channel.pins.failed", { why: why() })}
          </p>
        )}
      </Show>
      <For each={pinned() ?? []} keyed={(m) => m.id}>
        {(m) => (
          <button
            type="button"
            data-testid="pin"
            data-key={m().id}
            {...stylex.attrs(viewStyles.pin)}
            onClick={() => {
              router.navigate(messagePath(channelOf(core()?.chat, m().channel), m().number));
              untrack(() => props.onPick)();
            }}
          >
            <span {...stylex.attrs(viewStyles.pinsSpan)}>
              <span {...stylex.attrs(viewStyles.pinsSpan2)}>{m().from === ownerId ? t("web.channel.messages.owner") : m().name}</span>
              <span {...stylex.attrs(viewStyles.pinsSpan3)}>{workbenchClock(m().at)}</span>
            </span>
            <span {...stylex.attrs(variantStyles.pinsSpan)}>{m().text}</span>
          </button>
        )}
      </For>
    </div>
  );
}

export function Members(props: { channel: Channel }) {
  const core = useCore();
  const router = useRouter();
  const act = createAct();
  const now = useNow();
  const orchestrators = useOrchestrators();
  const isOrchestrator = (id: string) => Arr.some(orchestrators(), (a) => a.id === id);
  // The orchestrators in the place: a direct channel's other one, or those the owner put in the channel.
  const inside = () =>
    props.channel.type === "direct"
      ? props.channel.peer !== undefined && isOrchestrator(props.channel.peer)
        ? [props.channel.peer]
        : []
      : Arr.filter(props.channel.members ?? [], isOrchestrator);
  const nameOf = (id: string) => orchestrators().find((a) => a.id === id)?.name || t("web.channel.orchestrator");
  const helpers = () => {
    if (props.channel.type === "direct") return [];
    const fallback = defaultOf(core()?.chat)?.id;
    return (core()?.sessions ?? []).filter((h) => h.role === "worker" && (h.channel ?? fallback) === props.channel.id);
  };
  return (
    <aside aria-label={t("web.channel.members.title")} data-testid="members" {...stylex.attrs(viewStyles.members)}>
      <p {...stylex.attrs(viewStyles.membersP)}>{t("web.channel.members.title")}</p>
      <div {...stylex.attrs(viewStyles.membersDiv)}>
        <span {...stylex.attrs(viewStyles.membersSpan)}>{t("web.channel.members.owner").slice(0, 1)}</span>
        {t("web.channel.members.owner")}
      </div>
      <For each={inside()} keyed={(id) => id}>
        {(id) => (
          <div data-testid="member-orchestrator" data-key={id()} {...stylex.attrs(viewStyles.membersDiv)}>
            <OrchestratorFace size={28} agent={id()} />
            <span {...stylex.attrs(viewStyles.membersSpan2)}>
              <span {...stylex.attrs(viewStyles.membersSpan3)}>{nameOf(id())}</span>
              <span {...stylex.attrs(viewStyles.membersSpan4)}>{t("web.channel.members.inChannel")}</span>
            </span>
            <span {...stylex.attrs(viewStyles.membersSpan5)}>{orchestratorMoodLabels[orchestratorMood(core(), id())]}</span>
          </div>
        )}
      </For>
      <For each={helpers()} keyed={(h) => h.id}>
        {(h) => (
          <div {...stylex.attrs(viewStyles.membersDiv)}>
            <HelperFace agent={h().agent} runtime={h().runtime} size={28} />
            <span {...stylex.attrs(viewStyles.membersSpan2)}>
              <span {...stylex.attrs(viewStyles.membersSpan3)}>{h().name}</span>
              <span {...stylex.attrs(viewStyles.membersSpan4)}>{phaseText(h(), now())}</span>
            </span>
            <PhaseGlyph phase={h().phase} />
            <button
              type="button"
              {...stylex.attrs(recipeStyles.membersButton)}
              aria-label={t("web.channel.direct.open", { name: h().name })}
              title={t("web.channel.direct.open", { name: h().name })}
              onClick={() => {
                const agent = h().agent;
                void act.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
              }}
            >
              <Icon name="thread" size={14} />
            </button>
          </div>
        )}
      </For>
      <Show when={props.channel.type !== "direct" && helpers().length === 0}>
        <p {...stylex.attrs(viewStyles.membersP2)}>{t("web.channel.members.none")}</p>
      </Show>
    </aside>
  );
}

const selectStyles = stylex.create({
  notifications: { width: "calc(var(--spacing) * 28)", fontSize: "var(--text-xs)", lineHeight: "var(--text-xs--line-height)" },
});

export function ThreadPane(props: { thread: Channel; point: number | undefined; onClose: () => void }) {
  const core = useCore();
  const notifies = useIntents(notifySet);
  const now = useNow();
  const sessions = () => core()?.sessions ?? [];
  const session = () => threadOwnerOf(props.thread, sessions());
  const status = () => {
    const s = session();
    return s
      ? `@${s.id} · ${phaseText(s, now())}`
      : props.thread.subjectKind === "issue"
        ? t("web.channel.nobodyOnIt")
        : t("web.channel.replies", { n: props.thread.replies });
  };
  return (
    <section aria-label={t("web.channel.thread")} {...stylex.attrs(viewStyles.membersSpan2)}>
      <header {...stylex.attrs(recipeStyles.threadPaneHeader)}>
        <span {...stylex.attrs(viewStyles.threadPaneSpan)}>
          <Show when={session()} fallback={<Icon name="thread" size={16} />}>
            {(s) => <HelperFace agent={s().agent} runtime={s().runtime} size={32} />}
          </Show>
        </span>
        <div {...stylex.attrs(viewStyles.membersSpan2)}>
          <span {...stylex.attrs(viewStyles.threadPaneSpan2)}>{threadTitle(props.thread, core()?.issues, sessions())}</span>
          <span {...stylex.attrs(viewStyles.threadPaneSpan3)}>
            <Show when={session()}>{(s) => <PhaseGlyph phase={s().phase} />}</Show>
            <span {...stylex.attrs(viewStyles.membersSpan3)}>{status()}</span>
          </span>
        </div>
        <Select
          label={t("web.channel.threadList.notify")}
          value={props.thread.notify ?? "all"}
          options={notifyOptions()}
          styles={selectStyles.notifications}
          testid="thread-notify"
          state={markState(notifies.list(), (n) => n.id === props.thread.id)}
          onChange={(v) => {
            if (v === "all" || v === "mentions" || v === "none") setMark(notifies, { id: props.thread.id, notify: v }, sameMessage, bad);
          }}
        />
        <button
          type="button"
          {...stylex.attrs(recipeStyles.membersButton)}
          aria-label={t("web.channel.closeThread")}
          title={t("web.channel.closeThread")}
          onClick={() => props.onClose()}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <FileDrop channel={props.thread}>
        <MessageList channel={props.thread} point={props.point} emptyText={t("web.channel.threadEmpty")} />
        <Composer channel={props.thread} placeholder={session() ? t("web.channel.sayInThread", { name: session()?.name ?? "" }) : t("web.channel.reply")} />
      </FileDrop>
    </section>
  );
}

/** A channel's threads, the newest talked in first, each renamed or archived in place; the archived ones below. */
export function ThreadList(props: { channel: Channel; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const [showArchived, setShowArchived] = createSignal(false);
  const chat = useMarkedChat();
  const live = () => threadsIn(chat(), props.channel);
  const archived = () => threadsIn(chat(), props.channel, true);
  const title = (channel: Channel) => threadTitle(channel, core()?.issues, core()?.sessions ?? []);
  const item = (channel: Channel) => (
    <ThreadItem thread={channel} title={title(channel)} onOpen={() => (router.navigate(chatPath(channel)), untrack(() => props.onPick)())} />
  );
  return (
    <div role="dialog" data-testid="thread-list" aria-label={t("web.channel.threadList.title")} {...stylex.attrs(recipeStyles2.threadListDiv)}>
      <p {...stylex.attrs(viewStyles.membersP)}>{t("web.channel.threadList.title")}</p>
      <Show when={live().length === 0}>
        <p data-testid="threads-empty" {...stylex.attrs(viewStyles.pinsP2)}>
          {t("web.channel.threadList.none")}
        </p>
      </Show>
      <For each={live()}>{item}</For>
      <Show when={archived().length > 0}>
        <button
          type="button"
          data-testid="threads-archived"
          aria-expanded={aria(showArchived())}
          {...stylex.attrs(viewStyles.threadsArchived)}
          onClick={() => setShowArchived(!showArchived())}
        >
          <Icon
            name="expand"
            size={10}
            styles={[variantStyles2.threadListIcon, showArchived() ? variantStyles2.threadListIconVariant : variantStyles2.threadListIconVariant2]}
          />
          {t("web.channel.threadList.archived", { n: archived().length })}
        </button>
        <Show when={showArchived()}>
          <For each={archived()}>{item}</For>
        </Show>
      </Show>
    </div>
  );
}

function ThreadItem(props: { thread: Channel; title: string; onOpen: () => void }) {
  const [renaming, setRenaming] = createSignal(false);
  const [name, setName] = createSignal("");
  const act = createAct();
  const archives = useIntents(archiveSet);
  const save = () => {
    setRenaming(false);
    const next = name().trim();
    const id = untrack(() => props.thread.id);
    if (next !== untrack(() => props.title)) void act.run(() => api.channel.update({ id, name: next }));
  };
  return (
    <div
      data-testid="thread"
      data-key={props.thread.id}
      data-archived={props.thread.archived !== undefined ? "" : undefined}
      {...styleProps([threadItem, threadStyles.thread])}
    >
      <Show
        when={renaming()}
        fallback={
          <button type="button" {...stylex.attrs(viewStyles.threadItemButton)} onClick={() => props.onOpen()}>
            <span {...stylex.attrs(viewStyles.threadItemSpan)}>
              <Icon name="thread" size={14} />
              <span {...stylex.attrs(viewStyles.threadItemSpan2)}>{props.title}</span>
              <span {...stylex.attrs(viewStyles.threadItemSpan3)}>{t("web.channel.replies", { n: props.thread.replies })}</span>
            </span>
            <Show when={props.thread.last}>
              {(m) => (
                <span {...stylex.attrs(viewStyles.membersSpan4)}>
                  {t("shared.join.labeled", { label: m().from === ownerId ? t("web.channel.messages.owner") : m().name, text: m().text })}
                </span>
              )}
            </Show>
          </button>
        }
      >
        <input
          ref={autofocus()}
          data-testid="thread-name"
          value={name()}
          aria-label={t("web.channel.threadList.rename", { title: props.title })}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.isComposing) return;
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              e.stopPropagation();
              setRenaming(false);
            }
          }}
          onBlur={save}
          {...stylex.attrs(viewStyles.threadName)}
        />
      </Show>
      <button
        type="button"
        {...styleProps([channelIconButtonStyles, threadStyles.action])}
        data-testid="thread-rename"
        aria-label={t("web.channel.threadList.rename", { title: props.title })}
        title={t("web.channel.threadList.rename", { title: props.title })}
        onClick={() => {
          setName(props.thread.name ?? props.title);
          setRenaming(true);
        }}
      >
        <Icon name="edit" size={14} />
      </button>
      <button
        type="button"
        {...styleProps([channelIconButtonStyles, threadStyles.action])}
        data-testid="thread-archive"
        aria-label={
          props.thread.archived !== undefined
            ? t("web.channel.threadList.unarchive", { title: props.title })
            : t("web.channel.threadList.archive", { title: props.title })
        }
        title={
          props.thread.archived !== undefined
            ? t("web.channel.threadList.unarchive", { title: props.title })
            : t("web.channel.threadList.archive", { title: props.title })
        }
        onClick={() => setMark(archives, { id: props.thread.id, on: props.thread.archived === undefined, at: Date.now() }, sameMessage, bad)}
      >
        <Icon name="archive" size={14} />
      </button>
    </div>
  );
}

/** Every channel and thread searched at once, the server reading the filters; a hit opens where it is. */
export function FarmSearch(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={props.open} onClose={() => props.onClose()} title={t("web.channel.farmSearch.title")} wide testid="farm-search">
      <FarmSearchBody onClose={() => props.onClose()} />
    </Dialog>
  );
}

function FarmSearchBody(props: { onClose: () => void }) {
  const core = useCore();
  const router = useRouter();
  const [text, setText] = createSignal("");
  const search = useLatest(
    () => text().trim() || undefined,
    (q) => api.channel.message.search({ text: q }),
    200,
  );
  const hits = (): readonly MessageHit[] | undefined => {
    const a = search();
    return a === undefined ? [] : a.state === "done" ? a.value : undefined;
  };
  const failed = () => {
    const a = search();
    return a?.state === "failed" ? a.reason : undefined;
  };
  return (
    <div {...stylex.attrs(viewStyles.farmSearchBodyDiv)}>
      <label {...stylex.attrs(viewStyles.farmSearchBodyLabel)}>
        <Icon name="search" size={16} />
        <input
          ref={autofocus()}
          data-testid="farm-search-input"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          placeholder={t("web.channel.farmSearch.hint")}
          aria-label={t("web.channel.farmSearch.title")}
          {...stylex.attrs(viewStyles.farmSearchInput)}
        />
      </label>
      <p {...stylex.attrs(viewStyles.farmSearchBodyP)}>{t("web.channel.farmSearch.filters")}</p>
      <Show when={search()?.state === "waiting"}>
        <p {...stylex.attrs(viewStyles.farmSearchBodyP2)}>{t("web.channel.farmSearch.searching")}</p>
      </Show>
      <Show when={failed()}>
        {(why) => (
          <p data-testid="search-failed" {...stylex.attrs(viewStyles.searchFailed)}>
            {t("web.channel.farmSearch.failed", { why: why() })}
          </p>
        )}
      </Show>
      <Show when={hits()?.length === 0 && text().trim() !== ""}>
        <p {...stylex.attrs(viewStyles.farmSearchBodyP2)}>{t("web.channel.farmSearch.none")}</p>
      </Show>
      <div role="list" aria-label={t("web.channel.messages.label")} {...stylex.attrs(viewStyles.farmSearchBodyDiv2)}>
        <For each={hits() ?? []} keyed={(h) => h.message.id}>
          {(h) => (
            <button
              type="button"
              role="listitem"
              data-testid="search-hit"
              data-key={h().message.id}
              {...stylex.attrs(viewStyles.searchHit)}
              onClick={() => {
                router.navigate(messagePath(channelOf(core()?.chat, h().message.channel), h().message.number));
                untrack(() => props.onClose)();
              }}
            >
              <span {...stylex.attrs(viewStyles.pinsSpan)}>
                <span {...stylex.attrs(viewStyles.farmSearchBodySpan)}>{h().address}</span>
                <span {...stylex.attrs(viewStyles.pinsSpan2)}>{h().message.from === ownerId ? t("web.channel.messages.owner") : h().message.name}</span>
                <span {...stylex.attrs(viewStyles.pinsSpan3)}>{workbenchClock(h().message.at)}</span>
              </span>
              <span {...stylex.attrs(variantStyles.farmSearchBodySpan)}>{h().message.text}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
