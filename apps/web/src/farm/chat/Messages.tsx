import * as stylex from "@stylexjs/stylex";

import { t } from "@vibevalley/i18n";

const replyTo = (name: string, text: string) => (text ? t("web.farm.chat.replyToText", { name, text }) : t("web.farm.chat.replyTo", { name }));
// The rows of the farm's chat window: bubbles for what is said, a turn report with its outcome, the thread a message has, the message a thread hangs from, and a long message folded to its first lines.

import type { JSX } from "@solidjs/web";
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";

import { type Agent, attachmentPath, type ChatMessage, type Channel, type Outcome, userId } from "@vibevalley/protocol";
import { actorRoleOf, channelOf } from "@vibevalley/protocol/rules";

import { aria, autofocus } from "#/base/dom.tsx";
import { spentText } from "#/base/format.ts";
import { farmGroup, farmMessage } from "#/farm/interaction.stylex.ts";
import { farmClock, readsLong } from "#/farm/store.ts";
import { artifactHref } from "#/features/artifact/index.ts";
import { drafts, EmojiPicker, messagePath, quickReactions, reactionOn, reactionSet, sameReaction, setMark, useMessage } from "#/features/channel/index.ts";
import { api } from "#/infra/api.ts";
import { useCore } from "#/infra/frame.ts";
import { Link as A } from "#/infra/router.ts";
import { useIntents } from "#/state/intent.ts";
import { AgentFace, OrchestratorFace, UserFace } from "#/ui/Face.tsx";
import { createPixelAct, noticeTitle, PxMarkdown, SpriteIcon, ToastType, toasts } from "#/ui/pixel/index.ts";
import { styleProps } from "#/ui/positioner.ts";

