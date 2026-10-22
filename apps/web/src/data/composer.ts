// The box for saying a sentence in a conversation, as both chat windows carry it out: the workbench's
// (pages/chat/Composer.tsx) and the farm's (farm/chat/Composer.tsx). Enter sends, Shift+Enter starts a line, @ names
// someone from a menu that follows the caret. A failed send keeps the draft and its key, so a retry is the same message,
// not a second one. A window only draws it and says where a line goes and how a failure shows.

import { createEffect, createMemo, createSignal } from "solid-js";
import { type ChatMessage, type Conversation, type WorkspaceState } from "@vibevalley/protocol";
import { insertName, type Nameable, nameables, offeredFor, typedName } from "../rules/chat";
import { api, newSendKey, reasonOf } from "./api";

/** Says a line in a conversation (the general one when it is undefined), with the picked helper. */
export async function say(text: string, conversation: Conversation | undefined, sendKey: string, agent: string | undefined) {
  await api.channel.say({ body: { text, conversation: conversation?.kind === "general" ? undefined : conversation?.id, agent, sendKey } });
}

/** A line sent and not yet in its conversation as the server has it: a window shows it at once, until the server's copy
 * comes (a user's line with the same words, numbered after the conversation's last when it was sent). */
export interface PendingLine {
  readonly key: string;
  readonly conversation: string;
  readonly text: string;
  readonly after: number;
}

const [pendingLines, setPendingLines] = createSignal<readonly PendingLine[]>([]);
export const pending = pendingLines;

export const arrived = (p: PendingLine, messages: readonly ChatMessage[]) =>
  messages.some((m) => m.conversation === p.conversation && m.fromKind === "user" && m.number > p.after && m.text === p.text);

export interface ComposerWays {
  /** Sends the line with its key. */
  readonly send: (said: string, sendKey: string) => Promise<void>;
  /** Where the next line goes, for showing it before the server has it; none: it is not shown until then. */
  readonly where?: () => Conversation | undefined;
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

  // The lines whose server copy came, worked out where the reads are tracked; the callback only drops them.
  createEffect(
    () => {
      const messages = core()?.chat?.messages ?? [];
      return pendingLines()
        .filter((p) => arrived(p, messages))
        .map((p) => p.key);
    },
    (came) => {
      if (came.length > 0) setPendingLines((all) => all.filter((p) => !came.includes(p.key)));
    },
  );

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
    const sent = key.key;
    const at = ways.where?.();
    if (at) setPendingLines((all) => [...all.filter((p) => p.key !== sent), { key: sent, conversation: at.id, text: said, after: at.lastNumber ?? 0 }]);
    // The box empties at once; a failure puts the line back, with its key, unless something new was typed meanwhile.
    if (at) edit("", 0);
    setBusy(true);
    try {
      await ways.send(said, sent);
      key = undefined;
      if (!at) edit("", 0);
      // A copy that never comes (the words changed on the way) does not stay forever.
      setTimeout(() => setPendingLines((all) => all.filter((p) => p.key !== sent)), 15_000);
    } catch (e) {
      setPendingLines((all) => all.filter((p) => p.key !== sent));
      if (text() === "") edit(said, said.length);
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
