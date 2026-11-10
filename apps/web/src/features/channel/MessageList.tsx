import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type ChatMessage, type Channel, type MessageHit, defaultOrchestrator, type Outcome, userId } from "@vibevalley/protocol";
import { channelOf, plainText } from "@vibevalley/protocol/rules";

import { aria, useNow } from "#/base/dom.tsx";
import { tookText, spentText } from "#/base/format.ts";
import { ArtifactCard } from "#/features/artifact/index.ts";
import { RunSteps } from "#/features/session/index.ts";
import { useAgent, useOrchestrators } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter, Link as A } from "#/infra/router.ts";
import { useLatest } from "#/state/atom.ts";
import { useIntents } from "#/state/intent.ts";
import { OrchestratorFace, UserFace } from "#/ui/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { Markdown } from "#/ui/Markdown.tsx";
import { styleProps } from "#/ui/positioner.ts";
import { Tag, type TagTone } from "#/ui/Tag.tsx";
import { toast } from "#/ui/toasts.ts";

import { chatSay, editingId, pendingLines, setEditingId } from "./composing";
import { followed, useMessage } from "./follow";
import { useMarkedFollowed, useMarkRead } from "./marks";
import { dispatchRow, threadPreview, messageRow } from "./message.stylex";
import { Attachments, EditBox, Embeds, LinkedMessages, MessageBody, MessageTools, Reactions, ReplyQuote } from "./MessageParts";
import { feedOf, orchestratorTyping, workbenchClock, messagePath, chatPath, parentAt, threadOwnerOf, unreadIn } from "./places";
import { Dot, PhaseGlyph, SenderFace, ThinkingDots, phaseDot, phaseText, dutyShort, runtimeLabel } from "./presence";

const messageStyles = stylex.create({
  row: {
    position: "relative",
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
  continuation: {
    paddingTop: "calc(var(--spacing) * .5)",
  },
  start: {
    marginTop: "calc(var(--spacing) * 3)",
    paddingTop: "var(--spacing)",
  },
  jump: {
    position: "absolute",
    top: "calc(var(--spacing) * -3)",
    right: "calc(var(--spacing) * 2)",
    zIndex: 10,
    display: {
      default: "none",
      [stylex.when.ancestor(":focus-within", messageRow)]: "block",
      "@media (hover: hover)": {
        default: null,
        [stylex.when.ancestor(":hover", messageRow)]: "block",
      },
    },
    cursor: "pointer",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    boxShadow: "var(--shadow-float)",
  },
});

const recipeStyles2 = stylex.create({
  messageListButton: {
    position: "absolute",
    bottom: "calc(var(--spacing) * 3)",
    left: "50%",
    zIndex: 10,
    display: "inline-flex",
    translate: "calc(calc(1 / 2 * 100%) * -1) 0",
    animationName: { default: "pop-in", "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: ".28s",
    animationDelay: "0s",
    animationTimingFunction: "var(--ease-out)",
    animationIterationCount: "1",
    animationDirection: "normal",
    animationFillMode: "both",
    animationPlayState: "running",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "2147483647px",
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
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-ink)",
    boxShadow: "var(--shadow-float)",
    transitionProperty: "color,background-color,border-color,outline-color,text-decoration-color,fill,stroke",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
  },
  messageListDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    WebkitMaskImage: "linear-gradient(to bottom, transparent, black var(--fade-top), black calc(100% - var(--fade-bottom)), transparent)",
    maskImage: "linear-gradient(to bottom, transparent, black var(--fade-top), black calc(100% - var(--fade-bottom)), transparent)",
    animationName: "scroll-fade-y",
    animationDuration: "0s",
    animationDelay: "0s",
    animationTimingFunction: "linear",
    animationIterationCount: "1",
    animationDirection: "normal",
    animationFillMode: "both",
    animationPlayState: "running",
    animationTimeline: "scroll(self y)",
    flexDirection: "column-reverse",
    overflowY: "auto",
  },
});

