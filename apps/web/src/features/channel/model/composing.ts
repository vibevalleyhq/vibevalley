import { type Accessor, createMemo, createSignal, flush, onSettled } from "solid-js";
import { z } from "zod";

import { t } from "@vibevalley/i18n";
import { type Attachment, type ChatMessage, type Channel, defaultOrchestrator, type SayRequest, VibeValleyApi, type SpaceView } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import type { Mark } from "#/base/typedMarks.ts";
import { useOrchestrators } from "#/infra/agents.ts";
import { api, reasonOf } from "#/infra/api.ts";
import { attachmentData } from "#/infra/attachment.ts";
import { orchestratorMood } from "#/infra/frame.ts";
import { ready, settingsQuery, useQuery } from "#/infra/query.ts";
import { defineAtom } from "#/state/atom.ts";
import { defineIntent, type Intent, type Intents } from "#/state/intent.ts";
import { defineStored, orFallback } from "#/state/stored.ts";
import { createAct } from "#/ui/act.ts";

import { commandNameables, commandOf, runCommand, typedCommand } from "./commands";
import { followed, useMessage } from "./follow";
import { insertName, type Nameable, nameables, offeredFor, typedName } from "./mentions";

export type Said = Omit<SayRequest, "sendKey">;

const arrived = (key: string, messages: readonly Pick<ChatMessage, "sendKey">[]) => messages.some((m) => m.sendKey === key);

export const chatSay = defineIntent<Said, void>({
  send: (body, key) => api.channel.message.send({ ...body, sendKey: key }),
  confirmed: (_frame, intent) => arrived(intent.key, followed.get(intent.input.id).messages),
  watch: (body, changed) => followed.subscribe(body.id, changed),
  whileLost: "queue",
  timeoutMs: 20_000,
});

interface PendingLine {
  readonly key: string;
  readonly text: string;
  readonly state: "sending" | "failed";
  readonly reason?: string;
}

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
  readonly target: () => Omit<SayRequest, "text" | "sendKey">;
  readonly says: Intents<Said, void>;
  readonly initial?: string;
  readonly failed: (reason: string) => void;
  readonly told?: (say: string) => void;
  readonly opened?: (path: string) => void;
  readonly edited?: (value: string, at: number) => void;
  readonly sent?: () => void;
}

/** Normalized from full-width IME marks (`、` -> `/`, `＠` -> `@`) via `base/typedMarks.ts`. */
export const chatMarks: readonly Mark[] = ["/", "@"];

interface Trigger {
  readonly kind: "command" | "name";
  readonly start: number;
}

export function createComposer(core: () => SpaceView | undefined, input: () => HTMLTextAreaElement | undefined, ways: ComposerWays) {
  const [text, setText] = createSignal(ways.initial ?? "");
  const [caret, setCaret] = createSignal(0);
  const [active, setActive] = createSignal(0);
  // `shut` suppresses the autocomplete popup only while the caret stays inside the dismissed trigger span.
  const [menu, setMenu] = createSignal<{ readonly _tag: "open" } | { readonly _tag: "away" } | { readonly _tag: "shut"; readonly at: Trigger }>({
    _tag: "open",
  });
  const [sending, setSending] = createSignal(false);
  let disposed = false;
  onSettled(() => () => {
    disposed = true;
  });
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
  const readiness = () => ready(settings, undefined)?.readiness;
  const here = () => channelOf(ways.target().id)?.orchestrator ?? defaultOrchestrator;
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
    // Flush DOM updates synchronously before `setSelectionRange` so rapid keystrokes do not land at the stale caret.
    flush();
    input()?.focus();
    input()?.setSelectionRange(next.caret, next.caret);
  };

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
    const said = { ...body, id: channelOf(body.id)?.id ?? body.id };
    edit("", 0);
    ways.sent?.();
    const end = await ways.says.send(said).done;
    if (!disposed && end?.phase === "failed") ways.failed(end.fault.reason);
  };

  const onKey = (e: Pick<KeyboardEvent, "key" | "isComposing" | "shiftKey" | "preventDefault" | "stopPropagation">) => {
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
        // Stop propagation so Escape closes only the autocomplete menu, not an enclosing dialog.
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
    follow: (e: Event) => {
      if (!(e.currentTarget instanceof HTMLTextAreaElement)) return;
      setCaret(e.currentTarget.selectionStart);
      moved(e.currentTarget.value, e.currentTarget.selectionStart);
    },
    blur: () => setMenu({ _tag: "away" }),
    focus: () => setMenu((m) => (m._tag === "away" ? { _tag: "open" } : m)),
    canSend: () => (text().trim() !== "" || (ways.target().attachments?.length ?? 0) > 0) && !busy(),
    here,
    stoppable: () => ["thinking", "speaking"].includes(orchestratorMood(core(), here())),
  };
}

const DraftSchema = z.object({
  text: z.exactOptional(z.string()),
  reply: z.exactOptional(z.object({ id: z.string(), number: z.int() })),
  files: orFallback(z.array(S.Attachment), []),
});

export type Draft = z.output<typeof DraftSchema>;

const none: Draft = { files: [] };

const all = defineStored("chat.drafts", z.record(z.string(), DraftSchema), {});

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

const editing = defineAtom<string | undefined>(undefined);
export const editingId = editing.get;
export const setEditingId = editing.set;

/** Uses XMLHttpRequest instead of `fetch` to report upload byte progress. */
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

async function upload(file: File, progress: (percent: number) => void = () => {}): Promise<Attachment> {
  const data = await attachmentData(file);
  const api = new VibeValleyApi(
    "",
    sending((sent, total) => progress(Math.min(100, Math.round((sent / total) * 100)))),
  );
  return api.attachment.create({ name: file.name || "file", type: file.type || "application/octet-stream", data });
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

export async function attachFiles(channel: string, files: readonly File[], failed: (reason: string) => void) {
  for (const file of files) {
    const key = ++lastUpload;
    uploads.update((u) => [...u, { key, channel, name: file.name || "file", percent: 0 }]);
    try {
      drafts.add(channel, await upload(file, (percent) => uploads.update((u) => u.map((x) => (x.key === key ? { ...x, percent } : x)))));
    } catch (e) {
      failed(reasonOf(e));
    } finally {
      uploads.update((u) => u.filter((x) => x.key !== key));
    }
  }
}
