import * as stylex from "@stylexjs/stylex";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Agent, type ChatMessage, type Channel, type SpaceState } from "@vibevalley/protocol";
import { channelOf, defaultOf } from "@vibevalley/protocol/rules";

import { useNow } from "#/base/dom.tsx";
import { farm, farmChannelLabel, useFarm } from "#/farm/store.ts";
import {
  chatSay,
  pendingLines,
  topOf,
  feedOf,
  orchestratorTyping,
  parentAt,
  phaseText,
  threadOwnerOf,
  threadTitle,
  unreadIn,
  useMarkRead,
  followed,
  useMessage,
  useMarkedFollowed,
} from "#/features/channel/index.ts";
import { RunSteps } from "#/features/session/index.ts";
import { liveCaptions, type SpokenLine, voiceCall, type VoiceCall, createCall } from "#/features/voice/index.ts";
import { orchestratorMood, useCore } from "#/infra/frame.ts";
import { ready, useAgents } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { sendOnce, useIntents } from "#/state/intent.ts";
import { OrchestratorFace } from "#/ui/Face.tsx";
import { noticeTitle, PxButton, SpriteIcon, ToastType, toasts } from "#/ui/pixel/index.ts";
import { playSound } from "#/ui/pixel/sound.ts";

import { ChannelMenu } from "./ChannelMenu";
import { type ChatPhase, FarmComposer } from "./Composer";
import { ChatBubble, ChatReport, ChatRow, FaceOf, ParentMessage, ThreadChip } from "./Messages";

const typingPulse = stylex.keyframes({ "50%": { opacity: 0.5 } });

