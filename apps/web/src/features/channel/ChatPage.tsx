import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Channel } from "@vibevalley/protocol";
import { channelOf } from "@vibevalley/protocol/rules";
import { artifactId as brandArtifactId, blockId as brandBlockId } from "@vibevalley/protocol/schema";

import { aria, autofocus, Keyed } from "#/base/dom.tsx";
import { ArtifactCanvas, type QuoteTarget } from "#/features/artifact/index.ts";
import { useRouter } from "#/infra/router.ts";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { Splitter, usePaneWidth } from "#/ui/Splitter.tsx";
import { Tabs } from "#/ui/Tabs.tsx";

import { FarmSearch, Members, Pins, ThreadList, ThreadPane } from "./ChannelPanels";
import { markOf, Sidebar } from "./ChannelSidebar";
import { Composer, FileDrop, type QuotedBlockDraft } from "./Composer";
import { ChannelSettingsDialog, NewChannelDialog } from "./Dialogs";
import { useMarkedChat } from "./marks";
import { MessageList } from "./MessageList";
import { channelLabel, channelName, chatPath, pointedAt, topOf, topsOf } from "./places";
import { Crons, Sessions } from "./Tabs";

const styles = stylex.create({
  chatDiv: {
    position: "absolute",
    insetBlock: "0",
    left: "0",
    display: "flex",
    width: "calc(var(--spacing) * 72)",
    boxShadow: "var(--shadow-float)",
    transitionProperty: "transform,translate,scale,rotate",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".28s",
    translate: {
      default: null,
      "@starting-style": "-100% 0",
    },
  },
  chatDiv2: {
    position: {
      default: "absolute",
      "@media (width>=64rem)": "relative",
    },
    inset: "0",
    zIndex: {
      default: 20,
      "@media (width>=64rem)": "auto",
    },
    display: "flex",
    borderLeftStyle: "solid",
    borderLeftWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    transitionProperty: "transform,translate,scale,rotate",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: ".18s",
    width: {
      default: null,
      "@media (width>=64rem)": "var(--pane-w)",
    },
    flexShrink: {
      default: null,
      "@media (width>=64rem)": "0",
    },
    translate: {
      default: null,
      "@starting-style": "100% 0",
    },
  },
  channelMainHeader: {
    display: "flex",
    height: "66px",
    flexShrink: "0",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    paddingInline: "calc(var(--spacing) * 4)",
  },
  channelMainButton: {
    display: {
      default: "inline-flex",
      "@media (width>=48rem)": "none",
    },
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
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
  channelMainButton2: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  channelMainButtonPrimary: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  channelMainButtonSecondary: {
    backgroundColor: {
      default: "var(--color-selected)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  channelMainButton3: {
    display: {
      default: "inline-flex",
      "@media not all and (width>=48rem)": "none",
    },
    width: "auto",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
  channelMainButton4: {
    display: "inline-flex",
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
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
  chatDiv3: {
    position: "relative",
    display: "flex",
    height: "100%",
    overflow: "hidden",
  },
  chatDiv22: {
    display: {
      default: "none",
      "@media (width>=48rem)": "flex",
    },
    width: "calc(var(--spacing) * 72)",
    flexShrink: "0",
  },
  chatDiv32: {
    position: "absolute",
    inset: "0",
    zIndex: "30",
    display: {
      default: null,
      "@media (width>=48rem)": "none",
    },
  },
  chatDiv4: {
    position: "absolute",
    inset: "0",
    backgroundColor: "var(--color-scrim)",
  },
  chatDiv5: {
    display: {
      default: "none",
      "@media (width>=64rem)": "block",
    },
  },
  chatDiv6: {
    position: {
      default: "absolute",
      "@media (width>=64rem)": "relative",
    },
    inset: "0",
    zIndex: {
      default: "20",
      "@media (width>=64rem)": "auto",
    },
    display: "flex",
    borderLeftStyle: "solid",
    borderLeftWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    width: {
      default: null,
      "@media (width>=64rem)": "520px",
    },
    flexShrink: {
      default: null,
      "@media (width>=64rem)": "0",
    },
  },
  channelMainSection: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  channelMainSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 8)",
    height: "calc(var(--spacing) * 8)",
    flexShrink: "0",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-lg)",
    backgroundColor: "var(--color-selected)",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  channelMainH1: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  channelMainP: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  channelMainLabel: {
    display: "flex",
    height: "calc(var(--spacing) * 8)",
    width: "calc(var(--spacing) * 48)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: {
      default: "var(--color-line)",
      ":focus-within": "var(--color-focus)",
    },
    paddingInline: "calc(var(--spacing) * 2)",
  },
  messageSearch: {
    minWidth: "0",
    flex: "1",
    backgroundColor: "transparent",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
    color: {
      default: null,
      "::placeholder": "var(--color-faint)",
    },
  },
  channelMainDiv: {
    position: "relative",
  },
  channelMainDiv2: {
    display: "flex",
    minHeight: "0",
    flex: "1",
  },
  tabs: { flexShrink: 0, borderBottomWidth: 1, borderBottomStyle: "solid", borderColor: "var(--color-line)", paddingInline: "calc(var(--spacing) * 3)" },
});

/** /chat is the general; /chat/<id> a channel, or a thread shown beside its channel. */
export function ChatPage() {
  return <Chat />;
}

function Chat() {
  const router = useRouter();
  const id = () => decodeURIComponent((router.path().split("?")[0] ?? "").replace(/^\/chat\/?/u, "")) || undefined;
  const chat = useMarkedChat();
  const shown = createMemo(() => channelOf(chat(), id()));
  const channel = createMemo(() => topOf(chat(), shown()) ?? topsOf(chat())[0]);
  const thread = createMemo(() => (shown()?.type === "thread" ? shown() : undefined));
  const threadWidth = usePaneWidth("thread", 416, 320, 720);
  const [drawer, setDrawer] = createSignal(false);
  /** The one dialog over the page: a new channel or the search; opening one closes the other. */
  const [dialog, setDialog] = createSignal<"none" | "new" | "search">("none");
  // A message's address (?m=) lights it up in the pane it is in: the thread's, or the channel's.
  const point = () => pointedAt(router.path());
  // An artifact opened beside the talk that made it (?artifact=), and the block the user is about to speak about.
  const [quoted, setQuoted] = createSignal<QuotedBlockDraft[]>([]);
  const artifact = () => new URLSearchParams(router.path().split("?")[1] ?? "").get("artifact");
  createEffect(
    () => channel()?.id,
    () => {
      setQuoted([]);
    },
  );
  const closeArtifact = () => {
    const [path, query] = router.path().split("?");
    const params = new URLSearchParams(query ?? "");
    params.delete("artifact");
    router.navigate(`${path}${params.toString() ? `?${params}` : ""}`, { replace: true });
  };
  const quote = (id: string, block: QuoteTarget) =>
    setQuoted((had) =>
      had.some((q) => q.ref.blockId === block.id)
        ? had
        : [...had, { ref: { artifactId: brandArtifactId(id), blockId: brandBlockId(block.id), rev: block.rev }, text: block.text }],
    );
  const unquote = (blockId: string) => setQuoted((had) => had.filter((q) => q.ref.blockId !== blockId));

  const sidebar = () => (
    <Sidebar channel={channel()} thread={thread()} onNew={() => setDialog("new")} onSearch={() => setDialog("search")} onPick={() => setDrawer(false)} />
  );
  return (
    <div {...stylex.attrs(styles.chatDiv3)}>
      <div {...stylex.attrs(styles.chatDiv22)}>{sidebar()}</div>
      <Show when={drawer()}>
        <div {...stylex.attrs(styles.chatDiv32)}>
          <div {...stylex.attrs(styles.chatDiv4)} onClick={() => setDrawer(false)} />
          <div {...stylex.attrs(styles.chatDiv)}>{sidebar()}</div>
        </div>
      </Show>
      {/* Only once the chat is in: keyed before it, the channel's arrival would start a tab picked meanwhile over. */}
      <Show when={chat()}>
        <Keyed key={channel()?.id ?? ""}>
          {() => (
            <ChannelMain
              channel={channel()}
              point={thread() ? undefined : point()}
              onDrawer={() => setDrawer(!drawer())}
              quoted={quoted()}
              onClearQuote={() => setQuoted([])}
              onRemoveQuote={unquote}
            />
          )}
        </Keyed>
      </Show>
      <Show when={thread()}>
        {(shown) => (
          <div {...stylex.attrs(styles.chatDiv2)} style={{ "--pane-w": `${threadWidth()}px` }}>
            <div {...stylex.attrs(styles.chatDiv5)}>
              <Splitter pane="thread" side="left" width={threadWidth()} min={320} max={720} label={t("web.channel.threadWidth")} />
            </div>
            <Keyed key={shown().id}>{() => <ThreadPane thread={shown()} point={point()} onClose={() => router.navigate(chatPath(channel()))} />}</Keyed>
          </div>
        )}
      </Show>
      <Show when={artifact()}>
        {(id) => (
          <div {...stylex.attrs(styles.chatDiv6)}>
            <ArtifactCanvas id={id()} onClose={closeArtifact} onQuote={(block) => quote(id(), block)} />
          </div>
        )}
      </Show>
      <NewChannelDialog
        open={dialog() === "new"}
        onClose={() => setDialog((d) => (d === "new" ? "none" : d))}
        onCreated={(newId) => router.navigate(`/chat/${newId}`)}
      />
      <FarmSearch open={dialog() === "search"} onClose={() => setDialog((d) => (d === "search" ? "none" : d))} />
    </div>
  );
}

type Tab = "chat" | "issues" | "crons";

const tabs: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "chat", icon: "chat", label: t("web.channel.tab.chat") },
  { tab: "issues", icon: "issues", label: t("web.channel.tab.issues") },
  { tab: "crons", icon: "clock", label: t("web.channel.tab.crons") },
];

