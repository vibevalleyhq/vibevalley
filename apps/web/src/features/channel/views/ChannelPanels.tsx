import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";
import { type Channel, type ChatMessage, type MessageHit, userId } from "@vibevalley/protocol";
import { channelOf, defaultOf } from "@vibevalley/protocol/rules";

import { aria, autofocus, useNow } from "#/base/dom.tsx";
import { archiveSet, markState, notifySet, sameMessage, setMark, useMarkedChat } from "#/features/channel/model/marks.ts";
import { chatPath, messagePath, threadOwnerOf, threadsIn, threadTitle, workbenchClock } from "#/features/channel/model/places.ts";
import { useOrchestrators } from "#/infra/agents.ts";
import { api } from "#/infra/api.ts";
import { orchestratorMood, useCore } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { useLatest } from "#/state/atom.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { Dialog } from "#/ui/Dialog.tsx";
import { OrchestratorFace } from "#/ui/domain/Face.tsx";
import { Select } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { toast } from "#/ui/toasts.ts";

import { channelIconButtonStyles, orchestratorMoodLabels } from "./ChannelSidebar";
import { Composer, FileDrop } from "./Composer";
import { notifyOptions } from "./Dialogs";
import { MessageList } from "./MessageList";
import { HelperFace, PhaseGlyph, phaseText } from "./presence";

const bad = (reason: string) => toast(reason, "bad");

/** Newest pinned first. */
export function Pins(props: { channel: Channel; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const answer = useLatest(
    () => props.channel.id,
    (id) => api.channel.pin.list({ id }),
  );
  const pinned = (): readonly ChatMessage[] | undefined => {
    const a = answer();
    return a?.state === "done" ? a.value : undefined;
  };
  const failed = () => {
    const a = answer();
    return a?.state === "failed" ? a.reason : undefined;
  };
  return (
    <div
      role="dialog"
      data-testid="pins"
      aria-label={t("web.channel.pins.title")}
      class="animate-pop-in absolute top-full right-0 z-30 mt-1 flex max-h-96 w-80 [transform-origin:100%_0] flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-page p-2 shadow-float"
    >
      <p class="px-1 text-xs font-semibold text-muted">{t("web.channel.pins.title")}</p>
      <Show when={pinned()?.length === 0}>
        <p class="px-1 py-2 text-sm text-muted">{t("web.channel.pins.none")}</p>
      </Show>
      <Show when={failed()}>
        {(why) => (
          <p data-testid="pins-failed" class="px-1 py-2 text-sm text-berry">
            {t("web.channel.pins.failed", { why: why() })}
          </p>
        )}
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
              <span class="font-semibold">{m().from === userId ? t("web.channel.messages.user") : m().name}</span>
              <span class="text-muted">{workbenchClock(m().at)}</span>
            </span>
            <span class="line-clamp-3 block text-sm">{m().text}</span>
          </button>
        )}
      </For>
    </div>
  );
}

