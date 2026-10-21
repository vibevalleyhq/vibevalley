// The farm's chat window, 田头: folded, the manager's face and the input row; open, a
// window of a fixed size drawn up over the picture from that row, so the farm never rescales: a head (the channel menu
// and what the manager is doing, or a thread's title and its helper), the messages newest at the bottom, a few lines to
// say, and the row. Double-clicking the head makes it large.

import { useEffect, useState, type MouseEvent } from "react";
import type { Agent, ChatMessage, Conversation, CoreState } from "@vibevalley/protocol";
import { useAgents } from "../../data/agents";
import { useCore } from "../../data/frame";
import { conversationOf, feedOf, generalOf, parentOf, threadOwnerOf, threadTitle, unreadIn, unreadTotal, channelOf, phaseText } from "../../rules/chat";
import { HistoryProvider, useHistory, useMarkRead } from "../../pages/chat/data";
import { TurnSteps } from "../../pages/chat/WorkLog";
import { ManagerFace } from "../../ui/Face";
import { PxWindow, SpriteIcon } from "../kit";
import { playSound } from "../sound";
import { useCall, type VoiceCall } from "../../voice/call";
import { farm, useFarm } from "../store";
import { ChannelMenu, channelLabel } from "./ChannelMenu";
import { type ChatPhase, FarmComposer, newSendKey, say } from "./Composer";
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
const phaseOf = (v: VoiceCall, s: CoreState | undefined): ChatPhase => {
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
    <span className="inline-flex gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className="h-1 w-1 animate-pulse bg-bark-500" style={{ animationDelay: `${i * 0.2}s` }} />
      ))}
    </span>
  );
}

function HeadButton({ label, sprite, onClick }: { label: string; sprite: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onDoubleClick={(e) => e.stopPropagation()}
      className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center hover:bg-cream-200 active:bg-cream-300"
    >
      <SpriteIcon name={sprite} size={16} />
    </button>
  );
}

/** Where else there is something new, to go there in one tap. */
function NewElsewhere({ except }: { except: string | undefined }) {
  const chat = useCore()?.chat;
  const waiting = (chat?.conversations ?? []).filter((c) => c.id !== except && unreadIn(chat, c) > 0);
  if (waiting.length === 0) return null;
  const newest = waiting.reduce((a, b) => ((b.lastNumber ?? 0) > (a.lastNumber ?? 0) ? b : a));
  const text = waiting.length > 1 ? `${waiting.length} 处有新话` : newest.kind === "thread" ? "串里有新话" : `${channelLabel(newest)}有新话`;
  return (
    <button
      type="button"
      onClick={() => farm.showChat(newest.kind === "general" ? null : newest.id)}
      onDoubleClick={(e) => e.stopPropagation()}
      className="ml-2 shrink-0 cursor-pointer bg-berry/15 px-2 py-px text-[12px] text-berry hover:bg-berry/25"
    >
      {text}
    </button>
  );
}

export function ChatWindow() {
  return (
    <HistoryProvider>
      <Window />
    </HistoryProvider>
  );
}

