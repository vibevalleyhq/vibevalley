import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show, untrack } from "solid-js";

import { Toolbar } from "@vibevalley/base-ui";
import { list, t } from "@vibevalley/i18n";
import { type Attachment, attachmentPath, type ChatMessage, type Embed, ownerId } from "@vibevalley/protocol";
import { channelOf } from "@vibevalley/protocol/rules";

import { aria, autofocus } from "#/base/dom.tsx";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { fileKind, sizeText } from "#/ui/AttachmentTile.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Lightbox } from "#/ui/Lightbox.tsx";
import { Markdown } from "#/ui/Markdown.tsx";
import { MoreMenu } from "#/ui/MoreMenu.tsx";
import { styleProps } from "#/ui/positioner.ts";
import { toast } from "#/ui/toasts.ts";

import { drafts } from "./composing";
import { quickReactions, reactionOn, EmojiPicker } from "./EmojiPicker";
import { useMessage } from "./follow";
import { pinSet, reactionSet, sameMessage, sameReaction, setMark, markUnread, unreadMark } from "./marks";
import { messageRow } from "./message.stylex";
import { workbenchClock, type LinkedMessage, channelLabel, linkedMessages, messagePath } from "./places";

const messageStyles = stylex.create({
  reaction: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    borderRadius: "2147483647px",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: {
      default: "var(--wb-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  revealReaction: {
    opacity: {
      default: "0",
      ":focus-visible": "1",
      [stylex.when.ancestor(":focus-within", messageRow)]: 1,
      "@media (hover: hover)": {
        default: null,
        [stylex.when.ancestor(":hover", messageRow)]: 1,
      },
    },
  },
  toolbar: {
    position: "absolute",
    top: "calc(var(--spacing) * -3)",
    right: "calc(var(--spacing) * 2)",
    zIndex: 10,
    alignItems: "center",
    gap: "calc(var(--spacing) * .5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    padding: "calc(var(--spacing) * .5)",
    boxShadow: "var(--shadow-float)",
  },
  openToolbar: {
    display: "flex",
  },
  revealToolbar: {
    display: {
      default: "none",
      [stylex.when.ancestor(":focus-within", messageRow)]: "flex",
      "@media (hover: hover)": {
        default: null,
        [stylex.when.ancestor(":hover", messageRow)]: "flex",
      },
    },
  },
});

const recipeStyles2 = stylex.create({
  messageBodyDivVariant1Case1: {
    overflow: null,
    WebkitMaskImage: null,
    maskImage: null,
  },
  messageBodyDivVariant1Case2: {
    overflow: "hidden",
    WebkitMaskImage: "linear-gradient(black 70%,transparent)",
    maskImage: "linear-gradient(black 70%,transparent)",
  },
});

const recipeStyles = stylex.create({
  messageToolsToolbarButton: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  messageToolsToolbarButton2: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 7)",
    height: "calc(var(--spacing) * 7)",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
  },
  messageToolsToolbarButtonVariant1Case1: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  messageToolsToolbarButtonVariant1Case2: {
    backgroundColor: {
      default: "var(--color-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-berry) 15%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
});

const variantStyles2 = stylex.create({
  replyQuoteIcon: {
    opacity: ".6",
  },
  messageToolsIcon: {},
});

const variantStyles = stylex.create({
  embedsSpan: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  embedsSpan2: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-ok-ink)",
  },
  embedsSpan3: {
    WebkitLineClamp: "3",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  reactionsButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "var(--spacing)",
    borderRadius: "2147483647px",
    borderStyle: "solid",
    borderWidth: "1px",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  reactionsButtonVariant: {
    borderColor: "var(--color-accent)",
    backgroundColor: "var(--color-selected)",
  },
  reactionsButtonVariant2: {
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: "var(--color-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  editBoxButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  editBoxButtonVariant: {
    borderStyle: "solid",
    backgroundColor: "var(--color-page)",
  },
  editBoxButtonVariant2: {
    borderStyle: "dashed",
    color: "var(--color-faint)",
    textDecorationLine: "line-through",
  },
  linkedCardSpan: {
    WebkitLineClamp: "3",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
});