const recipeStyles2 = stylex.create({
  dotsSpan: {
    height: "var(--spacing)",
    width: "var(--spacing)",
    animationName: { default: typingPulse, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "2s",
    animationDelay: "0s",
    animationTimingFunction: "cubic-bezier(.4, 0, .6, 1)",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    backgroundColor: "var(--color-bark-500)",
  },
  chatWindowSpan: {
    marginLeft: "calc(var(--spacing) * .5)",
    display: "inline-block",
    height: "calc(var(--spacing) * 3)",
    width: "calc(var(--spacing) * 1.5)",
    animationName: { default: typingPulse, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "2s",
    animationDelay: "0s",
    animationTimingFunction: "cubic-bezier(.4, 0, .6, 1)",
    animationIterationCount: "infinite",
    animationDirection: "normal",
    animationFillMode: "none",
    animationPlayState: "running",
    backgroundColor: "currentColor",
    verticalAlign: "middle",
  },
  chatWindowDiv: {
    display: "flex",
    flexShrink: "0",
    WebkitMaskImage: "linear-gradient(to right, transparent, black var(--fade-left), black calc(100% - var(--fade-right)), transparent)",
    maskImage: "linear-gradient(to right, transparent, black var(--fade-left), black calc(100% - var(--fade-right)), transparent)",
    animationName: "scroll-fade-x",
    animationDuration: "0s",
    animationDelay: "0s",
    animationTimingFunction: "linear",
    animationIterationCount: "1",
    animationDirection: "normal",
    animationFillMode: "both",
    animationPlayState: "running",
    animationTimeline: "scroll(self x)",
    gap: "calc(var(--spacing) * 1.5)",
    overflowX: "auto",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBottom: "calc(var(--spacing) * 2)",
  },
});

const recipeStyles = stylex.create({
  chatWindowP: {
    display: "flex",
    height: "calc(var(--spacing) * 4)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "calc(var(--spacing) * 4)",
    color: "var(--color-bark-500)",
  },
  chatWindowButton: {
    alignSelf: "center",
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "calc(var(--spacing) * 4)",
    color: {
      default: "var(--color-bark-500)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-bark-800)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
    },
  },
  chatWindowP2: {
    paddingBlock: "calc(var(--spacing) * 4)",
    textAlign: "center",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "calc(var(--spacing) * 4)",
    color: "var(--color-bark-500)",
  },
  threadHeadP: {
    height: "calc(var(--spacing) * 4)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "calc(var(--spacing) * 4)",
    color: "var(--color-bark-500)",
  },
  itemP: {
    paddingInline: "calc(var(--spacing) * 4)",
    textAlign: "center",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.625",
    color: "var(--color-bark-500)",
  },
});

const variantStyles = stylex.create({
  chatWindowDiv: {
    display: "flex",
    minHeight: "0",
    flex: "1",
    flexDirection: "column-reverse",
    overflowY: "auto",
    padding: "calc(var(--spacing) * 3)",
  },
  chatWindowDiv2: {},
  chatWindowDivVariant: {
    opacity: ".7",
  },
});

const viewStyles = stylex.create({
  dotsSpan: {
    display: "inline-flex",
    gap: "calc(var(--spacing) * .5)",
  },
  headButtonButton: {
    display: "flex",
    height: "calc(var(--spacing) * 8)",
    width: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-200)",
      },
      ":active": "var(--color-cream-300)",
    },
  },
  newElsewhereButton: {
    marginLeft: "calc(var(--spacing) * 2)",
    flexShrink: "0",
    cursor: "pointer",
    backgroundColor: {
      default: "var(--color-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-berry) 15%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-berry)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--color-berry) 25%, transparent)",
        },
      },
    },
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "1px",
    fontSize: "12px",
    color: "var(--color-berry)",
  },
  farmChat: {
    position: "relative",
    height: "100%",
    width: "100%",
  },
  chatWindowDiv: {
    display: "flex",
    height: "100%",
    flexDirection: "column",
    overflow: "hidden",
    backgroundColor: "var(--color-cream-50)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.625",
    color: "var(--color-bark-900)",
  },
  chatWindowDiv2: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: "var(--spacing)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-cream-200)",
    paddingBlock: "calc(var(--spacing) * 2)",
    paddingRight: "calc(var(--spacing) * 2)",
    paddingLeft: "calc(var(--spacing) * 3)",
  },
  chatWindowDiv3: {
    minWidth: "0",
    flex: "1",
  },
  chatWindowDiv4: {
    display: "flex",
    alignItems: "center",
  },
  chatWindowSpan: {
    marginLeft: "calc(var(--spacing) * 2)",
    minWidth: "0",
  },
  chatWindowSpan2: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  chatWindowDiv5: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  chatWindowSpan3: {
    whiteSpace: "pre-line",
  },
  chatWindowDiv6: {
    display: "flex",
    justifyContent: "flex-end",
    gap: "calc(var(--spacing) * 1.5)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBottom: "var(--spacing)",
    fontSize: "12px",
  },
  chatWindowSpan4: {
    minWidth: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    color: "var(--color-berry)",
  },
  pendingRetry: {
    cursor: "pointer",
    backgroundColor: {
      default: "var(--color-cream-200)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-leaf-300)",
      },
    },
    paddingInline: "calc(var(--spacing) * 1.5)",
    color: "var(--color-bark-800)",
  },
  pendingDrop: {
    cursor: "pointer",
    backgroundColor: {
      default: "var(--color-cream-200)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-300)",
      },
    },
    paddingInline: "calc(var(--spacing) * 1.5)",
    color: "var(--color-bark-800)",
  },
  chatWindowDiv7: {
    opacity: ".7",
  },
  chatWindowSpan5: {
    display: "flex",
    height: "calc(var(--spacing) * 5)",
    alignItems: "center",
    paddingInline: "var(--spacing)",
  },
  chatProblem: {
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "12px",
    color: "var(--color-berry)",
  },
  chatWindowButton: {
    maxWidth: "calc(var(--spacing) * 40)",
    flexShrink: "0",
    cursor: "pointer",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    backgroundColor: {
      default: "var(--color-cream-200)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-leaf-300)",
      },
    },
    paddingInline: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "12px",
    color: {
      default: "var(--color-bark-800)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-bark-900)",
      },
    },
  },
  chatWindowDiv8: {
    marginTop: "auto",
  },
  callProblem: {
    flexShrink: "0",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-cream-200)",
    backgroundColor: {
      default: "var(--color-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-berry) 10%, transparent)",
    },
  },
  callProblemDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2.5)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1.625",
    color: "var(--color-bark-900)",
  },
  callProblemDiv2: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2)",
  },
  threadHeadDiv: {
    display: "flex",
    flexShrink: "0",
    alignItems: "center",
    gap: "var(--spacing)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-cream-200)",
    paddingBlock: "calc(var(--spacing) * 2)",
    paddingRight: "calc(var(--spacing) * 2)",
    paddingLeft: "var(--spacing)",
  },
  threadHeadDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  threadHeadSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "13px",
  },
  threadHeadSpan2: {
    flexShrink: "0",
    backgroundColor: "var(--color-cream-200)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    fontFamily: "var(--font-mono)",
    fontSize: "12.5px",
    color: "var(--color-bark-600)",
  },
  itemDiv: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
  },
});