const styles = stylex.create({
  textLink: {
    marginTop: "0.25rem",
    cursor: "pointer",
    fontSize: "12px",
    color: "var(--color-leaf-700)",
    textDecorationLine: { default: null, "@media (hover:hover)": { default: null, ":hover": "underline" } },
  },
  ownTextLink: { color: "var(--color-cream-50)" },
  dispatch: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "flex-start",
    gap: "0.375rem",
    textAlign: "left",
  },
  dispatchIcon: {
    marginTop: "0.25rem",
    opacity: { default: 0.6, "@media (hover:hover)": { default: null, [stylex.when.ancestor(":hover", farmGroup)]: 1 } },
  },
  row: { position: "relative", display: "flex", alignItems: "flex-start", gap: "0.5rem" },
  firstRow: { paddingTop: "0.25rem" },
  ownRow: { justifyContent: "flex-end" },
  menuTrigger: {
    cursor: "pointer",
    padding: "0.125rem",
    opacity: {
      default: 0,
      "@media (hover:hover)": { default: null, [stylex.when.ancestor(":hover", farmMessage)]: 1 },
      ":focus-visible": 1,
      ":is([aria-expanded=true])": 1,
    },
  },
  chatTextDivPrimary: {
    maxHeight: "117px",
    overflow: "hidden",
    WebkitMaskImage: "linear-gradient(black 70%,transparent)",
    maskImage: "linear-gradient(black 70%,transparent)",
  },
  chatTextDivSecondary: {
    maxHeight: null,
    overflow: null,
    WebkitMaskImage: null,
    maskImage: null,
  },
  messageMenuDiv: {
    position: "absolute",
    right: "0",
    bottom: "100%",
    zIndex: "30",
    marginBottom: "0.25rem",
    width: "10rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-cream-300)",
    backgroundColor: "var(--color-cream-50)",
    paddingBlock: "0.25rem",
    boxShadow: "var(--shadow-px)",
  },
  messageMenuButton: {
    cursor: "pointer",
    paddingInline: "0.25rem",
    fontSize: "14px",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-px-leaf-hover)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--color-leaf-300) 40%, transparent)",
        },
      },
    },
  },
  messageMenuButton2: {
    cursor: "pointer",
    paddingInline: "0.25rem",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-px-leaf-hover)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--color-leaf-300) 40%, transparent)",
        },
      },
    },
  },
  messageMenuButton3: {
    width: "100%",
    cursor: "pointer",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    textAlign: "left",
    fontSize: "12px",
    color: "var(--color-bark-900)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-px-leaf-hover)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--color-leaf-300) 40%, transparent)",
        },
      },
    },
  },
  messageMenuButton4: {
    width: "100%",
    cursor: "pointer",
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    textAlign: "left",
    fontSize: "12px",
    color: "var(--color-berry)",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-px-leaf-hover)",
        "@supports (color:color-mix(in lab, red, red))": {
          default: null,
          ":hover": "color-mix(in oklab, var(--color-leaf-300) 40%, transparent)",
        },
      },
    },
  },
  threadChipButton: {
    marginTop: "0.375rem",
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.375rem",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-cream-300)",
    backgroundColor: {
      default: "var(--color-px-paper-glass)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-cream-50) 80%, transparent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-50)",
      },
    },
    paddingInline: "0.5rem",
    paddingBlock: "0.125rem",
  },
  chatRowSpan: {
    marginInline: "0.25rem",
    marginBottom: "0.125rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1rem",
    color: "var(--color-bark-500)",
  },
  farmEditSpan: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1rem",
    color: "var(--color-bark-500)",
  },
  chatBubbleP: {
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1rem",
    color: "var(--color-bark-500)",
    fontStyle: "italic",
  },
  answersP: {
    marginBottom: "0.125rem",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1rem",
    color: "var(--color-bark-500)",
  },
  chatReportP: {
    marginTop: "0.25rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    lineHeight: "1rem",
    color: "var(--color-bark-500)",
  },
  chatBubbleA: {
    marginTop: "0.25rem",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-500)",
    backgroundColor: {
      default: "var(--color-cream-50)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-cream-hover)",
      },
    },
    paddingInline: "0.5rem",
    paddingBlock: "0.25rem",
    fontSize: "12px",
    color: "var(--color-bark-900)",
  },
  chatRowDiv: {
    display: "flex",
    maxWidth: "84%",
    flexDirection: "column",
  },
  chatRowDivTone: {
    alignItems: "flex-end",
  },
  chatRowDivAlt: {
    alignItems: "flex-start",
  },
  chatRowDiv2: {
    maxWidth: "100%",
    paddingInline: "0.75rem",
    paddingBlock: "0.5rem",
    fontSize: "12px",
    lineHeight: "1.625",
    color: "var(--color-bark-900)",
  },
  chatRowDivAccent: {
    backgroundColor: "var(--color-leaf-500)",
    boxShadow: "0 2px 0 0 var(--color-leaf-700)",
  },
  chatRowDivMuted: {
    borderStyle: "solid",
    borderWidth: "1.5px",
    borderColor: "var(--color-cream-300)",
    backgroundColor: "var(--color-cream-100)",
    boxShadow: "0 2px 0 0 var(--color-leaf-edge)",
  },
  chatTextDiv: {
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
  },
  dispatchNoteSpan: {
    minWidth: "0",
    flex: "1",
  },
  dispatchNoteSpan2: {
    display: "block",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  senderNameSpan: {
    fontFamily: "var(--font-mono)",
    color: "var(--color-bark-500)",
  },
  chatRowSpan2: {
    width: "30px",
    flexShrink: "0",
  },
  messageMenuDiv2: {
    position: "relative",
    alignSelf: "center",
  },
  messageMenuDiv22: {
    display: "flex",
    flexWrap: "wrap",
    gap: "0.125rem",
    paddingInline: "0.25rem",
    paddingBottom: "0.25rem",
  },
  farmEditDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
  },
  messageEdit: {
    fieldSizing: "content",
    minWidth: "12rem",
    resize: "none",
    backgroundColor: "var(--color-cream-50)",
    paddingInline: "0.375rem",
    paddingBlock: "0.25rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    color: "var(--color-bark-900)",
    boxShadow: "inset 0 0 0 2px var(--color-cream-300)",
    outlineStyle: "none",
  },
  chatBubbleSpan: {
    marginBottom: "0.25rem",
    display: "inline-block",
    backgroundColor: {
      default: "var(--color-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-wheat) 40%, transparent)",
    },
    paddingInline: "0.375rem",
    fontSize: "12px",
    color: "var(--color-bark-800)",
  },
  chatBubbleDiv: {
    marginTop: "0.25rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },
  chatBubbleA2: {
    display: "block",
    fontSize: "13px",
    textDecorationLine: "underline",
  },
  chatBubbleImg: {
    maxHeight: "10rem",
    maxWidth: "14rem",
    objectFit: "contain",
  },
  chatBubbleSpan2: {
    minWidth: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
  },
  chatBubbleDiv2: {
    marginTop: "0.25rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  reaction: {
    backgroundColor: "var(--color-cream-200)",
    paddingInline: "0.375rem",
    fontSize: "12px",
    color: "var(--color-bark-800)",
  },
  chatReportSpan: {
    marginBottom: "0.25rem",
    display: "inline-block",
    paddingInline: "0.375rem",
    fontSize: "12px",
  },
  reportCompleted: {
    backgroundColor: "var(--color-outcome-ok-fill)",
    color: "var(--color-bark-900)",
  },
  reportFailed: {
    backgroundColor: "var(--color-outcome-fail-fill)",
    color: "var(--color-berry-500)",
  },
  reportInterrupted: {
    backgroundColor: "var(--color-cream-200)",
    color: "var(--color-bark-600)",
  },
  threadChipSpan: {
    fontSize: "12px",
    color: "var(--color-leaf-700)",
  },
  threadChipSpan2: {
    backgroundColor: "var(--color-berry)",
    paddingInline: "0.375rem",
    fontSize: "12px",
    color: "var(--color-cream-50)",
  },
  parentMessageDiv: {
    marginBottom: "0.25rem",
    display: "flex",
    alignItems: "flex-start",
    gap: "0.5rem",
    backgroundColor: "var(--color-cream-100)",
    paddingInline: "0.625rem",
    paddingBlock: "0.5rem",
  },
  parentMessageDiv2: {
    fontSize: "12px",
    color: "var(--color-bark-800)",
  },
});