const recipeStyles = stylex.create({
  messageListDiv: {
    borderRadius: "var(--radius-md)",
    transitionProperty: "opacity,translate,background-color",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".28s",
  },
  messageListDivVariant1Case1: {
    translate: null,
    opacity: null,
  },
  messageListDivVariant1Case2: {
    translate: {
      default: null,
      "@starting-style": "0 calc(var(--spacing) * 2)",
    },
    opacity: {
      default: null,
      "@starting-style": "0",
    },
  },
  messageListDivVariant2Case1: {
    backgroundColor: null,
  },
  messageListDivVariant2Case2: {
    backgroundColor: {
      default: "var(--wb-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-wheat) 25%, transparent)",
    },
  },
});

const viewStyles = stylex.create({
  messageListRoot: {
    position: "relative",
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column",
  },
  toLatestIcon: {
    rotate: "90deg",
  },
  pendingSending: {
    opacity: ".6",
  },
  dayLineDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 3)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  dayLineNew: {
    color: "var(--color-berry)",
  },
  dayLineNormal: {
    color: "var(--color-muted)",
  },
  dayLineSpan: {
    height: "1px",
    flex: "1",
  },
  dayLineRuleNew: {
    backgroundColor: "var(--color-berry)",
  },
  dayLineRuleNormal: {
    backgroundColor: "var(--color-line)",
  },
  dispatchRow: { display: "flex", alignItems: "flex-start", gap: "calc(var(--spacing) * 1.5)" },
  dispatchA: {
    minWidth: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  dispatchIcon: { opacity: { default: 0.5, "@media (hover: hover)": { default: null, [stylex.when.ancestor(":hover", dispatchRow)]: 1 } } },
  threadIcon: { opacity: { default: 0.6, "@media (hover: hover)": { default: null, [stylex.when.ancestor(":hover", threadPreview)]: 1 } } },
  threadButton: {
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    width: "100%",
    maxWidth: "var(--container-xl)",
    cursor: "pointer",
    flexDirection: "column",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-lg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: "var(--color-line)", ":focus-visible": "var(--color-focus)" },
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    textAlign: "left",
    backgroundColor: { default: null, "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" } },
  },
  messageListDiv: {
    display: "flex",
    flexDirection: "column",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingTop: "calc(var(--spacing) * 3)",
    paddingBottom: "calc(var(--spacing) * 4)",
  },
  messageListDiv2: {
    display: "flex",
    justifyContent: "center",
    paddingBottom: "calc(var(--spacing) * 2)",
  },
  messageListSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  messageListButton: {
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--color-faint)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  messageListDiv3: {
    marginBottom: "calc(var(--spacing) * 2)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingBottom: "calc(var(--spacing) * 2)",
  },
  messagesFailed: {
    paddingBlock: "calc(var(--spacing) * 8)",
    textAlign: "center",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  messagesEmpty: {
    paddingBlock: "calc(var(--spacing) * 8)",
    textAlign: "center",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  messageListP: {
    paddingInline: "calc(var(--spacing) * 6)",
    paddingBlock: "calc(var(--spacing) * 2)",
    textAlign: "center",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-relaxed)",
    color: "var(--color-muted)",
  },
  messageListDiv4: {
    display: "flex",
    height: "calc(var(--spacing) * 5)",
    alignItems: "center",
  },
  pendingLinesP: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    overflowWrap: "break-word",
    whiteSpace: "pre-wrap",
  },
  pendingLinesDiv: {
    marginTop: "var(--spacing)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  pendingLinesSpan: {
    minWidth: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--color-berry)",
  },
  pendingRetry: {
    display: "inline-flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  frameDiv: {
    paddingLeft: "52px",
  },
  frameDiv2: {
    display: "flex",
    gap: "calc(var(--spacing) * 3)",
  },
  frameDiv3: {
    position: "relative",
    width: "calc(var(--spacing) * 10)",
    flexShrink: "0",
  },
  frameSpan: {
    position: "absolute",
    top: "26px",
    left: "26px",
  },
  frameDiv4: {
    minWidth: "0",
    flex: "1",
    paddingBottom: "calc(var(--spacing) * .5)",
  },
  frameDiv5: {
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
  },
  frameSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  frameSpan3: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  dispatchDiv: {
    minWidth: "0",
    flex: "1",
  },
  dispatchButton: {
    display: "block",
    width: "100%",
    cursor: "pointer",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textAlign: "left",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
  },
  dispatchP: {
    display: "flex",
    minWidth: "0",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
  },
  dispatchSpan: {
    flexShrink: "0",
  },
  dispatchSpan2: {
    flexShrink: "0",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  dispatchButton2: {
    marginTop: "5px",
    cursor: "pointer",
  },
  messageRowDiv: {
    marginBottom: "var(--spacing)",
  },
  messageRowDiv2: {
    marginTop: "var(--spacing)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  messageQuotedBlock: {
    display: "flex",
    maxWidth: "var(--container-md)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderLeftStyle: "solid",
    borderLeftWidth: "2px",
    borderColor: "var(--color-wheat)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  messageRowSpan: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  messageRowDiv3: {
    marginTop: "var(--spacing)",
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  threadPreviewSpan: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  threadPreviewSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-accent)",
  },
  threadPreviewSpan3: {
    flex: "1",
  },
  threadPreviewSpan4: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  threadPreviewSpan5: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  threadPreviewSpan6: {
    flexShrink: "0",
    fontWeight: "var(--font-weight-medium)",
  },
  threadPreviewSpan7: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--color-muted)",
  },
});

