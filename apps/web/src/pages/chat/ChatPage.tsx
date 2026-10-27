import { chatWording } from "./words";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Conversation, type OrchestratorState, type Session } from "@vibevalley/protocol";
import { wording } from "@vibevalley/protocol/words";
import {
  channelName,
  channelOf,
  channelsOf,
  chatPath,
  conversationOf,
  jobThreadOf,
  phaseDot,
  phaseText,
  threadOwnerOf,
  threadTitle,
  unreadIn,
  unreadUnder,
} from "../../rules/chat";
import { aria, autofocus, Keyed, useNow } from "../../base/util";
import { useRouter } from "../../base/router";
import { useCore } from "../../base/frame";
import { OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { Count, Dot, HelperFace, PhaseGlyph, ThinkingDots } from "./bits";
import { Composer } from "./Composer";
import { ChannelSettingsDialog, NewChannelDialog } from "./Dialogs";
import { MessageList } from "./MessageList";
import { Jobs, Recurrences } from "./Tabs";

const head = "flex h-[66px] shrink-0 items-center border-b border-line";

const iconButton =
  "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-hover disabled:cursor-default disabled:opacity-40";

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
  const shown = createMemo(() => conversationOf(chat(), id()));
  const channel = createMemo(() => channelOf(chat(), shown()) ?? channelsOf(chat())[0]);
  const thread = createMemo(() => (shown()?.kind === "thread" ? shown() : undefined));
  const [drawer, setDrawer] = createSignal(false);
  const [creating, setCreating] = createSignal(false);

  const sidebar = () => <Sidebar channel={channel()} thread={thread()} onNew={() => setCreating(true)} onPick={() => setDrawer(false)} />;
  return (
    <div class="relative flex h-full overflow-hidden">
      <div class="hidden w-72 shrink-0 md:flex">{sidebar()}</div>
      <Show when={drawer()}>
        <div class="absolute inset-0 z-30 md:hidden">
          <div class="absolute inset-0 bg-[#2f1f1340]" onClick={() => setDrawer(false)} />
          <div class="absolute inset-y-0 left-0 flex w-72 shadow-float transition-transform duration-180 ease-out starting:-translate-x-full">{sidebar()}</div>
        </div>
      </Show>
      {/* Only once the chat is in: keyed before it, the channel's arrival would start a tab picked meanwhile over. */}
      <Show when={chat()}>
        <Keyed key={channel()?.id ?? ""}>{() => <ChannelMain channel={channel()} onDrawer={() => setDrawer(!drawer())} />}</Keyed>
      </Show>
      <Show when={thread()}>
        {(t) => (
          <div class="absolute inset-0 z-20 flex border-l border-line bg-page transition-transform duration-180 ease-out starting:translate-x-full lg:static lg:z-auto lg:w-[416px] lg:shrink-0">
            <Keyed key={t().id}>{() => <ThreadPane thread={t()} onClose={() => router.navigate(chatPath(channel()))} />}</Keyed>
          </div>
        )}
      </Show>
      <NewChannelDialog open={creating()} onClose={() => setCreating(false)} onCreated={(newId) => router.navigate(`/chat/${newId}`)} />
    </div>
  );
}

type Tab = "chat" | "jobs" | "recurrences";

const tabs: { tab: Tab; icon: string; label: string }[] = [
  { tab: "chat", icon: "icon-board", label: chatWording().tab.chat },
  { tab: "jobs", icon: "icon-tasks", label: chatWording().tab.jobs },
  { tab: "recurrences", icon: "icon-clock", label: chatWording().tab.recurrences },
];

