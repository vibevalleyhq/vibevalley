import { computed, keymap, Scroll, signal, Text, untracked, View } from "nsh";
import { Input } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Channel, type ChatMessage, isHumanParticipant, type MessageHit } from "@vibevalley/protocol";
import { channelOf, defaultOf, isFreeUserSession, sessionChannelId, sessionProfile } from "@vibevalley/protocol/rules";

import { Dialog } from "../../../design/Dialog";
import { OrchestratorFace, UserFace } from "../../../design/domain/Face";
import { Select, TextInput } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { CountPill } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { createAct } from "../../../infra/act";
import { useOrchestrators } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { Keyed, useNow } from "../../../infra/base/dom";
import { orchestratorMood, useBoardSlice, useCollabSlice, useSessionsSlice } from "../../../infra/frame";
import { Link as A, useRouter } from "../../../infra/router";
import { localizeRuntimeError } from "../../../infra/runtimeError";
import { useLatest } from "../../../infra/state/atom";
import { useIntents } from "../../../infra/state/intent";
import { NoteCard } from "../../note";
import { archiveSet, markState, notifySet, sameMessage, setMark, useMarkedChat } from "../model/marks";
import {
  channelLabel,
  chatPath,
  directPeerOf,
  issueThreadOf,
  messagePath,
  threadOwnerOf,
  threadsIn,
  threadTitle,
  topsOf,
  workbenchClock,
} from "../model/places";
import { BarButton, orchestratorMoodLabels } from "./ChannelSidebar";
import { Composer, FileDrop } from "./Composer";
import { notifyOptions } from "./Dialogs";
import { MessageList } from "./MessageList";
import { Dot, HelperFace, PhaseGlyph, phaseDot, phaseText } from "./presence";

const bad = (reason: string) => toast(reason, "bad");

/** Newest pinned first. */
export function Pins(props: { channel: Channel; onPick: () => void }) {
  const collab = useCollabSlice();
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
    <View testID="pins" accessibilityLabel={t("web.channel.pins.title")} class="min-h-0 shrink">
      <View class="mb-1 shrink-0 flex-row items-center justify-between border-b border-line px-2 pt-1 pb-1.5">
        <Text class="text-xs font-semibold text-muted">{t("web.channel.pins.title")}</Text>
        <If when={pinned() !== undefined}>
          <CountPill count={pinned()?.length ?? 0} hoverBright />
        </If>
      </View>
      <Scroll class="min-h-0 shrink" contentClass="gap-1">
        <If when={pinned()?.length === 0}>
          <Text class="px-3 py-4 text-center text-xs leading-relaxed text-muted">{t("web.channel.pins.none")}</Text>
        </If>
        <If when={failed()}>
          {(why) => (
            <Text testID="pins-failed" class="px-2 py-2 text-sm text-berry">
              {t("web.channel.pins.failed", { why: why() })}
            </Text>
          )}
        </If>
        <Each of={pinned() ?? []} key={(m) => m.id}>
          {(m) => (
            <View
              role="button"
              testID={`pin-${m().id}`}
              class="gap-1 rounded-md border border-transparent px-2.5 py-2 hover:border-line hover:bg-hover"
              onPress={() => {
                router.navigate(messagePath(channelOf(collab()?.chat, m().channel), m().number));
                untracked(() => props.onPick)();
              }}
            >
              <View class="flex-row items-baseline justify-between gap-2">
                <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                  {isHumanParticipant(m().from) ? t("web.channel.messages.user") : m().name}
                </Text>
                <Text class="shrink-0 text-2xs text-faint tabular-nums">{workbenchClock(m().at)}</Text>
              </View>
              <Text class="line-clamp-3 text-sm text-ink">{localizeRuntimeError(m().text).text}</Text>
              <If when={m().deleted === undefined ? m().note : undefined}>{(card) => <NoteCard card={card()} />}</If>
            </View>
          )}
        </Each>
      </Scroll>
    </View>
  );
}