const outcomeTag: Record<Outcome, { label: string; tone: TagTone; icon: IconName }> = {
  completed: { label: t("shared.outcome.completed"), tone: "ok", icon: "check" },
  failed: { label: t("shared.outcome.failed"), tone: "bad", icon: "cross" },
  interrupted: { label: t("shared.outcome.interrupted"), tone: "wait", icon: "stop" },
};

/** A channel's messages, newest at the bottom; filter keeps those containing it. */
export function MessageList(props: { channel: Channel | undefined; filter?: string | undefined; point?: number | undefined; emptyText: string }) {
  const core = useCore();
  const router = useRouter();
  const id = () => props.channel?.id;
  const said = useMarkedFollowed(id);
  useMarkRead(
    () => props.channel,
    (reason) => toast(reason, "bad"),
  );
  let log: HTMLDivElement | undefined;
  // The message an address points at: older pages are read until it is among them, then it is scrolled to and lit up a while.
  const [lit, setLit] = createSignal<number>();
  createEffect(
    () => {
      const at = id();
      const n = props.point;
      const f = said();
      if (!at || n === undefined || !f.ready) return undefined;
      if (f.messages.some((m) => m.number === n)) return `here:${at}:${n}`;
      const first = f.messages[0]?.number;
      return !f.complete && first !== undefined && first > n ? `older:${at}:${first}` : undefined;
    },
    (step) => {
      if (!step) return;
      const [what = "", at = "", n = ""] = step.split(":");
      if (what === "older") return void followed.loadOlder(at);
      requestAnimationFrame(() => log?.querySelector(`[data-number="${n}"]`)?.scrollIntoView({ block: "center" }));
      setLit(Number(n));
      const off = setTimeout(() => setLit(undefined), litMs);
      return () => clearTimeout(off);
    },
  );
  // Rows newer than this arrived while the list was shown: they rise in; the rest just appear.
  const shownAt = Date.now();

  // Where the user had read to as the list opened: the new ones below a line.
  const readTo = untrack(() => props.channel?.read ?? 0);
  const searching = () => (props.filter ?? "").trim() !== "";
  // A search is the server's, over the whole channel and its threads, not only the pages read here.
  const search = useLatest(
    () => {
      const text = (props.filter ?? "").trim();
      const at = id();
      // A string, so the same words in the same channel again ask nothing.
      return text && at ? `${at}\n${text}` : undefined;
    },
    (key) => {
      const [channel = "", text = ""] = key.split("\n");
      return api.channel.message.search({ text, channel });
    },
    searchWaitMs,
  );
  const hits = (): readonly MessageHit[] | undefined => {
    const a = search();
    return a?.state === "done" ? a.value : undefined;
  };
  const searchFailed = () => {
    const a = search();
    return a?.state === "failed" ? a.reason : undefined;
  };
  const items = createMemo(() =>
    searching()
      ? feedOf(
          core()?.chat,
          [...(hits() ?? [])].toReversed().map((h) => h.message),
        )
      : feedOf(core()?.chat, said().messages),
  );
  const addressOf = (m: ChatMessage) => (m.channel === id() ? undefined : hits()?.find((h) => h.message.id === m.id)?.address);
  const firstNew = () => (searching() ? undefined : said().messages.find((m) => m.number > readTo && m.from !== userId)?.id);
  const parent = useMessage(() => (props.channel ? parentAt(core()?.chat, props.channel) : undefined));
  const hasOlder = () => !!id() && said().messages.length > 0 && !said().complete;
  const typing = () => orchestratorTyping(core(), props.channel);
  const clock = useNow();
  // Thinking or writing, and for how long the round has gone on.
  const roundText = (mood: "thinking" | "speaking", since: number | undefined) => {
    const what = mood === "speaking" ? t("web.channel.messages.typing") : t("web.channel.messages.thinking");
    return since === undefined ? what : t("web.channel.messages.roundFor", { what, took: tookText(Math.max(0, clock() - since)) });
  };
  const orchestrators = useOrchestrators();
  // Scrolled up from the newest: the number it was at then, so what came after is counted for the way back.
  const [awayFrom, setAwayFrom] = createSignal<number>();
  const newest = () => said().messages.at(-1)?.number ?? 0;
  const unseen = () => {
    const from = awayFrom();
    return from === undefined ? 0 : said().messages.filter((m) => m.number > from && m.from !== userId).length;
  };
  // The log is reversed: at the newest its scrollTop is 0, and it goes negative upward.
  const onScroll = () => {
    const away = (log?.scrollTop ?? 0) < -awayPx;
    if (away && awayFrom() === undefined) setAwayFrom(newest());
    if (!away && awayFrom() !== undefined) setAwayFrom(undefined);
  };
  const toLatest = () => log?.scrollTo({ top: 0, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });

  return (
    // Reversed, so it stays at the newest while you are there and older pages load above without a jump.
    <div {...stylex.attrs(viewStyles.messageListRoot)}>
      <Show when={awayFrom() !== undefined}>
        <button type="button" data-testid="to-latest" onClick={toLatest} {...stylex.attrs(recipeStyles2.messageListButton)}>
          <Icon name="expand" size={12} styles={viewStyles.toLatestIcon} />
          {unseen() > 0 ? t("web.channel.messages.newBelow", { n: unseen() }) : t("web.channel.messages.toLatest")}
        </button>
      </Show>
      <div
        ref={(el) => (log = el)}
        onScroll={onScroll}
        {...stylex.attrs(recipeStyles2.messageListDiv)}
        role="log"
        aria-label={t("web.channel.messages.label")}
        data-testid="messages"
        data-read={props.channel?.read}
      >
        <div {...stylex.attrs(viewStyles.messageListDiv)}>
          <div {...stylex.attrs(viewStyles.messageListDiv2)}>
            <Show
              when={hasOlder() && !searching()}
              fallback={
                <span {...stylex.attrs(viewStyles.messageListSpan)}>
                  {searching()
                    ? search()?.state !== "done" && searchFailed() === undefined
                      ? t("web.channel.messages.searching")
                      : t("web.channel.messages.containing", { text: (props.filter ?? "").trim() })
                    : t("web.channel.messages.start")}
                </span>
              }
            >
              <button
                type="button"
                onClick={() => {
                  const ch = id();
                  if (ch) void followed.loadOlder(ch);
                }}
                {...stylex.attrs(viewStyles.messageListButton)}
              >
                {t("web.channel.messages.older")}
              </button>
            </Show>
          </div>
          <Show when={parent()}>
            {(m) => (
              <div {...stylex.attrs(viewStyles.messageListDiv3)}>
                <MessageRow m={m()} continues={false} />
              </div>
            )}
          </Show>
          <Show when={searching() ? searchFailed() : said().error}>
            {(why) => (
              <p data-testid="messages-failed" {...stylex.attrs(viewStyles.messagesFailed)}>
                {searching() ? t("web.channel.messages.searchFailed", { why: why() }) : t("web.channel.messages.readFailed", { why: why() })}
              </p>
            )}
          </Show>
          <Show when={items().length === 0 && (searching() ? hits() !== undefined : !said().error)}>
            <p data-testid="messages-empty" {...stylex.attrs(viewStyles.messagesEmpty)}>
              {searching() ? t("web.channel.messages.notFound") : props.emptyText}
            </p>
          </Show>
          <For each={items()} keyed={(item) => item.message.id}>
            {(item) => (
              <div
                data-testid="message"
                data-key={item().message.id}
                data-from={item().message.from}
                data-from-kind={item().message.fromKind}
                data-from-role={item().message.fromRole}
                data-edited={item().message.edited !== undefined ? "" : undefined}
                data-deleted={item().message.deleted !== undefined ? "" : undefined}
                data-pinned={item().message.pinned !== undefined ? "" : undefined}
                data-kind={item().message.kind}
                data-lit={lit() === item().message.number && item().message.channel === id() ? "" : undefined}
                data-number={item().message.channel === id() ? item().message.number : undefined}
                {...stylex.attrs(
                  recipeStyles.messageListDiv,
                  item().message.at > shownAt ? recipeStyles.messageListDivVariant1Case2 : recipeStyles.messageListDivVariant1Case1,
                  lit() === item().message.number && item().message.channel === id()
                    ? recipeStyles.messageListDivVariant2Case2
                    : recipeStyles.messageListDivVariant2Case1,
                )}
              >
                <Show when={item().day}>{(day) => <DayLine label={day()} />}</Show>
                <Show when={item().message.id === firstNew()}>
                  <DayLine label={t("web.channel.messages.newMessages")} tone="new" />
                </Show>
                <Show
                  when={item().message.kind === "notice" || item().message.fromKind === "system"}
                  fallback={
                    <MessageRow
                      m={item().message}
                      continues={item().continues && item().message.id !== firstNew()}
                      thread={item().thread}
                      inChannel={props.channel?.type === "channel"}
                      where={addressOf(item().message)}
                      {...(searching()
                        ? { onJump: () => router.navigate(messagePath(channelOf(core()?.chat, item().message.channel), item().message.number)) }
                        : {})}
                    />
                  }
                >
                  <p {...stylex.attrs(viewStyles.messageListP)}>{item().message.text}</p>
                </Show>
              </div>
            )}
          </For>
          <Show when={!searching()}>
            <PendingLines channel={id()} messages={said().messages} />
          </Show>
          <Show when={typing()}>
            {(typer) => (
              <Frame
                face={<OrchestratorFace size={36} agent={typer().agent} />}
                name={orchestrators().find((a) => a.id === typer().agent)?.name || t("web.channel.orchestrator")}
                meta={roundText(typer().mood, typer().since)}
              >
                <div {...stylex.attrs(viewStyles.messageListDiv4)}>
                  <ThinkingDots />
                </div>
              </Frame>
            )}
          </Show>
        </div>
      </div>
    </div>
  );
}