/** A message's text; a long one shows its first lines until opened. */
function ChatText(props: { text: string; link?: stylex.StyleXStyles }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show when={readsLong(props.text)} fallback={<PxMarkdown text={props.text} mentions />}>
      <div {...stylex.attrs(styles.chatTextDiv)}>
        <div {...stylex.attrs(open() ? styles.chatTextDivSecondary : styles.chatTextDivPrimary)}>
          <PxMarkdown text={props.text} mentions />
        </div>
        <button type="button" onClick={() => setOpen(!open())} {...styleProps([styles.textLink, props.link])}>
          {open() ? t("web.farm.chat.less") : t("web.farm.chat.more")}
        </button>
      </div>
    </Show>
  );
}

/** A dispatch note: one line until tapped. */
function DispatchNote(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <button
      type="button"
      data-testid="dispatch-note"
      aria-expanded={aria(open())}
      aria-label={open() ? t("web.farm.chat.foldDispatch") : t("web.farm.chat.unfoldDispatch")}
      onClick={() => setOpen(!open())}
      {...styleProps([farmGroup, styles.dispatch])}
    >
      <span {...stylex.attrs(styles.dispatchNoteSpan)}>
        <Show when={open()} fallback={<span {...stylex.attrs(styles.dispatchNoteSpan2)}>{props.text.replace(/\s+/gu, " ").trim()}</span>}>
          <PxMarkdown text={props.text} mentions />
        </Show>
      </span>
      <SpriteIcon name={open() ? "button-collapse" : "button-enlarge"} size={12} styles={styles.dispatchIcon} />
    </button>
  );
}

export function FaceOf(props: { m: ChatMessage; agents: ReadonlyMap<string, Agent>; size?: number }) {
  const core = useCore();
  const session = () => core()?.sessions.find((s) => s.id === (props.m.session ?? props.m.from));
  const agentId = () => props.m.agent ?? session()?.agent ?? props.m.from;
  const agent = () => props.agents.get(agentId());
  const size = () => props.size ?? 30;
  return (
    <Switch fallback={<AgentFace agentId={agentId()} look={agent()?.look} runtime={session()?.runtime ?? agent()?.runtime} size={size()} />}>
      <Match when={props.m.actor.kind === "user"}>
        <UserFace size={size()} />
      </Match>
      <Match when={actorRoleOf(props.m.actor) === "orchestrator"}>
        <OrchestratorFace size={size()} agent={props.m.from} />
      </Match>
    </Switch>
  );
}

function SenderName(props: { m: ChatMessage }) {
  return (
    <Show when={actorRoleOf(props.m.actor) === "worker"} fallback={<>{props.m.name}</>}>
      {props.m.name} <span {...stylex.attrs(styles.senderNameSpan)}>@{props.m.from}</span>
    </Show>
  );
}