export function Members(props: { channel: Channel }) {
  const collab = useCollabSlice();
  const sessions = useSessionsSlice();
  const router = useRouter();
  const act = createAct();
  const now = useNow();
  const orchestrators = useOrchestrators();
  const isOrchestrator = (id: string) => orchestrators().some((a) => a.id === id);
  // The orchestrators in the place: a direct channel's other one, or those the user put in the channel.
  const inside = () => {
    if (props.channel.type === "direct") {
      const peer = directPeerOf(props.channel);
      return peer !== undefined && isOrchestrator(peer) ? [peer] : [];
    }
    return (props.channel.members ?? []).filter(isOrchestrator);
  };
  const nameOf = (id: string) => orchestrators().find((a) => a.id === id)?.name || t("web.channel.orchestrator");
  const helpers = () => {
    if (props.channel.type === "direct") return [];
    const fallback = defaultOf(collab()?.chat)?.id;
    return (sessions()?.sessions ?? []).filter((h) => h.role === "worker" && !isFreeUserSession(h) && (sessionChannelId(h) ?? fallback) === props.channel.id);
  };
  const totalCount = () => 1 + inside().length + helpers().length;
  return (
    <Scroll accessibilityLabel={t("web.channel.members.title")} testID="members" class="w-60 shrink-0 border-l border-line bg-side" contentClass="gap-1 p-3">
      <View class="mb-1 flex-row items-center justify-between border-b border-line px-1.5 pb-2">
        <Text class="text-xs font-semibold text-muted">{t("web.channel.members.title")}</Text>
        <CountPill count={totalCount()} hoverBright />
      </View>
      <View class="flex-row items-center gap-2 rounded-md px-2 py-1.5">
        <UserFace size={28} />
        <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{t("web.channel.members.user")}</Text>
      </View>
      <Each of={inside()} key={(id) => id}>
        {(id) => {
          const mood = () => orchestratorMood(sessions()?.sessions, id());
          return (
            <View testID={`member-orchestrator-${id()}`} class="flex-row items-center gap-2 rounded-md px-2 py-1.5">
              <View class="relative shrink-0">
                <OrchestratorFace size={28} agent={id()} />
                <View class="absolute -right-0.5 -bottom-0.5">
                  <Dot tone={mood() === "idle" ? "idle" : mood() === "thinking" ? "wheat" : "leaf"} size={6} />
                </View>
              </View>
              <View class="min-w-0 flex-1">
                <Text class="truncate text-sm font-medium text-ink">{nameOf(id())}</Text>
                <Text class="truncate text-xs text-muted">{t("web.channel.members.inChannel")}</Text>
              </View>
              <Text class="shrink-0 text-2xs text-muted">{orchestratorMoodLabels[mood()]}</Text>
            </View>
          );
        }}
      </Each>
      <If when={props.channel.type !== "direct"}>
        <View class="mt-1 gap-1 border-t border-line pt-1.5">
          <Each of={helpers()} key={(h) => h.id}>
            {(h) => (
              <View testID={`member-${h().id}`} class="flex-row items-center gap-2 rounded-md px-2 py-1.5 hover:bg-hover">
                <View class="relative shrink-0">
                  <HelperFace agent={sessionProfile(h()) ?? ""} runtime={h().runtime} size={28} />
                  <View class="absolute -right-0.5 -bottom-0.5">
                    <Dot tone={phaseDot(h().phase)} size={6} />
                  </View>
                </View>
                <View class="min-w-0 flex-1">
                  <Text class="truncate text-sm font-medium text-ink">{h().name}</Text>
                  <View class="flex-row items-center gap-1">
                    <PhaseGlyph phase={h().phase} size={12} />
                    <Text class="min-w-0 flex-1 truncate text-xs text-muted tabular-nums">{phaseText(h(), now())}</Text>
                  </View>
                </View>
                <BarButton
                  icon="thread"
                  size={14}
                  compact
                  label={t("web.channel.direct.open", { name: h().name })}
                  onPress={() => {
                    const agent = sessionProfile(h());
                    if (agent) void act.run(async () => router.navigate(`/chat/${await api.channel.direct.create({ agent })}`));
                  }}
                />
              </View>
            )}
          </Each>
          <If when={helpers().length === 0}>
            <Text class="px-2 py-1.5 text-xs text-muted">{t("web.channel.members.none")}</Text>
          </If>
        </View>
      </If>
    </Scroll>
  );
}