/** The user's lines on their way here (composing.ts), under the messages: sending, or failed with a retry. */
function PendingLines(props: { channel: string | undefined; messages: readonly ChatMessage[] }) {
  const says = useIntents(chatSay);
  const lines = createMemo(() => pendingLines(says.list(), props.channel, props.messages));
  return (
    <For each={lines()} keyed={(l) => l.key}>
      {(l) => (
        <div data-testid="pending-line" data-key={l().key} data-state={l().state} {...stylex.attrs(l().state === "sending" && viewStyles.pendingSending)}>
          <Frame
            face={<UserFace size={36} />}
            name={t("web.channel.messages.user")}
            meta={l().state === "sending" ? t("web.channel.messages.sending") : t("web.channel.messages.notSent")}
          >
            <p {...stylex.attrs(viewStyles.pendingLinesP)}>{l().text}</p>
            <Show when={l().state === "failed"}>
              <div {...stylex.attrs(viewStyles.pendingLinesDiv)}>
                <span {...stylex.attrs(viewStyles.pendingLinesSpan)}>{l().reason ?? t("web.channel.messages.notSent")}</span>
                <button type="button" data-testid="pending-retry" onClick={() => void says.retry(l().key)} {...stylex.attrs(viewStyles.pendingRetry)}>
                  <Icon name="retry" size={12} />
                  {t("web.channel.messages.retrySend")}
                </button>
                <button type="button" data-testid="pending-drop" onClick={() => says.drop(l().key)} {...stylex.attrs(viewStyles.pendingRetry)}>
                  <Icon name="close" size={12} />
                  {t("web.channel.messages.dropSend")}
                </button>
              </div>
            </Show>
          </Frame>
        </div>
      )}
    </For>
  );
}

