import { Schema } from "effect";
import { type Accessor, createMemo, createSignal, flush, onSettled } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Attachment, type ChatMessage, type Channel, defaultOrchestrator, type SayRequest, VibeValleyApi, type SpaceView } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import type { Mark } from "#/base/typedMarks.ts";
import { useOrchestrators } from "#/infra/agents.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { orchestratorMood } from "#/infra/frame.ts";
import { ready, settingsQuery, useQuery } from "#/infra/query.ts";
import { defineAtom } from "#/state/atom.ts";
import { defineIntent, type Intent, type Intents } from "#/state/intent.ts";
import { defineStored, orFallback } from "#/state/stored.ts";
import { createAct } from "#/ui/act.ts";

import { commandNameables, commandOf, runCommand, typedCommand } from "./commands";
import { followed, useMessage } from "./follow";
import { insertName, type Nameable, nameables, offeredFor, typedName } from "./mentions";

/** A line as it is said: everything the server takes but its key, which is the intent's. */
export type Said = Omit<SayRequest, "sendKey">;

const arrived = (key: string, messages: readonly Pick<ChatMessage, "sendKey">[]) => messages.some((m) => m.sendKey === key);

export const chatSay = defineIntent<Said, void>({
  send: (body, key) => api.channel.message.send({ ...body, sendKey: key }),
  // The channel is followed while the line is kept, so its copy is seen even after the window that sent it closed.
  confirmed: (_frame, intent) => arrived(intent.key, followed.get(intent.input.id).messages),
  watch: (body, changed) => followed.subscribe(body.id, changed),
  whileLost: "queue",
  timeoutMs: 20_000,
});

