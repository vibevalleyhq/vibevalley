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
import { channelHeadClass, channelIconButtonClass, markOf, Sidebar } from "./ChannelSidebar";
import { Composer, FileDrop, type QuotedBlockDraft } from "./Composer";
import { ChannelSettingsDialog, NewChannelDialog } from "./Dialogs";
import { useMarkedChat } from "./marks";
import { MessageList } from "./MessageList";
import { channelLabel, channelName, chatPath, pointedAt, topOf, topsOf } from "./places";
import { Crons, Sessions } from "./Tabs";

const viewStyles = stylex.create({
  chatDiv: {
    position: "relative",
    display: "flex",
    height: "100%",
    overflow: "hidden",
  },
  chatDiv2: {
    display: {
      default: "none",
      "@media (width>=48rem)": "flex",
    },
    width: "calc(var(--spacing) * 72)",
    flexShrink: "0",
  },
  chatDiv3: {
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
    backgroundColor: "var(--wb-scrim)",
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
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
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
    backgroundColor: "var(--wb-selected)",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-muted)",
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
    color: "var(--wb-muted)",
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
      default: "var(--wb-line)",
      ":focus-within": "var(--wb-focus)",
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
      "::placeholder": "var(--wb-faint)",
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
});

const styles = stylex.create({
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
  const [creating, setCreating] = createSignal(false);
  const [searching, setSearching] = createSignal(false);
  // A message's address (?m=) lights it up in the pane it is in: the thread's, or the channel's.
  const point = () => pointedAt(router.path());
  // An artifact opened beside the talk that made it (?artifact=), and the block the owner is about to speak about.
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
    <Sidebar channel={channel()} thread={thread()} onNew={() => setCreating(true)} onSearch={() => setSearching(true)} onPick={() => setDrawer(false)} />
  );
  return (
    <div {...stylex.attrs(viewStyles.chatDiv)}>
      <div {...stylex.attrs(viewStyles.chatDiv2)}>{sidebar()}</div>
      <Show when={drawer()}>
        <div {...stylex.attrs(viewStyles.chatDiv3)}>
          <div {...stylex.attrs(viewStyles.chatDiv4)} onClick={() => setDrawer(false)} />
          <div class="absolute inset-y-0 left-0 flex w-72 shadow-float transition-transform duration-280 starting:-translate-x-full">{sidebar()}</div>
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
          <div
            class="absolute inset-0 z-20 flex border-l border-line bg-page transition-transform duration-180 lg:relative lg:z-auto lg:w-(--pane-w) lg:shrink-0 starting:translate-x-full"
            style={{ "--pane-w": `${threadWidth()}px` }}
          >
            <div {...stylex.attrs(viewStyles.chatDiv5)}>
              <Splitter pane="thread" side="left" width={threadWidth()} min={320} max={720} label={t("web.channel.threadWidth")} />
            </div>
            <Keyed key={shown().id}>{() => <ThreadPane thread={shown()} point={point()} onClose={() => router.navigate(chatPath(channel()))} />}</Keyed>
          </div>
        )}
      </Show>
      <Show when={artifact()}>
        {(id) => (
          <div {...stylex.attrs(viewStyles.chatDiv6)}>
            <ArtifactCanvas id={id()} onClose={closeArtifact} onQuote={(block) => quote(id(), block)} />
          </div>
        )}
      </Show>
      <NewChannelDialog open={creating()} onClose={() => setCreating(false)} onCreated={(newId) => router.navigate(`/chat/${newId}`)} />
      <FarmSearch open={searching()} onClose={() => setSearching(false)} />
    </div>
  );
}

type Tab = "chat" | "issues" | "crons";

