import { type KeyboardEvent, useRef, useState } from "react";
import type { Conversation } from "@vibevalley/protocol";
import { api, reasonOf } from "../../data/api";
import { useCore } from "../../data/frame";
import { insertName, type Nameable, nameables, offeredFor, typedName } from "../../rules/chat";
import { ManagerFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { useToast } from "../../ui/Toast";
import { HelperFace } from "./bits";
import { DictationButton } from "../../voice/Buttons";

/** 16 random bytes in hex: names one send, so a retry is the message already said, not a second one. */
const newSendKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

/** The box for saying a sentence in a conversation: Enter sends, Shift+Enter starts a line, @ names someone. */
export function Composer({ conversation, placeholder }: { conversation: Conversation | undefined; placeholder: string }) {
  const core = useCore();
  const toast = useToast();
  const input = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [closed, setClosed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  // One key per draft: sending the same draft again, after a failure, reuses its key.
  const key = useRef<{ draft: string; key: string }>(undefined);

  const typing = closed ? undefined : typedName(text, caret);
  const offered = typing ? offeredFor(nameables(core?.sessions ?? [], Date.now()), typing.query) : [];
  const stoppable = core?.manager === "thinking" || core?.manager === "speaking";
  const canSend = text.trim() !== "" && !busy;

  const edit = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setActive(0);
    setClosed(false);
    setProblem(undefined);
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
      await api.manager.open();
      await api.channel.say({ body: { text: said, conversation: conversation?.kind === "general" ? undefined : conversation?.id, sendKey: key.current.key } });
      key.current = undefined;
      edit("", 0);
    } catch (e) {
      setProblem(reasonOf(e));
      toast(`没发出去：${reasonOf(e)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  const stop = () => api.manager.stop().catch((e) => toast(reasonOf(e), "bad"));

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that picks a word in an input method neither sends nor names.
    if (e.nativeEvent.isComposing) return;
    if (offered.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : offered.length - 1)) % offered.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(offered[Math.min(active, offered.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
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
    <div className="border-t border-line px-4 pt-3 pb-4">
      {offered.length > 0 && (
        <div role="listbox" aria-label="叫谁" className="mb-1.5 flex flex-col rounded-lg border border-line bg-page p-1 shadow-float">
          {offered.map((n, i) => (
            <div
              key={n.token}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              // Keeps the focus in the input.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(n);
              }}
              className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 ${i === active ? "bg-selected" : ""}`}
            >
              {n.session ? <HelperFace agent={n.session.agent} size={20} /> : n.name === "管家" ? <ManagerFace size={20} /> : <span className="size-5" />}
              <span className="font-mono text-xs">{n.token}</span>
              {n.session && <span className="text-sm">{n.name}</span>}
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{n.note}</span>
            </div>
          ))}
        </div>
      )}
      {problem && <p className="mb-1.5 text-xs text-berry">{problem}</p>}
      <div className="rounded-lg border border-line bg-page focus-within:border-focus">
        <textarea
          ref={input}
          value={text}
          rows={2}
          aria-label={placeholder}
          placeholder={placeholder}
          onChange={(e) => edit(e.target.value, e.target.selectionStart)}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKey}
          onBlur={() => setClosed(true)}
          onFocus={() => setClosed(false)}
          className="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base outline-none [field-sizing:content] placeholder:text-faint"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <span className="text-xs text-faint">@ 叫人</span>
          <span className="flex-1" />
          <DictationButton field={input} value={text} onValue={edit} size={16} className="rounded-md hover:bg-hover" />
          {stoppable && (
            <button
              type="button"
              onClick={stop}
              aria-label="叫停管家"
              title="叫管家停下这一轮，派出去的帮工照常干活"
              className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-line text-berry hover:bg-hover"
            >
              <Icon name="button-stop" size={14} />
            </button>
          )}
          <button
            type="button"
            onClick={() => void send()}
            disabled={!canSend}
            aria-label="发送"
            title="回车发送 · Shift+回车换行"
            className={`inline-flex size-7 cursor-pointer items-center justify-center rounded-md border disabled:cursor-default ${canSend ? "border-accent bg-accent hover:bg-leaf" : "border-transparent opacity-50"}`}
          >
            <Icon name="button-send" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
