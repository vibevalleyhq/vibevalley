// The box for saying a sentence in a channel, as both chat windows carry it out: the workbench's
// (features/channel/Composer.tsx) and the farm's (farm/chat/Composer.tsx). Enter sends, Shift+Enter starts a line, @ names
// someone from a menu that follows the caret. A failed send keeps the draft and its key, so a retry is the same message,
// not a second one. A window only draws it and says where a line goes and how a failure shows.

import { createMemo, createSignal, flush, onSettled } from "solid-js";
import { type ChatMessage, type Channel, defaultOrchestrator, type SayRequest, type WorkspaceState } from "@vibevalley/protocol";
import { same } from "@vibevalley/protocol/rules";
import { insertName, type Nameable, nameables, offeredFor, typedName } from "./rules";
import { api, newSendKey, reasonOf } from "../../base/api";
import { commandNameables, commandOf, runCommand, typedCommand } from "./commands";
import { orchestratorMood } from "../../base/frame";
import { useOrchestrators } from "../../base/agents";

export async function say(text: string, channel: Channel, sendKey: string, agent: string | undefined) {
  await api.channel.message.send({ id: channel.id, text, agent, sendKey });
}

/** A line sent and not yet in its channel: a window shows it at once, until the server's copy comes (the
 * owner's line carrying the same send key). */
export interface PendingLine {
  readonly key: string;
  readonly channel: string;
  readonly text: string;
}

const [pendingLines, setPendingLines] = createSignal<readonly PendingLine[]>([]);
export const pending = pendingLines;

export const arrived = (p: PendingLine, messages: readonly ChatMessage[]) => messages.some((m) => m.sendKey === p.key);

export interface ComposerWays {
  /** Every routing field of the next message; its text and retry identity belong to the composer. */
  readonly target: () => Omit<SayRequest, "text" | "sendKey">;
  /** The words the box starts with: a draft kept from before. */
  readonly initial?: string;
  /** The window draws pending lines (`pending`): a line shows at once and the box empties as it is sent. */
  readonly echo?: boolean;
  readonly failed: (reason: string) => void;
  /** What a slash command came to, in words (commands.ts); a failed one goes to failed. */
  readonly told?: (say: string) => void;
  /** A slash command that opens a place (/dm): the window goes there. */
  readonly opened?: (path: string) => void;
  /** After every edit: the text and the caret. */
  readonly edited?: (value: string, at: number) => void;
  /** Once a line went through: what it carried beside its words (a reply, files) is spent. */
  readonly sent?: () => void;
}

export function createComposer(core: () => WorkspaceState | undefined, input: () => HTMLTextAreaElement | undefined, ways: ComposerWays) {
  const [text, setText] = createSignal(ways.initial ?? "");
  const [caret, setCaret] = createSignal(0);
  const [active, setActive] = createSignal(0);
  const [closed, setClosed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let attempt: { body: Omit<SayRequest, "sendKey">; key: string } | undefined;
  let edits = 0;
  let sending = false;
  let disposed = false;
  onSettled(() => () => {
    disposed = true;
  });
  const intent = (): Omit<SayRequest, "sendKey"> => ({ ...ways.target(), text: text().trim() });
  const channelOf = (id: string | undefined): Channel | undefined => {
    const all = core()?.chat?.channels ?? [];
    return id ? all.find((c) => c.id === id) : all.find((c) => c.default);
  };

  const orchestrators = useOrchestrators();
  /** The orchestrator that looks after the place the next line goes to. */
  const here = () => channelOf(ways.target().id)?.orchestrator ?? defaultOrchestrator;
  // A command (/ first in the box) is offered anywhere; no one else is in a direct channel to be named.
  const commandTyping = createMemo(() => (closed() ? undefined : typedCommand(text(), caret())));
  const typing = createMemo(() => (closed() || channelOf(ways.target().id)?.type === "direct" ? undefined : typedName(text(), caret())));
  const offered = createMemo(() => {
    const c = commandTyping();
    if (c) return offeredFor(commandNameables(), c.query);
    const t = typing();
    return t ? offeredFor(nameables(core()?.sessions ?? [], orchestrators(), here(), Date.now()), t.query) : [];
  });

  const edit = (value: string, at: number) => {
    edits++;
    setText(value);
    setCaret(at);
    setActive(0);
    setClosed(false);
    ways.edited?.(value, at);
  };

  const choose = (n: Nameable) => {
    const t = commandTyping() ?? typing();
    if (!t) return;
    const next = insertName(text(), caret(), t.start, n.token);
    edit(next.text, next.caret);
    // The box's new value is written now, not a frame later: a key typed in between would land where the old caret
    // was, and the caret put back after it.
    flush();
    input()?.focus();
    input()?.setSelectionRange(next.caret, next.caret);
  };

  // A line that is a command runs it: the box empties once it went through, and keeps the line when it did not.
  const command = async (c: NonNullable<ReturnType<typeof commandOf>>) => {
    sending = true;
    setBusy(true);
    try {
      const done = await runCommand(c, { channel: channelOf(ways.target().id), orchestrator: here() });
      if (disposed) return;
      edit("", 0);
      if ("open" in done) ways.opened?.(done.open);
      else ways.told?.(done.say);
    } catch (e) {
      if (!disposed) ways.failed(reasonOf(e));
    } finally {
      sending = false;
      if (!disposed) setBusy(false);
    }
  };

  const send = async () => {
    if (disposed || sending) return;
    const asked = commandOf(text());
    if (asked && !(ways.target().attachments?.length ?? 0)) return command(asked);
    const body = intent();
    if (!body.text && !(body.attachments?.length ?? 0)) return;
    if (!attempt || !same(attempt.body, body)) attempt = { body, key: newSendKey() };
    const sent = attempt;
    const shown = ways.echo ? channelOf(body.id) : undefined;
    if (shown) {
      setPendingLines((all) => [...all.filter((p) => p.key !== sent.key), { key: sent.key, channel: shown.id, text: body.text }]);
      // The box empties at once; a failure puts the line back, with its key, unless something was typed meanwhile.
      edit("", 0);
    }
    const editedAt = edits;
    sending = true;
    setBusy(true);
    try {
      await api.channel.message.send({ ...sent.body, sendKey: sent.key });
      attempt = undefined;
      if (!disposed) ways.sent?.();
      // The window hides it once its copy is in the channel; the list lets it go a while after.
      if (shown) setTimeout(() => setPendingLines((all) => all.filter((p) => p.key !== sent.key)), 15_000);
      // The user may have edited, or chosen another destination, while this response was in flight.
      else if (!disposed && edits === editedAt && same(intent(), sent.body)) edit("", 0);
    } catch (e) {
      if (shown) {
        setPendingLines((all) => all.filter((p) => p.key !== sent.key));
        if (!disposed && edits === editedAt) edit(sent.body.text, sent.body.text.length);
      }
      if (!disposed) ways.failed(reasonOf(e));
    } finally {
      sending = false;
      if (!disposed) setBusy(false);
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
    canSend: () => (text().trim() !== "" || (ways.target().attachments?.length ?? 0) > 0) && !busy(),
    here,
    /** The place's orchestrator is in a round the owner may stop. */
    stoppable: () => ["thinking", "speaking"].includes(orchestratorMood(core(), here())),
  };
}
