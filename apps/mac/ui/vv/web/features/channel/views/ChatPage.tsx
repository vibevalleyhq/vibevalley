// Ported from VibeValley apps/web/src/features/channel/views/ChatPage.tsx:
// the sidebar (a drawer below md), the channel with its head, tabs, list and
// box, and a thread beside it (over it below lg) at its own width. The
// thread list and the pins open in nsh/base Popovers under their buttons;
// the message search field is an Input in the head. An artifact opened
// beside the talk (?artifact=) is over it below lg; its blocks are quoted
// into the box.
import { signal, Text, untracked, View, windowSize, type JSX } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Channel } from "@vibevalley/protocol";
import { channelOf } from "@vibevalley/protocol/rules";
import { artifactId as brandArtifactId, blockId as brandBlockId } from "@vibevalley/protocol/schema";

import { createEffect, createMemo } from "../../../../solid";
import { Keyed } from "../../../base/dom";
import { useRouter } from "../../../infra/router";
import { TextInput } from "../../../ui/Field";
import { Icon } from "../../../ui/Icon";
import type { IconName } from "../../../ui/icons";
import { Splitter, usePaneWidth } from "../../../ui/Splitter";
import { Tabs } from "../../../ui/Tabs";
import { Bubble } from "../../../ui/Tip";
import { ArtifactCanvas, type QuoteTarget } from "../../artifact";
import { useMarkedChat } from "../model/marks";
import { channelLabel, channelName, chatPath, pointedAt, topOf, topsOf } from "../model/places";
import { FarmSearch, Members, Pins, ThreadList, ThreadPane } from "./ChannelPanels";
import { BarButton, markOf, Sidebar } from "./ChannelSidebar";
import { Composer, FileDrop, type QuotedBlockDraft } from "./Composer";
import { ChannelSettingsDialog, NewChannelDialog } from "./Dialogs";
import { MessageList } from "./MessageList";
import { Crons, Sessions } from "./Tabs";

/** Tailwind's md (48rem) and lg (64rem). */
const md = () => windowSize().width >= 768;
const lg = () => windowSize().width >= 1024;

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
  const drawer = signal(false);
  /** The one dialog over the page: a new channel or the search; opening one closes the other. */
  const dialog = signal<"none" | "new" | "search">("none");
  // A message's address (?m=) lights it up in the pane it is in: the thread's, or the channel's.
  const point = () => pointedAt(router.path());
  // The blocks of an artifact the user is about to speak about (quoted from an artifact opened beside the talk).
  const quoted = signal<QuotedBlockDraft[]>([]);
  createEffect(
    () => channel()?.id,
    () => quoted.set([]),
  );
  const unquote = (blockId: string) => quoted.set(quoted().filter((q) => q.ref.blockId !== blockId));
  // An artifact opened beside the talk that made it (?artifact=).
  const artifact = () => new URLSearchParams(router.path().split("?")[1] ?? "").get("artifact") ?? undefined;
  const closeArtifact = () => {
    const [path, query] = router.path().split("?");
    const params = new URLSearchParams(query ?? "");
    params.delete("artifact");
    router.navigate(`${path}${params.toString() ? `?${params}` : ""}`, { replace: true });
  };
  const quote = (id: string, block: QuoteTarget) => {
    const had = quoted();
    if (had.some((q) => q.ref.blockId === block.id)) return;
    quoted.set([...had, { ref: { artifactId: brandArtifactId(id), blockId: brandBlockId(block.id), rev: block.rev }, text: block.text }]);
  };

  const sidebar = () => (
    <Sidebar channel={channel()} thread={thread()} onNew={() => dialog.set("new")} onSearch={() => dialog.set("search")} onPick={() => drawer.set(false)} />
  );
  return (
    <View testID="chat-page" class="h-full flex-1 flex-row overflow-hidden">
      <If when={md()}>
        <View class="w-72 shrink-0">{sidebar()}</View>
      </If>
      <If when={!md() && drawer()}>
        <View class="absolute inset-0 z-30">
          <View class="absolute inset-0 bg-scrim" onPress={() => drawer.set(false)} />
          <View class="absolute top-0 bottom-0 left-0 w-72 shadow-float">{sidebar()}</View>
        </View>
      </If>
      {/* Only once the chat is in: keyed before it, the channel's arrival would start a tab picked meanwhile over. */}
      <If when={chat()}>
        <Keyed key={channel()?.id ?? ""}>
          {() => (
            <ChannelMain
              channel={channel()}
              point={thread() ? undefined : point()}
              onDrawer={() => drawer.set(!drawer())}
              quoted={quoted()}
              onClearQuote={() => quoted.set([])}
              onRemoveQuote={unquote}
            />
          )}
        </Keyed>
      </If>
      <If when={thread()}>
        {(open) => (
          <View class={`border-l border-line bg-page ${lg() ? "shrink-0" : "absolute inset-0 z-20"}`} style={lg() ? { width: threadWidth() } : undefined}>
            <If when={lg()}>
              <Splitter pane="thread" side="left" width={threadWidth()} min={320} max={720} label={t("web.channel.threadWidth")} />
            </If>
            <Keyed key={open().id}>{() => <ThreadPane thread={open()} point={point()} onClose={() => router.navigate(chatPath(untracked(channel)))} />}</Keyed>
          </View>
        )}
      </If>
      <If when={artifact()}>
        {(id) => (
          <View class={`border-l border-line bg-page ${lg() ? "w-130 shrink-0" : "absolute inset-0 z-20"}`}>
            <Keyed key={id()}>{() => <ArtifactCanvas id={untracked(id)} onClose={closeArtifact} onQuote={(block) => quote(untracked(id), block)} />}</Keyed>
          </View>
        )}
      </If>
      <NewChannelDialog
        open={dialog() === "new"}
        onClose={() => dialog() === "new" && dialog.set("none")}
        onCreated={(newId) => router.navigate(`/chat/${newId}`)}
      />
      <FarmSearch open={dialog() === "search"} onClose={() => dialog() === "search" && dialog.set("none")} />
    </View>
  );
}