export function ThreadPane(props: { thread: Channel; point: number | undefined; onClose: () => void }) {
  const board = useBoardSlice();
  const sessionsSlice = useSessionsSlice();
  const notifies = useIntents(notifySet);
  const now = useNow();
  const sessions = () => sessionsSlice()?.sessions ?? [];
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
      <View class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line px-3.5">
        <View class="h-6 w-6 shrink-0 items-center justify-center rounded-md bg-side">
          <If when={session()} else={<Icon name="thread" size={14} tone="muted" />}>
            {(s) => <HelperFace agent={sessionProfile(s()) ?? ""} runtime={s().runtime} size={24} />}
          </If>
        </View>
        <View class="min-w-0 flex-1 flex-row items-center gap-2 overflow-hidden">
          <Text class="max-w-44 shrink-0 truncate text-sm font-semibold text-ink">{threadTitle(props.thread, board()?.issues, sessions())}</Text>
          <View class="min-w-0 flex-1 flex-row items-center gap-1">
            <If when={session()}>{(s) => <PhaseGlyph phase={s().phase} size={12} />}</If>
            <Text class="min-w-0 flex-1 truncate text-xs text-muted tabular-nums">{status()}</Text>
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

/** Embedded live channel pane used beside a note canvas so the user can discuss it in place. */
export function ChannelSidePane(props: {
  channel?: string | undefined;
  issue?: string | undefined;
  point?: number | undefined;
  onClose?: (() => void) | undefined;
}) {
  const chat = useMarkedChat();
  const shown = computed(() => {
    const c = chat();
    if (!c) return undefined;
    if (props.channel) {
      const found = channelOf(c, props.channel);
      if (found) return found;
    }
    if (props.issue) {
      const thread = issueThreadOf(c, props.issue);
      if (thread) return thread;
    }
    return defaultOf(c) ?? topsOf(c)[0];
  });
  const href = () => {
    const c = shown();
    if (!c) return "/chat";
    return props.point !== undefined ? messagePath(c, props.point) : chatPath(c);
  };
  return (
    <If when={shown()}>
      {(c) => (
        <Keyed key={c().id}>
          {() => (
            <View testID="note-chat-pane" class="min-h-0 min-w-0 flex-1">
              <View desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center justify-between gap-1.5 border-b border-line px-2.5">
                <A href={href()} testID="note-message" class="min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-hover">
                  <Icon name="chat" size={14} tone="muted" />
                  <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{channelLabel(c())}</Text>
                  <Icon name="open" size={12} tone="muted" />
                </A>
                <If when={props.onClose}>
                  <BarButton icon="close" size={14} testid="note-rail-close" label={t("web.note.page.railHide")} onPress={() => props.onClose?.()} />
                </If>
              </View>
              <FileDrop channel={c()}>
                <MessageList channel={c()} point={props.point} emptyText={t("web.channel.empty", { label: channelLabel(c()) })} />
                <Composer channel={c()} replyTo={props.point} placeholder={t("web.channel.sendTo", { label: channelLabel(c()) })} />
              </FileDrop>
            </View>
          )}
        </Keyed>
      )}
    </If>
  );
}

/** A channel's threads, the newest talked in first, each renamed or archived in place; the archived ones below. */
export function ThreadList(props: { channel: Channel; onPick: () => void }) {
  const board = useBoardSlice();
  const sessions = useSessionsSlice();
  const router = useRouter();
  const showArchived = signal(false);
  const chat = useMarkedChat();
  const live = () => threadsIn(chat(), props.channel);
  const archived = () => threadsIn(chat(), props.channel, true);
  const title = (channel: Channel) => threadTitle(channel, board()?.issues, sessions()?.sessions ?? []);
  const item = (channel: () => Channel) => (
    <ThreadItem
      thread={channel()}
      title={title(channel())}
      onOpen={() => {
        router.navigate(chatPath(channel()));
        untracked(() => props.onPick)();
      }}
    />
  );
  return (
    <View testID="thread-list" accessibilityLabel={t("web.channel.threadList.title")} class="min-h-0 shrink">
      <View class="mb-1 shrink-0 flex-row items-center justify-between border-b border-line px-2 pt-1 pb-1.5">
        <Text class="text-xs font-semibold text-muted">{t("web.channel.threadList.title")}</Text>
        <CountPill count={live().length} hoverBright />
      </View>
      <Scroll class="min-h-0 shrink" contentClass="gap-0.5">
        <If when={live().length === 0}>
          <Text testID="threads-empty" class="px-3 py-4 text-center text-xs leading-relaxed text-muted">
            {t("web.channel.threadList.none")}
          </Text>
        </If>
        <Each of={live()} key={(c) => c.id}>
          {(c) => item(c)}
        </Each>
        <If when={archived().length > 0}>
          <View class="mt-1.5 gap-0.5 border-t border-line pt-1.5">
            <View
              role="button"
              testID="threads-archived"
              accessibilityState={{ expanded: showArchived() }}
              class="group h-7 flex-row items-center gap-1.5 rounded-md px-1.5 hover:bg-hover"
              onPress={() => showArchived.set(!showArchived())}
            >
              <View class="h-4 w-4 shrink-0 items-center justify-center">
                <Icon name={showArchived() ? "choose" : "expand"} size={14} tone="muted" />
              </View>
              <Text class="text-xs font-medium text-muted group-hover:text-ink">{t("web.channel.threadList.archived", { n: archived().length })}</Text>
            </View>
            <If when={showArchived()}>
              <Each of={archived()} key={(c) => c.id}>
                {(c) => item(c)}
              </Each>
            </If>
          </View>
        </If>
      </Scroll>
    </View>
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
              <Text class="shrink-0 text-xs text-muted tabular-nums">{t("web.channel.replies", { n: props.thread.replies })}</Text>
            </View>
            <If when={props.thread.last}>
              {(m) => (
                <Text class="truncate text-xs text-muted">
                  {t("shared.join.labeled", {
                    label: isHumanParticipant(m().from) ? t("web.channel.messages.user") : m().name,
                    text: localizeRuntimeError(m().text).text,
                  })}
                </Text>
              )}
            </If>
          </View>
        }
      >
        <RenameBox
          value={name()}
          label={t("web.channel.threadList.rename", { title: props.title })}
          onInput={(v) => name.set(v)}
          onSave={save}
          onCancel={() => renaming.set(false)}
        />
      </If>
      <View class="flex-row items-center gap-0.5" style={{ opacity: hovered() ? 1 : 0 }}>
        <BarButton
          icon="edit"
          size={14}
          compact
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
          compact
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
    <Dialog
      open={props.open}
      onClose={() => props.onClose()}
      title={t("web.channel.farmSearch.title")}
      size="md"
      height="fixed"
      scroll={false}
      testid="farm-search"
    >
      <If when={props.open}>
        <FarmSearchBody onClose={() => props.onClose()} />
      </If>
    </Dialog>
  );
}