function Window() {
  const core = useCore();
  const chat = core?.chat;
  const agents = new Map<string, Agent>((useAgents().data ?? []).map((a) => [a.id, a]));
  const open = useFarm((s) => s.chatOpen);
  const large = useFarm((s) => s.chatLarge);
  const shownId = useFarm((s) => s.chatShown);
  const look = useFarm((s) => s.managerLook);
  const { loaded, ensure, loadOlder } = useHistory();
  const [problem, setProblem] = useState<string>();
  const shown = (shownId ? conversationOf(chat, shownId) : undefined) ?? generalOf(chat);
  const thread = shown?.kind === "thread" ? shown : undefined;
  const call = useCall();
  const phase = phaseOf(call, core);
  const unread = unreadTotal(chat);
  useEffect(() => {
    if (open && shown) ensure(shown.id);
  }, [open, shown, ensure]);
  useMarkRead(open ? shown : undefined);

  // Esc folds the window when nothing over it took the key.
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || farmStateHasLayers()) return;
      playSound("close");
      farm.chatOpen(false);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open]);

  const narrow = typeof window !== "undefined" && window.innerWidth < 640;
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  const size = !open
    ? { w: narrow ? w - 24 : 360, h: 60 }
    : large
      ? { w: narrow ? w - 16 : Math.min(640, w - 192), h: Math.min(760, h - 120) }
      : { w: narrow ? w - 24 : 360, h: Math.min(460, h - 144) };
  const toggleLarge = () => farm.chatLarge(!large);
  const fold = () => {
    playSound("close");
    farm.chatOpen(false);
  };
  const onHeadDouble = (e: MouseEvent) => {
    e.preventDefault();
    toggleLarge();
  };

  const items = shown ? feedOf(chat, shown.id, loaded[shown.id]) : [];
  const parent = thread ? parentOf(chat, thread, loaded[thread.id]) : undefined;
  const hasOlder = shown ? loaded[shown.id] !== undefined && !loaded[shown.id]!.complete : false;
  const last = items.at(-1)?.message;
  const thinking = phase === "thinking" && !thread && last?.from !== "manager";
  const showSuggestions = !thread && (core?.call === "live" || (chat?.messages ?? []).length === 0);

  const head = thread ? (
    <ThreadHead thread={thread} large={large} onLarge={toggleLarge} onFold={fold} onDouble={onHeadDouble} />
  ) : (
    <div onDoubleClick={onHeadDouble} className="flex shrink-0 items-center gap-1 border-b border-cream-200 py-2 pr-2 pl-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center">
          <SpriteIcon name="icon-board" size={20} />
          <span className="ml-2 min-w-0">
            <ChannelMenu current={shown} />
          </span>
          <NewElsewhere except={shown?.id} />
        </div>
        <p className={`flex h-4 items-center gap-1.5 ${small}`} aria-live="polite">
          <span className="truncate">{phaseWords[phase]}</span>
          {(phase === "thinking" || phase === "connecting") && <Dots />}
        </p>
      </div>
      <HeadButton label={large ? "还原对话窗口" : "放大对话窗口"} sprite={large ? "button-shrink" : "button-enlarge"} onClick={toggleLarge} />
      <HeadButton label="收起对话" sprite="button-collapse" onClick={fold} />
    </div>
  );

  return (
    <section
      aria-label="田头"
      className="pointer-events-auto transition-[width,height] duration-200 ease-out"
      style={{ width: Math.max(288, size.w), height: Math.max(60, size.h) }}
    >
      <PxWindow className="flex h-full flex-col overflow-hidden font-pixel text-[12px] leading-[1.625] text-bark-900">
        {open && size.h >= 160 && (
          <>
            {head}
            <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto p-3" aria-label={thread ? "工单串" : channelLabel(shown)} role="log">
              <div className="flex flex-col gap-2">
                {hasOlder && shown && (
                  <button
                    type="button"
                    onClick={() => void loadOlder(shown.id)}
                    className={`self-center px-2.5 py-0.5 hover:bg-cream-200 hover:text-bark-800 ${small}`}
                  >
                    更早的消息
                  </button>
                )}
                {parent && <ParentMessage m={parent} face={<FaceOf m={parent} agents={agents} />} />}
                {items.length === 0 && !thread && (
                  <ChatRow mine={false} first face={<ManagerFace size={30} look={look} />} name="管家">
                    <span className="whitespace-pre-line">{greeting}</span>
                  </ChatRow>
                )}
                {items.length === 0 && thread && <p className={`py-4 text-center ${small}`}>串里还没人说话。在这里说的话，它的帮工会看到。</p>}
                {items.map((item, i) => (
                  <Item
                    key={item.message.id}
                    m={item.message}
                    thread={item.thread}
                    first={i === 0 || items[i - 1]!.message.from !== item.message.from}
                    agents={agents}
                    chatUnread={(t) => unreadIn(chat, t)}
                  />
                ))}
                {thinking && (
                  <ChatRow mine={false} first face={<ManagerFace size={30} look={look} />}>
                    <span className="flex h-5 items-center px-1">
                      <Dots />
                    </span>
                  </ChatRow>
                )}
              </div>
            </div>
            {problem && <p className="px-3 py-0.5 text-[12px] text-berry">{problem}</p>}
            {showSuggestions && (
              <div className="flex shrink-0 gap-1.5 overflow-x-auto px-3 pb-2 [mask-image:linear-gradient(to_right,black_85%,transparent)]">
                {suggestions.map((line) => (
                  <button
                    key={line}
                    type="button"
                    onClick={() => {
                      setProblem(undefined);
                      void say(line, shown?.kind === "general" ? undefined : shown, newSendKey(), undefined).catch((e: unknown) =>
                        setProblem(`没发出去：${e instanceof Error ? e.message : String(e)}`),
                      );
                    }}
                    className="max-w-40 shrink-0 cursor-pointer truncate bg-cream-200 px-2.5 py-0.5 text-[12px] text-bark-800 hover:bg-leaf-300 hover:text-bark-900"
                  >
                    {line}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        <div className="mt-auto">
          <FarmComposer conversation={shown} thread={!!thread} phase={phase} open={open} unread={!open && unread > 0} onProblem={setProblem} />
        </div>
      </PxWindow>
    </section>
  );
}

/** Whether a farm layer (a dialog) is open: its Esc closes it first. */
const farmStateHasLayers = () => document.querySelector("dialog[open]") !== null;

function ThreadHead({
  thread,
  large,
  onLarge,
  onFold,
  onDouble,
}: {
  thread: Conversation;
  large: boolean;
  onLarge: () => void;
  onFold: () => void;
  onDouble: (e: MouseEvent) => void;
}) {
  const core = useCore();
  const chat = core?.chat;
  const channel = channelOf(chat, thread);
  const backTo = channel?.kind === "channel" ? channel.id : null;
  const session = threadOwnerOf(thread, core?.sessions ?? []);
  const title = threadTitle(chat, thread, core?.issues ?? [], core?.sessions ?? []);
  const status = session ? phaseText(session, Date.now()) : thread.subjectKind === "issue" ? "现在没有帮工在干，串还留着" : `${thread.replies} 条回复`;
  return (
    <div onDoubleClick={onDouble} className="flex shrink-0 items-center gap-1 border-b border-cream-200 py-2 pr-2 pl-1">
      <HeadButton label={`回到${channelLabel(channel)}`} sprite="button-back" onClick={() => farm.showChat(backTo)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px]">{title}</span>
          {session && <span className="shrink-0 bg-cream-200 px-1.5 font-mono text-[12.5px] text-bark-600">@{session.id}</span>}
          <NewElsewhere except={thread.id} />
        </div>
        <p className={`h-4 truncate ${small}`}>{status}</p>
      </div>
      <HeadButton label={large ? "还原对话窗口" : "放大对话窗口"} sprite={large ? "button-shrink" : "button-enlarge"} onClick={onLarge} />
      <HeadButton label="收起对话" sprite="button-collapse" onClick={onFold} />
    </div>
  );
}

function Item({
  m,
  thread,
  first,
  agents,
  chatUnread,
}: {
  m: ChatMessage;
  thread?: Conversation;
  first: boolean;
  agents: ReadonlyMap<string, Agent>;
  chatUnread: (t: Conversation) => number;
}) {
  if (m.kind === "notice" || m.fromKind === "system") return <p className={`px-4 text-center leading-[1.625] ${small}`}>{m.text}</p>;
  const face = <FaceOf m={m} agents={agents} />;
  if (m.kind === "report")
    return <ChatReport m={m} first={first} face={face} steps={m.final && m.fromKind === "agent" ? <TurnSteps session={m.from} run={m.run} /> : undefined} />;
  const chip = thread ? <ThreadChip thread={thread} unread={chatUnread(thread)} onOpen={() => farm.showChat(thread.id)} /> : undefined;
  if (m.fromKind === "user") return <ChatBubble m={m} mine first={first} after={chip} />;
  // The dispatch note is the farm's, under the manager's name: its words say the same turn.
  const turn = m.final && m.fromKind === "manager" && m.kind !== "dispatch" ? <TurnSteps session="manager" run={m.run} manager /> : undefined;
  return (
    <ChatBubble
      m={m}
      mine={false}
      first={first}
      face={face}
      tag={m.kind === "dispatch" ? "派活" : undefined}
      folded={m.kind === "dispatch"}
      after={
        turn || chip ? (
          <div className="flex flex-col items-start">
            {turn}
            {chip}
          </div>
        ) : undefined
      }
    />
  );
}
