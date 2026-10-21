// The rows of the farm's chat window: bubbles for
// what is said (yours on the right in green), a turn report with its outcome, the thread a message has, the message a
// thread hangs from, and a long message folded to its first lines.

import { useState, type ReactNode } from "react";
import type { Agent, ChatMessage, Conversation, Outcome } from "@vibevalley/protocol";
import { spentText } from "../../rules/chat";
import { AgentFace, ManagerFace, OwnerFace } from "../../ui/Face";
import { PxMarkdown, SpriteIcon } from "../kit";
import { useFarm } from "../store";

const small = "font-pixel text-[12px] leading-4 text-bark-500";

export const farmClock = (at: number) => {
  const d = new Date(Math.round(at));
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Long enough to fold: over 240 characters, eight lines or more, a heading or a code block. */
export const readsLong = (text: string) => text.length > 240 || (text.match(/\n/g)?.length ?? 0) >= 8 || /^(#{1,6} |```)/m.test(text);

/** A message's text; a long one shows its first lines until opened. One still streaming is shown whole. */
export function ChatText({ text, folds = true, link = "text-leaf-700" }: { text: string; folds?: boolean; link?: string }) {
  const [open, setOpen] = useState(false);
  if (!folds || !readsLong(text)) return <PxMarkdown text={text} mentions />;
  return (
    <div className="flex flex-col items-start">
      <div className={open ? "" : "max-h-[117px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"}>
        <PxMarkdown text={text} mentions />
      </div>
      <button type="button" onClick={() => setOpen(!open)} className={`mt-1 cursor-pointer text-[12px] hover:underline ${link}`}>
        {open ? "收起" : "展开阅读"}
      </button>
    </div>
  );
}

/** A dispatch note: one line until tapped. */
function DispatchNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      aria-label={open ? "收起派活" : "展开派活"}
      onClick={() => setOpen(!open)}
      className="group flex w-full cursor-pointer items-start gap-1.5 text-left"
    >
      <span className="min-w-0 flex-1">
        {open ? <PxMarkdown text={text} mentions /> : <span className="block truncate">{text.replace(/\s+/g, " ").trim()}</span>}
      </span>
      <SpriteIcon name={open ? "button-collapse" : "button-enlarge"} size={12} className="mt-1 opacity-60 group-hover:opacity-100" />
    </button>
  );
}

export function FaceOf({ m, agents, size = 30 }: { m: ChatMessage; agents: ReadonlyMap<string, Agent>; size?: number }) {
  const look = useFarm((s) => s.managerLook);
  if (m.fromKind === "user") return <OwnerFace size={size} />;
  if (m.fromKind === "manager") return <ManagerFace size={size} look={look} />;
  const id = m.agent ?? m.from;
  return <AgentFace agentId={id} look={agents.get(id)?.look} size={size} />;
}

export function SenderName({ m }: { m: ChatMessage }) {
  if (m.fromKind !== "agent") return <>{m.name}</>;
  return (
    <>
      {m.name} <span className="font-mono text-bark-500">@{m.from}</span>
    </>
  );
}

export function ChatRow({
  mine,
  first,
  face,
  name,
  title,
  children,
}: {
  mine: boolean;
  first: boolean;
  face?: ReactNode;
  name?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`flex items-start gap-2 ${first ? "pt-1" : ""} ${mine ? "justify-end" : ""}`}>
      {!mine && <span className="w-[30px] shrink-0">{first ? face : null}</span>}
      <div className={`flex max-w-[84%] flex-col ${mine ? "items-end" : "items-start"}`}>
        {!mine && first && name && <span className={`mx-1 mb-0.5 ${small}`}>{name}</span>}
        <div
          title={title}
          className={`px-3 py-2 text-[12px] leading-[1.625] ${mine ? "bg-leaf-500 text-cream-50 shadow-[0_2px_0_0_#3f6427]" : "border-[1.5px] border-cream-300 bg-cream-100 text-bark-900 shadow-[0_2px_0_0_#7a5f4029]"}`}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function ChatBubble({
  m,
  mine,
  first,
  face,
  tag,
  folded,
  after,
}: {
  m: ChatMessage;
  mine: boolean;
  first: boolean;
  face?: ReactNode;
  tag?: string;
  folded?: boolean;
  after?: ReactNode;
}) {
  return (
    <ChatRow mine={mine} first={first} face={face} name={<SenderName m={m} />} title={farmClock(m.at)}>
      {tag && <span className="mb-1 inline-block bg-wheat/40 px-1.5 text-[12px] text-bark-800">{tag}</span>}
      {folded ? <DispatchNote text={m.text} /> : <ChatText text={m.text} folds={m.final} link={mine ? "text-cream-50" : "text-leaf-700"} />}
      {!m.final && <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle" aria-hidden />}
      {after}
    </ChatRow>
  );
}

const outcomeTag: Record<Outcome, [label: string, fill: string, ink: string]> = {
  completed: ["做完了", "#e5a93c66", "#2f1f13"],
  failed: ["没做成", "#c84a3a26", "#c84a3a"],
  interrupted: ["叫停了", "#e2c995", "#67482d"],
};

export function ChatReport({ m, first, face, steps }: { m: ChatMessage; first: boolean; face: ReactNode; steps?: ReactNode }) {
  const [label, fill, ink] = outcomeTag[m.outcome ?? "completed"];
  return (
    <ChatRow mine={false} first={first} face={face} name={<SenderName m={m} />} title={farmClock(m.at)}>
      <span className="mb-1 inline-block px-1.5 text-[12px]" style={{ background: fill, color: ink }}>
        {label}
      </span>
      <ChatText text={m.text} folds={m.final} />
      {m.spent && <p className={`mt-1 ${small}`}>这一轮花了 {spentText(m.spent)}</p>}
      {steps}
    </ChatRow>
  );
}

export function ThreadChip({ thread, unread, onOpen }: { thread: Conversation; unread: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="mt-1.5 flex cursor-pointer items-center gap-1.5 border border-cream-300 bg-cream-50/80 px-2 py-0.5 hover:bg-cream-50"
    >
      <SpriteIcon name="button-thread" size={12} />
      <span className="text-[12px] text-leaf-700">{thread.replies > 0 ? `${thread.replies} 条回复` : "工单串"}</span>
      {unread > 0 && <span className="bg-berry px-1.5 text-[12px] text-cream-50">{unread} 新</span>}
      <SpriteIcon name="button-next" size={12} />
    </button>
  );
}

export function ParentMessage({ m, face }: { m: ChatMessage; face: ReactNode }) {
  return (
    <div className="mb-1 flex items-start gap-2 bg-cream-100 px-2.5 py-2">
      {face}
      <div className="min-w-0 flex-1">
        <p className={small}>
          <SenderName m={m} /> · {farmClock(m.at)}
        </p>
        <div className="text-[12px] text-bark-800">
          <ChatText text={m.text} folds={m.final} />
        </div>
      </div>
    </div>
  );
}