/** A line sent and not yet in its channel. */
interface PendingLine {
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
      s.phase === "failed" ? { key: s.key, text: s.input.text, state: "failed", reason: s.fault.reason } : { key: s.key, text: s.input.text, state: "sending" },
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

/** What a chat box reads from an input method's full-width marks (base/typedMarks.ts): 、 first is a command, ＠ names
 * someone. */
export const chatMarks: readonly Mark[] = ["/", "@"];

/** Where a menu was asked for: a command (/ first in the box) or a name (@), by where it starts. */
interface Trigger {
  readonly kind: "command" | "name";
  readonly start: number;
}

export function createComposer(core: () => SpaceView | undefined, input: () => HTMLTextAreaElement | undefined, ways: ComposerWays) {
  const [text, setText] = createSignal(ways.initial ?? "");
  const [caret, setCaret] = createSignal(0);
  const [active, setActive] = createSignal(0);
  /** The menu: open; away while the box has not the focus; or shut by Escape at one trigger (a command or a name, where it
   * starts), which it stays for while the caret is in that trigger. */
  const [menu, setMenu] = createSignal<{ readonly _tag: "open" } | { readonly _tag: "away" } | { readonly _tag: "shut"; readonly at: Trigger }>({
    _tag: "open",
  });
  const [sending, setSending] = createSignal(false);
  let disposed = false;
  onSettled(() => () => {
    disposed = true;
  });
  // A slash command is an Act: busy until it ends, and while the state stream is lost it is refused, not sent.
  const commanding = createAct((reason) => {
    if (!disposed) ways.failed(reason);
  });
  const busy = () => sending() || commanding.busy();
  const intent = (): Said => ({ ...ways.target(), text: text().trim() });
  const channelOf = (id: string | undefined): Channel | undefined => {
    const all = core()?.chat?.channels ?? [];
    return id ? all.find((c) => c.id === id) : all.find((c) => c.default);
  };

  const orchestrators = useOrchestrators();
  const settings = useQuery(settingsQuery);
  /** What is set up, for the commands that need it (/imagegen); unknown while the settings are on their way. */
  const readiness = () => ready(settings, undefined)?.readiness;
  /** The orchestrator in the place the next line goes to. */
  const here = () => channelOf(ways.target().id)?.orchestrator ?? defaultOrchestrator;
  // A command (/ first in the box) is offered anywhere; no one else is in a direct channel to be named.
  const hidden = (kind: Trigger["kind"], found: { readonly start: number } | undefined) => {
    const m = menu();
    return m._tag === "away" || (m._tag === "shut" && found !== undefined && m.at.kind === kind && m.at.start === found.start);
  };
  const commandTyping = createMemo(() => {
    const c = typedCommand(text(), caret());
    return hidden("command", c) ? undefined : c;
  });
  const typing = createMemo(() => {
    if (channelOf(ways.target().id)?.type === "direct") return undefined;
    const n = typedName(text(), caret());
    return hidden("name", n) ? undefined : n;
  });
  /** Read from what was typed, not the signals just set: a menu shut at a trigger the caret has left is forgotten. */
  const moved = (value: string, at: number) =>
    setMenu((m) => {
      if (m._tag === "open") return m;
      if (m._tag === "away") return { _tag: "open" };
      const now = m.at.kind === "command" ? typedCommand(value, at) : typedName(value, at);
      return now?.start === m.at.start ? m : { _tag: "open" };
    });
  const offered = createMemo(() => {
    const c = commandTyping();
    if (c) return offeredFor(commandNameables(readiness()), c.query);
    const t = typing();
    return t ? offeredFor(nameables(core()?.sessions ?? [], orchestrators(), here(), Date.now()), t.query) : [];
  });

  const edit = (value: string, at: number) => {
    setText(value);
    setCaret(at);
    setActive(0);
    moved(value, at);
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
    setSending(true);
    try {
      const done = await commanding.run(() => runCommand(c, { channel: channelOf(ways.target().id), orchestrator: here(), readiness: readiness() }));
      if (disposed || !done) return;
      edit("", 0);
      if ("open" in done) ways.opened?.(done.open);
      else ways.told?.(done.say);
    } finally {
      setSending(false);
    }
  };

  const send = async () => {
    if (disposed || busy()) return;
    const asked = commandOf(text());
    if (asked && !((ways.target().attachments?.length ?? 0) !== 0)) return command(asked);
    const body = intent();
    if (!body.text && !((body.attachments?.length ?? 0) !== 0)) return;
    // The default channel when the target names none: the line is kept, and followed, by the channel it is in.
    const said = { ...body, id: channelOf(body.id)?.id ?? body.id };
    edit("", 0);
    ways.sent?.();
    const end = await ways.says.send(said).done;
    if (!disposed && end?.phase === "failed") ways.failed(end.fault.reason);
  };

  const onKey = (e: Pick<KeyboardEvent, "key" | "isComposing" | "shiftKey" | "preventDefault" | "stopPropagation">) => {
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
        const picked = list[Math.min(active(), list.length - 1)];
        if (picked) choose(picked);
        return;
      }
      if (e.key === "Escape") {
        // The menu closes, not the window around it.
        e.preventDefault();
        e.stopPropagation();
        const c = commandTyping();
        const n = typing();
        if (c !== undefined) setMenu({ _tag: "shut", at: { kind: "command", start: c.start } });
        else if (n !== undefined) setMenu({ _tag: "shut", at: { kind: "name", start: n.start } });
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
    follow: (e: Event) => {
      if (!(e.currentTarget instanceof HTMLTextAreaElement)) return;
      setCaret(e.currentTarget.selectionStart);
      moved(e.currentTarget.value, e.currentTarget.selectionStart);
    },
    /** The menu closes when the box loses the focus and comes back with it. */
    blur: () => setMenu({ _tag: "away" }),
    focus: () => setMenu((m) => (m._tag === "away" ? { _tag: "open" } : m)),
    canSend: () => (text().trim() !== "" || (ways.target().attachments?.length ?? 0) > 0) && !busy(),
    here,
    /** The place's orchestrator is in a round the user may stop. */
    stoppable: () => ["thinking", "speaking"].includes(orchestratorMood(core(), here())),
  };
}

/** What the user is writing in each channel, kept on this machine (state/stored.ts) so a reload finds it. */
const DraftSchema = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  reply: Schema.optionalKey(Schema.Struct({ id: Schema.String, number: Schema.Int })),
  files: orFallback(Schema.Array(S.Attachment), []),
});

export type Draft = typeof DraftSchema.Type;

const none: Draft = { files: [] };

const all = defineStored("chat.drafts", Schema.Record(Schema.String, DraftSchema), {});