const searchWaitMs = 200;
/** Scrolled up this far from the newest, the way back shows. */
const awayPx = 240;
const litMs = 2500;

function DayLine(props: { label: string; tone?: "new" }) {
  return (
    <div {...stylex.attrs(viewStyles.dayLineDiv, props.tone === "new" ? viewStyles.dayLineNew : viewStyles.dayLineNormal)} role="separator">
      <span {...stylex.attrs(viewStyles.dayLineSpan, props.tone === "new" ? viewStyles.dayLineRuleNew : viewStyles.dayLineRuleNormal)} />
      {props.label}
      <span {...stylex.attrs(viewStyles.dayLineSpan, props.tone === "new" ? viewStyles.dayLineRuleNew : viewStyles.dayLineRuleNormal)} />
    </div>
  );
}

function Frame(props: {
  face: JSX.Element;
  dot?: JSX.Element;
  name: string;
  meta: string;
  continues?: boolean;
  /** The message it answers, quoted above it. */
  quote?: { channel: string; number: number } | undefined;
  tools?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div {...styleProps([messageRow, messageStyles.row, props.continues === true ? messageStyles.continuation : messageStyles.start])}>
      {props.tools}
      <Show when={props.quote}>
        {(q) => (
          <div {...stylex.attrs(viewStyles.frameDiv)}>
            <ReplyQuote channel={q().channel} number={q().number} />
          </div>
        )}
      </Show>
      <div {...stylex.attrs(viewStyles.frameDiv2)}>
        <div {...stylex.attrs(viewStyles.frameDiv3)}>
          <Show when={props.continues !== true}>
            {props.face}
            <Show when={props.dot}>
              <span {...stylex.attrs(viewStyles.frameSpan)}>{props.dot}</span>
            </Show>
          </Show>
        </div>
        <div {...stylex.attrs(viewStyles.frameDiv4)}>
          <Show when={props.continues !== true}>
            <div {...stylex.attrs(viewStyles.frameDiv5)}>
              <span {...stylex.attrs(viewStyles.frameSpan2)}>{props.name}</span>
              <span {...stylex.attrs(viewStyles.frameSpan3)}>{props.meta}</span>
            </div>
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  );
}

