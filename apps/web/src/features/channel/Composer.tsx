import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, flush, For, Show, untrack } from "solid-js";

import { Progress } from "@vibevalley/base-ui";
import { t } from "@vibevalley/i18n";
import { ownerId } from "@vibevalley/protocol";
import type { BlockRef, Channel } from "@vibevalley/protocol";

import { aria } from "#/base/dom.tsx";
import { DictationBar, DictationKey, dictationKey, DictationProblem, useDictation } from "#/features/voice/index.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { AttachmentTile } from "#/ui/AttachmentTile.tsx";
import { OrchestratorFace } from "#/ui/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { toast } from "#/ui/toasts.ts";
import { typeMarks } from "#/ui/typedMarks.ts";

import { attachFiles, chatMarks, chatSay, createComposer, draftOf, drafts, setEditingId, uploadsIn, useReplying } from "./composing";
import { EmojiPicker } from "./EmojiPicker";
import { followed } from "./follow";
import { HelperFace } from "./presence";

const viewStyles = stylex.create({
  composer: {
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--wb-line)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingTop: "calc(var(--spacing) * 3)",
    paddingBottom: "calc(var(--spacing) * 4)",
  },
  composerSpan: {
    width: "calc(var(--spacing) * 5)",
    height: "calc(var(--spacing) * 5)",
  },
  composerSpan2: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  composerSpan3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  composerSpan4: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  chatProblem: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-berry)",
  },
  composerDiv: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexDirection: "column",
    gap: "var(--spacing)",
  },
  quotedBlock: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--wb-hover)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  composerSpan5: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  quotedBlockRemove: {
    cursor: "pointer",
    borderRadius: ".25rem",
    padding: "calc(var(--spacing) * .5)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-page)",
      },
    },
  },
  replying: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--wb-hover)",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  composerDiv2: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 1.5)",
  },
  composerSpan6: {
    position: "relative",
    maxWidth: "calc(var(--spacing) * 48)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  composerDiv3: {
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--wb-line)",
      ":focus-within": "var(--wb-focus)",
    },
    backgroundColor: "var(--wb-page)",
  },
  composerInput: {
    display: "block",
    fieldSizing: "content",
    maxHeight: "200px",
    minHeight: "52px",
    width: "100%",
    resize: "none",
    backgroundColor: "transparent",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingTop: "calc(var(--spacing) * 2.5)",
    paddingBottom: "var(--spacing)",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--wb-faint)",
    },
  },
  composerDiv4: {
    display: "flex",
    height: "calc(var(--spacing) * 9)",
    alignItems: "center",
    gap: "var(--spacing)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBottom: "calc(var(--spacing) * 2)",
  },
  composerSpan7: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-faint)",
  },
  composerSpan8: {
    flex: "1",
  },
  composerInput2: {
    display: "none",
  },
  attach: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  stop: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    color: "var(--wb-berry)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  dropHint: {
    pointerEvents: "none",
    position: "absolute",
    inset: "calc(var(--spacing) * 2)",
    zIndex: "20",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    borderStyle: "dashed",
    borderWidth: "2px",
    borderColor: "var(--wb-accent)",
    backgroundColor: {
      default: "var(--wb-page)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--wb-page) 85%, transparent)",
    },
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-accent)",
  },
});

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
  const insert = (emojiText: string) => {
    const el = input;
    const from = el?.selectionStart ?? box.text().length;
    const to = el?.selectionEnd ?? from;
    const next = box.text().slice(0, from) + emojiText + box.text().slice(to);
    box.edit(next, from + emojiText.length);
    // Written now, so a key typed right after lands after the emoji (composing.ts, choose).
    flush();
    el?.focus();
    el?.setSelectionRange(from + emojiText.length, from + emojiText.length);
  };
  // ↑ in an empty box changes the owner's last message here; Esc lets go of the message being answered.
  const dictating = useDictation({ input: () => input, value: () => box.text(), onValue: (v, c) => box.edit(v, c) });
  // While this box listens, its row is the recording's: cancel or done in place of attach and send.
  const listening = () => dictating.mine() && (dictating.state() === "recording" || dictating.state() === "transcribing");
  const onKey = (e: KeyboardEvent) => {
    if (dictationKey(dictating, e)) return;
    const id = props.channel?.id;
    if (!e.isComposing && id && box.offered().length === 0) {
      if (e.key === "ArrowUp" && box.text() === "") {
        const mine = [...followed.get(id).messages].toReversed().find((m) => m.from === ownerId && m.kind === "chat" && m.deleted === undefined);
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
    <div data-testid="composer" data-key={props.channel?.id} {...stylex.attrs(viewStyles.composer)}>
      <Show when={box.offered().length > 0}>
        <div
          role="listbox"
          aria-label={t("web.channel.composer.who")}
          data-testid="mentions"
          class="mb-1.5 flex origin-bottom animate-pop-in flex-col rounded-lg border border-line bg-page p-1 shadow-float"
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
                class={["flex cursor-pointer items-center gap-2 rounded-md px-2 py-1", { "bg-selected": i() === box.active() }]}
              >
                <Show
                  when={n().session}
                  fallback={n().orchestrator ? <OrchestratorFace size={20} agent={n().orchestrator} /> : <span {...stylex.attrs(viewStyles.composerSpan)} />}
                >
                  {(s) => <HelperFace agent={s().agent} runtime={s().runtime} size={20} />}
                </Show>
                <span {...stylex.attrs(viewStyles.composerSpan2)}>{n().token}</span>
                <Show when={n().session}>
                  <span {...stylex.attrs(viewStyles.composerSpan3)}>{n().name}</span>
                </Show>
                <span {...stylex.attrs(viewStyles.composerSpan4)}>{n().note}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={problem()}>
        {(p) => (
          <p role="alert" data-testid="chat-problem" {...stylex.attrs(viewStyles.chatProblem)}>
            {p()}
          </p>
        )}
      </Show>
      <Show when={(props.quoted?.length ?? 0) > 0}>
        <div {...stylex.attrs(viewStyles.composerDiv)}>
          <For each={props.quoted} keyed={(q) => q.ref.blockId}>
            {(q) => (
              <div data-testid="quoted-block" data-key={q().ref.blockId} {...stylex.attrs(viewStyles.quotedBlock)}>
                <Icon name="artifacts" size={12} />
                <span {...stylex.attrs(viewStyles.composerSpan5)}>{t("web.channel.composer.quotedBlock", { text: q().text })}</span>
                <button
                  type="button"
                  {...stylex.attrs(viewStyles.quotedBlockRemove)}
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
          <div data-testid="replying" data-key={m().number} {...stylex.attrs(viewStyles.replying)}>
            <Icon name="reply" size={12} />
            <span {...stylex.attrs(viewStyles.composerSpan5)}>
              {t("shared.join.labeled", {
                label: t("web.channel.composer.replying", { name: m().from === ownerId ? t("web.channel.messages.owner") : m().name }),
                text: m().text,
              })}
            </span>
            <button
              type="button"
              {...stylex.attrs(viewStyles.quotedBlockRemove)}
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
        <div {...stylex.attrs(viewStyles.composerDiv2)}>
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
                <span {...stylex.attrs(viewStyles.composerSpan6)}>{t("web.channel.media.uploadingFile", { name: u().name, percent: u().percent })}</span>
              </Progress.Root>
            )}
          </For>
        </div>
      </Show>
      <div {...stylex.attrs(viewStyles.composerDiv3)}>
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
          {...stylex.attrs(viewStyles.composerInput)}
        />
        <DictationProblem dictating={dictating} />
        <div {...stylex.attrs(viewStyles.composerDiv4)}>
          <Show
            when={listening()}
            fallback={
              <>
                <Show when={props.channel?.type !== "direct"}>
                  <span {...stylex.attrs(viewStyles.composerSpan7)}>{t("web.channel.composer.mention")}</span>
                </Show>
                <span {...stylex.attrs(viewStyles.composerSpan8)} />
                <input
                  ref={(el) => (picker = el)}
                  type="file"
                  multiple
                  {...stylex.attrs(viewStyles.composerInput2)}
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
                  {...stylex.attrs(viewStyles.attach)}
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
                    {...stylex.attrs(viewStyles.attach)}
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
          <DictationKey dictating={dictating} bar size={16} class="size-7 rounded-md hover:bg-hover" />
          <Show when={!listening()}>
            <Show when={box.stoppable()}>
              <button
                type="button"
                data-testid="stop"
                onClick={() => void stop()}
                aria-label={t("web.channel.composer.stop")}
                title={t("web.channel.composer.stopHint")}
                {...stylex.attrs(viewStyles.stop)}
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
                "inline-flex size-7 cursor-pointer items-center justify-center rounded-md border disabled:cursor-default",
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
        <div data-testid="drop-hint" {...stylex.attrs(viewStyles.dropHint)}>
          {t("web.channel.media.drop")}
        </div>
      </Show>
    </div>
  );
}

const uploadFailed = (reason: string) => toast(t("web.channel.composer.uploadFailed", { why: reason }), "bad");
