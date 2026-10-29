import { Tabs } from "../../ui/Tabs";
import { t } from "@vibevalley/i18n";
import { tookText } from "../../base/format";
import { Splitter, usePaneWidth } from "../../ui/Splitter";
import type { IconName } from "../../ui/icons";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Channel, type ChatMessage, type MessageHit, defaultOrchestrator, type OrchestratorState, ownerId, type Session } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import {
  archivedOf,
  groupsOf,
  messagePath,
  pointedAt,
  threadsIn,
  channelLabel,
  channelName,
  directsOf,
  topOf,
  topsOf,
  chatPath,
  channelOf,
  jobThreadOf,
  phaseDot,
  phaseText,
  threadOwnerOf,
  threadTitle,
  unreadIn,
  unreadUnder,
  defaultOf,
  workbenchClock,
} from "./rules";
import { aria, autofocus, Keyed, useNow } from "../../base/util";
import { useRouter } from "../../base/router";
import { orchestratorMood, useCore } from "../../base/frame";
import { OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { Count, Dot, HelperFace, PhaseGlyph, ThinkingDots } from "./bits";
import { Composer, FileDrop } from "./Composer";
import { switcher } from "./QuickSwitcher";
import { ChannelSettingsDialog, NewChannelDialog, notifyOptions } from "./Dialogs";
import { ready, useAgents } from "../../base/query";
import { useAgent, useOrchestrators } from "../../base/agents";
import { toast } from "../../ui/toasts";
import { Dialog } from "../../ui/Dialog";
import { Select } from "../../ui/Field";
import { MessageList } from "./MessageList";
import { Jobs, Crons } from "./Tabs";

const head = "flex h-[66px] shrink-0 items-center border-b border-line";

const iconButton =
  "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-hover disabled:cursor-default disabled:opacity-50";

/** /chat is the general; /chat/<id> a channel, or a thread shown beside its channel. */
export function ChatPage() {
  return <Chat />;
}

function Chat() {
  const router = useRouter();
  const core = useCore();
  const id = () =>
    decodeURIComponent(
      router
        .path()
        .split("?")[0]!
        .replace(/^\/chat\/?/, ""),
    ) || undefined;
  const chat = () => core()?.chat;
  const shown = createMemo(() => channelOf(chat(), id()));
  const channel = createMemo(() => topOf(chat(), shown()) ?? topsOf(chat())[0]);
  const thread = createMemo(() => (shown()?.type === "thread" ? shown() : undefined));
  const threadWidth = usePaneWidth("thread", 416, 320, 720);
  const [drawer, setDrawer] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  const [searching, setSearching] = createSignal(false);
  // A message's address (?m=) lights it up in the pane it is in: the thread's, or the channel's.
  const point = () => pointedAt(router.path());

  const sidebar = () => (
    <Sidebar channel={channel()} thread={thread()} onNew={() => setCreating(true)} onSearch={() => setSearching(true)} onPick={() => setDrawer(false)} />
  );
  return (
    <div class="relative flex h-full overflow-hidden">
      <div class="hidden w-72 shrink-0 md:flex">{sidebar()}</div>
      <Show when={drawer()}>
        <div class="absolute inset-0 z-30 md:hidden">
          <div class="absolute inset-0 bg-scrim" onClick={() => setDrawer(false)} />
          <div class="absolute inset-y-0 left-0 flex w-72 shadow-float transition-transform duration-280 starting:-translate-x-full">{sidebar()}</div>
        </div>
      </Show>
      {/* Only once the chat is in: keyed before it, the channel's arrival would start a tab picked meanwhile over. */}
      <Show when={chat()}>
        <Keyed key={channel()?.id ?? ""}>
          {() => <ChannelMain channel={channel()} point={thread() ? undefined : point()} onDrawer={() => setDrawer(!drawer())} />}
        </Keyed>
      </Show>
      <Show when={thread()}>
        {(shown) => (
          <div
            class="absolute inset-0 z-20 flex border-l border-line bg-page transition-transform duration-180 starting:translate-x-full lg:relative lg:z-auto lg:w-(--pane-w) lg:shrink-0"
            style={{ "--pane-w": `${threadWidth()}px` }}
          >
            <div class="hidden lg:block">
              <Splitter pane="thread" side="left" width={threadWidth()} min={320} max={720} label={t("web.channel.threadWidth")} />
            </div>
            <Keyed key={shown().id}>{() => <ThreadPane thread={shown()} point={point()} onClose={() => router.navigate(chatPath(channel()))} />}</Keyed>
          </div>
        )}
      </Show>
      <NewChannelDialog open={creating()} onClose={() => setCreating(false)} onCreated={(newId) => router.navigate(`/chat/${newId}`)} />
      <FarmSearch open={searching()} onClose={() => setSearching(false)} />
    </div>
  );
}

type Tab = "chat" | "jobs" | "crons";

const tabs: { tab: Tab; icon: IconName; label: string }[] = [
  { tab: "chat", icon: "chat", label: t("web.channel.tab.chat") },
  { tab: "jobs", icon: "issues", label: t("web.channel.tab.jobs") },
  { tab: "crons", icon: "clock", label: t("web.channel.tab.crons") },
];

/** Built again for each channel (Keyed): its tab and search start over in another one. */
function ChannelMain(props: { channel: Channel | undefined; point: number | undefined; onDrawer: () => void }) {
  const router = useRouter();
  const [tab, setTab] = createSignal<Tab>("chat");
  const [threadsOpen, setThreadsOpen] = createSignal(false);
  const [search, setSearch] = createSignal<string>();
  const [settings, setSettings] = createSignal(false);
  const [pinsOpen, setPinsOpen] = createSignal(false);
  const [membersOpen, setMembersOpen] = createSignal(false);
  const name = () => channelName(props.channel);
  const about = () =>
    [props.channel?.description, props.channel?.project ? t("web.channel.defaultProject", { project: props.channel.project }) : ""].filter(Boolean).join(" · ");
  return (
    <section class="flex min-w-0 flex-1 flex-col" aria-label={channelLabel(props.channel)}>
      <header data-testid="channel-head" data-key={props.channel?.id} class={[head, "gap-3 px-4"]}>
        <button type="button" class={[iconButton, "md:hidden"]} aria-label={t("web.channel.channels")} onClick={() => props.onDrawer()}>
          <Icon name="chat" size={20} />
        </button>
        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-wheat text-lg font-semibold">{markOf(props.channel)}</span>
        <div class="flex min-w-0 flex-1 flex-col">
          <h1 class="truncate text-lg font-semibold" title={props.channel?.default ? t("web.channel.defaultHint") : undefined}>
            {name()}
          </h1>
          <Show when={about()}>
            <p class="truncate text-xs text-muted">{about()}</p>
          </Show>
        </div>
        <Show when={search() !== undefined}>
          <label class="flex h-8 w-48 items-center gap-1.5 rounded-md border border-line px-2 focus-within:border-focus">
            <Icon name="search" size={14} />
            <input
              ref={autofocus()}
              data-testid="message-search"
              value={search() ?? ""}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && setSearch(undefined)}
              placeholder={t("web.channel.findHint")}
              aria-label={t("web.channel.find")}
              class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
        </Show>
        <button
          type="button"
          class={[iconButton, { "bg-selected": search() !== undefined }]}
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
            <div class="relative">
              <button
                type="button"
                class={[iconButton, { "bg-selected": threadsOpen() }]}
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
        <div class="relative">
          <button
            type="button"
            class={[iconButton, { "bg-selected": pinsOpen() }]}
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
          class={[iconButton, "w-auto px-2 text-sm max-md:hidden", { "bg-selected": membersOpen() }]}
          data-testid="members-toggle"
          aria-pressed={aria(membersOpen())}
          disabled={!props.channel}
          onClick={() => setMembersOpen(!membersOpen())}
        >
          {t("web.channel.members.open")}
        </button>
        <button
          type="button"
          class={iconButton}
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
        class="shrink-0 border-b border-line px-3"
      />
      <Show when={tab() === "chat"}>
        <div class="flex min-h-0 flex-1">
          <FileDrop channel={props.channel}>
            <MessageList
              channel={props.channel}
              filter={search()}
              point={props.point}
              emptyText={t("web.channel.empty", { label: channelLabel(props.channel) })}
            />
            <Composer channel={props.channel} placeholder={t("web.channel.sendTo", { label: channelLabel(props.channel) })} />
          </FileDrop>
          <Show when={membersOpen() ? props.channel : undefined}>{(c) => <Members channel={c()} />}</Show>
        </div>
      </Show>
      <Show when={props.channel}>
        {(c) => (
          <>
            <Show when={tab() === "jobs"}>
              <Jobs channel={c()} />
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

function Sidebar(props: { channel: Channel | undefined; thread: Channel | undefined; onNew: () => void; onSearch: () => void; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const chat = () => core()?.chat;
  const channels = () => topsOf(chat());
  const archived = () => archivedOf(chat());
  const sessions = () => core()?.sessions ?? [];
  const [picking, setPicking] = createSignal(false);
  const [dragged, setDragged] = createSignal<string>();
  const go = (c: Channel) => {
    router.navigate(chatPath(c));
    props.onPick();
  };
  // Dropped on a channel: placed before it, in its group.
  const drop = (onto: Channel) => {
    const id = dragged();
    setDragged(undefined);
    if (!id || id === onto.id || onto.default || onto.type !== "channel") return;
    api.channel.update({ id, before: onto.id, category: onto.category ?? "" }).catch((e) => toast(reasonOf(e), "bad"));
  };
  const row = (c: Channel) => (
    <ChannelRow
      channel={c}
      here={c.id === props.channel?.id}
      unread={unreadUnder(chat(), c)}
      onClick={() => go(c)}
      movable={c.type === "channel" && !c.default}
      onDragStart={() => setDragged(c.id)}
      onDragEnd={() => setDragged(undefined)}
      onDrop={() => drop(c)}
    />
  );
  return (
    <aside aria-label={t("web.channel.side")} data-testid="channels-side" class="flex w-full flex-col border-r border-line bg-side">
      <div class={[head, "gap-2 px-5"]}>
        <span class="flex-1 text-xl font-semibold">{t("web.channel.tab.chat")}</span>
        <button
          type="button"
          class={iconButton}
          data-testid="farm-search-open"
          aria-label={t("web.channel.farmSearch.open")}
          title={t("web.channel.farmSearch.open")}
          onClick={() => props.onSearch()}
        >
          <Icon name="search" size={16} />
        </button>
      </div>
      <div class="scroll-fade-y flex-1 overflow-y-auto p-3">
        <button
          type="button"
          data-testid="switcher-open"
          onClick={() => switcher.show()}
          class="mb-3 flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-line bg-page px-2.5 text-left text-sm text-muted hover:bg-hover"
        >
          <span class="flex-1">{t("web.channel.switcher.open")}</span>
          <span class="text-xs text-faint">{t("web.channel.switcher.keys", { mac: /Mac|iPhone|iPad/.test(navigator.userAgent) })}</span>
        </button>
        <Section
          item="channels"
          title={t("web.channel.channelsTitle")}
          count={Math.max(1, channels().length)}
          action={
            <button
              type="button"
              class={[iconButton, "size-6"]}
              data-testid="new-channel"
              aria-label={t("web.channel.newChannel")}
              title={t("web.channel.newChannel")}
              onClick={() => props.onNew()}
            >
              <Icon name="add" size={14} />
            </button>
          }
        >
          <For each={groupsOf(channels())}>
            {(g) => (
              <Show when={g.category} fallback={<For each={g.channels}>{row}</For>}>
                {(name) => (
                  <Section title={name()} item={`category:${name()}`} count={g.channels.length} nested>
                    <For each={g.channels}>{row}</For>
                  </Section>
                )}
              </Show>
            )}
          </For>
        </Section>
        <Section
          item="directs"
          title={t("web.channel.directsTitle")}
          count={directsOf(chat()).length}
          action={
            <div class="relative">
              <button
                type="button"
                class={[iconButton, "size-6"]}
                data-testid="new-direct"
                aria-label={t("web.channel.direct.add")}
                title={t("web.channel.direct.add")}
                aria-expanded={aria(picking())}
                onClick={() => setPicking(!picking())}
              >
                <Icon name="add" size={14} />
              </button>
              <Show when={picking()}>
                <DirectPicker
                  onPicked={(id) => {
                    setPicking(false);
                    router.navigate(`/chat/${id}`);
                    props.onPick();
                  }}
                />
              </Show>
            </div>
          }
        >
          <For each={directsOf(chat())}>{row}</For>
        </Section>
        <Section title={t("web.channel.helpers")} item="helpers" count={sessions().length}>
          <Show when={sessions().length === 0}>
            <p class="px-3 text-xs text-muted">{t("web.channel.noHelpers")}</p>
          </Show>
          <For each={sessions()}>{(h) => <SessionRow h={h} active={!!props.thread && jobThreadOf(chat(), h)?.id === props.thread.id} onShow={go} />}</For>
        </Section>
        <Show when={archived().length > 0}>
          <Section title={t("web.channel.manage.archivedTitle")} item="archived" count={archived().length} closed>
            <For each={archived()}>{row}</For>
          </Section>
        </Show>
      </div>
      <OrchestratorLine agent={(props.thread ?? props.channel)?.orchestrator ?? defaultOrchestrator} />
    </aside>
  );
}

/** The profiles the owner can talk with alone, the orchestrators first: picking one opens its direct channel, made the
 * first time. */
function DirectPicker(props: { onPicked: (channel: string) => void }) {
  const all = useAgents();
  const agents = () => [...ready(all, [])].sort((a, b) => (a.role === b.role ? 0 : a.role === "orchestrator" ? -1 : 1));
  const open = (agent: string) =>
    api.channel.direct
      .create({ agent })
      .then((id) => props.onPicked(id))
      .catch((e) => toast(reasonOf(e), "bad"));
  return (
    <div
      role="menu"
      data-testid="direct-picker"
      aria-label={t("web.channel.direct.pick")}
      class="absolute top-full right-0 z-30 mt-1 flex max-h-80 w-56 origin-top-right animate-pop-in flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-page p-1 shadow-float"
    >
      <p class="px-2 py-1 text-xs font-semibold text-muted">{t("web.channel.direct.pick")}</p>
      <Show when={!all.isPending && agents().length === 0}>
        <p class="px-2 py-1 text-sm text-muted">{t("web.channel.direct.none")}</p>
      </Show>
      <For each={agents()} keyed={(a) => a.id}>
        {(a) => (
          <button
            type="button"
            role="menuitem"
            data-key={a().id}
            class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-hover"
            onClick={() => void open(a().id)}
          >
            <Show when={a().role === "orchestrator"} fallback={<HelperFace agent={a().id} runtime={a().runtime} size={20} />}>
              <OrchestratorFace size={20} agent={a().id} />
            </Show>
            <span class="min-w-0 flex-1 truncate">{a().name}</span>
          </button>
        )}
      </For>
    </div>
  );
}

function Section(props: { title: string; item: string; count: number; action?: JSX.Element; nested?: boolean; closed?: boolean; children: JSX.Element }) {
  const [open, setOpen] = createSignal(untrack(() => !props.closed));
  return (
    <section class={props.nested ? "mt-1 mb-1" : "mb-4"} aria-label={props.title} data-testid="side-section" data-key={props.item}>
      <div class="flex items-center px-1 pb-1">
        <button
          type="button"
          data-testid="side-section-toggle"
          aria-expanded={aria(open())}
          onClick={() => setOpen(!open())}
          class="flex flex-1 cursor-pointer items-center gap-1 text-left"
        >
          <Icon name="expand" size={10} class={["opacity-60 transition-transform duration-120", { "rotate-90": open() }]} />
          <span class="text-xs font-semibold text-muted">{props.title}</span>
          <span class="text-xs text-faint">{props.count}</span>
        </button>
        {props.action}
      </div>
      <Show when={open()}>
        <div class="flex flex-col gap-0.5">{props.children}</div>
      </Show>
    </section>
  );
}

const markOf = (c: Channel | undefined) => (c?.type === "direct" ? "@" : "#");

function ChannelRow(props: {
  channel: Channel;
  here: boolean;
  unread: number;
  onClick?: () => void;
  movable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDrop?: () => void;
}) {
  const [over, setOver] = createSignal(false);
  const quiet = () => props.channel.notify === "none";
  return (
    <button
      type="button"
      data-testid="channel-row"
      data-key={props.channel.id}
      data-type={props.channel.type}
      data-unread={props.unread}
      data-notify={props.channel.notify ?? "all"}
      onClick={() => props.onClick?.()}
      aria-current={props.here ? "page" : undefined}
      draggable={props.movable ? "true" : "false"}
      title={props.movable ? t("web.channel.manage.drag") : undefined}
      onDragStart={(e) => {
        e.dataTransfer?.setData("text/plain", props.channel.id);
        untrack(() => props.onDragStart)?.();
      }}
      onDragEnd={() => untrack(() => props.onDragEnd)?.()}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        untrack(() => props.onDrop)?.();
      }}
      class={[
        "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm",
        props.here ? "bg-selected" : "hover:bg-hover",
        { "shadow-[inset_0_2px_0_var(--color-accent)]": over() },
      ]}
    >
      <span class="text-faint" aria-hidden="true">
        {markOf(props.channel)}
      </span>
      <span class={["min-w-0 flex-1 truncate", { "font-semibold": props.here || props.unread > 0, "text-muted": quiet() && !props.here }]}>
        {channelName(props.channel)}
      </span>
      <Show when={props.channel.notify && props.channel.notify !== "all"}>
        <span class="text-xs text-faint">{props.channel.notify === "none" ? t("web.channel.manage.muted") : t("web.channel.manage.mentionsOnly")}</span>
      </Show>
      <Show when={props.unread > 0}>
        <Count n={props.unread} />
      </Show>
    </button>
  );
}

function SessionRow(props: { h: Session; active: boolean; onShow: (c: Channel) => void }) {
  const core = useCore();
  const now = useNow();
  const thread = () => jobThreadOf(core()?.chat, props.h);
  const unread = () => {
    const current = thread();
    return current ? unreadIn(current) : 0;
  };
  const phase = () => phaseText(props.h, now());
  return (
    <button
      type="button"
      disabled={!thread()}
      onClick={() => {
        const current = thread();
        if (current) props.onShow(current);
      }}
      title={phase()}
      class={["flex items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm enabled:cursor-pointer", props.active ? "bg-selected" : "hover:bg-hover"]}
    >
      <span class="relative shrink-0">
        <HelperFace agent={props.h.agent} runtime={props.h.runtime} size={24} />
        <Dot tone={phaseDot(props.h.phase)} class="absolute -right-0.5 -bottom-0.5" />
      </span>
      <span class="shrink-0">{props.h.name}</span>
      <PhaseGlyph phase={props.h.phase} />
      <span class="min-w-0 flex-1 truncate text-xs text-muted">{phase()}</span>
      <Show when={unread() > 0}>
        <Count n={unread()} />
      </Show>
    </button>
  );
}

const mood: Record<OrchestratorState, string> = {
  idle: t("web.channel.mood.idle"),
  listening: t("web.channel.mood.listening"),
  thinking: t("web.channel.mood.thinking"),
  speaking: t("web.channel.mood.speaking"),
};

/** Newest pinned first. */
function Pins(props: { channel: Channel; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const [pinned, setPinned] = createSignal<readonly ChatMessage[] | undefined>();
  createEffect(
    () => props.channel.id,
    (id) => void api.channel.pin.list({ id }).then(setPinned, () => setPinned([])),
  );
  return (
    <div
      role="dialog"
      data-testid="pins"
      aria-label={t("web.channel.pins.title")}
      class="absolute top-full right-0 z-30 mt-1 flex max-h-96 w-80 origin-top-right animate-pop-in flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-page p-2 shadow-float"
    >
      <p class="px-1 text-xs font-semibold text-muted">{t("web.channel.pins.title")}</p>
      <Show when={pinned()?.length === 0}>
        <p class="px-1 py-2 text-sm text-muted">{t("web.channel.pins.none")}</p>
      </Show>
      <For each={pinned() ?? []} keyed={(m) => m.id}>
        {(m) => (
          <button
            type="button"
            data-testid="pin"
            data-key={m().id}
            class="cursor-pointer rounded-md px-2 py-1.5 text-left hover:bg-hover"
            onClick={() => {
              router.navigate(messagePath(channelOf(core()?.chat, m().channel), m().number));
              untrack(() => props.onPick)();
            }}
          >
            <span class="flex items-baseline gap-2 text-xs">
              <span class="font-semibold">{m().from === ownerId ? t("web.channel.messages.owner") : m().name}</span>
              <span class="text-muted">{workbenchClock(m().at)}</span>
            </span>
            <span class="line-clamp-3 block text-sm">{m().text}</span>
          </button>
        )}
      </For>
    </div>
  );
}

function Members(props: { channel: Channel }) {
  const core = useCore();
  const router = useRouter();
  const now = useNow();
  const orchestrators = useOrchestrators();
  const here = () => props.channel.orchestrator ?? defaultOrchestrator;
  const nameOf = (id: string) => orchestrators().find((a) => a.id === id)?.name || t("web.channel.orchestrator");
  const helpers = () => {
    if (props.channel.type === "direct") return [];
    const fallback = defaultOf(core()?.chat)?.id;
    return (core()?.sessions ?? []).filter((h) => (h.channel ?? fallback) === props.channel.id);
  };
  return (
    <aside
      aria-label={t("web.channel.members.title")}
      data-testid="members"
      class="hidden w-60 shrink-0 flex-col gap-1 overflow-y-auto border-l border-line bg-side p-3 md:flex"
    >
      <p class="px-1 pb-1 text-xs font-semibold text-muted">{t("web.channel.members.title")}</p>
      <div class="flex items-center gap-2 px-1 py-1 text-sm">
        <span class="flex size-7 items-center justify-center rounded-full bg-wheat text-xs font-semibold">{t("web.channel.members.owner").slice(0, 1)}</span>
        {t("web.channel.members.owner")}
      </div>
      <div data-testid="member-orchestrator" data-key={here()} class="flex items-center gap-2 px-1 py-1 text-sm">
        <OrchestratorFace size={28} agent={here()} />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="truncate">{nameOf(here())}</span>
          <span class="truncate text-xs text-muted">{t("web.channel.members.looksAfter")}</span>
        </span>
        <span class="text-xs text-muted">{mood[orchestratorMood(core(), here())]}</span>
      </div>
      <For each={helpers()} keyed={(h) => h.id}>
        {(h) => (
          <div class="flex items-center gap-2 px-1 py-1 text-sm">
            <HelperFace agent={h().agent} runtime={h().runtime} size={28} />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">{h().name}</span>
              <span class="truncate text-xs text-muted">{phaseText(h(), now())}</span>
            </span>
            <PhaseGlyph phase={h().phase} />
            <button
              type="button"
              class={[iconButton, "size-6"]}
              aria-label={t("web.channel.direct.open", { name: h().name })}
              title={t("web.channel.direct.open", { name: h().name })}
              onClick={() =>
                void api.channel.direct
                  .create({ agent: h().agent })
                  .then((id) => router.navigate(`/chat/${id}`))
                  .catch((e) => toast(reasonOf(e), "bad"))
              }
            >
              <Icon name="thread" size={14} />
            </button>
          </div>
        )}
      </For>
      <Show when={props.channel.type !== "direct" && helpers().length === 0}>
        <p class="px-1 pt-1 text-xs text-muted">{t("web.channel.members.none")}</p>
      </Show>
    </aside>
  );
}

/** The orchestrator that looks after the place open, and what it is doing. */
function OrchestratorLine(props: { agent: string }) {
  const core = useCore();
  const profile = useAgent(() => props.agent);
  const now = (): OrchestratorState => orchestratorMood(core(), props.agent);
  const clock = useNow();
  const since = () => core()?.orchestrators?.[props.agent]?.since;
  return (
    <div
      data-testid="channel-orchestrator-line"
      data-key={props.agent}
      data-state={now()}
      class="flex items-center gap-2 border-t border-line px-4 py-3 text-sm"
      aria-label={t("web.channel.orchestrator")}
    >
      <OrchestratorFace size={32} agent={props.agent} />
      {profile()?.name || t("web.channel.orchestrator")}
      <Dot tone={now() === "idle" ? "idle" : now() === "thinking" ? "wheat" : "leaf"} size={8} class="ml-1" />
      <span class="text-xs text-muted">{mood[now()]}</span>
      <Show when={since()}>{(at) => <span class="text-xs text-faint">{tookText(Math.max(0, clock() - at()))}</span>}</Show>
      <Show when={now() === "thinking"}>
        <ThinkingDots />
      </Show>
    </div>
  );
}

function ThreadPane(props: { thread: Channel; point: number | undefined; onClose: () => void }) {
  const core = useCore();
  const now = useNow();
  const sessions = () => core()?.sessions ?? [];
  const session = () => threadOwnerOf(props.thread, sessions());
  const status = () => {
    const s = session();
    return s
      ? `@${s.id} · ${phaseText(s, now())}`
      : props.thread.subjectKind === "issue"
        ? t("web.channel.nobodyOnIt")
        : t("web.channel.replies", { n: props.thread.replies });
  };
  return (
    <section aria-label={t("web.channel.thread")} class="flex min-w-0 flex-1 flex-col">
      <header class={[head, "gap-2.5 px-4"]}>
        <span class="flex size-8 shrink-0 items-center justify-center">
          <Show when={session()} fallback={<Icon name="thread" size={16} />}>
            {(s) => <HelperFace agent={s().agent} runtime={s().runtime} size={32} />}
          </Show>
        </span>
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-semibold">{threadTitle(props.thread, core()?.issues ?? [], sessions())}</span>
          <span class="flex items-center gap-1 text-xs text-muted">
            <Show when={session()}>{(s) => <PhaseGlyph phase={s().phase} />}</Show>
            <span class="truncate">{status()}</span>
          </span>
        </div>
        <Select
          label={t("web.channel.threadList.notify")}
          value={props.thread.notify ?? "all"}
          options={notifyOptions()}
          class="w-28 text-xs"
          onChange={(v) => {
            if (v === "all" || v === "mentions" || v === "none")
              api.channel.notify.set({ id: props.thread.id, notify: v }).catch((e) => toast(reasonOf(e), "bad"));
          }}
        />
        <button type="button" class={iconButton} aria-label={t("web.channel.closeThread")} title={t("web.channel.closeThread")} onClick={() => props.onClose()}>
          <Icon name="close" size={16} />
        </button>
      </header>
      <FileDrop channel={props.thread}>
        <MessageList channel={props.thread} point={props.point} emptyText={t("web.channel.threadEmpty")} />
        <Composer channel={props.thread} placeholder={session() ? t("web.channel.sayInThread", { name: session()!.name }) : t("web.channel.reply")} />
      </FileDrop>
    </section>
  );
}

/** A channel's threads, the newest talked in first, each renamed or archived in place; the archived ones below. */
function ThreadList(props: { channel: Channel; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const [showArchived, setShowArchived] = createSignal(false);
  const live = () => threadsIn(core()?.chat, props.channel);
  const archived = () => threadsIn(core()?.chat, props.channel, true);
  const title = (channel: Channel) => threadTitle(channel, core()?.issues ?? [], core()?.sessions ?? []);
  const item = (channel: Channel) => (
    <ThreadItem thread={channel} title={title(channel)} onOpen={() => (router.navigate(chatPath(channel)), untrack(() => props.onPick)())} />
  );
  return (
    <div
      role="dialog"
      data-testid="thread-list"
      aria-label={t("web.channel.threadList.title")}
      class="absolute top-full right-0 z-30 mt-1 flex max-h-[28rem] w-96 origin-top-right animate-pop-in flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-page p-2 shadow-float"
    >
      <p class="px-1 pb-1 text-xs font-semibold text-muted">{t("web.channel.threadList.title")}</p>
      <Show when={live().length === 0}>
        <p data-testid="threads-empty" class="px-1 py-2 text-sm text-muted">
          {t("web.channel.threadList.none")}
        </p>
      </Show>
      <For each={live()}>{item}</For>
      <Show when={archived().length > 0}>
        <button
          type="button"
          data-testid="threads-archived"
          aria-expanded={aria(showArchived())}
          class="mt-1 flex cursor-pointer items-center gap-1 px-1 text-left text-xs text-muted hover:text-ink"
          onClick={() => setShowArchived(!showArchived())}
        >
          <Icon name="expand" size={10} class={["opacity-60 transition-transform", { "rotate-90": showArchived() }]} />
          {t("web.channel.threadList.archived", { n: archived().length })}
        </button>
        <Show when={showArchived()}>
          <For each={archived()}>{item}</For>
        </Show>
      </Show>
    </div>
  );
}

function ThreadItem(props: { thread: Channel; title: string; onOpen: () => void }) {
  const [renaming, setRenaming] = createSignal(false);
  const [name, setName] = createSignal("");
  const run = (call: () => Promise<unknown>) => void call().catch((e) => toast(reasonOf(e), "bad"));
  const save = () => {
    setRenaming(false);
    const next = name().trim();
    const id = untrack(() => props.thread.id);
    if (next !== untrack(() => props.title)) run(() => api.channel.update({ id, name: next }));
  };
  return (
    <div
      data-testid="thread"
      data-key={props.thread.id}
      data-archived={props.thread.archived !== undefined ? "" : undefined}
      class="group/t flex items-center gap-1 rounded-md px-1 hover:bg-hover"
    >
      <Show
        when={renaming()}
        fallback={
          <button type="button" class="flex min-w-0 flex-1 cursor-pointer flex-col py-1.5 pl-1 text-left" onClick={() => props.onOpen()}>
            <span class="flex items-center gap-1.5 text-sm">
              <Icon name="thread" size={14} />
              <span class="min-w-0 flex-1 truncate font-medium">{props.title}</span>
              <span class="shrink-0 text-xs text-muted">{t("web.channel.replies", { n: props.thread.replies })}</span>
            </span>
            <Show when={props.thread.last}>
              {(m) => (
                <span class="truncate text-xs text-muted">
                  {t("shared.join.labeled", { label: m().from === ownerId ? t("web.channel.messages.owner") : m().name, text: m().text })}
                </span>
              )}
            </Show>
          </button>
        }
      >
        <input
          ref={autofocus()}
          data-testid="thread-name"
          value={name()}
          aria-label={t("web.channel.threadList.rename", { title: props.title })}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.isComposing) return;
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              e.stopPropagation();
              setRenaming(false);
            }
          }}
          onBlur={save}
          class="my-1 min-w-0 flex-1 rounded border border-focus bg-page px-2 py-1 text-sm outline-none"
        />
      </Show>
      <button
        type="button"
        class={[iconButton, "size-7 opacity-0 group-hover/t:opacity-100 focus-visible:opacity-100"]}
        data-testid="thread-rename"
        aria-label={t("web.channel.threadList.rename", { title: props.title })}
        title={t("web.channel.threadList.rename", { title: props.title })}
        onClick={() => {
          setName(props.thread.name ?? props.title);
          setRenaming(true);
        }}
      >
        <Icon name="edit" size={14} />
      </button>
      <button
        type="button"
        class={[iconButton, "size-7 opacity-0 group-hover/t:opacity-100 focus-visible:opacity-100"]}
        data-testid="thread-archive"
        aria-label={
          props.thread.archived !== undefined
            ? t("web.channel.threadList.unarchive", { title: props.title })
            : t("web.channel.threadList.archive", { title: props.title })
        }
        title={
          props.thread.archived !== undefined
            ? t("web.channel.threadList.unarchive", { title: props.title })
            : t("web.channel.threadList.archive", { title: props.title })
        }
        onClick={() => run(() => api.channel.archive.toggle({ id: props.thread.id }))}
      >
        <Icon name="archive" size={14} />
      </button>
    </div>
  );
}

/** Every channel and thread searched at once, the server reading the filters; a hit opens where it is. */
function FarmSearch(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={props.open} onClose={() => props.onClose()} title={t("web.channel.farmSearch.title")} wide testid="farm-search">
      <FarmSearchBody onClose={() => props.onClose()} />
    </Dialog>
  );
}