/** A dispatch: one line until it is opened, then the whole task in its place. */
/** A dispatch said as what it is for the user: who went to which issue. */
function Dispatch(props: { m: ChatMessage }) {
  const core = useCore();
  const [open, setOpen] = createSignal(false);
  const sent = () => (core()?.sessions ?? []).find((s) => s.id === props.m.session);
  const issue = () => {
    const id = sent()?.issue;
    return id ? (core()?.issues ?? []).find((i) => i.id === id) : undefined;
  };
  return (
    <div {...stylex.attrs(viewStyles.dispatchRow, dispatchRow)} data-testid="dispatch">
      <div {...stylex.attrs(viewStyles.dispatchDiv)}>
        <Show
          when={open()}
          fallback={
            <Show
              when={issue()}
              fallback={
                <button type="button" onClick={() => setOpen(true)} {...stylex.attrs(viewStyles.dispatchButton)}>
                  {plainText(props.m.text)}
                </button>
              }
            >
              {(i) => (
                <p {...stylex.attrs(viewStyles.dispatchP)}>
                  <span {...stylex.attrs(viewStyles.dispatchSpan)}>{t("web.channel.messages.sentTo", { who: sent()?.name ?? "" })}</span>
                  <A href={`/issues/${i().id}`} data-testid="dispatch-issue" {...stylex.attrs(viewStyles.dispatchA)}>
                    #{i().number} {i().title}
                  </A>
                  <Show when={i().repo}>{(p) => <span {...stylex.attrs(viewStyles.dispatchSpan2)}>{p()}</span>}</Show>
                </p>
              )}
            </Show>
          }
        >
          <Markdown text={props.m.text} mentions />
        </Show>
      </div>
      <button
        type="button"
        onClick={() => setOpen(!open())}
        aria-label={open() ? t("web.channel.messages.foldDispatch") : t("web.channel.messages.unfoldDispatch")}
        aria-expanded={aria(open())}
        {...stylex.attrs(viewStyles.dispatchButton2)}
      >
        <Icon name={open() ? "collapse" : "enlarge"} size={12} styles={viewStyles.dispatchIcon} />
      </button>
    </div>
  );
}

