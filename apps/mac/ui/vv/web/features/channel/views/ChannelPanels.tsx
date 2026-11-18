// Ported from VibeValley apps/web/src/features/channel/views/ChannelPanels.tsx.
// Pins and the thread list are the contents of the head's popovers (the
// page puts them in nsh/base Popovers, which place and close them) rather
// than boxes placed under their buttons; a thread's rename and archive show
// on the row under the pointer, as group-hover does there.
import { keymap, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Channel, type ChatMessage, type MessageHit, userId } from "@vibevalley/protocol";
import { channelOf, defaultOf } from "@vibevalley/protocol/rules";

import { useNow } from "../../../base/dom";
import { useOrchestrators } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { orchestratorMood, useCore } from "../../../infra/frame";
import { useRouter } from "../../../infra/router";
import { useLatest } from "../../../state/atom";
import { useIntents } from "../../../state/intent";
import { createAct } from "../../../ui/act";
import { Dialog } from "../../../ui/Dialog";
import { OrchestratorFace } from "../../../ui/domain/Face";
import { Select, TextInput } from "../../../ui/Field";
import { Icon } from "../../../ui/Icon";
import { Bubble } from "../../../ui/Tip";
import { toast } from "../../../ui/toasts";
import { archiveSet, markState, notifySet, sameMessage, setMark, useMarkedChat } from "../model/marks";
import { chatPath, messagePath, threadOwnerOf, threadsIn, threadTitle, workbenchClock } from "../model/places";
import { BarButton, orchestratorMoodLabels } from "./ChannelSidebar";
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
    <Scroll testID="pins" accessibilityLabel={t("web.channel.pins.title")} contentClass="gap-1">
      <Text class="px-1 text-xs font-semibold text-muted">{t("web.channel.pins.title")}</Text>
      <If when={pinned()?.length === 0}>
        <Text class="px-1 py-2 text-sm text-muted">{t("web.channel.pins.none")}</Text>
      </If>
      <If when={failed()}>
        {(why) => (
          <Text testID="pins-failed" class="px-1 py-2 text-sm text-berry">
            {t("web.channel.pins.failed", { why: why() })}
          </Text>
        )}
      </If>
      <Each of={pinned() ?? []} key={(m) => m.id}>
        {(m) => (
          <View
            role="button"
            testID={`pin-${m().id}`}
            class="rounded-md px-2 py-1.5 hover:bg-hover"
            onPress={() => {
              router.navigate(messagePath(channelOf(core()?.chat, m().channel), m().number));
              untracked(() => props.onPick)();
            }}
          >
            <View class="flex-row items-baseline gap-2">
              <Text class="text-xs font-semibold text-ink">{m().from === userId ? t("web.channel.messages.user") : m().name}</Text>
              <Text class="text-xs text-muted">{workbenchClock(m().at)}</Text>
            </View>
            <Text class="text-sm text-ink" style={{ numberOfLines: 3 }}>
              {m().text}
            </Text>
          </View>
        )}
      </Each>
    </Scroll>
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
    <Scroll accessibilityLabel={t("web.channel.members.title")} testID="members" class="w-60 shrink-0 border-l border-line bg-side" contentClass="gap-1 p-3">
      <Text class="px-1 pb-1 text-xs font-semibold text-muted">{t("web.channel.members.title")}</Text>
      <View class="flex-row items-center gap-2 px-1 py-1">
        <View class="h-7 w-7 items-center justify-center rounded-full bg-selected">
          <Text class="text-xs font-semibold text-muted">{t("web.channel.members.user").slice(0, 1)}</Text>
        </View>
        <Text class="text-sm text-ink">{t("web.channel.members.user")}</Text>
      </View>
      <Each of={inside()}>
        {(id) => (
          <View testID={`member-orchestrator-${id()}`} class="flex-row items-center gap-2 px-1 py-1">
            <OrchestratorFace size={28} agent={id()} />
            <View class="min-w-0 flex-1">
              <Text class="truncate text-sm text-ink">{nameOf(id())}</Text>
              <Text class="truncate text-xs text-muted">{t("web.channel.members.inChannel")}</Text>
            </View>
            <Text class="text-xs text-muted">{orchestratorMoodLabels[orchestratorMood(core(), id())]}</Text>
          </View>
        )}
      </Each>
      <Each of={helpers()} key={(h) => h.id}>
        {(h) => (
          <View testID={`member-${h().id}`} class="flex-row items-center gap-2 px-1 py-1">
            <HelperFace agent={h().agent} runtime={h().runtime} size={28} />
            <View class="min-w-0 flex-1">
              <Text class="truncate text-sm text-ink">{h().name}</Text>
              <Text class="truncate text-xs text-muted">{phaseText(h(), now())}</Text>
            </View>
            <PhaseGlyph phase={h().phase} />
            <BarButton
              icon="thread"
              size={14}
              label={t("web.channel.direct.open", { name: h().name })}
              onPress={() => {
                const agent = h().agent;
                void act.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
              }}
            />
          </View>
        )}
      </Each>
      <If when={props.channel.type !== "direct" && helpers().length === 0}>
        <Text class="px-1 pt-1 text-xs text-muted">{t("web.channel.members.none")}</Text>
      </If>
    </Scroll>
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
    <View testID="thread-pane" accessibilityLabel={t("web.channel.thread")} class="min-w-0 flex-1">
      <View class="h-16.5 shrink-0 flex-row items-center gap-2.5 border-b border-line px-4">
        <View class="h-8 w-8 shrink-0 items-center justify-center">
          <If when={session()} else={<Icon name="thread" size={16} />}>
            {(s) => <HelperFace agent={s().agent} runtime={s().runtime} size={32} />}
          </If>
        </View>
        <View class="min-w-0 flex-1">
          <Text class="truncate text-sm font-semibold text-ink">{threadTitle(props.thread, core()?.issues, sessions())}</Text>
          <View class="flex-row items-center gap-1">
            <If when={session()}>{(s) => <PhaseGlyph phase={s().phase} />}</If>
            <Text class="truncate text-xs text-muted">{status()}</Text>
          </View>
        </View>
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
        <BarButton icon="close" size={16} testid="thread-close" label={t("web.channel.closeThread")} onPress={() => props.onClose()} />
      </View>
      <FileDrop channel={props.thread}>
        <MessageList channel={props.thread} point={props.point} emptyText={t("web.channel.threadEmpty")} />
        <Composer channel={props.thread} placeholder={session() ? t("web.channel.sayInThread", { name: session()?.name ?? "" }) : t("web.channel.reply")} />
      </FileDrop>
    </View>
  );
}

