import { t } from "@vibevalley/i18n";
import { ownerId } from "@vibevalley/protocol";
import { attachFiles, draftOf, drafts, setEditingId, uploadsIn } from "./draft";
import { EmojiPicker } from "./EmojiPicker";
import { followed } from "./follow";

import { createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { Channel } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { createComposer } from "./composing";
import { toast } from "../../ui/toasts";
import { aria } from "../../base/util";
import { useCore } from "../../base/frame";
import { OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { DictationButton } from "../voice";
import { HelperFace } from "./bits";

/** The box for saying a sentence in a channel: Enter sends, Shift+Enter starts a line, @ names someone. */
export function Composer(props: { channel: Channel | undefined; placeholder: string }) {
  const core = useCore();
  let input: HTMLTextAreaElement | undefined;
  const [problem, setProblem] = createSignal<string>();
  const [emoji, setEmoji] = createSignal(false);
  let emojiButton: HTMLButtonElement | undefined;
  const draft = () => draftOf(props.channel?.id);
  const uploading = () => uploadsIn(props.channel?.id);
  // Built once for the channel (the page keys the box by it): it starts from the draft kept for it.
  const at = untrack(() => props.channel?.id);
  const box = createComposer(core, () => input, {
    initial: at ? untrack(() => draftOf(at).text) : undefined,
    target: () => {
      const d = draft();
      return {
        id: props.channel?.id ?? "",
        ...(d.reply ? { replyTo: d.reply.number } : {}),
        ...(d.files.length > 0 ? { attachments: d.files.map((f) => f.id) } : {}),
      };
    },
    failed: (reason) => {
      setProblem(reason);
      toast(t("web.channel.composer.notSent", { why: reason }), "bad");
    },
    edited: (value) => {
      setProblem(undefined);
      if (at) drafts.text(at, value);
    },
    sent: () => {
      const id = props.channel?.id;
      if (id) drafts.clear(id);
    },
  });
  const attach = (files: readonly File[]) => {
    const id = props.channel?.id;
    if (id && files.length > 0) void attachFiles(id, files, uploadFailed);
  };
  const insert = (emojiText: string) => {
    const el = input;
    const from = el?.selectionStart ?? box.text().length;
    const to = el?.selectionEnd ?? from;
    const next = box.text().slice(0, from) + emojiText + box.text().slice(to);
    box.edit(next, from + emojiText.length);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(from + emojiText.length, from + emojiText.length);
    });
  };
  // ↑ in an empty box changes the owner's last message here; Esc lets go of the message being answered.
  const onKey = (e: KeyboardEvent) => {
    const id = props.channel?.id;
    if (!e.isComposing && id && box.offered().length === 0) {
      if (e.key === "ArrowUp" && box.text() === "") {
        const mine = [...followed.get(id).messages].reverse().find((m) => m.from === ownerId && m.kind === "chat" && m.deleted === undefined);
        if (mine) {
          e.preventDefault();
          return setEditingId(mine.id);
        }
      }
      if (e.key === "Escape" && draft().reply) {
        e.preventDefault();
        e.stopPropagation();
        return drafts.reply(id, undefined);
      }
    }
    box.onKey(e);
  };
  let picker: HTMLInputElement | undefined;
  const stop = () => api.orchestrator.stop({ agent: box.here() }).catch((e) => toast(reasonOf(e), "bad"));

  return (
    <div class="border-t border-line px-4 pt-3 pb-4">
      <Show when={box.offered().length > 0}>
        <div role="listbox" aria-label={t("web.channel.composer.who")} class="mb-1.5 flex flex-col rounded-lg border border-line bg-page p-1 shadow-float">
          <For each={box.offered()} keyed={(n) => n.token}>
            {(n, i) => (
              <div
                role="option"
                aria-selected={aria(i() === box.active())}
                onMouseEnter={() => box.setActive(i())}
                // Keeps the focus in the input.
                onMouseDown={(e) => {
                  e.preventDefault();
                  box.choose(n());
                }}
                class={["flex cursor-pointer items-center gap-2 rounded-md px-2 py-1", { "bg-selected": i() === box.active() }]}
              >
                <Show when={n().session} fallback={n().orchestrator ? <OrchestratorFace size={20} agent={n().orchestrator} /> : <span class="size-5" />}>
                  {(s) => <HelperFace agent={s().agent} runtime={s().runtime} size={20} />}
                </Show>
                <span class="font-mono text-xs">{n().token}</span>
                <Show when={n().session}>
                  <span class="text-sm">{n().name}</span>
                </Show>
                <span class="min-w-0 flex-1 truncate text-xs text-muted">{n().note}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={problem()}>{(p) => <p class="mb-1.5 text-xs text-berry">{p()}</p>}</Show>
      <Show when={draft().reply}>
        {(m) => (
          <div class="mb-1.5 flex items-center gap-2 rounded-md bg-hover px-3 py-1.5 text-xs text-muted">
            <Icon name="reply" size={12} />
            <span class="min-w-0 flex-1 truncate">
              {t("shared.join.labeled", {
                label: t("web.channel.composer.replying", { name: m().from === ownerId ? t("web.channel.messages.owner") : m().name }),
                text: m().text,
              })}
            </span>
            <button
              type="button"
              class="cursor-pointer rounded p-0.5 hover:bg-page"
              aria-label={t("web.channel.composer.cancelReply")}
              title={t("web.channel.composer.cancelReply")}
              onClick={() => drafts.reply(props.channel!.id, undefined)}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
      </Show>
      <Show when={draft().files.length > 0 || uploading().length > 0}>
        <div class="mb-1.5 flex flex-wrap gap-1.5">
          <For each={draft().files} keyed={(f) => f.id}>
            {(f) => (
              <span class="flex items-center gap-1.5 rounded-md border border-line bg-page py-1 pr-1 pl-2 text-xs">
                <Icon name="attach" size={12} />
                <span class="max-w-48 truncate">{f().name}</span>
                <button
                  type="button"
                  class="cursor-pointer rounded p-0.5 hover:bg-hover"
                  aria-label={t("web.channel.composer.removeFile", { name: f().name })}
                  onClick={() => drafts.drop(props.channel!.id, f().id)}
                >
                  <Icon name="close" size={10} />
                </button>
              </span>
            )}
          </For>
          <For each={uploading()} keyed={(u) => u.key}>
            {(u) => (
              <span
                role="progressbar"
                aria-label={u().name}
                aria-valuenow={u().percent}
                aria-valuemin={0}
                aria-valuemax={100}
                class="relative flex items-center overflow-hidden rounded-md border border-line bg-page px-2 py-1 text-xs text-muted"
              >
                <span class="absolute inset-y-0 left-0 bg-leaf/20" style={{ width: `${u().percent}%` }} />
                <span class="relative max-w-48 truncate">{t("web.channel.media.uploadingFile", { name: u().name, percent: u().percent })}</span>
              </span>
            )}
          </For>
        </div>
      </Show>
      <div class="rounded-lg border border-line bg-page focus-within:border-focus">
        <textarea
          ref={(el) => (input = el)}
          value={box.text()}
          rows={2}
          aria-label={props.placeholder}
          placeholder={props.placeholder}
          onInput={(e) => box.edit(e.currentTarget.value, e.currentTarget.selectionStart)}
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
          class="block max-h-[200px] min-h-[52px] w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base outline-none [field-sizing:content] placeholder:text-faint"
        />
        <div class="flex items-center gap-1 px-2 pb-2">
          <Show when={props.channel?.type !== "direct"}>
            <span class="text-xs text-faint">{t("web.channel.composer.mention")}</span>
          </Show>
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
            onClick={() => picker?.click()}
            disabled={!props.channel}
            aria-label={t("web.channel.composer.attach")}
            title={t("web.channel.composer.attach")}
            class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-hover disabled:cursor-default disabled:opacity-40"
          >
            <Icon name="attach" size={16} />
          </button>
          <div>
            <button
              type="button"
              ref={(el) => (emojiButton = el)}
              onClick={() => setEmoji(!emoji())}
              disabled={!props.channel}
              aria-label={t("web.channel.emoji.open")}
              aria-expanded={aria(emoji())}
              title={t("web.channel.emoji.open")}
              class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md hover:bg-hover disabled:cursor-default disabled:opacity-40"
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
          <DictationButton field={() => input} value={box.text()} onValue={box.edit} size={16} class="size-7 rounded-md hover:bg-hover" />
          <Show when={box.stoppable()}>
            <button
              type="button"
              onClick={() => void stop()}
              aria-label={t("web.channel.composer.stop")}
              title={t("web.channel.composer.stopHint")}
              class="inline-flex size-7 cursor-pointer items-center justify-center rounded-md border border-line text-berry hover:bg-hover"
            >
              <Icon name="stop" size={16} />
            </button>
          </Show>
          <button
            type="button"
            onClick={() => void box.send()}
            disabled={!box.canSend()}
            aria-label={t("web.channel.composer.send")}
            title={t("web.channel.composer.sendHint")}
            class={[
              "inline-flex size-7 cursor-pointer items-center justify-center rounded-md border disabled:cursor-default",
              box.canSend() ? "border-accent bg-accent hover:bg-leaf" : "border-transparent opacity-50",
            ]}
          >
            <Icon name="send" size={16} />
          </button>
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
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
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
        <div class="pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg border-2 border-dashed border-accent bg-page/85 text-base font-semibold text-accent">
          {t("web.channel.media.drop")}
        </div>
      </Show>
    </div>
  );
}

const uploadFailed = (reason: string) => toast(t("web.channel.composer.uploadFailed", { why: reason }), "bad");