/** Built again for each channel (Keyed): its tab and search start over in another one. */
function ChannelMain(props: { channel: Conversation | undefined; onDrawer: () => void }) {
  const [tab, setTab] = createSignal<Tab>("chat");
  const [search, setSearch] = createSignal<string>();
  const [settings, setSettings] = createSignal(false);
  const name = () => channelName(props.channel);
  const about = () =>
    [props.channel?.description, props.channel?.project ? chatWording().defaultProject(props.channel.project) : ""].filter(Boolean).join(" · ");
  return (
    <section class="flex min-w-0 flex-1 flex-col" aria-label={`#${name()}`}>
      <header class={[head, "gap-3 px-4"]}>
        <button type="button" class={[iconButton, "md:hidden"]} aria-label={chatWording().channels} onClick={() => props.onDrawer()}>
          <Icon name="icon-board" size={18} />
        </button>
        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-wheat text-lg font-semibold">#</span>
        <div class="flex min-w-0 flex-1 flex-col">
          <h1 class="truncate text-lg font-semibold" title={props.channel?.kind === "general" ? chatWording().general : undefined}>
            {name()}
          </h1>
          <Show when={about()}>
            <p class="truncate text-xs text-muted">{about()}</p>
          </Show>
        </div>
        <Show when={search() !== undefined}>
          <label class="flex h-8 w-48 items-center gap-1.5 rounded-md border border-line px-2 focus-within:border-focus">
            <Icon name="button-search" size={14} />
            <input
              ref={autofocus()}
              value={search() ?? ""}
              onInput={(e) => setSearch(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && setSearch(undefined)}
              placeholder={chatWording().findHint}
              aria-label={chatWording().find}
              class="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
        </Show>
        <button
          type="button"
          class={[iconButton, { "bg-selected": search() !== undefined }]}
          aria-label={chatWording().findMessages}
          aria-pressed={aria(search() !== undefined)}
          title={chatWording().findMessages}
          onClick={() => {
            setSearch(search() === undefined ? "" : undefined);
            setTab("chat");
          }}
        >
          <Icon name="act-search" size={18} />
        </button>
        <button
          type="button"
          class={iconButton}
          aria-label={chatWording().settings}
          title={chatWording().settings}
          disabled={!props.channel}
          onClick={() => setSettings(true)}
        >
          <Icon name="icon-wrench" size={18} />
        </button>
      </header>
      <div role="tablist" aria-label={chatWording().inChannel} class="flex shrink-0 gap-1 border-b border-line px-3">
        <For each={tabs}>
          {(t) => (
            <button
              type="button"
              role="tab"
              aria-selected={aria(tab() === t.tab)}
              onClick={() => setTab(t.tab)}
              class={[
                "group -mb-px flex cursor-pointer items-center gap-1.5 border-b-2 px-2 pt-2 pb-1.5 text-sm",
                tab() === t.tab ? "border-ink font-semibold" : "border-transparent text-muted hover:text-ink",
              ]}
            >
              <Icon name={t.icon} size={16} class={tab() === t.tab ? "" : "opacity-70 group-hover:opacity-100"} />
              {t.label}
            </button>
          )}
        </For>
      </div>
      <Show when={tab() === "chat"}>
        <MessageList conversation={props.channel} filter={search()} emptyText={chatWording().empty(name())} />
        <Composer conversation={props.channel} placeholder={chatWording().sendTo(name())} />
      </Show>
      <Show when={props.channel}>
        {(c) => (
          <>
            <Show when={tab() === "jobs"}>
              <Jobs channel={c()} />
            </Show>
            <Show when={tab() === "recurrences"}>
              <Recurrences channel={c()} />
            </Show>
            <ChannelSettingsDialog channel={c()} open={settings()} onClose={() => setSettings(false)} />
          </>
        )}
      </Show>
    </section>
  );
}

function Sidebar(props: { channel: Conversation | undefined; thread: Conversation | undefined; onNew: () => void; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const chat = () => core()?.chat;
  const channels = () => channelsOf(chat());
  const sessions = () => core()?.sessions ?? [];
  const go = (c: Conversation) => {
    router.navigate(chatPath(c));
    props.onPick();
  };
  return (
    <aside aria-label={chatWording().side} class="flex w-full flex-col border-r border-line bg-side">
      <div class={[head, "px-5 text-xl font-semibold"]}>{chatWording().tab.chat}</div>
      <div class="flex-1 overflow-y-auto p-3">
        <Section
          title={chatWording().channelsTitle}
          count={Math.max(1, channels().length)}
          action={
            <button
              type="button"
              class={[iconButton, "size-6"]}
              aria-label={chatWording().newChannel}
              title={chatWording().newChannel}
              onClick={() => props.onNew()}
            >
              <Icon name="button-add" size={14} />
            </button>
          }
        >
          {/* Before the first frame the general is not there yet: it is still where you talk. */}
          <Show when={channels().length === 0}>
            <ChannelRow label={wording().general} here unread={0} />
          </Show>
          <For each={channels()}>
            {(c) => <ChannelRow label={channelName(c)} here={c.id === props.channel?.id} unread={unreadUnder(chat(), c)} onClick={() => go(c)} />}
          </For>
        </Section>
        <Section title={chatWording().helpers} count={sessions().length}>
          <Show when={sessions().length === 0}>
            <p class="px-3 text-xs text-muted">{chatWording().noHelpers}</p>
          </Show>
          <For each={sessions()}>{(h) => <SessionRow h={h} active={!!props.thread && jobThreadOf(chat(), h)?.id === props.thread.id} onShow={go} />}</For>
        </Section>
      </div>
      <OrchestratorLine mood={core()?.orchestrator ?? "idle"} />
    </aside>
  );
}

function Section(props: { title: string; count: number; action?: JSX.Element; children: JSX.Element }) {
  const [open, setOpen] = createSignal(true);
  return (
    <section class="mb-4" aria-label={props.title}>
      <div class="flex items-center px-1 pb-1">
        <button type="button" aria-expanded={aria(open())} onClick={() => setOpen(!open())} class="flex flex-1 cursor-pointer items-center gap-1 text-left">
          <Icon name="button-next" size={10} class={["opacity-60 transition-transform duration-150", { "rotate-90": open() }]} />
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

function ChannelRow(props: { label: string; here: boolean; unread: number; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={() => props.onClick?.()}
      aria-current={props.here ? "page" : undefined}
      class={["flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1 text-left text-sm", props.here ? "bg-selected" : "hover:bg-hover"]}
    >
      <span class="text-faint" aria-hidden="true">
        #
      </span>
      <span class={["min-w-0 flex-1 truncate", { "font-semibold": props.here || props.unread > 0 }]}>{props.label}</span>
      <Show when={props.unread > 0}>
        <Count n={props.unread} />
      </Show>
    </button>
  );
}

function SessionRow(props: { h: Session; active: boolean; onShow: (c: Conversation) => void }) {
  const core = useCore();
  const now = useNow();
  const thread = () => jobThreadOf(core()?.chat, props.h);
  const unread = () => {
    const t = thread();
    return t ? unreadIn(t) : 0;
  };
  const phase = () => phaseText(props.h, now());
  return (
    <button
      type="button"
      disabled={!thread()}
      onClick={() => {
        const t = thread();
        if (t) props.onShow(t);
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
  idle: chatWording().mood.idle,
  listening: chatWording().mood.listening,
  thinking: chatWording().mood.thinking,
  speaking: chatWording().mood.speaking,
};

function OrchestratorLine(props: { mood: OrchestratorState }) {
  return (
    <div class="flex items-center gap-2 border-t border-line px-4 py-3 text-sm" aria-label={chatWording().orchestrator}>
      <OrchestratorFace size={32} />
      {chatWording().orchestrator}
      <Dot tone={props.mood === "idle" ? "idle" : props.mood === "thinking" ? "wheat" : "leaf"} size={8} class="ml-1" />
      <span class="text-xs text-muted">{mood[props.mood]}</span>
      <Show when={props.mood === "thinking"}>
        <ThinkingDots />
      </Show>
    </div>
  );
}

function ThreadPane(props: { thread: Conversation; onClose: () => void }) {
  const core = useCore();
  const now = useNow();
  const sessions = () => core()?.sessions ?? [];
  const session = () => threadOwnerOf(props.thread, sessions());
  const status = () => {
    const s = session();
    return s
      ? `@${s.id} · ${phaseText(s, now())}`
      : props.thread.subjectKind === "issue"
        ? chatWording().nobodyOnIt
        : chatWording().replies(props.thread.replies);
  };
  return (
    <section aria-label={chatWording().thread} class="flex min-w-0 flex-1 flex-col">
      <header class={[head, "gap-2.5 px-4"]}>
        <span class="flex size-8 shrink-0 items-center justify-center">
          <Show when={session()} fallback={<Icon name="button-thread" size={16} />}>
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
        <button type="button" class={iconButton} aria-label={chatWording().closeThread} title={chatWording().closeThread} onClick={() => props.onClose()}>
          <Icon name="button-close" size={16} />
        </button>
      </header>
      <MessageList conversation={props.thread} emptyText={chatWording().threadEmpty} />
      <Composer conversation={props.thread} placeholder={session() ? chatWording().sayInThread(session()!.name) : chatWording().reply} />
    </section>
  );
}
