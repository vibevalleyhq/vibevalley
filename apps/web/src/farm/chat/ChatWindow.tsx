// The farm's chat, 田头: the right screen of the farm phone when it is unfolded (Phone.tsx), filling it: a head (the channel
// menu and what the orchestrator is doing, or a thread's title and its helper), the messages newest at the bottom with the
// lines just sent and not yet back from the server, a few lines to say, and the input row. Double-clicking the head makes
// the phone large.

import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Agent, type ChatMessage, type Channel, type WorkspaceState } from "@vibevalley/protocol";

import { newSendKey } from "@/base/api";
import { messageOf } from "@/base/format";
import { orchestratorMood, useCore } from "@/base/frame";
import { ready, useAgents } from "@/base/query";
import { useRouter } from "@/base/router";
import { useNow } from "@/base/util";
import { farm } from "@/farm/store";
import { useFarm } from "@/farm/ui";
import {
  arrived,
  pending,
  say,
  topOf,
  channelOf,
  feedOf,
  defaultOf,
  orchestratorTyping,
  parentAt,
  phaseText,
  threadOwnerOf,
  threadTitle,
  unreadIn,
  useMarkRead,
  followed,
  useMessage,
  useFollowed,
} from "@/features/channel";
import { RunSteps } from "@/features/session";
import { liveCaptions, type SpokenLine, voiceCall, type VoiceCall, createCall } from "@/features/voice";
import { OrchestratorFace } from "@/ui/Face";
import { PxButton, SpriteIcon } from "@/ui/pixel";
import { playSound } from "@/ui/pixel/sound";

import { ChannelMenu } from "./ChannelMenu";
import { type ChatPhase, FarmComposer } from "./Composer";
import { farmChannelLabel } from "./labels";
import { ChatBubble, ChatReport, ChatRow, FaceOf, ParentMessage, ThreadChip } from "./Messages";

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

const small = "font-pixel text-[12px] leading-4 text-bark-500";

