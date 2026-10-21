// The farm chat window's input row: the manager's
// face that opens and folds the window, who the next job goes to, the box (Enter sends, Shift+Enter starts a line, @ names
// someone), and the stop button while the manager thinks. A failed send keeps the draft and its key, so a retry is the
// same message, not a second one.

import { type KeyboardEvent, useRef, useState } from "react";
import type { Conversation } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useAgents } from "../../data/agents";
import { useCore } from "../../data/frame";
import { insertName, type Nameable, nameables, offeredFor, threadOwnerOf, typedName } from "../../rules/chat";
import { AgentFace, ManagerFace } from "../../ui/Face";
import { SpriteIcon } from "../kit";
import { playSound } from "../sound";
import { farm, useFarm } from "../store";
import { CallButton, DictationButton } from "../../voice/Buttons";

/** 16 random bytes in hex: names one send. */
export const newSendKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Says a line in a conversation (the general one when it is undefined), with the picked helper; the manager is woken first. */
export async function say(text: string, conversation: Conversation | undefined, sendKey: string, agent: string | undefined) {
  await api.manager.open();
  await api.channel.say({ body: { text, conversation: conversation?.kind === "general" ? undefined : conversation?.id, agent, sendKey } });
}

/** Who the next line goes to, with a button to stop picking. */
function PickChip({ named }: { named: boolean }) {
  const pick = useFarm((s) => s.pick);
  const agent = (useAgents().data ?? []).find((a) => a.id === pick);
  if (pick === "auto" || !agent?.enabled) return null;
  return (
    <span className="mr-1 flex h-8 shrink-0 items-center gap-1 bg-cream-200 pr-1 pl-0.5" title={`派给${agent.name}`}>
      <AgentFace agentId={agent.id} look={agent.look} size={26} />
      {named && <span className="max-w-20 truncate text-[12px] text-bark-800">派给{agent.name}</span>}
      <button
        type="button"
        aria-label="不指定帮工"
        onClick={() => farm.setPick("auto")}
        className="flex h-6 w-6 cursor-pointer items-center justify-center hover:bg-cream-300"
      >
        <SpriteIcon name="button-close" size={12} />
      </button>
    </span>
  );
}

export type ChatPhase = "off" | "connecting" | "listening" | "thinking" | "speaking" | "error";

const ring: Record<ChatPhase, string> = {
  off: "#c8a46e",
  connecting: "#c8a46e",
  listening: "#74a046",
  thinking: "#c8a46e",
  speaking: "#e5a93c",
  error: "#c84a3a",
};

export function FarmComposer({
  conversation,
  thread,
  phase,
  open,
  unread,
  onProblem,
}: {
  conversation: Conversation | undefined;
  thread: boolean;
  phase: ChatPhase;
  open: boolean;
  unread: boolean;
  onProblem: (p: string | undefined) => void;
}) {
  const core = useCore();
  const look = useFarm((s) => s.managerLook);
  const pick = useFarm((s) => s.pick);
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useRef<{ draft: string; key: string }>(undefined);
  const typing = closed ? undefined : typedName(text, caret);
  const offered = typing ? offeredFor(nameables(core?.sessions ?? [], Date.now()), typing.query) : [];
  const stoppable = core?.manager === "thinking" || core?.manager === "speaking";
  const owner = thread && conversation ? threadOwnerOf(conversation, core?.sessions ?? []) : undefined;
  const placeholder = thread ? (owner ? `在串里说，${owner.name}会看到…` : "在串里说…") : "对管家说，@ 叫帮工…";

  const edit = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setActive(0);
    setClosed(false);
    onProblem(undefined);
    // Naming someone opens the window, to show who can be named.
    if (!open && typedName(value, at)) farm.chatOpen(true);
  };
  const choose = (n: Nameable) => {
    if (!typing) return;
    const next = insertName(text, caret, typing.start, n.token);
    edit(next.text, next.caret);
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(next.caret, next.caret);
    });
  };
  const send = async () => {
    const said = text.trim();
    if (!said || busy) return;
    if (key.current?.draft !== said) key.current = { draft: said, key: newSendKey() };
    setBusy(true);
    try {
      await say(said, conversation, key.current.key, thread || pick === "auto" ? undefined : pick);
      key.current = undefined;
      edit("", 0);
    } catch (e) {
      onProblem(`没发出去：${reasonOf(e)}`);
    } finally {
      setBusy(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (offered.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : offered.length - 1)) % offered.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const n = offered[active];
        if (n) choose(n);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setClosed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className={`relative flex items-end gap-1.5 p-1.5 ${open ? "border-t border-cream-200" : ""}`}>
      {offered.length > 0 && (
        <div className="absolute right-2 bottom-full left-2 mb-1 border-2 border-cream-300 bg-cream-50 py-1 shadow-px" role="listbox" aria-label="叫谁">
          {offered.map((n, i) => (
            <button
              key={n.token}
              type="button"
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(n)}
              className={`flex w-full cursor-pointer items-center gap-2 px-2 py-1 text-left text-[12px] ${i === active ? "bg-leaf-300/40" : ""}`}
            >
              <span className="text-bark-900">{n.name}</span>
              <span className="truncate text-bark-500">{n.note}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label={open ? "收起对话" : "展开对话"}
        title={open ? "收起对话" : unread ? "田头有新话，点开看看" : "展开对话"}
        onClick={() => {
          playSound(open ? "close" : "open");
          farm.chatOpen(!open);
        }}
        className="relative shrink-0 cursor-pointer p-0.5 shadow-[inset_0_0_0_2px_#2f1f1340]"
        style={{ background: ring[phase] }}
      >
        <ManagerFace size={40} look={look} />
        {unread && <span className="absolute -top-0.5 -right-0.5 h-3 w-3 bg-berry shadow-[inset_0_0_0_2px_#2f1f1340]" />}
      </button>
      <div className="flex min-h-11 min-w-0 flex-1 items-center bg-cream-50 px-1 shadow-[inset_0_0_0_2px_#c8a46e]">
        {!thread && <PickChip named />}
        <textarea
          ref={input}
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(e) => edit(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
          className="max-h-24 min-w-0 flex-1 resize-none bg-transparent px-1 py-2 font-pixel text-[12px] leading-4 text-bark-900 outline-none placeholder:text-bark-400"
        />
        {stoppable && (
          <button
            type="button"
            aria-label="叫管家停下"
            title="叫管家停下这一轮，派出去的帮工照常干活"
            onClick={() => void api.manager.stop().catch(() => {})}
            className="cursor-pointer p-1"
          >
            <SpriteIcon name="button-stop" size={24} />
          </button>
        )}
        <DictationButton field={input} value={text} onValue={edit} />
        <button type="button" aria-label="发送" disabled={!text.trim() || busy} onClick={() => void send()} className="cursor-pointer p-1 disabled:opacity-40">
          <SpriteIcon name="button-send" size={20} />
        </button>
      </div>
      {!thread && <CallButton />}
    </div>
  );
}