const viewStyles = stylex.create({
  quote: {
    marginBottom: "calc(var(--spacing) * .5)",
    display: "flex",
    width: "100%",
    minWidth: "0",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    textAlign: "left",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  replyQuoteSpan: {
    fontStyle: "italic",
  },
  replyQuoteSpan2: {
    flexShrink: "0",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-ink)",
  },
  replyQuoteSpan3: {
    minWidth: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  messageBodyP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
    fontStyle: "italic",
  },
  messageMore: {
    marginTop: "calc(var(--spacing) * .5)",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    paddingInline: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  messageBodySpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-faint)",
  },
  attachmentsDiv: {
    marginTop: "var(--spacing)",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2)",
  },
  attachment: {
    display: "block",
    cursor: "zoom-in",
    borderRadius: "var(--radius-md)",
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".12s",
    opacity: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": ".9",
      },
    },
  },
  attachmentsImg: {
    maxHeight: "calc(var(--spacing) * 64)",
    maxWidth: "calc(var(--spacing) * 80)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    objectFit: "contain",
  },
  attachment2: {
    maxHeight: "calc(var(--spacing) * 72)",
    maxWidth: "calc(var(--spacing) * 96)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-ink)",
  },
  attachment3: {
    maxWidth: "calc(var(--spacing) * 96)",
  },
  attachment4: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: "var(--color-page)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  attachmentsSpan: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
  attachmentsSpan2: {
    maxWidth: "calc(var(--spacing) * 64)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  attachmentsSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  embedsDiv: {
    marginTop: "var(--spacing)",
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  embedsA: {
    display: "flex",
    maxWidth: "var(--container-lg)",
    gap: "calc(var(--spacing) * 3)",
    borderRadius: "var(--radius-md)",
    borderLeftStyle: "solid",
    borderLeftWidth: "4px",
    borderColor: "var(--color-accent)",
    backgroundColor: {
      default: "var(--color-side)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
  },
  embedsSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  embedsImg: {
    width: "calc(var(--spacing) * 16)",
    height: "calc(var(--spacing) * 16)",
    flexShrink: "0",
    borderRadius: "var(--radius-sm)",
    objectFit: "cover",
  },
  reactionsDiv: {
    marginTop: "var(--spacing)",
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--spacing)",
  },
  messageToolsDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * .5)",
    borderRightStyle: "solid",
    borderRightWidth: "1px",
    borderColor: "var(--color-line)",
    paddingRight: "calc(var(--spacing) * .5)",
  },
  editBoxDiv: {
    marginTop: "calc(var(--spacing) * .5)",
  },
  messageEdit: {
    display: "block",
    fieldSizing: "content",
    width: "100%",
    resize: "none",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-focus)",
    backgroundColor: "var(--color-page)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
    outlineStyle: "none",
  },
  editBoxDiv2: {
    marginTop: "var(--spacing)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 1.5)",
  },
  editBoxSpan: {
    maxWidth: "calc(var(--spacing) * 48)",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  editBoxP: {
    marginTop: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  linkedMessage: {
    display: "flex",
    maxWidth: "var(--container-lg)",
    cursor: "pointer",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
    borderRadius: "var(--radius-md)",
    borderLeftStyle: "solid",
    borderLeftWidth: "4px",
    borderColor: "var(--color-wheat)",
    backgroundColor: {
      default: "var(--color-side)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * 2)",
    textAlign: "left",
  },
  linkedCardSpan: {
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  linkedCardSpan2: {
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-ink)",
  },
});

const nameOf = (m: ChatMessage) => (m.from === ownerId ? t("web.channel.messages.owner") : m.name);

const bad = (reason: string) => toast(reason, "bad");

/** The owner's reaction set on a message, shown at once (marks.ts); a refusal is said and the reaction goes back. */
function useReact() {
  const reactions = useIntents(reactionSet);
  return (m: ChatMessage, emoji: string, on: boolean) => setMark(reactions, { channel: m.channel, id: m.id, emoji, on }, sameReaction, bad);
}

export function ReplyQuote(props: { channel: string; number: number }) {
  const answered = useMessage(() => ({ channel: props.channel, number: props.number }));
  const core = useCore();
  const router = useRouter();
  return (
    <button
      type="button"
      data-testid="quote"
      data-key={props.number}
      onClick={() => router.navigate(messagePath(channelOf(core()?.chat, props.channel), props.number))}
      {...stylex.attrs(viewStyles.quote)}
    >
      <Icon name="reply" size={10} styles={[variantStyles2.replyQuoteIcon]} />
      <Show when={answered()} fallback={<span>#{props.number}</span>}>
        {(m) => (
          <Show when={m().deleted === undefined} fallback={<span {...stylex.attrs(viewStyles.replyQuoteSpan)}>{t("web.channel.messages.replyGone")}</span>}>
            <span {...stylex.attrs(viewStyles.replyQuoteSpan2)}>{nameOf(m())}</span>
            <span {...stylex.attrs(viewStyles.replyQuoteSpan3)}>{m().text || list(m().attachments.map((a) => a.name))}</span>
          </Show>
        )}
      </Show>
    </button>
  );
}

/** Past this height a message's words start folded: a helper's long report should not push the conversation away. */
const foldPx = 360;

export function MessageBody(props: { m: ChatMessage }) {
  let box: HTMLDivElement | undefined;
  const [long, setLong] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  onSettled(() => {
    const el = box;
    if (!el) return;
    const watch = new ResizeObserver(() => setLong(el.scrollHeight > foldPx + 40));
    watch.observe(el);
    return () => watch.disconnect();
  });
  return (
    <Show when={props.m.deleted === undefined} fallback={<p {...stylex.attrs(viewStyles.messageBodyP)}>{t("web.channel.messages.deleted")}</p>}>
      <Show when={props.m.text}>
        <div
          ref={(el) => (box = el)}
          data-testid="message-body"
          data-folded={long() && !open() ? "" : undefined}
          {...stylex.attrs(long() && !open() ? recipeStyles2.messageBodyDivVariant1Case2 : recipeStyles2.messageBodyDivVariant1Case1)}
          style={long() && !open() ? { "max-height": `${foldPx}px` } : undefined}
        >
          <Markdown text={props.m.text} mentions />
        </div>
        <Show when={long()}>
          <button
            type="button"
            data-testid="message-more"
            aria-expanded={open() ? "true" : "false"}
            onClick={() => setOpen(!open())}
            {...stylex.attrs(viewStyles.messageMore)}
          >
            {open() ? t("web.base.rich.longLess") : t("web.base.rich.longMore")}
          </button>
        </Show>
      </Show>
      <Show when={props.m.edited !== undefined}>
        <span {...stylex.attrs(viewStyles.messageBodySpan)}>{t("web.channel.messages.edited")}</span>
      </Show>
    </Show>
  );
}

const shownAs = fileKind;

export function Attachments(props: { files: readonly Attachment[] }) {
  // The message's pictures open over the page, one at a time, in their order here.
  const pictures = () => props.files.filter((f) => shownAs(f.type) === "image").map((f) => ({ id: f.id, src: attachmentPath(f.id), name: f.name }));
  const [open, setOpen] = createSignal<number>();
  return (
    <div {...stylex.attrs(viewStyles.attachmentsDiv)}>
      <Lightbox pictures={pictures()} at={open()} onAt={setOpen} />
      <For each={props.files} keyed={(f) => f.id}>
        {(f) => {
          // Keyed by its id, which names its bytes: a file never changes.
          const file = untrack(f);
          const at = () => attachmentPath(file.id);
          switch (shownAs(file.type)) {
            case "image":
              return (
                <button
                  type="button"
                  data-testid="attachment"
                  data-key={file.id}
                  data-kind="image"
                  aria-label={file.name}
                  {...stylex.attrs(viewStyles.attachment)}
                  onClick={() => setOpen(pictures().findIndex((p) => p.id === file.id))}
                >
                  <img src={at()} alt={file.name} {...stylex.attrs(viewStyles.attachmentsImg)} loading="lazy" />
                </button>
              );
            case "video":
              return (
                <video
                  data-testid="attachment"
                  data-key={file.id}
                  data-kind="video"
                  src={at()}
                  controls
                  preload="metadata"
                  aria-label={file.name}
                  {...stylex.attrs(viewStyles.attachment2)}
                />
              );
            case "audio":
              return (
                <audio
                  data-testid="attachment"
                  data-key={file.id}
                  data-kind="audio"
                  src={at()}
                  controls
                  preload="metadata"
                  aria-label={file.name}
                  {...stylex.attrs(viewStyles.attachment3)}
                />
              );
            case "pdf":
            case "file":
              return (
                <a
                  href={at()}
                  data-testid="attachment"
                  data-key={file.id}
                  data-kind={shownAs(file.type)}
                  target="_blank"
                  rel="noreferrer"
                  {...stylex.attrs(viewStyles.attachment4)}
                >
                  <Icon name={shownAs(file.type) === "pdf" ? "file" : "attach"} size={16} />
                  <span {...stylex.attrs(viewStyles.attachmentsSpan)}>
                    <span {...stylex.attrs(viewStyles.attachmentsSpan2)}>{file.name}</span>
                    <span {...stylex.attrs(viewStyles.attachmentsSpan3)}>
                      {shownAs(file.type) === "pdf" ? t("web.channel.media.pdf") : t("web.channel.messages.file", { size: sizeText(file.size) })}
                    </span>
                  </span>
                </a>
              );
          }
        }}
      </For>
    </div>
  );
}

/** The links' previews the server read: what the page says of itself, and its picture from its own site. */
export function Embeds(props: { embeds: readonly Embed[] }) {
  return (
    <div {...stylex.attrs(viewStyles.embedsDiv)} aria-label={t("web.channel.media.preview")}>
      <For each={props.embeds} keyed={(e) => e.url}>
        {(e) => (
          <a href={e().url} target="_blank" rel="noreferrer noopener" {...stylex.attrs(viewStyles.embedsA)}>
            <span {...stylex.attrs(variantStyles.embedsSpan)}>
              <Show when={e().site}>
                <span {...stylex.attrs(viewStyles.embedsSpan)}>{e().site}</span>
              </Show>
              <Show when={e().title}>
                <span {...stylex.attrs(variantStyles.embedsSpan2)}>{e().title}</span>
              </Show>
              <Show when={e().description}>
                <span {...stylex.attrs(variantStyles.embedsSpan3)}>{e().description}</span>
              </Show>
            </span>
            <Show when={e().image}>
              {(src) => <img src={src()} alt="" referrerpolicy="no-referrer" loading="lazy" {...stylex.attrs(viewStyles.embedsImg)} />}
            </Show>
          </a>
        )}
      </For>
    </div>
  );
}

export function Reactions(props: { m: ChatMessage; names: (id: string) => string }) {
  const react = useReact();
  return (
    <div {...stylex.attrs(viewStyles.reactionsDiv)}>
      <For each={props.m.reactions} keyed={(r) => r.emoji}>
        {(r) => {
          const mine = () => r().by.includes(ownerId);
          return (
            <button
              type="button"
              data-testid="reaction"
              data-key={r().emoji}
              data-count={r().by.length}
              aria-pressed={aria(mine())}
              title={t("web.channel.messages.reactedBy", { emoji: r().emoji, names: list(r().by.map(props.names)) })}
              onClick={() => react(props.m, r().emoji, !mine())}
              {...stylex.attrs(variantStyles.reactionsButton, mine() ? variantStyles.reactionsButtonVariant : variantStyles.reactionsButtonVariant2)}
            >
              <span>{r().emoji}</span>
              <span>{r().by.length}</span>
            </button>
          );
        }}
      </For>
      <AddReaction m={props.m} />
    </div>
  );
}

/** A reaction picked from every emoji, for a message that has some already. */
function AddReaction(props: { m: ChatMessage }) {
  const react = useReact();
  const [open, setOpen] = createSignal(false);
  let button: HTMLButtonElement | undefined;
  return (
    <>
      <button
        type="button"
        ref={(el) => (button = el)}
        data-testid="add-reaction"
        aria-label={t("web.channel.emoji.more")}
        title={t("web.channel.emoji.more")}
        aria-expanded={aria(open())}
        onClick={() => setOpen(!open())}
        // Only on the message under the pointer or the focus, as the toolbar: every message has a 👀 to sit beside.
        {...styleProps([messageStyles.reaction, !open() && messageStyles.revealReaction])}
      >
        <Icon name="add" size={12} />
      </button>
      <Show when={open()}>
        <EmojiPicker
          anchor={button}
          onClose={() => setOpen(false)}
          onPick={(emoji) => {
            setOpen(false);
            const m = untrack(() => props.m);
            react(m, emoji, reactionOn(m, emoji));
          }}
        />
      </Show>
    </>
  );
}

export function MessageTools(props: { m: ChatMessage; inChannel: boolean; onEdit: () => void }) {
  const router = useRouter();
  const core = useCore();
  const [picking, setPicking] = createSignal(false);
  const [everyEmoji, setEveryEmoji] = createSignal(false);
  let moreEmoji: HTMLButtonElement | undefined;
  const [sure, setSure] = createSignal(false);
  const [more, setMore] = createSignal(false);
  const react = useReact();
  const pins = useIntents(pinSet);
  const unreads = useIntents(unreadMark);
  const act = createAct();
  const unread = () => {
    const { channel, number } = props.m;
    markUnread(unreads, { channel, number }, bad);
  };
  const copyLink = () => {
    const link = location.origin + messagePath(channelOf(core()?.chat, props.m.channel), props.m.number);
    void act.run(async () => {
      await navigator.clipboard.writeText(link);
      toast(t("web.channel.more.copied"));
    });
  };
  const editable = () => props.m.from === ownerId && props.m.kind === "chat";
  return (
    <Toolbar.Root
      data-testid="message-tools"
      aria-label={t("web.channel.tools.label")}
      // Shown while hovered, and while something it opened is: the picker is outside the row.
      {...styleProps([messageStyles.toolbar, everyEmoji() || more() ? messageStyles.openToolbar : messageStyles.revealToolbar])}
    >
      <Show when={picking()}>
        <div role="group" aria-label={t("web.channel.tools.pick")} {...stylex.attrs(viewStyles.messageToolsDiv)}>
          <For each={quickReactions}>
            {(emoji) => (
              <Toolbar.Button
                {...stylex.attrs(recipeStyles.messageToolsToolbarButton)}
                data-testid="quick-reaction"
                data-key={emoji}
                aria-label={emoji}
                onClick={() => {
                  setPicking(false);
                  const m = props.m;
                  react(m, emoji, reactionOn(m, emoji));
                }}
              >
                {emoji}
              </Toolbar.Button>
            )}
          </For>
          <Toolbar.Button
            ref={(el) => (moreEmoji = el)}
            {...stylex.attrs(recipeStyles.messageToolsToolbarButton)}
            data-testid="more-emoji"
            aria-label={t("web.channel.emoji.more")}
            title={t("web.channel.emoji.more")}
            aria-expanded={aria(everyEmoji())}
            onClick={() => setEveryEmoji(!everyEmoji())}
          >
            <Icon name="add" size={14} />
          </Toolbar.Button>
        </div>
      </Show>
      <Show when={everyEmoji()}>
        <EmojiPicker
          anchor={moreEmoji}
          onClose={() => setEveryEmoji(false)}
          onPick={(emoji) => {
            setEveryEmoji(false);
            setPicking(false);
            const m = untrack(() => props.m);
            react(m, emoji, reactionOn(m, emoji));
          }}
        />
      </Show>
      <Toolbar.Button
        {...stylex.attrs(recipeStyles.messageToolsToolbarButton)}
        data-testid="message-tool"
        data-key="react"
        aria-label={t("web.channel.tools.react")}
        title={t("web.channel.tools.react")}
        onClick={() => setPicking(!picking())}
      >
        <Icon name="react" size={16} />
      </Toolbar.Button>
      <Toolbar.Button
        {...stylex.attrs(recipeStyles.messageToolsToolbarButton)}
        data-testid="message-tool"
        data-key="reply"
        aria-label={t("web.channel.tools.reply")}
        title={t("web.channel.tools.reply")}
        onClick={() => drafts.reply(props.m.channel, props.m)}
      >
        <Icon name="reply" size={14} />
      </Toolbar.Button>
      <Show when={props.inChannel}>
        <Toolbar.Button
          {...stylex.attrs(recipeStyles.messageToolsToolbarButton)}
          data-testid="message-tool"
          data-key="thread"
          aria-label={t("web.channel.tools.thread")}
          title={t("web.channel.tools.thread")}
          onClick={() => {
            const id = props.m.id;
            void act.run(async () => {
              const thread = await api.channel.thread.create({ id });
              router.navigate(`/chat/${thread}`);
            });
          }}
        >
          <Icon name="thread" size={16} />
        </Toolbar.Button>
      </Show>
      <Toolbar.Button
        {...stylex.attrs(recipeStyles.messageToolsToolbarButton)}
        data-testid="message-tool"
        data-key="pin"
        aria-label={props.m.pinned !== undefined ? t("web.channel.tools.unpin") : t("web.channel.tools.pin")}
        title={props.m.pinned !== undefined ? t("web.channel.tools.unpin") : t("web.channel.tools.pin")}
        aria-pressed={aria(props.m.pinned !== undefined)}
        onClick={() => {
          const m = props.m;
          setMark(pins, { channel: m.channel, id: m.id, on: m.pinned === undefined, at: Date.now() }, sameMessage, bad);
        }}
      >
        <Icon
          name="pin"
          size={16}
          styles={[variantStyles2.messageToolsIcon, props.m.pinned !== undefined ? variantStyles2.messageToolsIcon : variantStyles2.replyQuoteIcon]}
        />
      </Toolbar.Button>
      <Show when={editable()}>
        <Toolbar.Button
          {...stylex.attrs(recipeStyles.messageToolsToolbarButton)}
          data-testid="message-tool"
          data-key="edit"
          aria-label={t("web.channel.tools.edit")}
          title={t("web.channel.tools.edit")}
          onClick={() => props.onEdit()}
        >
          <Icon name="edit" size={14} />
        </Toolbar.Button>
      </Show>
      <MoreMenu
        label={t("web.channel.more.label")}
        testid="message-tool"
        dataKey="more"
        side="top"
        open={more()}
        onOpenChange={setMore}
        render={(p) => <Toolbar.Button {...p} />}
        items={[
          { key: "copy-link", label: t("web.channel.more.copyLink"), icon: "copy", onSelect: copyLink },
          { key: "mark-unread", label: t("web.channel.more.markUnread"), icon: "show", onSelect: unread },
        ]}
      />
      <Toolbar.Button
        {...stylex.attrs(
          recipeStyles.messageToolsToolbarButton2,
          sure() ? recipeStyles.messageToolsToolbarButtonVariant1Case2 : recipeStyles.messageToolsToolbarButtonVariant1Case1,
        )}
        data-testid="message-tool"
        data-key="delete"
        data-sure={sure() ? "" : undefined}
        aria-label={sure() ? t("web.channel.tools.sure") : t("web.channel.tools.remove")}
        title={sure() ? t("web.channel.tools.sure") : t("web.channel.tools.remove")}
        onBlur={() => setSure(false)}
        onClick={() => {
          if (!sure()) return void setSure(true);
          setSure(false);
          const id = props.m.id;
          void act.run(() => api.channel.message.delete({ id }));
        }}
      >
        <Icon name="delete" size={14} />
      </Toolbar.Button>
    </Toolbar.Root>
  );
}

export function EditBox(props: { m: ChatMessage; onDone: () => void }) {
  // The words as they were when editing began: a change heard meanwhile does not move the box under the owner's hands.
  const { id, text: was, attachments: files } = untrack(() => props.m);
  const done = () => untrack(() => props.onDone)();
  const [text, setText] = createSignal(was);
  const [kept, setKept] = createSignal<readonly string[]>(files.map((f) => f.id));
  const act = createAct();
  const save = () => {
    const words = text().trim();
    const fewer = kept().length < files.length;
    if ((!words && kept().length === 0) || (words === was && !fewer)) return done();
    const keep = [...kept()];
    void act.run(async () => {
      await api.channel.message.update({ id, text: words, ...(fewer ? { attachments: keep } : {}) });
      done();
    });
  };
  return (
    <div {...stylex.attrs(viewStyles.editBoxDiv)}>
      <textarea
        ref={autofocus()}
        data-testid="message-edit"
        value={text()}
        aria-label={t("web.channel.tools.edit")}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done();
          }
        }}
        {...stylex.attrs(viewStyles.messageEdit)}
      />
      <Show when={files.length > 0}>
        <div {...stylex.attrs(viewStyles.editBoxDiv2)}>
          <For each={files}>
            {(f) => {
              const keeps = () => kept().includes(f.id);
              return (
                <button
                  type="button"
                  data-testid="edit-file"
                  data-key={f.name}
                  aria-pressed={aria(keeps())}
                  aria-label={keeps() ? t("web.channel.media.takeOff", { name: f.name }) : t("web.channel.media.keep", { name: f.name })}
                  onClick={() => setKept((k) => (keeps() ? k.filter((x) => x !== f.id) : [...k, f.id]))}
                  {...stylex.attrs(variantStyles.editBoxButton, keeps() ? variantStyles.editBoxButtonVariant : variantStyles.editBoxButtonVariant2)}
                >
                  <Icon name="attach" size={12} />
                  <span {...stylex.attrs(viewStyles.editBoxSpan)}>{f.name}</span>
                  <Icon name={keeps() ? "close" : "add"} size={10} />
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <p {...stylex.attrs(viewStyles.editBoxP)}>{t("web.channel.tools.editHint")}</p>
    </div>
  );
}

/** The farm's messages a message links to, each as it is now; a press goes there. */
export function LinkedMessages(props: { text: string }) {
  const core = useCore();
  const links = () => linkedMessages(props.text, core()?.chat, location.host);
  return (
    <Show when={links().length > 0}>
      <div {...stylex.attrs(viewStyles.embedsDiv)}>
        <For each={links()} keyed={(l) => `${l.channel}:${l.number}`}>
          {(l) => <LinkedCard at={l()} />}
        </For>
      </div>
    </Show>
  );
}

function LinkedCard(props: { at: LinkedMessage }) {
  const core = useCore();
  const router = useRouter();
  const m = useMessage(() => props.at);
  const where = () => channelOf(core()?.chat, props.at.channel);
  return (
    <button
      type="button"
      data-testid="linked-message"
      data-key={`${props.at.channel}:${props.at.number}`}
      aria-label={t("web.channel.messages.linked", { where: channelLabel(where()), number: props.at.number })}
      onClick={() => router.navigate(messagePath(where(), props.at.number))}
      {...stylex.attrs(viewStyles.linkedMessage)}
    >
      <span {...stylex.attrs(viewStyles.linkedCardSpan)}>
        <span {...stylex.attrs(viewStyles.linkedCardSpan2)}>
          <Show when={m()} fallback={`#${props.at.number}`}>
            {(said) => nameOf(said())}
          </Show>
        </span>
        <span>{channelLabel(where())}</span>
        <Show when={m()}>{(said) => <span>{workbenchClock(said().at)}</span>}</Show>
      </span>
      <Show when={m()}>
        {(said) => (
          <Show when={said().deleted === undefined} fallback={<span {...stylex.attrs(viewStyles.messageBodyP)}>{t("web.channel.messages.replyGone")}</span>}>
            <span {...stylex.attrs(variantStyles.linkedCardSpan)}>{said().text || list(said().attachments.map((a) => a.name))}</span>
          </Show>
        )}
      </Show>
    </button>
  );
}