type HeaderOverlay = "none" | "threads" | "pins";

/** Built again for each channel (Keyed): its tab and search start over in another one. */
function ChannelMain(props: {
  channel: Channel | undefined;
  point: number | undefined;
  onDrawer: () => void;
  quoted: readonly QuotedBlockDraft[];
  onClearQuote: () => void;
  onRemoveQuote: (blockId: string) => void;
}) {
  const router = useRouter();
  const [tab, setTab] = createSignal<Tab>("chat");
  const [overlay, setOverlay] = createSignal<HeaderOverlay>("none");
  const threadsOpen = () => overlay() === "threads";
  const pinsOpen = () => overlay() === "pins";
  const [search, setSearch] = createSignal<string>();
  const [settings, setSettings] = createSignal(false);
  const [membersOpen, setMembersOpen] = createSignal(false);
  const name = () => channelName(props.channel);
  const about = () =>
    [props.channel?.description, props.channel?.repo ? t("web.channel.defaultRepo", { repo: props.channel.repo }) : ""].filter(Boolean).join(" · ");
  return (
    <section {...stylex.attrs(styles.channelMainSection)} aria-label={channelLabel(props.channel)}>
      <header data-testid="channel-head" data-key={props.channel?.id} {...stylex.attrs(styles.channelMainHeader)}>
        <button type="button" {...stylex.attrs(styles.channelMainButton)} aria-label={t("web.channel.channels")} onClick={() => props.onDrawer()}>
          <Icon name="chat" size={20} />
        </button>
        <span {...stylex.attrs(styles.channelMainSpan)}>{markOf(props.channel)}</span>
        <div {...stylex.attrs(styles.channelMainSection)}>
          <h1 {...stylex.attrs(styles.channelMainH1)} title={props.channel?.default === true ? t("web.channel.defaultHint") : undefined}>
            {name()}
          </h1>
          <Show when={about()}>
            <p {...stylex.attrs(styles.channelMainP)}>{about()}</p>
          </Show>
        </div>
        <Show when={search() !== undefined}>
          <label {...stylex.attrs(styles.channelMainLabel)}>
            <Icon name="search" size={14} />
            <input
              ref={autofocus()}
              data-testid="message-search"
              value={search() ?? ""}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && setSearch(undefined)}
              placeholder={t("web.channel.findHint")}
              aria-label={t("web.channel.find")}
              {...stylex.attrs(styles.messageSearch)}
            />
          </label>
        </Show>
        <button
          type="button"
          {...stylex.attrs(
            styles.channelMainButton2,
            search() !== undefined ? styles.channelMainButtonSecondary : styles.channelMainButtonPrimary,
          )}
          data-testid="message-search-toggle"
          aria-label={t("web.channel.findMessages")}
          aria-pressed={aria(search() !== undefined)}
          title={t("web.channel.findMessages")}
          onClick={() => {
            setSearch(search() === undefined ? "" : undefined);
            setTab("chat");
          }}
        >
          <Icon name="search" size={20} />
        </button>
        <Show when={props.channel?.type === "channel" ? props.channel : undefined}>
          {(c) => (
            <div {...stylex.attrs(styles.channelMainDiv)}>
              <button
                type="button"
                {...stylex.attrs(
                  styles.channelMainButton2,
                  threadsOpen() ? styles.channelMainButtonSecondary : styles.channelMainButtonPrimary,
                )}
                data-testid="threads-toggle"
                aria-label={t("web.channel.threadList.title")}
                aria-expanded={aria(threadsOpen())}
                title={t("web.channel.threadList.title")}
                onClick={() => setOverlay(threadsOpen() ? "none" : "threads")}
              >
                <Icon name="thread" size={20} />
              </button>
              <Show when={threadsOpen()}>
                <ThreadList channel={c()} onPick={() => setOverlay("none")} />
              </Show>
            </div>
          )}
        </Show>
        <div {...stylex.attrs(styles.channelMainDiv)}>
          <button
            type="button"
            {...stylex.attrs(
              styles.channelMainButton2,
              pinsOpen() ? styles.channelMainButtonSecondary : styles.channelMainButtonPrimary,
            )}
            data-testid="pins-toggle"
            aria-label={t("web.channel.pins.open")}
            aria-expanded={aria(pinsOpen())}
            title={t("web.channel.pins.open")}
            disabled={!props.channel}
            onClick={() => setOverlay(pinsOpen() ? "none" : "pins")}
          >
            <Icon name="pin" size={20} />
          </button>
          <Show when={pinsOpen() ? props.channel : undefined}>{(c) => <Pins channel={c()} onPick={() => setOverlay("none")} />}</Show>
        </div>
        <button
          type="button"
          // The members panel is beside the list, which a phone has no room for.
          {...stylex.attrs(
            styles.channelMainButton3,
            membersOpen() ? styles.channelMainButtonSecondary : styles.channelMainButtonPrimary,
          )}
          data-testid="members-toggle"
          aria-pressed={aria(membersOpen())}
          disabled={!props.channel}
          onClick={() => {
            const next = !membersOpen();
            setMembersOpen(next);
            if (next) setTab("chat");
          }}
        >
          {t("web.channel.members.open")}
        </button>
        <button
          type="button"
          {...stylex.attrs(styles.channelMainButton4)}
          data-testid="channel-settings-open"
          aria-label={t("web.channel.settings")}
          title={t("web.channel.settings")}
          disabled={!props.channel}
          onClick={() => setSettings(true)}
        >
          <Icon name="settings" size={20} />
        </button>
      </header>
      <Tabs
        look="line"
        label={t("web.channel.inChannel")}
        value={tab()}
        onChange={setTab}
        items={(props.channel?.type === "direct" ? tabs.filter((entry) => entry.tab === "chat") : tabs).map((e) => ({
          value: e.tab,
          label: e.label,
          icon: e.icon,
        }))}
        styles={styles.tabs}
      />
      <Show when={tab() === "chat"}>
        <div {...stylex.attrs(styles.channelMainDiv2)}>
          <FileDrop channel={props.channel}>
            <MessageList
              channel={props.channel}
              filter={search()}
              point={props.point}
              emptyText={t("web.channel.empty", { label: channelLabel(props.channel) })}
            />
            <Composer
              channel={props.channel}
              placeholder={t("web.channel.sendTo", { label: channelLabel(props.channel) })}
              quoted={props.quoted}
              onClearQuote={props.onClearQuote}
              onRemoveQuote={props.onRemoveQuote}
            />
          </FileDrop>
          <Show when={membersOpen() ? props.channel : undefined}>{(c) => <Members channel={c()} />}</Show>
        </div>
      </Show>
      <Show when={props.channel}>
        {(c) => (
          <>
            <Show when={tab() === "issues"}>
              <Sessions channel={c()} />
            </Show>
            <Show when={tab() === "crons"}>
              <Crons channel={c()} />
            </Show>
            <ChannelSettingsDialog channel={c()} open={settings()} onClose={() => setSettings(false)} onGone={() => router.navigate("/chat")} />
          </>
        )}
      </Show>
    </section>
  );
}