export function ChatRow(props: {
  mine: boolean;
  first: boolean;
  face?: JSX.Element;
  name?: JSX.Element;
  title?: string;
  actions?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div {...styleProps([farmMessage, styles.row, props.first && styles.firstRow, props.mine && styles.ownRow])}>
      <Show when={props.mine}>{props.actions}</Show>
      <Show when={!props.mine}>
        <span {...stylex.attrs(styles.chatRowSpan2)}>{props.first ? props.face : null}</span>
      </Show>
      <div {...stylex.attrs(styles.chatRowDiv, props.mine ? styles.chatRowDivTone : styles.chatRowDivAlt)}>
        <Show when={!props.mine && props.first && props.name}>
          <span {...stylex.attrs(styles.chatRowSpan)}>{props.name}</span>
        </Show>
        <div title={props.title} {...stylex.attrs(styles.chatRowDiv2, props.mine ? styles.chatRowDivAccent : styles.chatRowDivMuted)}>
          {props.children}
        </div>
      </div>
      <Show when={!props.mine}>{props.actions}</Show>
    </div>
  );
}

type FarmMenuState = "closed" | "menu" | "confirmDelete" | "emojiPicker";

/** What the user can do to a message from the farm's window: the same requests as the workbench's tools. */
function MessageMenu(props: { m: ChatMessage; onEdit: () => void }) {
  const core = useCore();
  const [menu, setMenu] = createSignal<FarmMenuState>("closed");
  const open = () => menu() !== "closed";
  const sure = () => menu() === "confirmDelete";
  const every = () => menu() === "emojiPicker";
  let plus: HTMLButtonElement | undefined;
  const act = createPixelAct();
  const reactions = useIntents(reactionSet);
  const close = () => setMenu("closed");
  const run = (call: () => Promise<unknown>) => {
    close();
    void act.run(call);
  };
  const react = (m: ChatMessage, emoji: string) => {
    close();
    setMark(reactions, { channel: m.channel, id: m.id, emoji, on: reactionOn(m, emoji) }, sameReaction, (reason) =>
      toasts.add({ type: ToastType.error, title: noticeTitle.error ?? reason, description: reason }),
    );
  };
  const editable = () => props.m.from === userId && props.m.kind === "chat";
  return (
    <div {...stylex.attrs(styles.messageMenuDiv2)}>
      <button
        type="button"
        data-testid="message-menu-open"
        aria-label={t("web.farm.chat.actions.open")}
        title={t("web.farm.chat.actions.open")}
        aria-expanded={aria(open())}
        onClick={() => setMenu(open() ? "closed" : "menu")}
        {...styleProps(styles.menuTrigger)}
      >
        <SpriteIcon name="button-more" size={16} />
      </button>
      <Show when={open()}>
        <div role="menu" data-testid="message-menu" aria-label={t("web.farm.chat.actions.open")} {...stylex.attrs(styles.messageMenuDiv)}>
          <div role="group" aria-label={t("web.farm.chat.actions.react")} {...stylex.attrs(styles.messageMenuDiv22)}>
            <For each={quickReactions}>
              {(emoji) => (
                <button
                  type="button"
                  data-testid="quick-reaction"
                  data-key={emoji}
                  aria-label={emoji}
                  {...stylex.attrs(styles.messageMenuButton)}
                  onClick={() => react(props.m, emoji)}
                >
                  {emoji}
                </button>
              )}
            </For>
            <button
              type="button"
              ref={(el) => (plus = el)}
              aria-label={t("web.farm.chat.actions.moreEmoji")}
              aria-expanded={aria(every())}
              {...stylex.attrs(styles.messageMenuButton2)}
              onClick={() => setMenu(every() ? "menu" : "emojiPicker")}
            >
              <SpriteIcon name="button-add" size={12} />
            </button>
          </div>
          <button
            type="button"
            role="menuitem"
            data-key="reply"
            {...stylex.attrs(styles.messageMenuButton3)}
            onClick={() => {
              close();
              drafts.reply(props.m.channel, props.m);
            }}
          >
            {t("web.farm.chat.actions.reply")}
          </button>
          <button
            type="button"
            role="menuitem"
            data-key="copy-link"
            {...stylex.attrs(styles.messageMenuButton3)}
            onClick={() =>
              run(async () => {
                await navigator.clipboard.writeText(location.origin + messagePath(channelOf(core()?.chat, props.m.channel), props.m.number));
                toasts.add({ title: t("web.farm.chat.actions.copied") });
              })
            }
          >
            {t("web.farm.chat.actions.copyLink")}
          </button>
          <Show when={editable()}>
            <button
              type="button"
              role="menuitem"
              data-key="edit"
              {...stylex.attrs(styles.messageMenuButton3)}
              onClick={() => {
                close();
                untrack(() => props.onEdit)();
              }}
            >
              {t("web.farm.chat.actions.edit")}
            </button>
          </Show>
          <button
            type="button"
            role="menuitem"
            data-key="delete"
            data-sure={sure() ? "" : undefined}
            {...stylex.attrs(styles.messageMenuButton4)}
            onClick={() => {
              if (!sure()) return void setMenu("confirmDelete");
              const id = props.m.id;
              close();
              void act.run(() => api.channel.message.delete({ id }));
            }}
          >
            {sure() ? t("web.farm.chat.actions.sure") : t("web.farm.chat.actions.remove")}
          </button>
        </div>
      </Show>
      <Show when={every()}>
        <EmojiPicker
          anchor={plus}
          onClose={() => setMenu("menu")}
          onPick={(emoji) => {
            react(
              untrack(() => props.m),
              emoji,
            );
          }}
        />
      </Show>
    </div>
  );
}

