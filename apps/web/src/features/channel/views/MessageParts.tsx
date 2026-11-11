import * as stylex from "@stylexjs/stylex";
import { createSignal, For, onSettled, Show, untrack } from "solid-js";

import { Toolbar } from "@vibevalley/base-ui";
import { list, t } from "@vibevalley/i18n";
import { type Attachment, attachmentPath, type ChatMessage, type Embed, userId } from "@vibevalley/protocol";
import { channelOf } from "@vibevalley/protocol/rules";

import { aria, autofocus } from "#/base/dom.tsx";
import { drafts } from "#/features/channel/model/composing.ts";
import { useMessage } from "#/features/channel/model/follow.ts";
import { pinSet, reactionSet, sameMessage, sameReaction, setMark, markUnread, unreadMark } from "#/features/channel/model/marks.ts";
import { workbenchClock, type LinkedMessage, channelLabel, linkedMessages, messagePath } from "#/features/channel/model/places.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { fileKind, sizeText } from "#/ui/domain/AttachmentTile.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Lightbox } from "#/ui/Lightbox.tsx";
import { Markdown } from "#/ui/Markdown.tsx";
import { MoreMenu } from "#/ui/MoreMenu.tsx";
import { styleProps } from "#/ui/positioner.ts";
import { toast } from "#/ui/toasts.ts";

import { quickReactions, reactionOn, EmojiPicker } from "./EmojiPicker";
import { messageRow } from "./message.stylex";