/** What the orchestrator is doing: on a call, what the call says; else from the farm's state. */
const phaseOf = (v: VoiceCall, s: WorkspaceState | undefined): ChatPhase => {
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
    <span class="inline-flex gap-0.5" aria-hidden="true">
      <For each={[0, 1, 2]}>{(i) => <span class="h-1 w-1 animate-pulse bg-bark-500" style={{ "animation-delay": `${i * 0.2}s` }} />}</For>
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
      class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center hover:bg-cream-200 active:bg-cream-300"
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
          class="ml-2 shrink-0 cursor-pointer bg-berry/15 px-2 py-px text-[12px] text-berry hover:bg-berry/25"
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
  const said = useFollowed(() => shown()?.id);
  useMarkRead(shown);

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
  const sending = createMemo(() => {
    const here = shown()?.id;
    return pending().filter((p) => p.channel === here && !arrived(p, said().messages));
  });
  // What is being said on the call, drawn as it is said: the turns 田头 does not have as lines yet. A copy each time, so
  // the rows read the words they grew to.
  const tick = useNow(1000);
  const captions = createMemo(() => {
    const c = call();
    const here = shown();
    if (c.phase !== "live" || here?.default !== true) return [];
    const spoken: SpokenLine[] = said()
      .messages.filter((m) => m.spoken)
      .map((m) => ({ speaker: m.fromKind === "owner" ? "you" : "orchestrator", text: m.text }));
    return liveCaptions(c.captions.turns, spoken, tick()).map((turn) => ({ ...turn }));
  });
  // On a call the captions show what is being said; the dots are for the chat.
  const thinking = () => captions().length === 0 && orchestratorTyping(core(), shown()) !== undefined;
  const showSuggestions = () => !thread() && (core()?.call === "live" || (said().ready && said().messages.length === 0));

  return (
    <section aria-label={t("web.farm.chat.label")} data-testid="farm-chat" class="relative h-full w-full">
      <div class="flex h-full flex-col overflow-hidden bg-cream-50 font-pixel text-[12px] leading-[1.625] text-bark-900">
        <Show
          when={thread()}
          fallback={
            <div onDblClick={onHeadDouble} class="flex shrink-0 items-center gap-1 border-b border-cream-200 py-2 pr-2 pl-3">
              <div class="min-w-0 flex-1">
                <div class="flex items-center">
                  <SpriteIcon name="icon-board" size={20} />
                  <span class="ml-2 min-w-0">
                    <ChannelMenu current={shown()} />
                  </span>
                  <NewElsewhere except={shown()?.id} />
                </div>
                <p class={["flex h-4 items-center gap-1.5", small]} aria-live="polite">
                  <span class="truncate">{phaseWords[phase()]}</span>
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
          class="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto p-3"
          aria-label={thread() ? t("web.farm.chat.thread") : farmChannelLabel(shown())}
          role="log"
          data-testid="messages"
        >
          <div class="flex flex-col gap-2">
            <Show when={hasOlder() && shown()}>
              <button
                type="button"
                onClick={() => void followed.loadOlder(shown()!.id)}
                class={["self-center px-2.5 py-0.5 hover:bg-cream-200 hover:text-bark-800", small]}
              >
                {t("web.farm.chat.older")}
              </button>
            </Show>
            <Show when={parent()}>{(m) => <ParentMessage m={m()} face={<FaceOf m={m()} agents={agents()} />} />}</Show>
            <Show when={items().length === 0 && !thread()}>
              <ChatRow mine={false} first face={<OrchestratorFace size={30} />} name={t("web.farm.orchestrator")}>
                <span class="whitespace-pre-line">{greeting}</span>
              </ChatRow>
            </Show>
            <Show when={items().length === 0 && thread()}>
              <p class={["py-4 text-center", small]}>{t("web.farm.chat.threadEmpty")}</p>
            </Show>
            <For each={items()} keyed={(item) => item.message.id}>
              {(item, i) => (
                <div
                  data-testid="message"
                  data-key={item().message.id}
                  data-from={item().message.from}
                  data-from-kind={item().message.fromKind}
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
                <div class="opacity-70" aria-label={t("web.farm.chat.sending")} data-testid="message" data-from-kind="owner" data-state="sending">
                  <ChatRow mine first title={t("web.farm.chat.sending")}>
                    <span class="whitespace-pre-line">{p().text}</span>
                  </ChatRow>
                </div>
              )}
            </For>
            <For each={captions()} keyed={(caption) => caption.speaker + caption.turn}>
              {(caption) => (
                <div class="opacity-70" aria-label={t("web.farm.chat.captions")}>
                  <ChatRow
                    mine={caption().speaker === "you"}
                    first
                    face={caption().speaker === "you" ? undefined : <OrchestratorFace size={30} />}
                    name={caption().speaker === "you" ? undefined : t("web.farm.orchestrator")}
                    title={caption().done ? t("web.farm.chat.done") : t("web.farm.chat.speaking")}
                  >
                    <span class="whitespace-pre-line">{caption().text}</span>
                    <Show when={!caption().done}>
                      <span class="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle" aria-hidden="true" />
                    </Show>
                  </ChatRow>
                </div>
              )}
            </For>
            <Show when={thinking()}>
              <ChatRow mine={false} first face={<OrchestratorFace size={30} />}>
                <span class="flex h-5 items-center px-1">
                  <Dots />
                </span>
              </ChatRow>
            </Show>
          </div>
        </div>
        <Show when={problem()}>
          <p role="alert" data-testid="chat-problem" class="px-3 py-0.5 text-[12px] text-berry">
            {problem()}
          </p>
        </Show>
        <Show when={showSuggestions()}>
          <div class="flex shrink-0 scroll-fade-x gap-1.5 overflow-x-auto px-3 pb-2">
            <For each={suggestions}>
              {(line) => (
                <button
                  type="button"
                  onClick={() => {
                    setProblem(undefined);
                    const c = shown();
                    if (!c) return;
                    void say(line, c, newSendKey(), undefined).catch((e: unknown) => setProblem(t("web.farm.chat.notSent", { why: messageOf(e) })));
                  }}
                  class="max-w-40 shrink-0 cursor-pointer truncate bg-cream-200 px-2.5 py-0.5 text-[12px] text-bark-800 hover:bg-leaf-300 hover:text-bark-900"
                >
                  {line}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="mt-auto">
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
      <div role="alert" data-testid="call-problem" class="shrink-0 border-b border-cream-200 bg-berry/10">
        <div class="flex flex-col gap-2 px-3 py-2.5 font-pixel text-[12px] leading-[1.625] text-bark-900">
          <div class="flex items-start gap-2">
            <span class="min-w-0 flex-1">{t("web.farm.chat.noVoice", { why: props.call.problem })}</span>
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
    <div onDblClick={(e) => props.onDouble(e)} class="flex shrink-0 items-center gap-1 border-b border-cream-200 py-2 pr-2 pl-1">
      <HeadButton
        testid="chat-back"
        label={t("web.farm.chat.back", { channel: farmChannelLabel(channel()) })}
        sprite="button-back"
        onClick={() => farm.showChat(backTo())}
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-[13px]">{title()}</span>
          <Show when={session()}>{(s) => <span class="shrink-0 bg-cream-200 px-1.5 font-mono text-[12.5px] text-bark-600">@{s().id}</span>}</Show>
          <NewElsewhere except={props.thread.id} />
        </div>
        <p class={["h-4 truncate", small]}>{status()}</p>
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
    props.m.fromKind === "orchestrator" && props.m.kind !== "dispatch" ? <RunSteps session={props.m.from} run={props.m.run} orchestrator /> : undefined;
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
            <div class="flex flex-col items-start">
              {turn()}
              {chip()}
            </div>
          }
        />
      }
    >
      <Match when={props.m.kind === "notice" || props.m.fromKind === "system"}>
        <p class={["px-4 text-center leading-[1.625]", small]}>{props.m.text}</p>
      </Match>
      <Match when={props.m.kind === "report"}>
        <ChatReport
          m={props.m}
          first={props.first}
          face={face()}
          steps={props.m.fromKind === "session" ? <RunSteps session={props.m.from} run={props.m.run} /> : undefined}
        />
      </Match>
      <Match when={props.m.fromKind === "owner"}>
        <ChatBubble m={props.m} mine first={props.first} after={chip()} />
      </Match>
    </Switch>
  );
}