function FarmEdit(props: { m: ChatMessage; onDone: () => void }) {
  const { id, text: was } = untrack(() => props.m);
  const done = () => untrack(() => props.onDone)();
  const [text, setText] = createSignal(was);
  const act = createPixelAct();
  const save = () => {
    const words = text().trim();
    if (!words || words === was) return done();
    void act.run(async () => {
      await api.channel.message.update({ id, text: words });
      done();
    });
  };
  return (
    <div {...stylex.attrs(styles.farmEditDiv)}>
      <textarea
        ref={autofocus()}
        data-testid="message-edit"
        value={text()}
        aria-label={t("web.farm.chat.actions.edit")}
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
      <span {...stylex.attrs(styles.farmEditSpan)}>{t("web.farm.chat.actions.editHint")}</span>
    </div>
  );
}

export function ChatBubble(props: {
  m: ChatMessage;
  mine: boolean;
  first: boolean;
  face?: JSX.Element;
  tag?: string | undefined;
  folded?: boolean;
  after?: JSX.Element;
}) {
  const [editing, setEditing] = createSignal(false);
  return (
    <ChatRow
      mine={props.mine}
      first={props.first}
      face={props.face}
      name={<SenderName m={props.m} />}
      title={farmClock(props.m.at)}
      actions={props.m.deleted === undefined ? <MessageMenu m={props.m} onEdit={() => setEditing(true)} /> : undefined}
    >
      <Show when={props.tag}>
        <span {...stylex.attrs(styles.chatBubbleSpan)}>{props.tag}</span>
      </Show>
      <Show when={props.m.replyTo}>{(n) => <Answers channel={props.m.channel} number={n()} />}</Show>
      <Show when={props.m.deleted === undefined} fallback={<p {...stylex.attrs(styles.chatBubbleP)}>{t("web.farm.chat.deleted")}</p>}>
        <Show
          when={editing()}
          fallback={
            <Show when={props.folded} fallback={<ChatText text={props.m.text} link={props.mine && styles.ownTextLink} />}>
              <DispatchNote text={props.m.text} />
            </Show>
          }
        >
          <FarmEdit m={props.m} onDone={() => setEditing(false)} />
        </Show>
        <Show when={props.m.edited !== undefined}>
          <span {...stylex.attrs(styles.farmEditSpan)}>{t("web.farm.chat.edited")}</span>
        </Show>
        <Show when={props.m.attachments.length > 0 ? props.m.attachments : undefined}>
          {(files) => (
            <div {...stylex.attrs(styles.chatBubbleDiv)}>
              <For each={files()} keyed={(f) => f.id}>
                {(f) => (
                  <a href={attachmentPath(f().id)} target="_blank" rel="noreferrer" {...stylex.attrs(styles.chatBubbleA2)}>
                    <Show when={f().type.startsWith("image/")} fallback={f().name}>
                      <img src={attachmentPath(f().id)} alt={f().name} {...stylex.attrs(styles.chatBubbleImg)} loading="lazy" />
                    </Show>
                  </a>
                )}
              </For>
            </div>
          )}
        </Show>
      </Show>
      <Show when={props.m.deleted === undefined ? props.m.artifact : undefined}>
        {(card) => (
          // Opened in the workbench: a page runs in a sandbox there, never in the farm's window.
          <A
            href={artifactHref(card().id, card().version)}
            data-testid="artifact-card"
            data-key={card().id}
            data-version={card().version}
            {...stylex.attrs(styles.chatBubbleA)}
          >
            <SpriteIcon name="icon-deed" size={14} />
            <span {...stylex.attrs(styles.chatBubbleSpan2)}>
              {card().title} · {t("web.artifact.card.version", { version: card().version })}
            </span>
          </A>
        )}
      </Show>
      <Show when={props.m.reactions.length > 0}>
        <div {...stylex.attrs(styles.chatBubbleDiv2)}>
          <For each={props.m.reactions} keyed={(r) => r.emoji}>
            {(r) => (
              <span data-testid="reaction" data-key={r().emoji} data-count={r().by.length} {...stylex.attrs(styles.reaction)}>
                {r().emoji} {r().by.length}
              </span>
            )}
          </For>
        </div>
      </Show>
      {props.after}
    </ChatRow>
  );
}