const messageStyles = stylex.create({
  reaction: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    borderRadius: "9999px",
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
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
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
    top: "-0.75rem",
    right: "0.5rem",
    zIndex: 10,
    alignItems: "center",
    gap: "0.125rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    padding: "0.125rem",
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

const styles = stylex.create({
  messageBodyDivPrimary: {
    overflow: null,
    WebkitMaskImage: null,
    maskImage: null,
  },
  messageBodyDivSecondary: {
    overflow: "hidden",
    WebkitMaskImage: "linear-gradient(black 70%,transparent)",
    maskImage: "linear-gradient(black 70%,transparent)",
  },
  messageToolsToolbarButton: {
    display: "inline-flex",
    width: "1.75rem",
    height: "1.75rem",
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
    width: "1.75rem",
    height: "1.75rem",
    cursor: "pointer",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-sm)",
  },
  messageToolsToolbarButtonPrimary: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  messageToolsToolbarButtonSecondary: {
    backgroundColor: {
      default: "var(--color-berry)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-berry) 15%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  replyQuoteIcon: {
    opacity: ".6",
  },
  messageToolsIcon: {},
  embedsSpan: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "0.125rem",
  },
  embedsSpan2: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-ok-ink)",
  },
  embedsSpan3: {
    WebkitLineClamp: "3",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  reactionsButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.25rem",
    borderRadius: "9999px",
    borderStyle: "solid",
    borderWidth: "1px",
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  reactionsButtonTone: {
    borderColor: "var(--color-accent)",
    backgroundColor: "var(--color-selected)",
  },
  reactionsButtonAlt: {
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
    gap: "0.375rem",
    borderRadius: "var(--radius-md)",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  editBoxButtonTone: {
    borderStyle: "solid",
    backgroundColor: "var(--color-page)",
  },
  editBoxButtonAlt: {
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
    lineHeight: "var(--leading-sm)",
  },
  quote: {
    marginBottom: "0.125rem",
    display: "flex",
    width: "100%",
    minWidth: "0",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.375rem",
    textAlign: "left",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
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
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
    fontStyle: "italic",
  },
  messageMore: {
    marginTop: "0.125rem",
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    paddingInline: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
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
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  attachmentsDiv: {
    marginTop: "0.25rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "flex-start",
    gap: "0.5rem",
  },
  attachment: {
    display: "block",
    cursor: "zoom-in",
    borderRadius: "var(--radius-md)",
    transitionProperty: "opacity",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "120ms",
    opacity: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": ".9",
      },
    },
  },
  attachmentsImg: {
    maxHeight: "16rem",
    maxWidth: "20rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    objectFit: "contain",
  },
  attachment2: {
    maxHeight: "18rem",
    maxWidth: "24rem",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-ink)",
  },
  attachment3: {
    maxWidth: "24rem",
  },
  attachment4: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
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
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  attachmentsSpan: {
    display: "flex",
    minWidth: "0",
    flexDirection: "column",
  },
  attachmentsSpan2: {
    maxWidth: "16rem",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  attachmentsSpan3: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  embedsDiv: {
    marginTop: "0.25rem",
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  embedsA: {
    display: "flex",
    maxWidth: "var(--container-lg)",
    gap: "0.75rem",
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
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
  },
  embedsSpan4: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  embedsImg: {
    width: "4rem",
    height: "4rem",
    flexShrink: "0",
    borderRadius: "var(--radius-sm)",
    objectFit: "cover",
  },
  reactionsDiv: {
    marginTop: "0.25rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  messageToolsDiv: {
    display: "flex",
    alignItems: "center",
    gap: "0.125rem",
    borderRightStyle: "solid",
    borderRightWidth: "1px",
    borderColor: "var(--color-line)",
    paddingRight: "0.125rem",
  },
  editBoxDiv: {
    marginTop: "0.125rem",
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
    paddingInline: "0.5rem",
    paddingBlock: "0.375rem",
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
    outlineStyle: "none",
  },
  editBoxDiv2: {
    marginTop: "0.25rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },
  editBoxSpan: {
    maxWidth: "12rem",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  editBoxP: {
    marginTop: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  linkedMessage: {
    display: "flex",
    maxWidth: "var(--container-lg)",
    cursor: "pointer",
    flexDirection: "column",
    gap: "0.125rem",
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
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    textAlign: "left",
  },
  linkedCardSpan2: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  linkedCardSpan22: {
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-ink)",
  },
});

const nameOf = (m: ChatMessage) => (m.from === userId ? t("web.channel.messages.user") : m.name);

const bad = (reason: string) => toast(reason, "bad");

/** The user's reaction set on a message, shown at once (marks.ts); a refusal is said and the reaction goes back. */
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
      {...stylex.attrs(styles.quote)}
    >
      <Icon name="reply" size={10} styles={[styles.replyQuoteIcon]} />
      <Show when={answered()} fallback={<span>#{props.number}</span>}>
        {(m) => (
          <Show when={m().deleted === undefined} fallback={<span {...stylex.attrs(styles.replyQuoteSpan)}>{t("web.channel.messages.replyGone")}</span>}>
            <span {...stylex.attrs(styles.replyQuoteSpan2)}>{nameOf(m())}</span>
            <span {...stylex.attrs(styles.replyQuoteSpan3)}>{m().text || list(m().attachments.map((a) => a.name))}</span>
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
  const [fold, setFold] = createSignal<"short" | "folded" | "expanded">("short");
  onSettled(() => {
    const el = box;
    if (!el) return;
    const watch = new ResizeObserver(() => {
      const isLong = el.scrollHeight > foldPx + 40;
      setFold((prev) => (!isLong ? "short" : prev === "short" ? "folded" : prev));
    });
    watch.observe(el);
    return () => watch.disconnect();
  });
  const isFolded = () => fold() === "folded";
  const isExpanded = () => fold() === "expanded";
  return (
    <Show when={props.m.deleted === undefined} fallback={<p {...stylex.attrs(styles.messageBodyP)}>{t("web.channel.messages.deleted")}</p>}>
      <Show when={props.m.text}>
        <div
          ref={(el) => (box = el)}
          data-testid="message-body"
          data-folded={isFolded() ? "" : undefined}
          {...stylex.attrs(isFolded() ? styles.messageBodyDivSecondary : styles.messageBodyDivPrimary)}
          style={isFolded() ? { "max-height": `${foldPx}px` } : undefined}
        >
          <Markdown text={props.m.text} mentions />
        </div>
        <Show when={fold() !== "short"}>
          <button
            type="button"
            data-testid="message-more"
            aria-expanded={isExpanded() ? "true" : "false"}
            onClick={() => setFold(isExpanded() ? "folded" : "expanded")}
            {...stylex.attrs(styles.messageMore)}
          >
            {isExpanded() ? t("web.base.rich.longLess") : t("web.base.rich.longMore")}
          </button>
        </Show>
      </Show>
      <Show when={props.m.edited !== undefined}>
        <span {...stylex.attrs(styles.messageBodySpan)}>{t("web.channel.messages.edited")}</span>
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
    <div {...stylex.attrs(styles.attachmentsDiv)}>
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
                  {...stylex.attrs(styles.attachment)}
                  onClick={() => setOpen(pictures().findIndex((p) => p.id === file.id))}
                >
                  <img src={at()} alt={file.name} {...stylex.attrs(styles.attachmentsImg)} loading="lazy" />
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
                  {...stylex.attrs(styles.attachment2)}
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
                  {...stylex.attrs(styles.attachment3)}
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
                  {...stylex.attrs(styles.attachment4)}
                >
                  <Icon name={shownAs(file.type) === "pdf" ? "file" : "attach"} size={16} />
                  <span {...stylex.attrs(styles.attachmentsSpan)}>
                    <span {...stylex.attrs(styles.attachmentsSpan2)}>{file.name}</span>
                    <span {...stylex.attrs(styles.attachmentsSpan3)}>
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
    <div {...stylex.attrs(styles.embedsDiv)} aria-label={t("web.channel.media.preview")}>
      <For each={props.embeds} keyed={(e) => e.url}>
        {(e) => (
          <a href={e().url} target="_blank" rel="noreferrer noopener" {...stylex.attrs(styles.embedsA)}>
            <span {...stylex.attrs(styles.embedsSpan)}>
              <Show when={e().site}>
                <span {...stylex.attrs(styles.embedsSpan4)}>{e().site}</span>
              </Show>
              <Show when={e().title}>
                <span {...stylex.attrs(styles.embedsSpan2)}>{e().title}</span>
              </Show>
              <Show when={e().description}>
                <span {...stylex.attrs(styles.embedsSpan3)}>{e().description}</span>
              </Show>
            </span>
            <Show when={e().image}>{(src) => <img src={src()} alt="" referrerpolicy="no-referrer" loading="lazy" {...stylex.attrs(styles.embedsImg)} />}</Show>
          </a>
        )}
      </For>
    </div>
  );
}

export function Reactions(props: { m: ChatMessage; names: (id: string) => string }) {
  const react = useReact();
  return (
    <div {...stylex.attrs(styles.reactionsDiv)}>
      <For each={props.m.reactions} keyed={(r) => r.emoji}>
        {(r) => {
          const mine = () => r().by.includes(userId);
          return (
            <button
              type="button"
              data-testid="reaction"
              data-key={r().emoji}
              data-count={r().by.length}
              aria-pressed={aria(mine())}
              title={t("web.channel.messages.reactedBy", { emoji: r().emoji, names: list(r().by.map(props.names)) })}
              onClick={() => react(props.m, r().emoji, !mine())}
              {...stylex.attrs(styles.reactionsButton, mine() ? styles.reactionsButtonTone : styles.reactionsButtonAlt)}
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

type ToolbarMenu = "closed" | "quickEmoji" | "fullEmoji" | "more" | "confirmDelete";

export function MessageTools(props: { m: ChatMessage; inChannel: boolean; onEdit: () => void }) {
  const router = useRouter();
  const core = useCore();
  const [menu, setMenu] = createSignal<ToolbarMenu>("closed");
  let moreEmoji: HTMLButtonElement | undefined;
  const picking = () => menu() === "quickEmoji" || menu() === "fullEmoji";
  const everyEmoji = () => menu() === "fullEmoji";
  const sure = () => menu() === "confirmDelete";
  const more = () => menu() === "more";
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
  const editable = () => props.m.from === userId && props.m.kind === "chat";
  return (
    <Toolbar.Root
      data-testid="message-tools"
      aria-label={t("web.channel.tools.label")}
      // Shown while hovered, and while something it opened is: the picker is outside the row.
      {...styleProps([messageStyles.toolbar, everyEmoji() || more() ? messageStyles.openToolbar : messageStyles.revealToolbar])}
    >
      <Show when={picking()}>
        <div role="group" aria-label={t("web.channel.tools.pick")} {...stylex.attrs(styles.messageToolsDiv)}>
          <For each={quickReactions}>
            {(emoji) => (
              <Toolbar.Button
                {...stylex.attrs(styles.messageToolsToolbarButton)}
                data-testid="quick-reaction"
                data-key={emoji}
                aria-label={emoji}
                onClick={() => {
                  setMenu("closed");
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
            {...stylex.attrs(styles.messageToolsToolbarButton)}
            data-testid="more-emoji"
            aria-label={t("web.channel.emoji.more")}
            title={t("web.channel.emoji.more")}
            aria-expanded={aria(everyEmoji())}
            onClick={() => setMenu(everyEmoji() ? "quickEmoji" : "fullEmoji")}
          >
            <Icon name="add" size={14} />
          </Toolbar.Button>
        </div>
      </Show>
      <Show when={everyEmoji()}>
        <EmojiPicker
          anchor={moreEmoji}
          onClose={() => setMenu("quickEmoji")}
          onPick={(emoji) => {
            setMenu("closed");
            const m = untrack(() => props.m);
            react(m, emoji, reactionOn(m, emoji));
          }}
        />
      </Show>
      <Toolbar.Button
        {...stylex.attrs(styles.messageToolsToolbarButton)}
        data-testid="message-tool"
        data-key="react"
        aria-label={t("web.channel.tools.react")}
        title={t("web.channel.tools.react")}
        onClick={() => setMenu(picking() ? "closed" : "quickEmoji")}
      >
        <Icon name="react" size={16} />
      </Toolbar.Button>
      <Toolbar.Button
        {...stylex.attrs(styles.messageToolsToolbarButton)}
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
          {...stylex.attrs(styles.messageToolsToolbarButton)}
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
        {...stylex.attrs(styles.messageToolsToolbarButton)}
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
        <Icon name="pin" size={16} styles={[styles.messageToolsIcon, props.m.pinned !== undefined ? styles.messageToolsIcon : styles.replyQuoteIcon]} />
      </Toolbar.Button>
      <Show when={editable()}>
        <Toolbar.Button
          {...stylex.attrs(styles.messageToolsToolbarButton)}
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
        onOpenChange={(next) => setMenu((prev) => (next ? "more" : prev === "more" ? "closed" : prev))}
        render={(p) => <Toolbar.Button {...p} />}
        items={[
          { key: "copy-link", label: t("web.channel.more.copyLink"), icon: "copy", onSelect: copyLink },
          { key: "mark-unread", label: t("web.channel.more.markUnread"), icon: "show", onSelect: unread },
        ]}
      />
      <Toolbar.Button
        {...stylex.attrs(styles.messageToolsToolbarButton2, sure() ? styles.messageToolsToolbarButtonSecondary : styles.messageToolsToolbarButtonPrimary)}
        data-testid="message-tool"
        data-key="delete"
        data-sure={sure() ? "" : undefined}
        aria-label={sure() ? t("web.channel.tools.sure") : t("web.channel.tools.remove")}
        title={sure() ? t("web.channel.tools.sure") : t("web.channel.tools.remove")}
        onBlur={() => setMenu((prev) => (prev === "confirmDelete" ? "closed" : prev))}
        onClick={() => {
          if (!sure()) return void setMenu("confirmDelete");
          setMenu("closed");
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
  // The words as they were when editing began: a change heard meanwhile does not move the box under the user's hands.
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
    <div {...stylex.attrs(styles.editBoxDiv)}>
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
        {...stylex.attrs(styles.messageEdit)}
      />
      <Show when={files.length > 0}>
        <div {...stylex.attrs(styles.editBoxDiv2)}>
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
                  {...stylex.attrs(styles.editBoxButton, keeps() ? styles.editBoxButtonTone : styles.editBoxButtonAlt)}
                >
                  <Icon name="attach" size={12} />
                  <span {...stylex.attrs(styles.editBoxSpan)}>{f.name}</span>
                  <Icon name={keeps() ? "close" : "add"} size={10} />
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <p {...stylex.attrs(styles.editBoxP)}>{t("web.channel.tools.editHint")}</p>
    </div>
  );
}

/** The farm's messages a message links to, each as it is now; a press goes there. */
export function LinkedMessages(props: { text: string }) {
  const core = useCore();
  const links = () => linkedMessages(props.text, core()?.chat, location.host);
  return (
    <Show when={links().length > 0}>
      <div {...stylex.attrs(styles.embedsDiv)}>
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
      {...stylex.attrs(styles.linkedMessage)}
    >
      <span {...stylex.attrs(styles.linkedCardSpan2)}>
        <span {...stylex.attrs(styles.linkedCardSpan22)}>
          <Show when={m()} fallback={`#${props.at.number}`}>
            {(said) => nameOf(said())}
          </Show>
        </span>
        <span>{channelLabel(where())}</span>
        <Show when={m()}>{(said) => <span>{workbenchClock(said().at)}</span>}</Show>
      </span>
      <Show when={m()}>
        {(said) => (
          <Show when={said().deleted === undefined} fallback={<span {...stylex.attrs(styles.messageBodyP)}>{t("web.channel.messages.replyGone")}</span>}>
            <span {...stylex.attrs(styles.linkedCardSpan)}>{said().text || list(said().attachments.map((a) => a.name))}</span>
          </Show>
        )}
      </Show>
    </button>
  );
}