const empty = (d: Draft) => !d.text && !d.reply && d.files.length === 0;

export const draftOf = (channel: string | undefined): Draft => (channel ? all.get()[channel] : undefined) ?? none;

const put = (channel: string, change: (d: Draft) => Draft) =>
  all.update((a) => {
    const { [channel]: was, ...rest } = a;
    const next = change(was ?? none);
    return empty(next) ? rest : { ...rest, [channel]: next };
  });

export const drafts = {
  text: (channel: string, text: string) => put(channel, (d) => ({ ...d, text })),
  reply: (channel: string, m: ChatMessage | undefined) => put(channel, ({ reply: _, ...d }) => (m ? { ...d, reply: { id: m.id, number: m.number } } : d)),
  add: (channel: string, file: Attachment) => put(channel, (d) => ({ ...d, files: [...d.files.filter((f) => f.id !== file.id), file] })),
  drop: (channel: string, id: string) => put(channel, (d) => ({ ...d, files: d.files.filter((f) => f.id !== id) })),
  clear: (channel: string) => put(channel, () => none),
};

/** The message a channel's draft answers, as it is now; undefined when there is none, or it was deleted. */
export function useReplying(channel: Accessor<string | undefined>): Accessor<ChatMessage | undefined> {
  const at = createMemo(
    () => {
      const id = channel();
      const reply = draftOf(id).reply;
      return id && reply ? { channel: id, ...reply } : undefined;
    },
    { equals: (a, b) => a?.channel === b?.channel && a?.id === b?.id && a?.number === b?.number },
  );
  const message = useMessage(at);
  return () => {
    const m = message();
    return m && m.id === at()?.id && m.deleted === undefined ? m : undefined;
  };
}

/** The message the user is changing in place, one at a time across the page (↑ in an empty box picks the last). */
const editing = defineAtom<string | undefined>(undefined);
export const editingId = editing.get;
export const setEditingId = editing.set;

/** fetch over XMLHttpRequest, which tells how much of the body has gone up. */
const sending =
  (progress: (sent: number, total: number) => void): typeof fetch =>
  (url, init) =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(init?.method ?? "GET", url instanceof Request ? url.url : url.toString());
      for (const [k, v] of new Headers(init?.headers).entries()) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => e.lengthComputable && progress(e.loaded, e.total);
      xhr.onload = () =>
        resolve(new Response(xhr.responseText, { status: xhr.status, headers: { "content-type": xhr.getResponseHeader("content-type") ?? "" } }));
      xhr.onerror = () => reject(new Error(t("web.base.unreachable")));
      const body = init?.body;
      if (body instanceof ReadableStream) throw new TypeError("a streamed body has no upload progress");
      xhr.send(body);
    });

/** A file uploaded for a message; progress is told in whole percents as it goes up. */
async function upload(file: File, progress: (percent: number) => void = () => {}): Promise<Attachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In pieces: one call with every byte as an argument overflows the stack for a big file.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const api = new VibeValleyApi(
    "",
    sending((sent, total) => progress(Math.min(100, Math.round((sent / total) * 100)))),
  );
  return api.channel.attachment.create({ name: file.name || "file", type: file.type || "application/octet-stream", data: btoa(binary) });
}

export interface Upload {
  readonly key: number;
  readonly channel: string;
  readonly name: string;
  readonly percent: number;
}

const uploads = defineAtom<readonly Upload[]>([]);
let lastUpload = 0;

export const uploadsIn = (channel: string | undefined) => uploads.get().filter((u) => u.channel === channel);

/** Files picked, pasted or dropped: each goes up in turn and joins the channel's draft. */
export async function attachFiles(channel: string, files: readonly File[], failed: (reason: string) => void) {
  for (const file of files) {
    const key = ++lastUpload;
    uploads.update((u) => [...u, { key, channel, name: file.name || "file", percent: 0 }]);
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one upload at a time, in the order picked: the drafts keep the files' order
      drafts.add(channel, await upload(file, (percent) => uploads.update((u) => u.map((x) => (x.key === key ? { ...x, percent } : x)))));
    } catch (e) {
      failed(reasonOf(e));
    } finally {
      uploads.update((u) => u.filter((x) => x.key !== key));
    }
  }
}