function Answers(props: { channel: string; number: number }) {
  const m = useMessage(() => ({ channel: props.channel, number: props.number }));
  return (
    <p {...stylex.attrs(styles.answersP)}>
      {replyTo(m()?.name ?? `#${props.number}`, m()?.deleted === undefined ? (m()?.text ?? "") : t("web.farm.chat.deleted"))}
    </p>
  );
}

const outcomeTag: Record<Outcome, [label: string, look: stylex.StyleXStyles]> = {
  completed: [t("shared.outcome.completed"), styles.reportCompleted],
  failed: [t("shared.outcome.failed"), styles.reportFailed],
  interrupted: [t("shared.outcome.interrupted"), styles.reportInterrupted],
};

export function ChatReport(props: { m: ChatMessage; first: boolean; face: JSX.Element; steps?: JSX.Element }) {
  const tag = () => outcomeTag[props.m.outcome ?? "completed"];
  return (
    <ChatRow mine={false} first={props.first} face={props.face} name={<SenderName m={props.m} />} title={farmClock(props.m.at)}>
      <span {...styleProps([styles.chatReportSpan, tag()[1]])}>{tag()[0]}</span>
      <ChatText text={props.m.text} />
      <Show when={props.m.spent}>
        {(spent) => <p {...stylex.attrs(styles.chatReportP)}>{t("web.farm.chat.spent", { spent: spentText(spent()) })}</p>}
      </Show>
      {props.steps}
    </ChatRow>
  );
}

export function ThreadChip(props: { thread: Channel; unread: number; onOpen: () => void }) {
  return (
    <button type="button" onClick={() => props.onOpen()} {...stylex.attrs(styles.threadChipButton)}>
      <SpriteIcon name="button-thread" size={12} />
      <span {...stylex.attrs(styles.threadChipSpan)}>
        {props.thread.replies > 0 ? t("web.farm.chat.replies", { n: props.thread.replies }) : t("web.farm.chat.thread")}
      </span>
      <Show when={props.unread > 0}>
        <span {...stylex.attrs(styles.threadChipSpan2)}>{t("web.farm.chat.newCount", { n: props.unread })}</span>
      </Show>
      <SpriteIcon name="button-next" size={12} />
    </button>
  );
}

export function ParentMessage(props: { m: ChatMessage; face: JSX.Element }) {
  return (
    <div {...stylex.attrs(styles.parentMessageDiv)}>
      {props.face}
      <div {...stylex.attrs(styles.dispatchNoteSpan)}>
        <p {...stylex.attrs(styles.farmEditSpan)}>
          <SenderName m={props.m} /> · {farmClock(props.m.at)}
        </p>
        <div {...stylex.attrs(styles.parentMessageDiv2)}>
          <ChatText text={props.m.text} />
        </div>
      </div>
    </div>
  );
}
