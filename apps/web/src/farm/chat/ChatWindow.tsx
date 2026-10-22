// The farm's chat window, 田头: folded, the manager's face and the input row; open, a window of a fixed size drawn up
// over the picture from that row, so the farm never rescales: a head (the channel menu and what the manager is doing,
// or a thread's title and its helper), the messages newest at the bottom, a few lines to say, and the row.
// Double-clicking the head makes it large.

import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { type Agent, type ChatMessage, type Conversation, type WorkspaceState } from "@vibevalley/protocol";
import { newSendKey, say } from "./say";
import { playSound } from "../sound";
import { farm } from "../store";
import { channelOf, conversationOf, feedOf, generalOf, parentOf, phaseText, threadOwnerOf, threadTitle, unreadIn, unreadTotal } from "../../rules/chat";
import { voiceCall, type VoiceCall } from "../../voice/call";
import { useRouter } from "../../app/router";
import { useNow, useViewport } from "../../app/util";
import { createHistory, HistoryContext, useHistory, useMarkRead } from "../../pages/chat/data";
import { TurnSteps } from "../../pages/chat/WorkLog";
import { useCore } from "../../data/frame";
import { ready, useAgents } from "../../data/query";
import { ManagerFace } from "../../ui/Face";
import { createCall } from "../../voice/CallButton";
import { PxButton, PxWindow, SpriteIcon } from "../kit";
import { useFarm } from "../state";
import { ChannelMenu, channelLabel } from "./ChannelMenu";
import { type ChatPhase, FarmComposer } from "./Composer";
import { ChatBubble, ChatReport, ChatRow, FaceOf, ParentMessage, ThreadChip } from "./Messages";

const suggestions = ["让阿郑做字幕面板", "让小吴跑测试", "进度怎么样？", "大家收工"];

const greeting =
  "这里是田头，你、管家和帮工都在这儿说话。跟我说一句要做的活，比如「让测试小吴跑一遍测试」。\n\n帮工来了以后，写 @w1 这样的名字就是直接叫它；每个活下面挂着它的工单串。";

const phaseWords: Record<ChatPhase, string> = {
  off: "打字或者按麦克风，就开工",
  connecting: "正在接通管家…",
  listening: "管家在听",
  thinking: "管家在想…",
  speaking: "管家在说",
  error: "没接通，再试一次",
};

const small = "font-pixel text-[12px] leading-4 text-bark-500";

/** What the manager is doing: on a call, what the call says; else from the farm's state. */
const phaseOf = (v: VoiceCall, s: WorkspaceState | undefined): ChatPhase => {
  if (v.phase === "connecting" || v.phase === "ending") return "connecting";
  if (v.phase === "live")
    return !v.agentHere ? "connecting" : v.agentState === "speaking" ? "speaking" : v.agentState === "thinking" ? "thinking" : "listening";
  if (!s) return "off";
  if (s.call === "connecting") return "connecting";
  if (s.call === "error" || v.problem !== undefined) return "error";
  if (s.call !== "live") return "off";
  return s.manager === "speaking" ? "speaking" : s.manager === "thinking" ? "thinking" : "listening";
};

function Dots() {
  return (
    <span class="inline-flex gap-0.5" aria-hidden="true">
      <For each={[0, 1, 2]}>{(i) => <span class="h-1 w-1 animate-pulse bg-bark-500" style={{ "animation-delay": `${i * 0.2}s` }} />}</For>
    </span>
  );
}

function HeadButton(props: { label: string; sprite: string; onClick: () => void }) {
  return (
    <button
      type="button"
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
    return (chat?.conversations ?? []).filter((c) => c.id !== props.except && unreadIn(chat, c) > 0);
  };
  return (
    <Show when={waiting().length > 0 ? waiting().reduce((a, b) => ((b.lastNumber ?? 0) > (a.lastNumber ?? 0) ? b : a)) : undefined}>
      {(newest) => (
        <button
          type="button"
          onClick={() => farm.showChat(newest().kind === "general" ? null : newest().id)}
          onDblClick={(e) => e.stopPropagation()}
          class="ml-2 shrink-0 cursor-pointer bg-berry/15 px-2 py-px text-[12px] text-berry hover:bg-berry/25"
        >
          {waiting().length > 1 ? `${waiting().length} 处有新话` : newest().kind === "thread" ? "串里有新话" : `${channelLabel(newest())}有新话`}
        </button>
      )}
    </Show>
  );
}

export function ChatWindow() {
  const core = useCore();
  return (
    <HistoryContext value={createHistory(core)}>
      <Window />
    </HistoryContext>
  );
}

/** Whether a farm layer (a dialog) is open: its Esc closes it first. */
const farmStateHasLayers = () => document.querySelector("dialog[open]") !== null;

