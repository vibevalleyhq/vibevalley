import type { JSX } from "@solidjs/web";
import { createSignal, flush, For, Show, untrack } from "solid-js";

import { Progress } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import { userId } from "@vibevalley/protocol";
import type { BlockRef, Channel } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { attachFiles, chatMarks, chatSay, createComposer, draftOf, drafts, setEditingId, uploadsIn, useReplying } from "#/features/channel/model/composing.ts";
import { followed } from "#/features/channel/model/follow.ts";
import { DictationBar, DictationKey, dictationKey, DictationProblem, useDictation } from "#/features/voice/index.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { AttachmentTile } from "#/ui/domain/AttachmentTile.tsx";
import { OrchestratorFace } from "#/ui/domain/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { typeMarks } from "#/ui/markInput.ts";
import { toast } from "#/ui/toasts.ts";

import { EmojiPicker } from "./EmojiPicker";
import { HelperFace } from "./presence";

/** The box for saying a sentence in a channel: Enter sends, Shift+Enter starts a line, @ names someone. */
export interface QuotedBlockDraft {
  readonly ref: BlockRef;
  readonly text: string;
}

export function Composer(props: {
  channel: Channel | undefined;
  placeholder: string;
  quoted?: readonly QuotedBlockDraft[] | undefined;
  onClearQuote?: (() => void) | undefined;
  onRemoveQuote?: ((blockId: string) => void) | undefined;
}) {
  const core = useCore();
  let input: HTMLTextAreaElement | undefined;
  const [problem, setProblem] = createSignal<string>();
  const [emoji, setEmoji] = createSignal(false);
  let emojiButton: HTMLButtonElement | undefined;
  const draft = () => draftOf(props.channel?.id);
  const uploading = () => uploadsIn(props.channel?.id);
  const replying = useReplying(() => props.channel?.id);
  // Built once for the channel (the page keys the box by it): it starts from the draft kept for it.
  const at = untrack(() => props.channel?.id);
  const router = useRouter();
  const box = createComposer(core, () => input, {
    ...(at ? { initial: untrack(() => draftOf(at).text) } : {}),
    says: useIntents(chatSay),
    target: () => {
      const d = draft();
      const reply = replying();
      return {
        id: props.channel?.id ?? "",
        ...(reply ? { replyTo: reply.number } : {}),
        ...(d.files.length > 0 ? { attachments: d.files.map((f) => f.id) } : {}),
        ...((props.quoted?.length ?? 0) > 0 ? { blocks: (props.quoted ?? []).map((q) => q.ref) } : {}),
      };
    },
    failed: (reason) => {
      setProblem(reason);
      toast(t("web.channel.composer.notSent", { why: reason }), "bad");
    },
    told: (say) => toast(say),
    opened: (path) => router.navigate(path),
    edited: (value) => {
      setProblem(undefined);
      if (at) drafts.text(at, value);
    },
    sent: () => {
      const id = props.channel?.id;
      if (id) drafts.clear(id);
      props.onClearQuote?.();
    },
  });
  const attach = (files: readonly File[]) => {
    const id = props.channel?.id;
    if (id && files.length > 0) void attachFiles(id, files, uploadFailed);
  };
  /** The box as it is now, with its caret at: written at once, so a key typed right after lands there (composing.ts, choose). */
  const put = (next: string, at: number) => {
    box.edit(next, at);
    flush();
    input?.focus();
    input?.setSelectionRange(at, at);
  };
  const insert = (emojiText: string) => {
    const from = input?.selectionStart ?? box.text().length;
    const to = input?.selectionEnd ?? from;
    put(box.text().slice(0, from) + emojiText + box.text().slice(to), from + emojiText.length);
  };
  /** An @ at the caret, apart from the word before it: the names menu opens. */
  const startMention = () => {
    const from = input?.selectionStart ?? box.text().length;
    const before = box.text().slice(0, from);
    insert(before === "" || /\s$/u.test(before) ? "@" : " @");
  };
  /** A command is the line's first word: a / at its start opens the commands menu, the words after it kept. */
  const startCommand = () => put(box.text().startsWith("/") ? box.text() : "/" + box.text(), 1);
  // ↑ in an empty box changes the user's last message here; Esc lets go of the message being answered.
  const dictating = useDictation({ input: () => input, value: () => box.text(), onValue: (v, c) => box.edit(v, c) });
  // While this box listens, its row is the recording's: cancel or done in place of attach and send.
  const listening = () => dictating.mine() && (dictating.state() === "recording" || dictating.state() === "transcribing");
  const onKey = (e: KeyboardEvent) => {
    if (dictationKey(dictating, e)) return;
    const id = props.channel?.id;
    if (!e.isComposing && id && box.offered().length === 0) {
      if (e.key === "ArrowUp" && box.text() === "") {
        const mine = [...followed.get(id).messages].toReversed().find((m) => m.from === userId && m.kind === "chat" && m.deleted === undefined);
        if (mine) {
          e.preventDefault();
          setEditingId(mine.id);
          return;
        }
      }
      if (e.key === "Escape" && replying()) {
        e.preventDefault();
        e.stopPropagation();
        drafts.reply(id, undefined);
        return;
      }
    }
    box.onKey(e);
  };
  let picker: HTMLInputElement | undefined;
  const stopping = createAct();
  const stop = () => {
    const agent = box.here();
    return stopping.run(() => api.orchestrator.stop({ agent }));
  };

  return (
    <div data-testid="composer" data-key={props.channel?.id} class="relative border-t border-line px-4 pt-3 pb-4">
      <Show when={box.offered().length > 0}>
        <div
          role="listbox"
          aria-label={t("web.channel.composer.who")}
          data-testid="mentions"
          class="animate-pop-in absolute inset-x-4 bottom-[calc(100%_-_0.5rem)] z-30 max-h-72 overflow-y-auto flex [transform-origin:bottom] flex-col rounded-lg border border-line bg-page p-1 shadow-float"
        >
          <For each={box.offered()} keyed={(n) => n.token}>
            {(n, i) => (
              <div
                role="option"
                data-key={n().token}
                aria-selected={aria(i() === box.active())}
                onMouseEnter={() => box.setActive(i())}
                // Keeps the focus in the input.
                onMouseDown={(e) => {
                  e.preventDefault();
                  box.choose(n());
                }}
                class={["flex cursor-pointer items-center gap-2 rounded-md px-2 py-1", i() === box.active() ? "bg-selected" : ""]}
              >
                <Show
                  when={n().session}
                  fallback={
                    n().orchestrator ? (
                      <OrchestratorFace size={20} agent={n().orchestrator} />
                    ) : (
                      <span class="inline-flex shrink-0 w-5 h-5 items-center justify-center text-muted">
                        <Show when={n().args !== undefined}>
                          <Icon name="command" size={14} />
                        </Show>
                      </span>
                    )
                  }
                >
                  {(s) => <HelperFace agent={s().agent} runtime={s().runtime} size={20} />}
                </Show>
                <span class="font-mono text-xs">
                  {n().token}
                  <Show when={n().args !== undefined && n().args !== ""}>
                    <span class="text-faint"> {n().args}</span>
                  </Show>
                </span>
                <Show when={n().session !== undefined || n().args !== undefined}>
                  <span class="text-sm">{n().name}</span>
                </Show>
                <span class="min-w-0 flex-1 truncate text-xs text-muted">{n().note}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={problem()}>
        {(p) => (
          <p role="alert" data-testid="chat-problem" class="mb-1.5 text-xs text-berry">
            {p()}
          </p>
        )}
      </Show>
      <Show when={(props.quoted?.length ?? 0) > 0}>
        <div class="mb-1.5 flex flex-col gap-1">
          <For each={props.quoted} keyed={(q) => q.ref.blockId}>
            {(q) => (
              <div data-testid="quoted-block" data-key={q().ref.blockId} class="flex items-center gap-2 rounded-md bg-hover px-3 py-1.5 text-xs text-muted">
                <Icon name="artifacts" size={12} />
                <span class="min-w-0 flex-1 truncate">{t("web.channel.composer.quotedBlock", { text: q().text })}</span>
                <button
                  type="button"
                  class="cursor-pointer rounded-sm p-0.5 hover:bg-page"
                  data-testid="quoted-block-remove"
                  aria-label={t("web.channel.composer.cancelQuote")}
                  title={t("web.channel.composer.cancelQuote")}
                  onClick={() => props.onRemoveQuote?.(q().ref.blockId)}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={replying()}>
        {(m) => (
          <div data-testid="replying" data-key={m().number} class="mb-1.5 flex items-center gap-2 rounded-md bg-hover px-3 py-1.5 text-xs text-muted">
            <Icon name="reply" size={12} />
            <span class="min-w-0 flex-1 truncate">
              {t("shared.join.labeled", {
                label: t("web.channel.composer.replying", { name: m().from === userId ? t("web.channel.messages.user") : m().name }),
                text: m().text,
              })}
            </span>
            <button
              type="button"
              class="cursor-pointer rounded-sm p-0.5 hover:bg-page"
              data-testid="cancel-reply"
              aria-label={t("web.channel.composer.cancelReply")}
              title={t("web.channel.composer.cancelReply")}
              onClick={() => props.channel && drafts.reply(props.channel.id, undefined)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
      </Show>
      <Show when={draft().files.length > 0 || uploading().length > 0}>
        <div class="mb-1.5 flex flex-wrap gap-1.5">
          <For each={draft().files} keyed={(f) => f.id}>
            {(f) => <AttachmentTile testid="pending-file" file={f()} onRemove={() => props.channel && drafts.drop(props.channel.id, f().id)} />}
          </For>
          <For each={uploading()} keyed={(u) => u.key}>
            {(u) => (
              <Progress.Root
                value={u().percent}
                aria-label={u().name}
                class="relative flex h-10 items-center overflow-hidden rounded-md border border-line bg-page px-2 text-xs text-muted"
              >
                <Progress.Indicator class="absolute inset-y-0 left-0 bg-leaf/20" />
                <span class="relative max-w-48 truncate">{t("web.channel.media.uploadingFile", { name: u().name, percent: u().percent })}</span>
              </Progress.Root>
            )}
          </For>
        </div>
      </Show>
      <div class="rounded-lg border border-line focus-within:border-focus bg-page">
        <textarea
          ref={(el) => (input = el)}
          value={box.text()}
          rows={2}
          data-testid="composer-input"
          aria-label={props.placeholder}
          placeholder={props.placeholder}
          onInput={(e) => {
            if (!e.isComposing && typeMarks(e.currentTarget, chatMarks)) return;
            box.edit(e.currentTarget.value, e.currentTarget.selectionStart);
          }}
          onKeyUp={box.follow}
          onClick={box.follow}
          onKeyDown={onKey}
          onBlur={box.blur}
          onFocus={box.focus}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (files.length === 0) return;
            e.preventDefault();
            attach(files);
          }}
          class="block field-sizing-content max-h-50 min-h-13 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base outline-none placeholder:text-faint"
        />
        <DictationProblem dictating={dictating} />
        <div class="flex h-9 items-center gap-1 px-2 pb-2">
          <Show
            when={listening()}
            fallback={
              <>
                <Show when={props.channel?.type !== "direct"}>
                  <button
                    type="button"
                    data-testid="mention-open"
                    onClick={startMention}
                    disabled={props.channel === undefined}
                    aria-label={t("web.channel.composer.mention")}
                    title={t("web.channel.composer.mention")}
                    class="inline-flex w-7 h-7 cursor-pointer disabled:cursor-default items-center justify-center rounded-md hover:bg-hover disabled:opacity-50"
                  >
                    <Icon name="mention" size={16} />
                  </button>
                </Show>
                <button
                  type="button"
                  data-testid="command-open"
                  onClick={startCommand}
                  disabled={props.channel === undefined}
                  aria-label={t("web.channel.composer.command")}
                  title={t("web.channel.composer.command")}
                  class="inline-flex w-7 h-7 cursor-pointer disabled:cursor-default items-center justify-center rounded-md hover:bg-hover disabled:opacity-50"
                >
                  <Icon name="command" size={16} />
                </button>
                <span class="flex-1" />
                <input
                  ref={(el) => (picker = el)}
                  type="file"
                  multiple
                  class="hidden"
                  aria-hidden="true"
                  tabindex={-1}
                  onChange={(e) => {
                    const files = [...(e.currentTarget.files ?? [])];
                    e.currentTarget.value = "";
                    attach(files);
                  }}
                />
                <button
                  type="button"
                  data-testid="attach"
                  onClick={() => picker?.click()}
                  disabled={!props.channel}
                  aria-label={t("web.channel.composer.attach")}
                  title={t("web.channel.composer.attach")}
                  class="inline-flex w-7 h-7 cursor-pointer disabled:cursor-default items-center justify-center rounded-md hover:bg-hover disabled:opacity-50"
                >
                  <Icon name="attach" size={16} />
                </button>
                <div>
                  <button
                    type="button"
                    ref={(el) => (emojiButton = el)}
                    data-testid="emoji"
                    onClick={() => setEmoji(!emoji())}
                    disabled={!props.channel}
                    aria-label={t("web.channel.emoji.open")}
                    aria-expanded={aria(emoji())}
                    title={t("web.channel.emoji.open")}
                    class="inline-flex w-7 h-7 cursor-pointer disabled:cursor-default items-center justify-center rounded-md hover:bg-hover disabled:opacity-50"
                  >
                    <Icon name="react" size={16} />
                  </button>
                  <Show when={emoji()}>
                    <EmojiPicker
                      anchor={emojiButton}
                      onClose={() => setEmoji(false)}
                      onPick={(e) => {
                        setEmoji(false);
                        insert(e);
                      }}
                    />
                  </Show>
                </div>
              </>
            }
          >
            <DictationBar dictating={dictating} />
          </Show>
          <DictationKey dictating={dictating} bar surface size={16} class="w-7 h-7 rounded-md" />
          <Show when={!listening()}>
            <Show when={box.stoppable()}>
              <button
                type="button"
                data-testid="stop"
                onClick={() => void stop()}
                aria-label={t("web.channel.composer.stop")}
                title={t("web.channel.composer.stopHint")}
                class="inline-flex w-7 h-7 cursor-pointer items-center justify-center rounded-md border border-line text-berry hover:bg-hover"
              >
                <Icon name="stop" size={16} />
              </button>
            </Show>
            <button
              type="button"
              data-testid="send"
              onClick={() => void box.send()}
              disabled={!box.canSend()}
              aria-label={t("web.channel.composer.send")}
              title={t("web.channel.composer.sendHint")}
              class={[
                "inline-flex w-7 h-7 cursor-pointer disabled:cursor-default items-center justify-center rounded-md border",
                box.canSend() ? "border-accent bg-accent hover:bg-accent-hover" : "border-transparent opacity-50",
              ]}
            >
              <Icon name="send" size={16} />
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** A channel's pane taking files dropped on it into the channel's draft; a sidebar row dragged over it is not a file. */
export function FileDrop(props: { channel: Channel | undefined; children: JSX.Element }) {
  const [over, setOver] = createSignal(false);
  const files = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes("Files");
  return (
    <div
      class="relative flex min-w-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!files(e) || !props.channel) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget instanceof Node ? e.relatedTarget : null)) setOver(false);
      }}
      onDrop={(e) => {
        setOver(false);
        const id = props.channel?.id;
        if (!files(e) || !id) return;
        e.preventDefault();
        void attachFiles(id, [...(e.dataTransfer?.files ?? [])], uploadFailed);
      }}
    >
      {props.children}
      <Show when={over()}>
        <div
          data-testid="drop-hint"
          class="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-dashed border-2 border-accent bg-page/85 text-base font-semibold text-accent"
        >
          {t("web.channel.media.drop")}
        </div>
      </Show>
    </div>
  );
}

const uploadFailed = (reason: string) => toast(t("web.channel.composer.uploadFailed", { why: reason }), "bad");
