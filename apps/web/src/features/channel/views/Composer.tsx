import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { String as Str } from "effect";
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

const popIn = stylex.keyframes({
  from: { opacity: 0, scale: 0.98 },
});

const styles = stylex.create({
  // Floats over the messages just above the box: opening it moves nothing on the page.
  composerDiv: {
    position: "absolute",
    insetInline: "1rem",
    bottom: "calc(100% - 0.5rem)",
    zIndex: 30,
    maxHeight: "18rem",
    overflowY: "auto",
    display: "flex",
    transformOrigin: "bottom",
    animationName: { default: popIn, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "280ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    flexDirection: "column",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "0.25rem",
    boxShadow: "var(--shadow-float)",
  },
  composerDictationKey: {
    width: "1.75rem",
    height: "1.75rem",
    borderRadius: "var(--radius-md)",
  },
  composerProgressRoot: {
    position: "relative",
    display: "flex",
    height: "2.5rem",
    alignItems: "center",
    overflow: "hidden",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    paddingInline: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  composerProgressIndicator: {
    position: "absolute",
    insetBlock: "0",
    left: "0",
    backgroundColor: {
      default: "var(--color-leaf)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-leaf) 20%, transparent)",
    },
  },
  composerDiv2: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
  },
  composerDivTone: {
    backgroundColor: "var(--color-selected)",
  },
  composerDivAlt: {},
  composerButton: {
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
  },
  composerButtonTone: {
    borderColor: "var(--color-accent)",
    backgroundColor: {
      default: "var(--color-accent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-accent-hover)",
      },
    },
  },
  composerButtonAlt: {
    borderColor: "transparent",
    opacity: ".5",
  },
  fileDropDiv: {
    position: "relative",
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  composer: {
    position: "relative",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "1rem",
    paddingTop: "0.75rem",
    paddingBottom: "1rem",
  },
  composerSpan: {
    display: "inline-flex",
    flexShrink: 0,
    width: "1.25rem",
    height: "1.25rem",
    alignItems: "center",
    justifyContent: "center",
    color: "var(--color-muted)",
  },
  commandArgs: {
    color: "var(--color-faint)",
  },
  composerSpan2: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  composerSpan3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  composerSpan4: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  chatProblem: {
    marginBottom: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-berry)",
  },
  composerDiv3: {
    marginBottom: "0.375rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  quotedBlock: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "0.75rem",
    paddingBlock: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
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
    borderRadius: "var(--radius-sm)",
    padding: "0.125rem",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-page)",
      },
    },
  },
  replying: {
    marginBottom: "0.375rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-hover)",
    paddingInline: "0.75rem",
    paddingBlock: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  composerDiv22: {
    marginBottom: "0.375rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },
  composerSpan6: {
    position: "relative",
    maxWidth: "12rem",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  composerDiv32: {
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      ":focus-within": "var(--color-focus)",
    },
    backgroundColor: "var(--color-page)",
  },
  composerInput: {
    display: "block",
    fieldSizing: "content",
    maxHeight: "200px",
    minHeight: "52px",
    width: "100%",
    resize: "none",
    backgroundColor: "transparent",
    paddingInline: "0.75rem",
    paddingTop: "0.625rem",
    paddingBottom: "0.25rem",
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--color-faint)",
    },
  },
  composerDiv4: {
    display: "flex",
    height: "2.25rem",
    alignItems: "center",
    gap: "0.25rem",
    paddingInline: "0.5rem",
    paddingBottom: "0.5rem",
  },
  composerSpan8: {
    flex: "1",
  },
  composerInput2: {
    display: "none",
  },
  attach: {
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
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
        ":hover": "var(--color-hover)",
      },
    },
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  stop: {
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    color: "var(--color-berry)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  dropHint: {
    pointerEvents: "none",
    position: "absolute",
    inset: "0.5rem",
    zIndex: "20",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    borderStyle: "dashed",
    borderWidth: "2px",
    borderColor: "var(--color-accent)",
    backgroundColor: {
      default: "var(--color-page)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-page) 85%, transparent)",
    },
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-accent)",
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
    const before = Str.slice(0, from)(box.text());
    insert(before === "" || /\s$/u.test(before) ? "@" : " @");
  };
  /** A command is the line's first word: a / at its start opens the commands menu, the words after it kept. */
  const startCommand = () => put(Str.startsWith("/")(box.text()) ? box.text() : "/" + box.text(), 1);
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
    <div data-testid="composer" data-key={props.channel?.id} {...stylex.attrs(styles.composer)}>
      <Show when={box.offered().length > 0}>
        <div role="listbox" aria-label={t("web.channel.composer.who")} data-testid="mentions" {...stylex.attrs(styles.composerDiv)}>
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
                {...stylex.attrs(styles.composerDiv2, i() === box.active() ? styles.composerDivTone : styles.composerDivAlt)}
              >
                <Show
                  when={n().session}
                  fallback={
                    n().orchestrator ? (
                      <OrchestratorFace size={20} agent={n().orchestrator} />
                    ) : (
                      <span {...stylex.attrs(styles.composerSpan)}>
                        <Show when={n().args !== undefined}>
                          <Icon name="command" size={14} />
                        </Show>
                      </span>
                    )
                  }
                >
                  {(s) => <HelperFace agent={s().agent} runtime={s().runtime} size={20} />}
                </Show>
                <span {...stylex.attrs(styles.composerSpan2)}>
                  {n().token}
                  <Show when={n().args !== undefined && n().args !== ""}>
                    <span {...stylex.attrs(styles.commandArgs)}> {n().args}</span>
                  </Show>
                </span>
                <Show when={n().session !== undefined || n().args !== undefined}>
                  <span {...stylex.attrs(styles.composerSpan3)}>{n().name}</span>
                </Show>
                <span {...stylex.attrs(styles.composerSpan4)}>{n().note}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={problem()}>
        {(p) => (
          <p role="alert" data-testid="chat-problem" {...stylex.attrs(styles.chatProblem)}>
            {p()}
          </p>
        )}
      </Show>
      <Show when={(props.quoted?.length ?? 0) > 0}>
        <div {...stylex.attrs(styles.composerDiv3)}>
          <For each={props.quoted} keyed={(q) => q.ref.blockId}>
            {(q) => (
              <div data-testid="quoted-block" data-key={q().ref.blockId} {...stylex.attrs(styles.quotedBlock)}>
                <Icon name="artifacts" size={12} />
                <span {...stylex.attrs(styles.composerSpan5)}>{t("web.channel.composer.quotedBlock", { text: q().text })}</span>
                <button
                  type="button"
                  {...stylex.attrs(styles.quotedBlockRemove)}
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
          <div data-testid="replying" data-key={m().number} {...stylex.attrs(styles.replying)}>
            <Icon name="reply" size={12} />
            <span {...stylex.attrs(styles.composerSpan5)}>
              {t("shared.join.labeled", {
                label: t("web.channel.composer.replying", { name: m().from === userId ? t("web.channel.messages.user") : m().name }),
                text: m().text,
              })}
            </span>
            <button
              type="button"
              {...stylex.attrs(styles.quotedBlockRemove)}
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
        <div {...stylex.attrs(styles.composerDiv22)}>
          <For each={draft().files} keyed={(f) => f.id}>
            {(f) => <AttachmentTile testid="pending-file" file={f()} onRemove={() => props.channel && drafts.drop(props.channel.id, f().id)} />}
          </For>
          <For each={uploading()} keyed={(u) => u.key}>
            {(u) => (
              <Progress.Root value={u().percent} aria-label={u().name} {...stylex.attrs(styles.composerProgressRoot)}>
                <Progress.Indicator {...stylex.attrs(styles.composerProgressIndicator)} />
                <span {...stylex.attrs(styles.composerSpan6)}>{t("web.channel.media.uploadingFile", { name: u().name, percent: u().percent })}</span>
              </Progress.Root>
            )}
          </For>
        </div>
      </Show>
      <div {...stylex.attrs(styles.composerDiv32)}>
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
          {...stylex.attrs(styles.composerInput)}
        />
        <DictationProblem dictating={dictating} />
        <div {...stylex.attrs(styles.composerDiv4)}>
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
                    {...stylex.attrs(styles.attach)}
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
                  {...stylex.attrs(styles.attach)}
                >
                  <Icon name="command" size={16} />
                </button>
                <span {...stylex.attrs(styles.composerSpan8)} />
                <input
                  ref={(el) => (picker = el)}
                  type="file"
                  multiple
                  {...stylex.attrs(styles.composerInput2)}
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
                  {...stylex.attrs(styles.attach)}
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
                    {...stylex.attrs(styles.attach)}
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
          <DictationKey dictating={dictating} bar surface size={16} styles={[styles.composerDictationKey]} />
          <Show when={!listening()}>
            <Show when={box.stoppable()}>
              <button
                type="button"
                data-testid="stop"
                onClick={() => void stop()}
                aria-label={t("web.channel.composer.stop")}
                title={t("web.channel.composer.stopHint")}
                {...stylex.attrs(styles.stop)}
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
              {...stylex.attrs(styles.composerButton, box.canSend() ? styles.composerButtonTone : styles.composerButtonAlt)}
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
      {...stylex.attrs(styles.fileDropDiv)}
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
        <div data-testid="drop-hint" {...stylex.attrs(styles.dropHint)}>
          {t("web.channel.media.drop")}
        </div>
      </Show>
    </div>
  );
}

const uploadFailed = (reason: string) => toast(t("web.channel.composer.uploadFailed", { why: reason }), "bad");
