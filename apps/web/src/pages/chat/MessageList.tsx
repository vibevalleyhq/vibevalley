import { type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { type ChatMessage, type Conversation, managerAgent, type Outcome } from "@vibevalley/protocol";
import { useAgents } from "../../data/agents";
import { useCore } from "../../data/frame";
import {
  chatPath,
  feedOf,
  messagesIn,
  messagesOf,
  parentOf,
  phaseDot,
  phaseText,
  roleShort,
  runtimeLabel,
  spentText,
  threadOwnerOf,
  unreadIn,
  waitingForManager,
  workbenchClock,
} from "../../rules/chat";
import { Icon } from "../../ui/Icon";
import { ManagerFace } from "../../ui/Face";
import { Markdown } from "../../ui/Markdown";
import { Dot, PhaseGlyph, SenderFace, StreamingCaret, Tag, ThinkingDots } from "./bits";
import { useHistory, useMarkRead } from "./data";
import { TurnSteps } from "./WorkLog";

const outcomeTag: Record<Outcome, { label: string; fill: string; icon: string }> = {
  completed: { label: "做完了", fill: "#b4cb7c", icon: "icon-harvest" },
  failed: { label: "没做成", fill: "#e9a092", icon: "icon-bug" },
  interrupted: { label: "叫停了", fill: "#e2c995", icon: "icon-shovel" },
};

/** A conversation's messages, newest at the bottom; filter keeps those containing it. */
export function MessageList({ conversation, filter = "", emptyText }: { conversation: Conversation | undefined; filter?: string; emptyText: string }) {
  const core = useCore();
  const chat = core?.chat;
  const { loaded, ensure, loadOlder } = useHistory();
  const id = conversation?.id;
  useEffect(() => void (id && ensure(id)), [id, ensure]);
  useMarkRead(conversation);
  // Rows newer than this arrived while the list was shown: they rise in; the rest just appear.
  const [shownAt] = useState(Date.now);

  const more = id ? loaded[id] : undefined;
  const all = id ? messagesOf(chat, id, more) : [];
  const items = id ? feedOf(chat, id, more, filter) : [];
  const parent = conversation?.kind === "thread" ? parentOf(chat, conversation, more) : undefined;
  const searching = filter.trim() !== "";
  const hasOlder = !!id && all.length > 0 && !(more?.complete ?? false);
  const waiting = waitingForManager(core?.manager, conversation, all);

  return (
    // Reversed, so it stays at the newest while you are there and older pages load above without a jump.
    <div className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto" role="log" aria-label="消息">
      <div className="flex flex-col px-4 pt-3 pb-4">
        <div className="flex justify-center pb-2">
          {hasOlder && !searching ? (
            <button type="button" onClick={() => void loadOlder(id)} className="cursor-pointer rounded px-2 py-1 text-xs text-faint hover:text-ink">
              更早的消息
            </button>
          ) : (
            <span className="text-xs text-muted">{searching ? `含「${filter.trim()}」的消息` : "消息的开头"}</span>
          )}
        </div>
        {parent && (
          <div className="mb-2 border-b border-line pb-2">
            <MessageRow m={parent} continues={false} />
          </div>
        )}
        {items.length === 0 && <p className="py-8 text-center text-sm text-muted">{searching ? "没有找到" : emptyText}</p>}
        {items.map((item) => (
          <div
            key={item.message.id}
            className={item.message.at > shownAt ? "transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0" : ""}
          >
            {item.day && <DayLine label={item.day} />}
            {item.message.kind === "notice" || item.message.fromKind === "system" ? (
              <p className="px-6 py-2 text-center text-xs leading-relaxed text-muted">{item.message.text}</p>
            ) : (
              <MessageRow m={item.message} continues={item.continues} thread={item.thread} />
            )}
          </div>
        ))}
        {waiting && (
          <Frame face={<ManagerFace size={36} />} name="管家" meta="在想…">
            <div className="flex h-5 items-center">
              <ThinkingDots />
            </div>
          </Frame>
        )}
      </div>
    </div>
  );
}

function DayLine({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-3 text-xs text-muted" role="separator">
      <span className="h-px flex-1 bg-line" />
      {label}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function Frame({
  face,
  dot,
  name,
  meta,
  continues = false,
  children,
}: {
  face: ReactNode;
  dot?: ReactNode;
  name: string;
  meta: string;
  continues?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex gap-3 rounded-md px-1 hover:bg-hover ${continues ? "pt-0.5" : "mt-3 pt-1"}`}>
      <div className="relative w-10 shrink-0">
        {!continues && (
          <>
            {face}
            {dot && <span className="absolute top-[26px] left-[26px]">{dot}</span>}
          </>
        )}
      </div>
      <div className="min-w-0 flex-1 pb-0.5">
        {!continues && (
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-semibold">{name}</span>
            <span className="truncate text-xs text-muted">{meta}</span>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

/** A dispatch: one line until it is opened, then the whole task in its place. */
function Dispatch({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="group/d flex items-start gap-1.5">
      <div className="min-w-0 flex-1">
        {open ? (
          <Markdown text={text} mentions />
        ) : (
          <button type="button" onClick={() => setOpen(true)} className="block w-full cursor-pointer truncate text-left text-base">
            {text.replace(/\s+/g, " ").trim()}
          </button>
        )}
      </div>
      <button type="button" onClick={() => setOpen(!open)} aria-label={open ? "收起派活" : "展开派活"} aria-expanded={open} className="mt-[5px] cursor-pointer">
        <Icon name={open ? "button-collapse" : "button-enlarge"} size={12} className="opacity-50 group-hover/d:opacity-100" />
      </button>
    </div>
  );
}

function MessageRow({ m, continues, thread }: { m: ChatMessage; continues: boolean; thread?: Conversation }) {
  const sessions = useCore()?.sessions ?? [];
  const agent = useAgents().data?.find((a) => a.id === m.agent);
  const session = m.fromKind === "agent" ? sessions.find((h) => h.id === m.from) : undefined;
  const who =
    m.fromKind === "agent"
      ? [`@${m.from}`, session ? (runtimeLabel[session.runtime] ?? session.runtime) : "", agent?.role ? roleShort(agent.role) : ""].filter(Boolean).join(" ")
      : "";
  const outcome = outcomeTag[m.outcome ?? "completed"];
  const turn = !m.final ? null : m.fromKind === "manager" && m.kind !== "dispatch" ? (
    <TurnSteps session={managerAgent} run={m.run} manager />
  ) : m.fromKind === "agent" && m.kind === "report" ? (
    <TurnSteps session={m.from} run={m.run} />
  ) : null;
  return (
    <Frame
      face={<SenderFace m={m} />}
      dot={session && <Dot tone={phaseDot(session.phase)} size={11} />}
      name={m.fromKind === "user" ? "主人" : m.name}
      meta={`${who ? `${who}  ` : ""}${workbenchClock(m.at)}`}
      continues={continues}
    >
      {m.kind === "dispatch" && (
        <div className="mb-1">
          <Tag icon="icon-seeds" label="派活" fill="#f3d38a" />
        </div>
      )}
      {m.kind === "report" && (
        <div className="mb-1">
          <Tag icon={outcome.icon} label={outcome.label} fill={outcome.fill} />
        </div>
      )}
      <div className={m.final ? "" : "opacity-70"}>{m.kind === "dispatch" ? <Dispatch text={m.text} /> : <Markdown text={m.text} mentions />}</div>
      {!m.final && <StreamingCaret />}
      {m.spent && m.kind === "report" && (
        <div className="mt-1 flex items-center gap-1 text-xs text-muted">
          <Icon name="icon-coin" size={12} />
          这一轮花了 {spentText(m.spent)}
        </div>
      )}
      {turn}
      {thread && <ThreadPreview thread={thread} />}
    </Frame>
  );
}

function ThreadPreview({ thread }: { thread: Conversation }) {
  const core = useCore();
  const navigate = useNavigate();
  const unread = unreadIn(core?.chat, thread);
  const last = messagesIn(core?.chat, thread.id).at(-1);
  const session = threadOwnerOf(thread, core?.sessions ?? []);
  return (
    <button
      type="button"
      onClick={() => navigate(chatPath(thread))}
      className="group/t mt-2 flex w-full max-w-xl cursor-pointer flex-col gap-1 rounded-lg border border-line px-3 py-2 text-left hover:bg-hover focus-visible:border-focus"
    >
      <span className="flex w-full items-center gap-1.5">
        <Icon name="button-thread" size={16} />
        <span className="text-sm font-semibold text-accent">{thread.replies > 0 ? `${thread.replies} 条回复` : "工单串"}</span>
        {unread > 0 && <Tag label={`${unread} 条新`} fill="#b4cb7c" />}
        {session && (
          <>
            <PhaseGlyph phase={session.phase} />
            <span className="min-w-0 flex-1 truncate text-xs text-muted">{phaseText(session, Date.now())}</span>
          </>
        )}
        {!session && <span className="flex-1" />}
        <Icon name="button-next" size={12} className="opacity-60 group-hover/t:opacity-100" />
      </span>
      {last && (
        <span className="flex w-full items-center gap-2 text-sm">
          <span className="shrink-0 font-medium">{last.fromKind === "user" ? "主人" : last.name}</span>
          <span className="min-w-0 flex-1 truncate text-muted">{last.text.replace(/\s+/g, " ")}</span>
          <span className="shrink-0 text-xs text-muted">{workbenchClock(last.at)}</span>
        </span>
      )}
    </button>
  );
}
