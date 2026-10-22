// The box for saying a sentence in a conversation, as both chat windows carry it out: the workbench's
// (pages/chat/Composer.tsx) and the farm's (farm/chat/Composer.tsx). Enter sends, Shift+Enter starts a line, @ names
// someone from a menu that follows the caret. A failed send keeps the draft and its key, so a retry is the same message,
// not a second one. A window only draws it and says where a line goes and how a failure shows.

import { createMemo, createSignal } from "solid-js";
import { type Conversation, type WorkspaceState } from "@vibevalley/protocol";
import { insertName, type Nameable, nameables, offeredFor, typedName } from "../rules/chat";
import { api, newSendKey, reasonOf } from "./api";

/** Says a line in a conversation (the general one when it is undefined), with the picked helper. */
export async function say(text: string, conversation: Conversation | undefined, sendKey: string, agent: string | undefined) {
  await api.channel.say({ body: { text, conversation: conversation?.kind === "general" ? undefined : conversation?.id, agent, sendKey } });
}

export interface ComposerWays {
  /** Sends the line with its key. */
  readonly send: (said: string, sendKey: string) => Promise<void>;
  readonly failed: (reason: string) => void;
  /** After every edit: the text and the caret. */
  readonly edited?: (value: string, at: number) => void;
}

export function createComposer(core: () => WorkspaceState | undefined, input: () => HTMLTextAreaElement | undefined, ways: ComposerWays) {
  const [text, setText] = createSignal("");
  const [caret, setCaret] = createSignal(0);
  const [active, setActive] = createSignal(0);
  const [closed, setClosed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // One key per draft: sending the same draft again, after a failure, reuses its key.
  let key: { draft: string; key: string } | undefined;

  const typing = createMemo(() => (closed() ? undefined : typedName(text(), caret())));
  const offered = createMemo(() => {
    const t = typing();
    return t ? offeredFor(nameables(core()?.sessions ?? [], Date.now()), t.query) : [];
  });

  const edit = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setActive(0);
    setClosed(false);
    ways.edited?.(value, at);
  };

  const choose = (n: Nameable) => {
    const t = typing();
    if (!t) return;
    const next = insertName(text(), caret(), t.start, n.token);
    edit(next.text, next.caret);
    requestAnimationFrame(() => {
      input()?.focus();
      input()?.setSelectionRange(next.caret, next.caret);
    });
  };

  const send = async () => {
    const said = text().trim();
    if (!said || busy()) return;
    if (key?.draft !== said) key = { draft: said, key: newSendKey() };
    setBusy(true);
    try {
      await ways.send(said, key.key);
      key = undefined;
      edit("", 0);
    } catch (e) {
      ways.failed(reasonOf(e));
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent) => {
    // Enter that picks a word in an input method neither sends nor names.
    if (e.isComposing) return;
    const list = offered();
    if (list.length > 0) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (a + (e.key === "ArrowDown" ? 1 : list.length - 1)) % list.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(list[Math.min(active(), list.length - 1)]!);
        return;
      }
      if (e.key === "Escape") {
        // The menu closes, not the window around it.
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

  return {
    text,
    busy,
    active,
    setActive,
    offered,
    edit,
    choose,
    send,
    onKey,
    /** The caret moves without typing too (arrow keys, a click): the @ menu follows it. */
    follow: (e: Event) => setCaret((e.currentTarget as HTMLTextAreaElement).selectionStart),
    /** The menu closes when the box loses the focus and comes back with it. */
    blur: () => setClosed(true),
    focus: () => setClosed(false),
    canSend: () => text().trim() !== "" && !busy(),
    /** The orchestrator is in a round the owner may stop. */
    stoppable: () => core()?.orchestrator === "thinking" || core()?.orchestrator === "speaking",
  };
}