/** A channel's threads, the newest talked in first, each renamed or archived in place; the archived ones below. */
export function ThreadList(props: { channel: Channel; onPick: () => void }) {
  const core = useCore();
  const router = useRouter();
  const showArchived = signal(false);
  const chat = useMarkedChat();
  const live = () => threadsIn(chat(), props.channel);
  const archived = () => threadsIn(chat(), props.channel, true);
  const title = (channel: Channel) => threadTitle(channel, core()?.issues, core()?.sessions ?? []);
  const item = (channel: Channel) => (
    <ThreadItem
      thread={channel}
      title={title(channel)}
      onOpen={() => {
        router.navigate(chatPath(channel));
        untracked(() => props.onPick)();
      }}
    />
  );
  return (
    <Scroll testID="thread-list" accessibilityLabel={t("web.channel.threadList.title")} contentClass="gap-0.5">
      <Text class="px-1 pb-1 text-xs font-semibold text-muted">{t("web.channel.threadList.title")}</Text>
      <If when={live().length === 0}>
        <Text testID="threads-empty" class="px-1 py-2 text-sm text-muted">
          {t("web.channel.threadList.none")}
        </Text>
      </If>
      <Each of={live()} key={(c) => c.id}>
        {(c) => item(c())}
      </Each>
      <If when={archived().length > 0}>
        <View
          role="button"
          testID="threads-archived"
          accessibilityState={{ expanded: showArchived() }}
          class="mt-1 flex-row items-center gap-1 px-1"
          onPress={() => showArchived.set(!showArchived())}
        >
          <View style={{ opacity: 0.6, transform: [{ rotate: showArchived() ? "90deg" : "0deg" }] }}>
            <Icon name="expand" size={10} tone="muted" />
          </View>
          <Text class="text-xs text-muted">{t("web.channel.threadList.archived", { n: archived().length })}</Text>
        </View>
        <If when={showArchived()}>
          <Each of={archived()} key={(c) => c.id}>
            {(c) => item(c())}
          </Each>
        </If>
      </If>
    </Scroll>
  );
}