export function MessageRow(props: {
  m: ChatMessage;
  continues: boolean;
  thread?: Channel | undefined;
  inChannel?: boolean;
  where?: string | undefined;
  onJump?: () => void;
}) {
  const core = useCore();
  const editing = () => editingId() === props.m.id;
  const setEditing = (on: boolean) => setEditingId(on ? props.m.id : undefined);
  const orchestrators = useOrchestrators();
  const nameOf = (who: string) =>
    who === userId
      ? t("web.channel.messages.user")
      : (orchestrators().find((a) => a.id === who)?.name ??
        (who === defaultOrchestrator ? t("web.channel.orchestrator") : undefined) ??
        (core()?.sessions ?? []).find((h) => h.id === who)?.name ??
        who);
  const meta = () =>
    [props.where ? t("web.channel.messages.inThread", { address: props.where }) : "", props.m.pinned !== undefined ? t("web.channel.messages.pinned") : ""]
      .filter(Boolean)
      .join(" · ");
  const agentOf = useAgent(() => props.m.agent);
  const session = () => (props.m.fromRole === "worker" ? (core()?.sessions ?? []).find((h) => h.id === props.m.from) : undefined);
  const who = () => {
    if (props.m.fromRole !== "worker") return "";
    const agent = agentOf();
    const s = session();
    return [`@${props.m.from}`, s ? (runtimeLabel[s.runtime] ?? s.runtime) : "", agent?.duty ? dutyShort(agent.duty) : ""].filter(Boolean).join(" ");
  };
  const outcome = () => outcomeTag[props.m.outcome ?? "completed"];
  return (
    <Frame
      face={<SenderFace m={props.m} />}
      dot={<Show when={session()}>{(s) => <Dot tone={phaseDot(s().phase)} size={11} />}</Show>}
      name={props.m.fromKind === "user" ? t("web.channel.messages.user") : props.m.name}
      meta={`${who() ? `${who()}  ` : ""}${workbenchClock(props.m.at)}${meta() ? `  ${meta()}` : ""}`}
      continues={props.continues}
      quote={props.m.replyTo !== undefined ? { channel: props.m.channel, number: props.m.replyTo } : undefined}
      tools={
        props.onJump ? (
          <button type="button" onClick={() => props.onJump?.()} {...styleProps(messageStyles.jump)}>
            {t("web.channel.more.jump")}
          </button>
        ) : props.m.deleted === undefined && !props.where ? (
          <MessageTools m={props.m} inChannel={!(props.inChannel !== true)} onEdit={() => setEditing(true)} />
        ) : undefined
      }
    >
      <Show when={props.m.kind === "dispatch"}>
        <div {...stylex.attrs(viewStyles.messageRowDiv)}>
          <Tag icon="send" label={t("web.channel.messages.dispatch")} tone="wait" />
        </div>
      </Show>
      <Show when={props.m.kind === "report"}>
        <div {...stylex.attrs(viewStyles.messageRowDiv)}>
          <Tag icon={outcome().icon} label={outcome().label} tone={outcome().tone} />
        </div>
      </Show>
      <Show
        when={props.m.kind === "dispatch" && props.m.deleted === undefined}
        fallback={
          <Show when={editing()} fallback={<MessageBody m={props.m} />}>
            <EditBox m={props.m} onDone={() => setEditing(false)} />
          </Show>
        }
      >
        <Dispatch m={props.m} />
      </Show>
      <Show when={props.m.attachments.length > 0 ? props.m.attachments : undefined}>{(files) => <Attachments files={files()} />}</Show>
      <Show when={props.m.deleted === undefined ? props.m.artifact : undefined}>{(card) => <ArtifactCard card={card()} />}</Show>
      <Show when={props.m.deleted === undefined && (props.m.blocks?.length ?? 0) > 0 ? props.m.blocks : undefined}>
        {(blocks) => (
          <div {...stylex.attrs(viewStyles.messageRowDiv2)}>
            <For each={blocks()} keyed={(b) => `${b.artifactId}:${b.blockId}`}>
              {(b) => (
                <div data-testid="message-quoted-block" data-key={b().blockId} {...stylex.attrs(viewStyles.messageQuotedBlock)}>
                  <Icon name="artifacts" size={12} />
                  <span {...stylex.attrs(viewStyles.messageRowSpan)}>
                    {t("web.channel.messages.quotedBlock", {
                      title: b().title,
                      text: b().deleted === true ? t("web.channel.messages.quotedGone") : (b().text ?? ""),
                    })}
                  </span>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
      <Show when={props.m.deleted === undefined && props.m.text}>{(text) => <LinkedMessages text={text()} />}</Show>
      <Show when={props.m.deleted === undefined && props.m.embeds.length > 0 ? props.m.embeds : undefined}>{(embeds) => <Embeds embeds={embeds()} />}</Show>
      <Show when={props.m.reactions.length > 0}>
        <Reactions m={props.m} names={nameOf} />
      </Show>
      <Show when={props.m.spent && props.m.kind === "report" ? props.m.spent : undefined}>
        {(spent) => (
          <div {...stylex.attrs(viewStyles.messageRowDiv3)}>
            <Icon name="spend" size={12} />
            {t("web.channel.messages.spent", { spent: spentText(spent()) })}
          </div>
        )}
      </Show>
      <Show when={props.m.fromRole === "orchestrator" && props.m.kind !== "dispatch"}>
        <RunSteps session={props.m.from} run={props.m.run} orchestrator />
      </Show>
      <Show when={props.m.fromRole === "worker" && props.m.kind === "report"}>
        <RunSteps session={props.m.from} run={props.m.run} />
      </Show>
      <Show when={props.thread}>{(thread) => <ThreadPreview thread={thread()} />}</Show>
    </Frame>
  );
}

function ThreadPreview(props: { thread: Channel }) {
  const core = useCore();
  const router = useRouter();
  const now = useNow();
  const unread = () => unreadIn(props.thread);
  const last = () => props.thread.last;
  const session = () => threadOwnerOf(props.thread, core()?.sessions ?? []);
  return (
    <button
      type="button"
      data-testid="thread-preview"
      data-key={props.thread.id}
      data-subject={props.thread.subjectKind}
      onClick={() => router.navigate(chatPath(props.thread))}
      {...stylex.attrs(viewStyles.threadButton, threadPreview)}
    >
      <span {...stylex.attrs(viewStyles.threadPreviewSpan)}>
        <Icon name="thread" size={16} />
        <span {...stylex.attrs(viewStyles.threadPreviewSpan2)}>
          {props.thread.replies > 0
            ? t("web.channel.replies", { n: props.thread.replies })
            : props.thread.subjectKind === "issue"
              ? t("web.channel.issues.thread")
              : t("web.channel.names.thread")}
        </span>
        <Show when={unread() > 0}>
          <Tag label={t("web.channel.messages.unread", { n: unread() })} tone="ok" />
        </Show>
        <Show when={session()} fallback={<span {...stylex.attrs(viewStyles.threadPreviewSpan3)} />}>
          {(s) => (
            <>
              <PhaseGlyph phase={s().phase} />
              <span {...stylex.attrs(viewStyles.threadPreviewSpan4)}>{phaseText(s(), now())}</span>
            </>
          )}
        </Show>
        <Icon name="expand" size={12} styles={viewStyles.threadIcon} />
      </span>
      <Show when={last()}>
        {(m) => (
          <span {...stylex.attrs(viewStyles.threadPreviewSpan5)}>
            <span {...stylex.attrs(viewStyles.threadPreviewSpan6)}>{m().from === userId ? t("web.channel.messages.user") : m().name}</span>
            <span {...stylex.attrs(viewStyles.threadPreviewSpan7)}>{plainText(m().text)}</span>
            <span {...stylex.attrs(viewStyles.dispatchSpan2)}>{workbenchClock(m().at)}</span>
          </span>
        )}
      </Show>
    </button>
  );
}