function Window() {
  const core = useCore();
  const chat = () => core()?.chat;
  const agentsQuery = useAgents();
  const agents = createMemo(() => new Map<string, Agent>(ready(agentsQuery, []).map((a) => [a.id, a])));
  const open = useFarm((s) => s.chatOpen);
  const large = useFarm((s) => s.chatLarge);
  const shownId = useFarm((s) => s.chatShown);
  const look = useFarm((s) => s.managerLook);
  const history = useHistory();
  const [problem, setProblem] = createSignal<string>();
  const shown = createMemo(() => (shownId() ? conversationOf(chat(), shownId()!) : undefined) ?? generalOf(chat()));
  const thread = () => (shown()?.kind === "thread" ? shown() : undefined);
  const call = createCall();
  const phase = () => phaseOf(call(), core());
  const unread = () => unreadTotal(chat());
  createEffect(
    () => (open() ? shown()?.id : undefined),
    (id) => {
      if (id) history.ensure(id);
    },
  );
  useMarkRead(core, () => (open() ? shown() : undefined));

  // Esc folds the window when nothing over it took the key.
  createEffect(open, (on) => {
    if (!on) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || farmStateHasLayers()) return;
      playSound("close");
      farm.chatOpen(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  });

  const viewport = useViewport();
  const size = () => {
    const { w, h } = viewport();
    const narrow = w < 640;
    return !open()
      ? { w: narrow ? w - 24 : 360, h: 60 }
      : large()
        ? { w: narrow ? w - 16 : Math.min(640, w - 192), h: Math.min(760, h - 120) }
        : { w: narrow ? w - 24 : 360, h: Math.min(460, h - 144) };
  };
  const toggleLarge = () => farm.chatLarge(!large());
  const fold = () => {
    playSound("close");
    farm.chatOpen(false);
  };
  const onHeadDouble = (e: MouseEvent) => {
    e.preventDefault();
    toggleLarge();
  };

  const more = () => {
    const c = shown();
    return c ? history.loaded[c.id] : undefined;
  };
  const items = createMemo(() => {
    const c = shown();
    return c ? feedOf(chat(), c.id, more()) : [];
  });
  const parent = () => {
    const t = thread();
    return t ? parentOf(chat(), t, more()) : undefined;
  };
  const hasOlder = () => more() !== undefined && !more()!.complete;
  const thinking = () => phase() === "thinking" && !thread() && items().at(-1)?.message.from !== "manager";
  const showSuggestions = () => !thread() && (core()?.call === "live" || (chat()?.messages ?? []).length === 0);

  return (
    <section
      aria-label="田头"
      class="pointer-events-auto relative transition-[width,height] duration-200 ease-out"
      style={{ width: `${Math.max(288, size().w)}px`, height: `${Math.max(60, size().h)}px` }}
    >
      <CallProblem call={call()} />
      <PxWindow class="flex h-full flex-col overflow-hidden font-pixel text-[12px] leading-[1.625] text-bark-900">
        <Show when={open() && size().h >= 160}>
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
                <HeadButton label={large() ? "还原对话窗口" : "放大对话窗口"} sprite={large() ? "button-shrink" : "button-enlarge"} onClick={toggleLarge} />
                <HeadButton label="收起对话" sprite="button-collapse" onClick={fold} />
              </div>
            }
          >
            {(t) => <ThreadHead thread={t()} large={large()} onLarge={toggleLarge} onFold={fold} onDouble={onHeadDouble} />}
          </Show>
          <div class="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto p-3" aria-label={thread() ? "工单串" : channelLabel(shown())} role="log">
            <div class="flex flex-col gap-2">
              <Show when={hasOlder() && shown()}>
                <button
                  type="button"
                  onClick={() => void history.loadOlder(shown()!.id)}
                  class={["self-center px-2.5 py-0.5 hover:bg-cream-200 hover:text-bark-800", small]}
                >
                  更早的消息
                </button>
              </Show>
              <Show when={parent()}>{(m) => <ParentMessage m={m()} face={<FaceOf m={m()} agents={agents()} />} />}</Show>
              <Show when={items().length === 0 && !thread()}>
                <ChatRow mine={false} first face={<ManagerFace size={30} look={look()} />} name="管家">
                  <span class="whitespace-pre-line">{greeting}</span>
                </ChatRow>
              </Show>
              <Show when={items().length === 0 && thread()}>
                <p class={["py-4 text-center", small]}>串里还没人说话。在这里说的话，它的帮工会看到。</p>
              </Show>
              <For each={items()} keyed={(item) => item.message.id}>
                {(item, i) => (
                  <Item
                    m={item().message}
                    thread={item().thread}
                    first={i() === 0 || items()[i() - 1]!.message.from !== item().message.from}
                    agents={agents()}
                    chatUnread={(t) => unreadIn(chat(), t)}
                  />
                )}
              </For>
              <Show when={thinking()}>
                <ChatRow mine={false} first face={<ManagerFace size={30} look={look()} />}>
                  <span class="flex h-5 items-center px-1">
                    <Dots />
                  </span>
                </ChatRow>
              </Show>
            </div>
          </div>
          <Show when={problem()}>
            <p class="px-3 py-0.5 text-[12px] text-berry">{problem()}</p>
          </Show>
          <Show when={showSuggestions()}>
            <div class="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-2 [mask-image:linear-gradient(to_right,black_85%,transparent)]">
              <For each={suggestions}>
                {(line) => (
                  <button
                    type="button"
                    onClick={() => {
                      setProblem(undefined);
                      const c = shown();
                      void say(line, c?.kind === "general" ? undefined : c, newSendKey(), undefined).catch((e: unknown) =>
                        setProblem(`没发出去：${e instanceof Error ? e.message : String(e)}`),
                      );
                    }}
                    class="max-w-40 shrink-0 cursor-pointer truncate bg-cream-200 px-2.5 py-0.5 text-[12px] text-bark-800 hover:bg-leaf-300 hover:text-bark-900"
                  >
                    {line}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </Show>
        <div class="mt-auto">
          <FarmComposer conversation={shown()} thread={!!thread()} phase={phase()} open={open()} unread={!open() && unread() > 0} onProblem={setProblem} />
        </div>
      </PxWindow>
    </section>
  );
}

/** Why the last call did not connect, over the window (folded too): when a setting fixes it, a way to that section. */
function CallProblem(props: { call: VoiceCall }) {
  const router = useRouter();
  const open = () => props.call.phase === "idle" && props.call.problem !== undefined;
  return (
    <Show when={open()}>
      <div role="alert" class="absolute right-0 bottom-full mb-2 w-full">
        <PxWindow class="flex flex-col gap-2 px-3 py-2.5 font-pixel text-[12px] leading-[1.625] text-bark-900">
          <div class="flex items-start gap-2">
            <span class="min-w-0 flex-1">语音没接通：{props.call.problem}</span>
            <PxButton size="sm" icon="button-close" label="知道了" onClick={() => voiceCall.dismiss()} />
          </div>
          <Show when={props.call.problemAt}>
            {(at) => (
              <div>
                <PxButton
                  tone="primary"
                  size="sm"
                  onClick={() => {
                    voiceCall.dismiss();
                    router.navigate(`/settings/${at()}`);
                  }}
                >
                  去设置
                </PxButton>
              </div>
            )}
          </Show>
        </PxWindow>
      </div>
    </Show>
  );
}

function ThreadHead(props: { thread: Conversation; large: boolean; onLarge: () => void; onFold: () => void; onDouble: (e: MouseEvent) => void }) {
  const core = useCore();
  const now = useNow();
  const chat = () => core()?.chat;
  const channel = () => channelOf(chat(), props.thread);
  const backTo = () => (channel()?.kind === "channel" ? channel()!.id : null);
  const session = () => threadOwnerOf(props.thread, core()?.sessions ?? []);
  const title = () => threadTitle(chat(), props.thread, core()?.issues ?? [], core()?.sessions ?? []);
  const status = () => {
    const s = session();
    return s ? phaseText(s, now()) : props.thread.subjectKind === "issue" ? "现在没有帮工在干，串还留着" : `${props.thread.replies} 条回复`;
  };
  return (
    <div onDblClick={(e) => props.onDouble(e)} class="flex shrink-0 items-center gap-1 border-b border-cream-200 py-2 pr-2 pl-1">
      <HeadButton label={`回到${channelLabel(channel())}`} sprite="button-back" onClick={() => farm.showChat(backTo())} />
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span class="truncate text-[13px]">{title()}</span>
          <Show when={session()}>{(s) => <span class="shrink-0 bg-cream-200 px-1.5 font-mono text-[12.5px] text-bark-600">@{s().id}</span>}</Show>
          <NewElsewhere except={props.thread.id} />
        </div>
        <p class={["h-4 truncate", small]}>{status()}</p>
      </div>
      <HeadButton
        label={props.large ? "还原对话窗口" : "放大对话窗口"}
        sprite={props.large ? "button-shrink" : "button-enlarge"}
        onClick={() => props.onLarge()}
      />
      <HeadButton label="收起对话" sprite="button-collapse" onClick={() => props.onFold()} />
    </div>
  );
}

function Item(props: { m: ChatMessage; thread?: Conversation; first: boolean; agents: ReadonlyMap<string, Agent>; chatUnread: (t: Conversation) => number }) {
  const face = () => <FaceOf m={props.m} agents={props.agents} />;
  const chip = () => {
    const t = props.thread;
    return t ? <ThreadChip thread={t} unread={props.chatUnread(t)} onOpen={() => farm.showChat(t.id)} /> : undefined;
  };
  // The dispatch note is the farm's, under the manager's name: its words say the same turn.
  const turn = () =>
    props.m.final && props.m.fromKind === "manager" && props.m.kind !== "dispatch" ? <TurnSteps session="manager" run={props.m.run} manager /> : undefined;
  return (
    <Switch
      fallback={
        <ChatBubble
          m={props.m}
          mine={false}
          first={props.first}
          face={face()}
          tag={props.m.kind === "dispatch" ? "派活" : undefined}
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
          steps={props.m.final && props.m.fromKind === "agent" ? <TurnSteps session={props.m.from} run={props.m.run} /> : undefined}
        />
      </Match>
      <Match when={props.m.fromKind === "user"}>
        <ChatBubble m={props.m} mine first={props.first} after={chip()} />
      </Match>
    </Switch>
  );
}