const suggestions = ([0, 1, 2, 3] as const).map((i) => t(`web.farm.chat.suggestions.${i}`));

const greeting = t("web.farm.chat.greeting");

const phaseWords: Record<ChatPhase, string> = {
  off: t("web.farm.chat.phase.off"),
  connecting: t("web.farm.chat.phase.connecting"),
  listening: t("web.farm.chat.phase.listening"),
  thinking: t("web.farm.chat.phase.thinking"),
  speaking: t("web.farm.chat.phase.speaking"),
  error: t("web.farm.chat.phase.error"),
};

/** What the orchestrator is doing: on a call, what the call says; else from the farm's state. */
const phaseOf = (v: VoiceCall, s: SpaceState | undefined): ChatPhase => {
  if (v.phase === "connecting" || v.phase === "ending") return "connecting";
  if (v.phase === "live")
    return !v.agentHere ? "connecting" : v.agentState === "speaking" ? "speaking" : v.agentState === "thinking" ? "thinking" : "listening";
  if (!s) return "off";
  if (s.call === "connecting") return "connecting";
  if (s.call === "error" || v.problem !== "") return "error";
  if (s.call !== "live") return "off";
  const mood = orchestratorMood(s);
  return mood === "speaking" ? "speaking" : mood === "thinking" ? "thinking" : "listening";
};

function Dots() {
  return (
    <span {...stylex.attrs(viewStyles.dotsSpan)} aria-hidden="true">
      <For each={[0, 1, 2]}>{(i) => <span {...stylex.attrs(recipeStyles2.dotsSpan)} style={{ "animation-delay": `${i * 0.2}s` }} />}</For>
    </span>
  );
}

function HeadButton(props: { label: string; testid: string; sprite: string; onClick: () => void }) {
  return (
    <button
      type="button"
      data-testid={props.testid}
      aria-label={props.label}
      title={props.label}
      onClick={() => props.onClick()}
      onDblClick={(e) => e.stopPropagation()}
      {...stylex.attrs(viewStyles.headButtonButton)}
    >
      <SpriteIcon name={props.sprite} size={16} />
    </button>
  );
}

/** Where else there is something new, to go there in one tap. */
function NewElsewhere(props: { except: string | undefined }) {
  const core = useCore();
  const waiting = () => {
    const chat = core()?.chat;
    return (chat?.channels ?? []).filter((c) => c.id !== props.except && unreadIn(c) > 0);
  };
  return (
    <Show when={waiting().length > 0 ? waiting().reduce((a, b) => ((b.lastNumber ?? 0) > (a.lastNumber ?? 0) ? b : a)) : undefined}>
      {(newest) => (
        <button
          type="button"
          onClick={() => farm.showChat(newest().default ? undefined : newest().id)}
          onDblClick={(e) => e.stopPropagation()}
          {...stylex.attrs(viewStyles.newElsewhereButton)}
        >
          {waiting().length > 1
            ? t("web.farm.chat.newIn", { n: waiting().length })
            : newest().type === "thread"
              ? t("web.farm.chat.newInThread")
              : t("web.farm.chat.newInChannel", { channel: farmChannelLabel(newest()) })}
        </button>
      )}
    </Show>
  );
}