function FarmSearchBody(props: { onClose: () => void }) {
  const collab = useCollabSlice();
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
    <View class="min-h-0 flex-1">
      <View class="shrink-0 gap-2 border-b border-line px-5 py-3">
        <View class="h-9 flex-row items-center gap-2">
          <Icon name="search" size={16} tone="muted" />
          <TextInput
            testID="farm-search-input"
            autoFocus
            value={text()}
            onInput={(v) => text.set(v)}
            placeholder={t("web.channel.farmSearch.hint")}
            accessibilityLabel={t("web.channel.farmSearch.title")}
            class="flex-1"
            wide={false}
          />
        </View>
        <View class="rounded-md bg-side px-2.5 py-1.5">
          <Text class="font-mono text-xs text-muted">{t("web.channel.farmSearch.filters")}</Text>
        </View>
      </View>
      <Scroll class="min-h-0 flex-1" contentClass="gap-1 px-5 py-3">
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
          <Text class="py-4 text-center text-sm text-muted">{t("web.channel.farmSearch.none")}</Text>
        </If>
        <View role="list" accessibilityLabel={t("web.channel.messages.label")} class="gap-1">
          <Each of={hits() ?? []} key={(h) => h.message.id}>
            {(h) => (
              <View
                role="button"
                testID={`search-hit-${h().message.id}`}
                tooltip={<Bubble text={h().address} />}
                class="gap-1 rounded-md border border-transparent px-2.5 py-2 hover:border-line hover:bg-hover"
                onPress={() => {
                  router.navigate(messagePath(channelOf(collab()?.chat, h().message.channel), h().message.number));
                  untracked(() => props.onClose)();
                }}
              >
                <View class="flex-row items-baseline gap-2">
                  <Text class="text-xs font-semibold text-accent">{h().address}</Text>
                  <Text class="text-xs font-semibold text-ink">{isHumanParticipant(h().message.from) ? t("web.channel.messages.user") : h().message.name}</Text>
                  <Text class="text-xs text-muted tabular-nums">{workbenchClock(h().message.at)}</Text>
                </View>
                <Text class="line-clamp-2 text-sm text-ink">{localizeRuntimeError(h().message.text).text}</Text>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
    </View>
  );
}