type Tab = "chat" | "issues" | "crons";

const tabs: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "chat", icon: "chat", label: t("web.channel.tab.chat") },
  { tab: "issues", icon: "issues", label: t("web.channel.tab.issues") },
  { tab: "crons", icon: "clock", label: t("web.channel.tab.crons") },
];

type HeaderOverlay = "none" | "threads" | "pins";

/** A head button that opens a popover under it. */
function HeadPopover(props: {
  icon: IconName;
  label: string;
  testid: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  disabled?: boolean;
  children: () => JSX.Element;
  width: number;
}) {
  return (
    <Popover
      open={props.open}
      onOpenChange={(e) => props.onOpen(e.open)}
      placement="bottom"
      align="end"
      offset={4}
      popupClass="rounded-lg border border-line bg-page p-2 shadow-float"
      popupStyle={{ width: props.width, maxHeight: 448 }}
      trigger={
        <View
          testID={props.testid}
          accessibilityLabel={props.label}
          accessibilityState={{ expanded: props.open }}
          tooltip={<Bubble text={props.label} />}
          disabled={props.disabled}
          class={`h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-hover ${props.open ? "bg-selected" : ""} ${props.disabled === true ? "opacity-50" : ""}`}
        >
          <Icon name={props.icon} size={20} />
        </View>
      }
    >
      {props.children()}
    </Popover>
  );
}

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
  const tab = signal<Tab>("chat");
  const overlay = signal<HeaderOverlay>("none");
  const threadsOpen = () => overlay() === "threads";
  const pinsOpen = () => overlay() === "pins";
  const search = signal<string | undefined>(undefined);
  const settings = signal(false);
  const membersOpen = signal(false);
  const name = () => channelName(props.channel);
  const about = () =>
    [props.channel?.description, props.channel?.repo ? t("web.channel.defaultRepo", { repo: props.channel.repo }) : ""].filter(Boolean).join(" · ");
  return (
    <View accessibilityLabel={channelLabel(props.channel)} testID="channel-main" class="min-w-0 flex-1">
      <View testID="channel-head" class="h-16.5 shrink-0 flex-row items-center gap-3 border-b border-line px-4">
        <If when={!md()}>
          <BarButton icon="chat" label={t("web.channel.channels")} testid="channels-drawer" onPress={() => props.onDrawer()} />
        </If>
        <View class="h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-selected">
          <Text class="text-lg font-semibold text-muted">{markOf(props.channel)}</Text>
        </View>
        <View class="min-w-0 flex-1">
          <View tooltip={props.channel?.default === true ? <Bubble text={t("web.channel.defaultHint")} /> : undefined}>
            <Text role="header" class="truncate text-lg font-semibold text-ink">
              {name()}
            </Text>
          </View>
          <If when={about()}>
            <Text class="truncate text-xs text-muted">{about()}</Text>
          </If>
        </View>
        <If when={search() !== undefined}>
          <View class="w-48">
            <TextInput
              testID="message-search"
              autoFocus
              value={search() ?? ""}
              onInput={search.set}
              placeholder={t("web.channel.findHint")}
              accessibilityLabel={t("web.channel.find")}
            />
          </View>
        </If>
        <BarButton
          icon="search"
          testid="message-search-toggle"
          label={t("web.channel.findMessages")}
          pressed={search() !== undefined}
          onPress={() => {
            search.set(search() === undefined ? "" : undefined);
            tab.set("chat");
          }}
        />
        <If when={props.channel?.type === "channel" ? props.channel : undefined}>
          {(c) => (
            <HeadPopover
              icon="thread"
              testid="threads-toggle"
              label={t("web.channel.threadList.title")}
              open={threadsOpen()}
              onOpen={(o) => overlay.set(o ? "threads" : "none")}
              width={384}
            >
              {() => <ThreadList channel={c()} onPick={() => overlay.set("none")} />}
            </HeadPopover>
          )}
        </If>
        <HeadPopover
          icon="pin"
          testid="pins-toggle"
          label={t("web.channel.pins.open")}
          open={pinsOpen()}
          onOpen={(o) => overlay.set(o ? "pins" : "none")}
          disabled={!props.channel}
          width={320}
        >
          {() => <If when={props.channel}>{(c) => <Pins channel={c()} onPick={() => overlay.set("none")} />}</If>}
        </HeadPopover>
        {/* The members panel is beside the list, which a phone has no room for. */}
        <If when={md()}>
          <View
            role="button"
            testID="members-toggle"
            accessibilityState={{ selected: membersOpen() }}
            disabled={!props.channel}
            onPress={() => {
              const next = !membersOpen();
              membersOpen.set(next);
              if (next) tab.set("chat");
            }}
            class={`h-8 shrink-0 items-center justify-center rounded-md px-2 hover:bg-hover ${membersOpen() ? "bg-selected" : ""}`}
          >
            <Text class="text-sm text-ink">{t("web.channel.members.open")}</Text>
          </View>
        </If>
        <BarButton
          icon="settings"
          testid="channel-settings-open"
          label={t("web.channel.settings")}
          disabled={!props.channel}
          onPress={() => settings.set(true)}
        />
      </View>
      <Tabs
        look="line"
        label={t("web.channel.inChannel")}
        value={tab()}
        onChange={tab.set}
        items={(props.channel?.type === "direct" ? tabs.filter((entry) => entry.tab === "chat") : tabs).map((e) => ({
          value: e.tab,
          label: e.label,
          icon: e.icon,
        }))}
        class="shrink-0 border-b border-line px-3"
      />
      <If when={tab() === "chat"}>
        <View class="min-h-0 flex-1 flex-row">
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
          <If when={md() && membersOpen() ? props.channel : undefined}>{(c) => <Members channel={c()} />}</If>
        </View>
      </If>
      <If when={props.channel}>
        {(c) => (
          <>
            <If when={tab() === "issues"}>
              <Sessions channel={c()} />
            </If>
            <If when={tab() === "crons"}>
              <Crons channel={c()} />
            </If>
            <ChannelSettingsDialog channel={c()} open={settings()} onClose={() => settings.set(false)} onGone={() => router.navigate("/chat")} />
          </>
        )}
      </If>
    </View>
  );
}