export function ChatWindow() {
  const core = useCore();
  const chat = () => core()?.chat;
  const agentsQuery = useAgents();
  const agents = createMemo(() => new Map<string, Agent>(ready(agentsQuery, []).map((a) => [a.id, a])));
  const large = useFarm((s) => s.chatLarge);
  const shownId = useFarm((s) => s.chatShown);
  const [problem, setProblem] = createSignal<string>();
  const shown = createMemo(() => (shownId() ? channelOf(chat(), shownId()) : undefined) ?? defaultOf(chat()));
  const thread = () => (shown()?.type === "thread" ? shown() : undefined);
  const call = createCall();
  const phase = () => phaseOf(call(), core());
  const said = useMarkedFollowed(() => shown()?.id);
  useMarkRead(shown, (reason) => toasts.add({ type: ToastType.error, title: noticeTitle.error ?? reason, description: reason }));

  const toggleLarge = () => farm.chatLarge(!large());
  const fold = () => {
    playSound("close");
    farm.chatOpen(false);
  };
  const onHeadDouble = (e: MouseEvent) => {
    e.preventDefault();
    toggleLarge();
  };

  const items = createMemo(() => feedOf(chat(), said().messages));
  const parent = useMessage(() => {
    const current = thread();
    return current ? parentAt(chat(), current) : undefined;
  });
  const hasOlder = () => said().ready && !said().complete;
  const says = useIntents(chatSay);
  const sending = createMemo(() => pendingLines(says.list(), shown()?.id, said().messages));
  const notSent = (reason: string | undefined) => setProblem(t("web.farm.chat.notSent", { why: reason ?? "" }));
  // What is being said on the call, drawn as it is said: the turns the farm chat does not have as lines yet.
  const tick = useNow(1000);
  const captions = createMemo(() => {
    const c = call();
    const here = shown();
    if (c.phase !== "live" || here?.default !== true) return [];
    const spoken: SpokenLine[] = said()
      .messages.filter((m) => m.spoken)
      .map((m) => ({ speaker: m.fromKind === "user" ? "you" : "orchestrator", text: m.text }));
    return liveCaptions(c.captions.turns, spoken, tick()).map((turn) => ({ ...turn }));
  });
  // On a call the captions show what is being said; the dots are for the chat.
  const thinking = () => captions().length === 0 && orchestratorTyping(core(), shown()) !== undefined;
  const showSuggestions = () => !thread() && (core()?.call === "live" || (said().ready && said().messages.length === 0));

  return (
    <section aria-label={t("web.farm.chat.label")} data-testid="farm-chat" {...stylex.attrs(viewStyles.farmChat)}>
      <div {...stylex.attrs(viewStyles.chatWindowDiv)}>
        <Show
          when={thread()}
          fallback={
            <div onDblClick={onHeadDouble} {...stylex.attrs(viewStyles.chatWindowDiv2)}>
              <div {...stylex.attrs(viewStyles.chatWindowDiv3)}>
                <div {...stylex.attrs(viewStyles.chatWindowDiv4)}>
                  <SpriteIcon name="icon-board" size={20} />
                  <span {...stylex.attrs(viewStyles.chatWindowSpan)}>
                    <ChannelMenu current={shown()} />
                  </span>
                  <NewElsewhere except={shown()?.id} />
                </div>
                <p {...stylex.attrs(recipeStyles.chatWindowP)} aria-live="polite">
                  <span {...stylex.attrs(viewStyles.chatWindowSpan2)}>{phaseWords[phase()]}</span>
                  <Show when={phase() === "thinking" || phase() === "connecting"}>
                    <Dots />
                  </Show>
                </p>
              </div>
              <HeadButton
                testid="chat-large"
                label={large() ? t("web.farm.chat.restore") : t("web.farm.chat.enlarge")}
                sprite={large() ? "button-shrink" : "button-enlarge"}
                onClick={toggleLarge}
              />
              <HeadButton testid="chat-fold" label={t("web.farm.chat.fold")} sprite="button-collapse" onClick={fold} />
            </div>
          }
        >
          {(shown) => <ThreadHead thread={shown()} large={large()} onLarge={toggleLarge} onFold={fold} onDouble={onHeadDouble} />}
        </Show>
        <CallProblem call={call()} />
        <div
          {...stylex.attrs(variantStyles.chatWindowDiv)}
          aria-label={thread() ? t("web.farm.chat.thread") : farmChannelLabel(shown())}
          role="log"
          data-testid="messages"
        >
          <div {...stylex.attrs(viewStyles.chatWindowDiv5)}>
            <Show when={hasOlder() && shown()}>
              <button type="button" onClick={() => void followed.loadOlder(shown()!.id)} {...stylex.attrs(recipeStyles.chatWindowButton)}>
                {t("web.farm.chat.older")}
              </button>
            </Show>
            <Show when={parent()}>{(m) => <ParentMessage m={m()} face={<FaceOf m={m()} agents={agents()} />} />}</Show>
            <Show when={items().length === 0 && !thread()}>
              <ChatRow mine={false} first face={<OrchestratorFace size={30} />} name={t("web.farm.orchestrator")}>
                <span {...stylex.attrs(viewStyles.chatWindowSpan3)}>{greeting}</span>
              </ChatRow>
            </Show>
            <Show when={items().length === 0 && thread()}>
              <p {...stylex.attrs(recipeStyles.chatWindowP2)}>{t("web.farm.chat.threadEmpty")}</p>
            </Show>
            <For each={items()} keyed={(item) => item.message.id}>
              {(item, i) => (
                <div
                  data-testid="message"
                  data-key={item().message.id}
                  data-from={item().message.from}
                  data-from-kind={item().message.fromKind}
                  data-from-role={item().message.fromRole}
                  data-kind={item().message.kind}
                  data-deleted={item().message.deleted !== undefined ? "" : undefined}
                  data-edited={item().message.edited !== undefined ? "" : undefined}
                >
                  <Item
                    m={item().message}
                    thread={item().thread}
                    first={i() === 0 || items()[i() - 1]!.message.from !== item().message.from}
                    agents={agents()}
                    chatUnread={(channel) => unreadIn(channel)}
                  />
                </div>
              )}
            </For>
            <For each={sending()} keyed={(p) => p.key}>
              {(p) => (
                <div
                  {...stylex.attrs(variantStyles.chatWindowDiv2, p().state === "failed" ? variantStyles.chatWindowDiv2 : variantStyles.chatWindowDivVariant)}
                  aria-label={p().state === "failed" ? t("web.farm.chat.notSentLine") : t("web.farm.chat.sending")}
                  data-testid="message"
                  data-key={p().key}
                  data-from-kind="user"
                  data-state={p().state}
                >
                  <ChatRow mine first title={p().state === "failed" ? (p().reason ?? t("web.farm.chat.notSentLine")) : t("web.farm.chat.sending")}>
                    <span {...stylex.attrs(viewStyles.chatWindowSpan3)}>{p().text}</span>
                  </ChatRow>
                  <Show when={p().state === "failed"}>
                    <div {...stylex.attrs(viewStyles.chatWindowDiv6)}>
                      <span {...stylex.attrs(viewStyles.chatWindowSpan4)}>{p().reason ?? t("web.farm.chat.notSentLine")}</span>
                      <button
                        type="button"
                        data-testid="pending-retry"
                        onClick={() => {
                          setProblem(undefined);
                          void says.retry(p().key).then((end) => end?.phase === "failed" && notSent(end.fault.reason));
                        }}
                        {...stylex.attrs(viewStyles.pendingRetry)}
                      >
                        {t("web.farm.chat.retrySend")}
                      </button>
                      <button type="button" data-testid="pending-drop" onClick={() => says.drop(p().key)} {...stylex.attrs(viewStyles.pendingDrop)}>
                        {t("web.farm.chat.dropSend")}
                      </button>
                    </div>
                  </Show>
                </div>
              )}
            </For>
            <For each={captions()} keyed={(caption) => caption.speaker + caption.turn}>
              {(caption) => (
                <div {...stylex.attrs(viewStyles.chatWindowDiv7)} aria-label={t("web.farm.chat.captions")}>
                  <ChatRow
                    mine={caption().speaker === "you"}
                    first
                    face={caption().speaker === "you" ? undefined : <OrchestratorFace size={30} />}
                    name={caption().speaker === "you" ? undefined : t("web.farm.orchestrator")}
                    title={caption().done ? t("web.farm.chat.done") : t("web.farm.chat.speaking")}
                  >
                    <span {...stylex.attrs(viewStyles.chatWindowSpan3)}>{caption().text}</span>
                    <Show when={!caption().done}>
                      <span {...stylex.attrs(recipeStyles2.chatWindowSpan)} aria-hidden="true" />
                    </Show>
                  </ChatRow>
                </div>
              )}
            </For>
            <Show when={thinking()}>
              <ChatRow mine={false} first face={<OrchestratorFace size={30} />}>
                <span {...stylex.attrs(viewStyles.chatWindowSpan5)}>
                  <Dots />
                </span>
              </ChatRow>
            </Show>
          </div>
        </div>
        <Show when={problem() ?? (said().error === undefined ? undefined : t("web.farm.chat.unread", { why: said().error ?? "" }))}>
          {(line) => (
            <p role="alert" data-testid="chat-problem" {...stylex.attrs(viewStyles.chatProblem)}>
              {line()}
            </p>
          )}
        </Show>
        <Show when={showSuggestions()}>
          <div {...stylex.attrs(recipeStyles2.chatWindowDiv)}>
            <For each={suggestions}>
              {(line) => (
                <button
                  type="button"
                  onClick={() => {
                    setProblem(undefined);
                    const c = shown();
                    if (!c) return;
                    void sendOnce(says, { id: c.id, text: line }).then((end) => end?.phase === "failed" && notSent(end.fault.reason));
                  }}
                  {...stylex.attrs(viewStyles.chatWindowButton)}
                >
                  {line}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div {...stylex.attrs(viewStyles.chatWindowDiv8)}>
          <FarmComposer channel={shown()} thread={!!thread()} onProblem={setProblem} />
        </div>
      </div>
    </section>
  );
}

/** Why the last call did not connect, under the head: when a setting fixes it, a way to that section. */
function CallProblem(props: { call: VoiceCall }) {
  const router = useRouter();
  const open = () => props.call.phase === "idle" && props.call.problem !== "";
  return (
    <Show when={open()}>
      <div role="alert" data-testid="call-problem" {...stylex.attrs(viewStyles.callProblem)}>
        <div {...stylex.attrs(viewStyles.callProblemDiv)}>
          <div {...stylex.attrs(viewStyles.callProblemDiv2)}>
            <span {...stylex.attrs(viewStyles.chatWindowDiv3)}>{t("web.farm.chat.noVoice", { why: props.call.problem })}</span>
            <PxButton size="sm" icon="button-close" data-testid="call-problem-dismiss" label={t("web.farm.chat.gotIt")} onClick={() => voiceCall.dismiss()} />
          </div>
          <Show when={props.call.problemAt}>
            {(at) => (
              <div>
                <PxButton
                  tone="primary"
                  size="sm"
                  data-testid="call-problem-fix"
                  onClick={() => {
                    voiceCall.dismiss();
                    router.navigate(`/settings/${at()}`);
                  }}
                >
                  {t("web.farm.chat.settings")}
                </PxButton>
              </div>
            )}
          </Show>
        </div>
      </div>
    </Show>
  );
}

function ThreadHead(props: { thread: Channel; large: boolean; onLarge: () => void; onFold: () => void; onDouble: (e: MouseEvent) => void }) {
  const core = useCore();
  const now = useNow();
  const chat = () => core()?.chat;
  const channel = () => topOf(chat(), props.thread);
  const backTo = () => (channel()?.type === "channel" ? channel()!.id : undefined);
  const session = () => threadOwnerOf(props.thread, core()?.sessions ?? []);
  const title = () => threadTitle(props.thread, core()?.issues, core()?.sessions ?? []);
  const status = () => {
    const s = session();
    return s
      ? phaseText(s, now())
      : props.thread.subjectKind === "issue"
        ? t("web.farm.chat.nobodyOnIt")
        : t("web.farm.chat.replies", { n: props.thread.replies });
  };
  return (
    <div onDblClick={(e) => props.onDouble(e)} {...stylex.attrs(viewStyles.threadHeadDiv)}>
      <HeadButton
        testid="chat-back"
        label={t("web.farm.chat.back", { channel: farmChannelLabel(channel()) })}
        sprite="button-back"
        onClick={() => farm.showChat(backTo())}
      />
      <div {...stylex.attrs(viewStyles.chatWindowDiv3)}>
        <div {...stylex.attrs(viewStyles.threadHeadDiv2)}>
          <span {...stylex.attrs(viewStyles.threadHeadSpan)}>{title()}</span>
          <Show when={session()}>{(s) => <span {...stylex.attrs(viewStyles.threadHeadSpan2)}>@{s().id}</span>}</Show>
          <NewElsewhere except={props.thread.id} />
        </div>
        <p {...stylex.attrs(recipeStyles.threadHeadP)}>{status()}</p>
      </div>
      <HeadButton
        testid="chat-large"
        label={props.large ? t("web.farm.chat.restore") : t("web.farm.chat.enlarge")}
        sprite={props.large ? "button-shrink" : "button-enlarge"}
        onClick={() => props.onLarge()}
      />
      <HeadButton testid="chat-fold" label={t("web.farm.chat.fold")} sprite="button-collapse" onClick={() => props.onFold()} />
    </div>
  );
}

function Item(props: { m: ChatMessage; thread?: Channel | undefined; first: boolean; agents: ReadonlyMap<string, Agent>; chatUnread: (t: Channel) => number }) {
  const face = () => <FaceOf m={props.m} agents={props.agents} />;
  const chip = () => {
    const inThread = props.thread;
    return inThread ? <ThreadChip thread={inThread} unread={props.chatUnread(inThread)} onOpen={() => farm.showChat(inThread.id)} /> : undefined;
  };
  // The dispatch note is the farm's, under the orchestrator's name: its words say the same turn.
  const turn = () =>
    props.m.fromRole === "orchestrator" && props.m.kind !== "dispatch" ? <RunSteps session={props.m.from} run={props.m.run} orchestrator /> : undefined;
  return (
    <Switch
      fallback={
        <ChatBubble
          m={props.m}
          mine={false}
          first={props.first}
          face={face()}
          tag={props.m.kind === "dispatch" ? t("web.farm.chat.dispatch") : undefined}
          folded={props.m.kind === "dispatch"}
          after={
            <div {...stylex.attrs(viewStyles.itemDiv)}>
              {turn()}
              {chip()}
            </div>
          }
        />
      }
    >
      <Match when={props.m.kind === "notice" || props.m.fromKind === "system"}>
        <p {...stylex.attrs(recipeStyles.itemP)}>{props.m.text}</p>
      </Match>
      <Match when={props.m.kind === "report"}>
        <ChatReport
          m={props.m}
          first={props.first}
          face={face()}
          steps={props.m.fromRole === "worker" ? <RunSteps session={props.m.from} run={props.m.run} /> : undefined}
        />
      </Match>
      <Match when={props.m.fromKind === "user"}>
        <ChatBubble m={props.m} mine first={props.first} after={chip()} />
      </Match>
    </Switch>
  );
}