export function Members(props: { channel: Channel }) {
  const core = useCore();
  const router = useRouter();
  const act = createAct();
  const now = useNow();
  const orchestrators = useOrchestrators();
  const isOrchestrator = (id: string) => orchestrators().some((a) => a.id === id);
  // The orchestrators in the place: a direct channel's other one, or those the user put in the channel.
  const inside = () =>
    props.channel.type === "direct"
      ? props.channel.peer !== undefined && isOrchestrator(props.channel.peer)
        ? [props.channel.peer]
        : []
      : (props.channel.members ?? []).filter(isOrchestrator);
  const nameOf = (id: string) => orchestrators().find((a) => a.id === id)?.name || t("web.channel.orchestrator");
  const helpers = () => {
    if (props.channel.type === "direct") return [];
    const fallback = defaultOf(core()?.chat)?.id;
    return (core()?.sessions ?? []).filter((h) => h.role === "worker" && (h.channel ?? fallback) === props.channel.id);
  };
  return (
    <aside
      aria-label={t("web.channel.members.title")}
      data-testid="members"
      class="hidden md:flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-l border-line bg-side p-3"
    >
      <p class="px-1 pb-1 text-xs font-semibold text-muted">{t("web.channel.members.title")}</p>
      <div class="flex items-center gap-2 px-1 py-1 text-sm">
        <span class="flex w-7 h-7 items-center justify-center rounded-full bg-selected text-xs font-semibold text-muted">
          {t("web.channel.members.user").slice(0, 1)}
        </span>
        {t("web.channel.members.user")}
      </div>
      <For each={inside()} keyed={(id) => id}>
        {(id) => (
          <div data-testid="member-orchestrator" data-key={id()} class="flex items-center gap-2 px-1 py-1 text-sm">
            <OrchestratorFace size={28} agent={id()} />
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">{nameOf(id())}</span>
              <span class="truncate text-xs text-muted">{t("web.channel.members.inChannel")}</span>
            </span>
            <span class="text-xs text-muted">{orchestratorMoodLabels[orchestratorMood(core(), id())]}</span>
          </div>
        )}
      </For>
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
              class="inline-flex w-8 h-8 shrink-0 cursor-pointer disabled:cursor-default items-center justify-center rounded-md hover:bg-hover disabled:opacity-50"
              aria-label={t("web.channel.direct.open", { name: h().name })}
              title={t("web.channel.direct.open", { name: h().name })}
              onClick={() => {
                const agent = h().agent;
                void act.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
              }}
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

export function ThreadPane(props: { thread: Channel; point: number | undefined; onClose: () => void }) {
  const core = useCore();
  const notifies = useIntents(notifySet);
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
      <header class="flex h-16.5 shrink-0 items-center gap-2.5 border-b border-line px-4">
        <span class="flex w-8 h-8 shrink-0 items-center justify-center">
          <Show when={session()} fallback={<Icon name="thread" size={16} />}>
            {(s) => <HelperFace agent={s().agent} runtime={s().runtime} size={32} />}
          </Show>
        </span>
        <div class="flex min-w-0 flex-1 flex-col">
          <span class="truncate text-sm font-semibold">{threadTitle(props.thread, core()?.issues, sessions())}</span>
          <span class="flex items-center gap-1 text-xs text-muted">
            <Show when={session()}>{(s) => <PhaseGlyph phase={s().phase} />}</Show>
            <span class="truncate">{status()}</span>
          </span>
        </div>
        <Select
          label={t("web.channel.threadList.notify")}
          value={props.thread.notify ?? "all"}
          options={notifyOptions()}
          text="xs"
          class="w-28"
          testid="thread-notify"
          state={markState(notifies.list(), (n) => n.id === props.thread.id)}
          onChange={(v) => {
            if (v === "all" || v === "mentions" || v === "none") setMark(notifies, { id: props.thread.id, notify: v }, sameMessage, bad);
          }}
        />
        <button
          type="button"
          class="inline-flex w-8 h-8 shrink-0 cursor-pointer disabled:cursor-default items-center justify-center rounded-md hover:bg-hover disabled:opacity-50"
          aria-label={t("web.channel.closeThread")}
          title={t("web.channel.closeThread")}
          onClick={() => props.onClose()}
        >
          <Icon name="close" size={16} />
        </button>
      </header>
      <FileDrop channel={props.thread}>
        <MessageList channel={props.thread} point={props.point} emptyText={t("web.channel.threadEmpty")} />
        <Composer channel={props.thread} placeholder={session() ? t("web.channel.sayInThread", { name: session()?.name ?? "" }) : t("web.channel.reply")} />
      </FileDrop>
    </section>
  );
}

/** A channel's threads, the newest talked in first, each renamed or archived in place; the archived ones below. */
export function ThreadList(props: { channel: Channel; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const [showArchived, setShowArchived] = createSignal(false);
  const chat = useMarkedChat();
  const live = () => threadsIn(chat(), props.channel);
  const archived = () => threadsIn(chat(), props.channel, true);
  const title = (channel: Channel) => threadTitle(channel, core()?.issues, core()?.sessions ?? []);
  const item = (channel: Channel) => (
    <ThreadItem thread={channel} title={title(channel)} onOpen={() => (router.navigate(chatPath(channel)), untrack(() => props.onPick)())} />
  );
  return (
    <div
      role="dialog"
      data-testid="thread-list"
      aria-label={t("web.channel.threadList.title")}
      class="animate-pop-in absolute top-full right-0 z-30 mt-1 flex max-h-112 w-96 [transform-origin:100%_0] flex-col gap-0.5 overflow-y-auto rounded-lg border border-line bg-page p-2 shadow-float"
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
          <Icon name="expand" size={10} class={["opacity-60 transition-[rotate] ease-out duration-180", showArchived() ? "[rotate:90deg]" : ""]} />
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
  const act = createAct();
  const archives = useIntents(archiveSet);
  const save = () => {
    setRenaming(false);
    const next = name().trim();
    const id = untrack(() => props.thread.id);
    if (next !== untrack(() => props.title)) void act.run(() => api.channel.update({ id, name: next }));
  };
  return (
    <div
      data-testid="thread"
      data-key={props.thread.id}
      data-archived={props.thread.archived !== undefined ? "" : undefined}
      class={["group/thread-item", "flex items-center gap-1 rounded-md px-1 hover:bg-hover"]}
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
                  {t("shared.join.labeled", { label: m().from === userId ? t("web.channel.messages.user") : m().name, text: m().text })}
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
          class="my-1 min-w-0 flex-1 rounded-sm border border-focus bg-page px-2 py-1 text-sm outline-none"
        />
      </Show>
      <button
        type="button"
        class={[channelIconButtonStyles, "w-7 h-7 opacity-0 focus-visible:opacity-100 group-hover/thread-item:opacity-100"]}
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
        class={[channelIconButtonStyles, "w-7 h-7 opacity-0 focus-visible:opacity-100 group-hover/thread-item:opacity-100"]}
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
        onClick={() => setMark(archives, { id: props.thread.id, on: props.thread.archived === undefined, at: Date.now() }, sameMessage, bad)}
      >
        <Icon name="archive" size={14} />
      </button>
    </div>
  );
}

/** Every channel and thread searched at once, the server reading the filters; a hit opens where it is. */
export function FarmSearch(props: { open: boolean; onClose: () => void }) {
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
  const search = useLatest(
    () => text().trim() || undefined,
    (q) => api.channel.message.search({ text: q }),
    200,
  );
  const hits = (): readonly MessageHit[] | undefined => {
    const a = search();
    return a === undefined ? [] : a.state === "done" ? a.value : undefined;
  };
  const failed = () => {
    const a = search();
    return a?.state === "failed" ? a.reason : undefined;
  };
  return (
    <div class="flex flex-col gap-3">
      <label class="flex h-9 items-center gap-2 rounded-md border border-line focus-within:border-focus px-2">
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
      <Show when={search()?.state === "waiting"}>
        <p class="text-sm text-muted">{t("web.channel.farmSearch.searching")}</p>
      </Show>
      <Show when={failed()}>
        {(why) => (
          <p data-testid="search-failed" class="text-sm text-berry">
            {t("web.channel.farmSearch.failed", { why: why() })}
          </p>
        )}
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
                <span class="font-semibold">{h().message.from === userId ? t("web.channel.messages.user") : h().message.name}</span>
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
