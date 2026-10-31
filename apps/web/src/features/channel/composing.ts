// The box for saying a sentence in a channel, as both chat windows carry it out: the workbench's
// (features/channel/Composer.tsx) and the farm's (farm/chat/Composer.tsx). Enter sends, Shift+Enter starts a line, @ names
// someone from a menu that follows the caret. A line sent is an intent (chatSay, state/intent.ts) keyed by its send key:
// the box empties at once and the window shows the line until the channel has the owner's copy carrying the key. A
// failed one stays in sight with its key, wherever the owner goes meanwhile, so a retry is the same message, not a second
// one. A window only draws it and says where a line goes and how a failure shows.

import { createMemo, createSignal, flush, onSettled } from "solid-js";

import { type ChatMessage, type Channel, defaultOrchestrator, type SayRequest, type WorkspaceView } from "@vibevalley/protocol";

import { useOrchestrators } from "@/infra/agents";
import { api } from "@/infra/api";
import { orchestratorMood } from "@/infra/frame";
import { defineIntent, type Intent, type Intents } from "@/state/intent";
import { createAct } from "@/ui/act";

import { commandNameables, commandOf, runCommand, typedCommand } from "./commands";
import { followed } from "./follow";
import { insertName, type Nameable, nameables, offeredFor, typedName } from "./mentions";

/** A line as it is said: everything the server takes but its key, which is the intent's. */
export type Said = Omit<SayRequest, "sendKey">;

const arrived = (key: string, messages: readonly Pick<ChatMessage, "sendKey">[]) => messages.some((m) => m.sendKey === key);

/** Every line the owner says in a channel: from either composer, the project map, an artifact's reply, a suggestion. */
export const chatSay = defineIntent<Said, void>({
  send: (body, key) => api.channel.message.send({ ...body, sendKey: key }),
  // The channel is followed while the line is kept, so its copy is seen even after the window that sent it closed.
  confirmed: (_frame, intent) => arrived(intent.key, followed.get(intent.input.id).messages),
  watch: (body, changed) => followed.subscribe(body.id, changed),
  whileLost: "queue",
  timeoutMs: 20_000,
});

/** A line sent and not yet in its channel. */
export interface PendingLine {
  readonly key: string;
  readonly text: string;
  readonly state: "sending" | "failed";
  readonly reason?: string;
}

/** The lines said in a channel that its messages do not have yet, oldest first. */
export function pendingLines(
  says: readonly Intent<Said, void>[],
  channel: string | undefined,
  messages: readonly Pick<ChatMessage, "sendKey">[],
): PendingLine[] {
  if (!channel) return [];
  return says
    .filter((s) => s.input.id === channel && !arrived(s.key, messages))
    .map((s) =>
      s.status === "failed"
        ? { key: s.key, text: s.input.text, state: "failed", ...(s.reason === undefined ? {} : { reason: s.reason }) }
        : { key: s.key, text: s.input.text, state: "sending" },
    );
}

export interface ComposerWays {
  /** Every routing field of the next message; its text and retry identity belong to the composer. */
  readonly target: () => Omit<SayRequest, "text" | "sendKey">;
  /** The page's lines on their way (useIntents(chatSay)). */
  readonly says: Intents<Said, void>;
  /** The words the box starts with: a draft kept from before. */
  readonly initial?: string;
  readonly failed: (reason: string) => void;
  /** What a slash command came to, in words (commands.ts); a failed one goes to failed. */
  readonly told?: (say: string) => void;
  /** A slash command that opens a place (/dm): the window goes there. */
  readonly opened?: (path: string) => void;
  /** After every edit: the text and the caret. */
  readonly edited?: (value: string, at: number) => void;
  /** Once a line is on its way: what it carried beside its words (a reply, files) is in the line now. */
  readonly sent?: () => void;
}

export function createComposer(core: () => WorkspaceView | undefined, input: () => HTMLTextAreaElement | undefined, ways: ComposerWays) {
  const [text, setText] = createSignal(ways.initial ?? "");
  const [caret, setCaret] = createSignal(0);
  const [active, setActive] = createSignal(0);
  const [closed, setClosed] = createSignal(false);
  let sending = false;
  let disposed = false;
  onSettled(() => () => {
    disposed = true;
  });
  // A slash command is an Act: busy until it ends, and while the state stream is lost it is refused, not sent.
  const commanding = createAct((reason) => {
    if (!disposed) ways.failed(reason);
  });
  const intent = (): Said => ({ ...ways.target(), text: text().trim() });
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
    try {
      const done = await commanding.run(() => runCommand(c, { channel: channelOf(ways.target().id), orchestrator: here() }));
      if (disposed || !done) return;
      edit("", 0);
      if ("open" in done) ways.opened?.(done.open);
      else ways.told?.(done.say);
    } finally {
      sending = false;
    }
  };

  const send = async () => {
    if (disposed || sending) return;
    const asked = commandOf(text());
    if (asked && !((ways.target().attachments?.length ?? 0) !== 0)) return command(asked);
    const body = intent();
    if (!body.text && !((body.attachments?.length ?? 0) !== 0)) return;
    // The default channel when the target names none: the line is kept, and followed, by the channel it is in.
    const said = { ...body, id: channelOf(body.id)?.id ?? body.id };
    edit("", 0);
    ways.sent?.();
    const end = await ways.says.send(said).done;
    if (!disposed && end?.status === "failed") ways.failed(end.reason ?? "");
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
    busy: commanding.busy,
    active,
    setActive,
    offered,
    edit,
    choose,
    send,
    onKey,
    /** The caret moves without typing too (arrow keys, a click): the @ menu follows it. */
    follow: (e: Event) => e.currentTarget instanceof HTMLTextAreaElement && setCaret(e.currentTarget.selectionStart),
    /** The menu closes when the box loses the focus and comes back with it. */
    blur: () => setClosed(true),
    focus: () => setClosed(false),
    canSend: () => (text().trim() !== "" || (ways.target().attachments?.length ?? 0) > 0) && !commanding.busy(),
    here,
    /** The place's orchestrator is in a round the owner may stop. */
    stoppable: () => ["thinking", "speaking"].includes(orchestratorMood(core(), here())),
  };
}