function ThreadItem(props: { thread: Channel; title: string; onOpen: () => void }) {
  const renaming = signal(false);
  const hovered = signal(false);
  const name = signal("");
  const act = createAct();
  const archives = useIntents(archiveSet);
  const save = () => {
    if (!untracked(renaming)) return;
    renaming.set(false);
    const next = name().trim();
    const id = untracked(() => props.thread.id);
    if (next !== untracked(() => props.title)) void act.run(() => api.channel.update({ id, name: next }));
  };
  const archiveLabel = () =>
    props.thread.archived !== undefined
      ? t("web.channel.threadList.unarchive", { title: props.title })
      : t("web.channel.threadList.archive", { title: props.title });
  return (
    <View
      testID={`thread-${props.thread.id}`}
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      class="flex-row items-center gap-1 rounded-md px-1 hover:bg-hover"
    >
      <If
        when={renaming()}
        else={
          <View role="button" class="min-w-0 flex-1 py-1.5 pl-1" onPress={() => props.onOpen()}>
            <View class="flex-row items-center gap-1.5">
              <Icon name="thread" size={14} />
              <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{props.title}</Text>
              <Text class="shrink-0 text-xs text-muted">{t("web.channel.replies", { n: props.thread.replies })}</Text>
            </View>
            <If when={props.thread.last}>
              {(m) => (
                <Text class="truncate text-xs text-muted">
                  {t("shared.join.labeled", { label: m().from === userId ? t("web.channel.messages.user") : m().name, text: m().text })}
                </Text>
              )}
            </If>
          </View>
        }
      >
        <RenameBox
          value={name()}
          label={t("web.channel.threadList.rename", { title: props.title })}
          onInput={name.set}
          onSave={save}
          onCancel={() => renaming.set(false)}
        />
      </If>
      <View class="flex-row" style={{ opacity: hovered() ? 1 : 0 }}>
        <BarButton
          icon="edit"
          size={14}
          testid="thread-rename"
          label={t("web.channel.threadList.rename", { title: props.title })}
          onPress={() => {
            name.set(props.thread.name ?? props.title);
            renaming.set(true);
          }}
        />
        <BarButton
          icon="archive"
          size={14}
          testid="thread-archive"
          label={archiveLabel()}
          onPress={() => setMark(archives, { id: props.thread.id, on: props.thread.archived === undefined, at: Date.now() }, sameMessage, bad)}
        />
      </View>
    </View>
  );
}

function RenameBox(props: { value: string; label: string; onInput: (v: string) => void; onSave: () => void; onCancel: () => void }) {
  keymap.bind("escape", () => props.onCancel(), { when: "always" });
  return (
    <Input
      testID="thread-name"
      autoFocus
      value={props.value}
      accessibilityLabel={props.label}
      onChange={(e) => props.onInput(e.value)}
      onSubmit={() => props.onSave()}
      onBlur={() => props.onSave()}
      class="my-1 min-w-0 flex-1 rounded-sm border border-focus bg-page px-2 py-1 text-sm text-ink"
    />
  );
}

/** Every channel and thread searched at once, the server reading the filters; a hit opens where it is. */
export function FarmSearch(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={props.open} onClose={() => props.onClose()} title={t("web.channel.farmSearch.title")} wide testid="farm-search">
      <If when={props.open}>
        <FarmSearchBody onClose={() => props.onClose()} />
      </If>
    </Dialog>
  );
}

function FarmSearchBody(props: { onClose: () => void }) {
  const core = useCore();
  const router = useRouter();
  const text = signal("");
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
    <View class="gap-3">
      <View class="h-9 flex-row items-center gap-2">
        <Icon name="search" size={16} tone="muted" />
        <TextInput
          testID="farm-search-input"
          autoFocus
          value={text()}
          onInput={text.set}
          placeholder={t("web.channel.farmSearch.hint")}
          accessibilityLabel={t("web.channel.farmSearch.title")}
          class="flex-1"
          wide={false}
        />
      </View>
      <Text class="text-xs text-faint">{t("web.channel.farmSearch.filters")}</Text>
      <If when={search()?.state === "waiting"}>
        <Text class="text-sm text-muted">{t("web.channel.farmSearch.searching")}</Text>
      </If>
      <If when={failed()}>
        {(why) => (
          <Text testID="search-failed" class="text-sm text-berry">
            {t("web.channel.farmSearch.failed", { why: why() })}
          </Text>
        )}
      </If>
      <If when={hits()?.length === 0 && text().trim() !== ""}>
        <Text class="text-sm text-muted">{t("web.channel.farmSearch.none")}</Text>
      </If>
      <View role="list" accessibilityLabel={t("web.channel.messages.label")} class="gap-0.5">
        <Each of={hits() ?? []} key={(h) => h.message.id}>
          {(h) => (
            <View
              role="button"
              testID={`search-hit-${h().message.id}`}
              tooltip={<Bubble text={h().address} />}
              class="gap-0.5 rounded-md px-2 py-1.5 hover:bg-hover"
              onPress={() => {
                router.navigate(messagePath(channelOf(core()?.chat, h().message.channel), h().message.number));
                untracked(() => props.onClose)();
              }}
            >
              <View class="flex-row items-baseline gap-2">
                <Text class="text-xs font-semibold text-accent">{h().address}</Text>
                <Text class="text-xs font-semibold text-ink">{h().message.from === userId ? t("web.channel.messages.user") : h().message.name}</Text>
                <Text class="text-xs text-muted">{workbenchClock(h().message.at)}</Text>
              </View>
              <Text class="text-sm text-ink" style={{ numberOfLines: 2 }}>
                {h().message.text}
              </Text>
            </View>
          )}
        </Each>
      </View>
    </View>
  );
}