function FarmSearchBody(props: { onClose: () => void }) {
  const core = useCore();
  const router = useRouter();
  const [text, setText] = createSignal("");
  const [hits, setHits] = createSignal<readonly MessageHit[] | undefined>([]);
  createEffect(
    () => text().trim(),
    (q) => {
      if (!q) return void setHits([]);
      setHits(undefined);
      const wait = setTimeout(() => void api.channel.message.search({ text: q }).then(setHits, () => setHits([])), 200);
      return () => clearTimeout(wait);
    },
  );
  return (
    <div class="flex flex-col gap-3">
      <label class="flex h-9 items-center gap-2 rounded-md border border-line px-2 focus-within:border-focus">
        <Icon name="search" size={16} />
        <input
          ref={autofocus()}
          data-testid="farm-search-input"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          placeholder={t("web.channel.farmSearch.hint")}
          aria-label={t("web.channel.farmSearch.title")}
          class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
      </label>
      <p class="text-xs text-faint">{t("web.channel.farmSearch.filters")}</p>
      <Show when={hits() === undefined}>
        <p class="text-sm text-muted">{t("web.channel.farmSearch.searching")}</p>
      </Show>
      <Show when={hits()?.length === 0 && text().trim() !== ""}>
        <p class="text-sm text-muted">{t("web.channel.farmSearch.none")}</p>
      </Show>
      <div role="list" aria-label={t("web.channel.messages.label")} class="flex flex-col gap-0.5">
        <For each={hits() ?? []} keyed={(h) => h.message.id}>
          {(h) => (
            <button
              type="button"
              role="listitem"
              data-testid="search-hit"
              data-key={h().message.id}
              class="flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-hover"
              onClick={() => {
                router.navigate(messagePath(channelOf(core()?.chat, h().message.channel), h().message.number));
                untrack(() => props.onClose)();
              }}
            >
              <span class="flex items-baseline gap-2 text-xs">
                <span class="font-semibold text-accent">{h().address}</span>
                <span class="font-semibold">{h().message.from === ownerId ? t("web.channel.messages.owner") : h().message.name}</span>
                <span class="text-muted">{workbenchClock(h().message.at)}</span>
              </span>
              <span class="line-clamp-2 text-sm">{h().message.text}</span>
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