const tabs: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "chat", icon: "chat", label: t("web.channel.tab.chat") },
  { tab: "issues", icon: "issues", label: t("web.channel.tab.issues") },
  { tab: "crons", icon: "clock", label: t("web.channel.tab.crons") },
];

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
  const [threadsOpen, setThreadsOpen] = createSignal(false);
  const [search, setSearch] = createSignal<string>();
  const [settings, setSettings] = createSignal(false);
  const [pinsOpen, setPinsOpen] = createSignal(false);
  const [membersOpen, setMembersOpen] = createSignal(false);
  const name = () => channelName(props.channel);
  const about = () =>
    [props.channel?.description, props.channel?.repo ? t("web.channel.defaultRepo", { repo: props.channel.repo }) : ""].filter(Boolean).join(" · ");
  return (
    <section {...stylex.attrs(viewStyles.channelMainSection)} aria-label={channelLabel(props.channel)}>
      <header data-testid="channel-head" data-key={props.channel?.id} class={[channelHeadClass, "gap-3 px-4"]}>
        <button type="button" class={[channelIconButtonClass, "md:hidden"]} aria-label={t("web.channel.channels")} onClick={() => props.onDrawer()}>
          <Icon name="chat" size={20} />
        </button>
        <span {...stylex.attrs(viewStyles.channelMainSpan)}>{markOf(props.channel)}</span>
        <div {...stylex.attrs(viewStyles.channelMainSection)}>
          <h1 {...stylex.attrs(viewStyles.channelMainH1)} title={props.channel?.default === true ? t("web.channel.defaultHint") : undefined}>
            {name()}
          </h1>
          <Show when={about()}>
            <p {...stylex.attrs(viewStyles.channelMainP)}>{about()}</p>
          </Show>
        </div>
        <Show when={search() !== undefined}>
          <label {...stylex.attrs(viewStyles.channelMainLabel)}>
            <Icon name="search" size={14} />
            <input
              ref={autofocus()}
              data-testid="message-search"
              value={search() ?? ""}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && setSearch(undefined)}
              placeholder={t("web.channel.findHint")}
              aria-label={t("web.channel.find")}
              {...stylex.attrs(viewStyles.messageSearch)}
            />
          </label>
        </Show>
        <button
          type="button"
          class={[channelIconButtonClass, { "bg-selected": search() !== undefined }]}
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
            <div {...stylex.attrs(viewStyles.channelMainDiv)}>
              <button
                type="button"
                class={[channelIconButtonClass, { "bg-selected": threadsOpen() }]}
                data-testid="threads-toggle"
                aria-label={t("web.channel.threadList.title")}
                aria-expanded={aria(threadsOpen())}
                title={t("web.channel.threadList.title")}
                onClick={() => setThreadsOpen(!threadsOpen())}
              >
                <Icon name="thread" size={20} />
              </button>
              <Show when={threadsOpen()}>
                <ThreadList channel={c()} onPick={() => setThreadsOpen(false)} />
              </Show>
            </div>
          )}
        </Show>
        <div {...stylex.attrs(viewStyles.channelMainDiv)}>
          <button
            type="button"
            class={[channelIconButtonClass, { "bg-selected": pinsOpen() }]}
            data-testid="pins-toggle"
            aria-label={t("web.channel.pins.open")}
            aria-expanded={aria(pinsOpen())}
            title={t("web.channel.pins.open")}
            disabled={!props.channel}
            onClick={() => setPinsOpen(!pinsOpen())}
          >
            <Icon name="pin" size={20} />
          </button>
          <Show when={pinsOpen() ? props.channel : undefined}>{(c) => <Pins channel={c()} onPick={() => setPinsOpen(false)} />}</Show>
        </div>
        <button
          type="button"
          // The members panel is beside the list, which a phone has no room for.
          class={[channelIconButtonClass, "w-auto px-2 text-sm max-md:hidden", { "bg-selected": membersOpen() }]}
          data-testid="members-toggle"
          aria-pressed={aria(membersOpen())}
          disabled={!props.channel}
          onClick={() => setMembersOpen(!membersOpen())}
        >
          {t("web.channel.members.open")}
        </button>
        <button
          type="button"
          class={channelIconButtonClass}
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
        <div {...stylex.attrs(viewStyles.channelMainDiv2)}>
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
