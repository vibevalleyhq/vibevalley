import { computed, List, signal, Text, untracked, View, type JSX, type ListRef } from "nsh";

import { t } from "@vibevalley/i18n";
import { type ChatMessage, type Channel, type MessageHit, defaultOrchestrator, type Outcome, userId } from "@vibevalley/protocol";
import { actorRoleOf, channelOf, plainText } from "@vibevalley/protocol/rules";

import { createEffect } from "../../../../solid";
import { useNow } from "../../../base/dom";
import { tookText, spentText } from "../../../base/format";
import { useAgent, useOrchestrators } from "../../../infra/agents";
import { api } from "../../../infra/api";
import { useCore, useIssue, useSession, useSessionsMap, useThreadOwner } from "../../../infra/frame";
import { useRouter, Link as A } from "../../../infra/router";
import { useLatest } from "../../../state/atom";
import { useIntents } from "../../../state/intent";
import { OrchestratorFace, UserFace } from "../../../ui/domain/Face";
import { Icon } from "../../../ui/Icon";
import type { IconName } from "../../../ui/icons";
import { Markdown } from "../../../ui/Markdown";
import { Tag, type TagTone } from "../../../ui/Tag";
import { Bubble } from "../../../ui/Tip";
import { toast } from "../../../ui/toasts";
import { mix } from "../../../ui/tone";
import { ArtifactCard } from "../../artifact";
import { RunSteps } from "../../session/WorkLog";
import { chatSay, editingId, pendingLines, setEditingId } from "../model/composing";
import { followed, useMessage } from "../model/follow";
import { useMarkedFollowed, useMarkRead } from "../model/marks";
import { feedOf, orchestratorTyping, workbenchClock, messagePath, chatPath, parentAt, unreadIn } from "../model/places";
import { Attachments, EditBox, Embeds, LinkedMessages, MessageBody, MessageTools, Reactions, ReplyQuote } from "./MessageParts";
import { Dot, PhaseGlyph, SenderFace, ThinkingDots, phaseDot, phaseText, dutyShort, runtimeLabel } from "./presence";

type FeedItem = ReturnType<typeof feedOf>[number];

const outcomeTag: Record<Outcome, { label: string; tone: TagTone; icon: IconName }> = {
  completed: { label: t("shared.outcome.completed"), tone: "ok", icon: "check" },
  failed: { label: t("shared.outcome.failed"), tone: "bad", icon: "cross" },
  interrupted: { label: t("shared.outcome.interrupted"), tone: "wait", icon: "stop" },
};

/** A channel's messages, newest at the bottom; filter keeps those containing it. */
export function MessageList(props: { channel: Channel | undefined; filter?: string | undefined; point?: number | undefined; emptyText: string }) {
  const core = useCore();
  const router = useRouter();
  const id = () => props.channel?.id;
  const said = useMarkedFollowed(id);
  useMarkRead(
    () => props.channel,
    (reason) => toast(reason, "bad"),
  );
  let log: ListRef | undefined;
  // The message an address points at: older pages are read until it is among them, then it is scrolled to and lit up a while.
  const lit = signal<number | undefined>(undefined);
  createEffect(
    () => {
      const at = id();
      const n = props.point;
      const f = said();
      if (!at || n === undefined || !f.ready) return undefined;
      if (f.messages.some((m) => m.number === n)) return `here:${at}:${n}`;
      const first = f.messages[0]?.number;
      return !f.complete && first !== undefined && first > n ? `older:${at}:${first}` : undefined;
    },
    (step) => {
      if (!step) return;
      const [what = "", at = "", n = ""] = step.split(":");
      if (what === "older") return void followed.loadOlder(at);
      const index = untracked(items).findIndex((item) => item.message.number === Number(n) && item.message.channel === at);
      if (index >= 0) setTimeout(() => log?.scrollToIndex({ index, viewPosition: 0.5 }), 0);
      lit.set(Number(n));
      const off = setTimeout(() => lit.set(undefined), litMs);
      return () => clearTimeout(off);
    },
  );

  // Where the user had read to as the list opened: the new ones below a line.
  const readTo = untracked(() => props.channel?.read ?? 0);
  const searching = () => (props.filter ?? "").trim() !== "";
  // A search is the server's, over the whole channel and its threads, not only the pages read here.
  const search = useLatest(
    () => {
      const text = (props.filter ?? "").trim();
      const at = id();
      // A string, so the same words in the same channel again ask nothing.
      return text && at ? `${at}\n${text}` : undefined;
    },
    (key) => {
      const [channel = "", text = ""] = key.split("\n");
      return api.channel.message.search({ text, channel });
    },
    searchWaitMs,
  );
  const hits = (): readonly MessageHit[] | undefined => {
    const a = search();
    return a?.state === "done" ? a.value : undefined;
  };
  const searchFailed = () => {
    const a = search();
    return a?.state === "failed" ? a.reason : undefined;
  };
  const items = computed(() =>
    searching()
      ? feedOf(
          core()?.chat,
          [...(hits() ?? [])].toReversed().map((h) => h.message),
        )
      : feedOf(core()?.chat, said().messages),
  );
  const addressOf = (m: ChatMessage) => (m.channel === id() ? undefined : hits()?.find((h) => h.message.id === m.id)?.address);
  const firstNew = () => (searching() ? undefined : said().messages.find((m) => m.number > readTo && m.from !== userId)?.id);
  const parent = useMessage(() => (props.channel ? parentAt(core()?.chat, props.channel) : undefined));
  const hasOlder = () => !!id() && said().messages.length > 0 && !said().complete;
  const typing = () => orchestratorTyping(core(), props.channel);
  const clock = useNow();
  // Thinking or writing, and for how long the round has gone on.
  const roundText = (mood: "thinking" | "speaking", since: number | undefined) => {
    const what = mood === "speaking" ? t("web.channel.messages.typing") : t("web.channel.messages.thinking");
    return since === undefined ? what : t("web.channel.messages.roundFor", { what, took: tookText(Math.max(0, clock() - since)) });
  };
  const orchestrators = useOrchestrators();
  // Scrolled up from the newest: the number it was at then, so what came after is counted for the way back.
  const awayFrom = signal<number | undefined>(undefined);
  const newest = () => said().messages.at(-1)?.number ?? 0;
  const unseen = () => {
    const from = awayFrom();
    return from === undefined ? 0 : said().messages.filter((m) => m.number > from && m.from !== userId).length;
  };
  const onScroll = (e: { offset: { y: number }; contentSize: { height: number }; size: { height: number } }) => {
    const away = e.contentSize.height - e.size.height - e.offset.y > awayPx;
    if (away && untracked(awayFrom) === undefined) awayFrom.set(untracked(newest));
    if (!away && untracked(awayFrom) !== undefined) awayFrom.set(undefined);
  };
  const toLatest = () => log?.scrollToEnd({ animated: true });

  const header = () => (
    <View class="px-4 pt-3">
      <View class="items-center pb-2">
        <If
          when={hasOlder() && !searching()}
          else={
            <Text class="text-xs text-muted">
              {searching()
                ? search()?.state !== "done" && searchFailed() === undefined
                  ? t("web.channel.messages.searching")
                  : t("web.channel.messages.containing", { text: (props.filter ?? "").trim() })
                : t("web.channel.messages.start")}
            </Text>
          }
        >
          <View
            role="button"
            testID="messages-older"
            onPress={() => {
              const ch = id();
              if (ch) void followed.loadOlder(ch);
            }}
            class="rounded-sm px-2 py-1"
          >
            <Text class="text-xs text-faint hover:text-ink">{t("web.channel.messages.older")}</Text>
          </View>
        </If>
      </View>
      <If when={parent()}>
        {(m) => (
          <View class="mb-2 border-b border-line pb-2">
            <MessageRow m={m()} continues={false} />
          </View>
        )}
      </If>
      <If when={searching() ? searchFailed() : said().error}>
        {(why) => (
          <Text testID="messages-failed" class="py-8 text-center text-sm text-berry">
            {searching() ? t("web.channel.messages.searchFailed", { why: why() }) : t("web.channel.messages.readFailed", { why: why() })}
          </Text>
        )}
      </If>
      <If when={items().length === 0 && (searching() ? hits() !== undefined : !said().error)}>
        <Text testID="messages-empty" class="py-8 text-center text-sm text-muted">
          {searching() ? t("web.channel.messages.notFound") : props.emptyText}
        </Text>
      </If>
    </View>
  );

  const footer = () => (
    <View class="px-4 pb-4">
      <If when={!searching()}>
        <PendingLines channel={id()} messages={said().messages} />
      </If>
      <If when={typing()}>
        {(typer) => (
          <Frame
            face={<OrchestratorFace size={36} agent={typer().agent} />}
            name={orchestrators().find((a) => a.id === typer().agent)?.name || t("web.channel.orchestrator")}
            meta={roundText(typer().mood, typer().since)}
          >
            <View class="h-5 flex-row items-center">
              <ThinkingDots />
            </View>
          </Frame>
        )}
      </If>
    </View>
  );

  return (
    <View class="min-h-0 flex-1">
      <List
        ref={(r) => (log = r)}
        each={items()}
        keyExtractor={(item) => item.message.id}
        alignment="bottom"
        initialScrollAtEnd
        maintainVisibleContentPosition={{ autoscrollToBottomThreshold: awayPx }}
        onScroll={onScroll}
        testID="messages"
        accessibilityLabel={t("web.channel.messages.label")}
        class="min-h-0 flex-1"
        header={header()}
        footer={footer()}
      >
        {(item) => (
          <View class="px-4">
            <FeedRow
              item={item()}
              here={id()}
              lit={lit() === item().message.number && item().message.channel === id()}
              firstNew={item().message.id === firstNew()}
              inChannel={props.channel?.type === "channel"}
              where={addressOf(item().message)}
              onJump={searching() ? () => router.navigate(messagePath(channelOf(core()?.chat, item().message.channel), item().message.number)) : undefined}
            />
          </View>
        )}
      </List>
      <If when={awayFrom() !== undefined}>
        <View class="absolute bottom-3 w-full items-center">
          <View
            role="button"
            testID="to-latest"
            onPress={toLatest}
            class="h-7 flex-row items-center gap-1.5 rounded-full border border-line bg-elevated px-3 shadow-float transition duration-120 ease-out hover:bg-hover active:translate-y-px"
          >
            <View style={{ transform: [{ rotate: "90deg" }] }}>
              <Icon name="expand" size={12} tone="muted" />
            </View>
            <Text class="text-xs font-medium text-ink">
              {unseen() > 0 ? t("web.channel.messages.newBelow", { n: unseen() }) : t("web.channel.messages.toLatest")}
            </Text>
          </View>
        </View>
      </If>
    </View>
  );
}

/** One row of the feed: its day, the line over the new ones, then a notice or a message. */
function FeedRow(props: {
  item: FeedItem;
  here: string | undefined;
  lit: boolean;
  firstNew: boolean;
  inChannel: boolean;
  where: string | undefined;
  onJump: (() => void) | undefined;
}) {
  const m = () => props.item.message;
  return (
    <View testID={`message-${m().number}`} class="rounded-md" style={props.lit ? { backgroundColor: mix("wheat", 0.25) } : undefined}>
      <If when={props.item.day}>{(day) => <DayLine label={day()} />}</If>
      <If when={props.firstNew}>
        <DayLine label={t("web.channel.messages.newMessages")} tone="new" />
      </If>
      <If
        when={m().kind === "notice" || m().actor.kind === "system"}
        else={
          <MessageRow
            m={m()}
            continues={props.item.continues && !props.firstNew}
            thread={props.item.thread}
            inChannel={props.inChannel}
            where={props.where}
            onJump={props.onJump}
          />
        }
      >
        <Text testID="message-notice" class="px-6 py-2 text-center text-xs leading-relaxed text-muted">
          {m().text}
        </Text>
      </If>
    </View>
  );
}

/** The user's lines on their way here (composing.ts), under the messages: sending, or failed with a retry. */
function PendingLines(props: { channel: string | undefined; messages: readonly ChatMessage[] }) {
  const says = useIntents(chatSay);
  const lines = computed(() => pendingLines(says.list(), props.channel, props.messages));
  return (
    <Each of={lines()} key={(l) => l.key}>
      {(l) => (
        <View testID={`pending-line-${l().state}`} style={{ opacity: l().state === "sending" ? 0.6 : 1 }}>
          <Frame
            face={<UserFace size={36} />}
            name={t("web.channel.messages.user")}
            meta={l().state === "sending" ? t("web.channel.messages.sending") : t("web.channel.messages.notSent")}
          >
            <Text class="text-base text-ink">{l().text}</Text>
            <If when={l().state === "failed"}>
              <View class="mt-1 flex-row items-center gap-2">
                <Text class="min-w-0 shrink truncate text-xs text-berry">{l().reason ?? t("web.channel.messages.notSent")}</Text>
                <View
                  role="button"
                  testID="pending-retry"
                  onPress={() => void says.retry(l().key)}
                  class="flex-row items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover"
                >
                  <Icon name="retry" size={12} tone="muted" />
                  <Text class="text-xs text-muted">{t("web.channel.messages.retrySend")}</Text>
                </View>
                <View
                  role="button"
                  testID="pending-drop"
                  onPress={() => says.drop(l().key)}
                  class="flex-row items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover"
                >
                  <Icon name="close" size={12} tone="muted" />
                  <Text class="text-xs text-muted">{t("web.channel.messages.dropSend")}</Text>
                </View>
              </View>
            </If>
          </Frame>
        </View>
      )}
    </Each>
  );
}

const searchWaitMs = 200;
/** Scrolled up this far from the newest, the way back shows. */
const awayPx = 240;
const litMs = 2500;

function DayLine(props: { label: string; tone?: "new" }) {
  const line = () => (props.tone === "new" ? "bg-berry" : "bg-line");
  return (
    <View class="flex-row items-center gap-3 py-3">
      <View class={`h-px flex-1 ${line()}`} />
      <Text class={`text-xs ${props.tone === "new" ? "text-berry" : "text-muted"}`}>{props.label}</Text>
      <View class={`h-px flex-1 ${line()}`} />
    </View>
  );
}

function Frame(props: {
  face: JSX.Element;
  dot?: JSX.Element;
  name: string;
  meta: string;
  continues?: boolean;
  /** The message it answers, quoted above it. */
  quote?: { channel: string; number: number } | undefined;
  /** The row's tools, given whether the pointer is over the row. */
  tools?: (hovered: boolean) => JSX.Element;
  children: JSX.Element;
}) {
  const hovered = signal(false);
  return (
    <View
      onMouseEnter={() => hovered.set(true)}
      onMouseLeave={() => hovered.set(false)}
      class={`rounded-md px-1 hover:bg-hover ${props.continues === true ? "pt-0.5" : "mt-3 pt-1"}`}
    >
      <If when={props.quote}>
        {(q) => (
          <View class="pl-13">
            <ReplyQuote channel={q().channel} number={q().number} />
          </View>
        )}
      </If>
      <View class="flex-row gap-3">
        <View class="w-10 shrink-0">
          <If when={props.continues !== true}>
            <View class="relative h-9 w-9">
              {props.face}
              <If when={props.dot}>
                <View class="absolute -right-0.5 -bottom-0.5">{props.dot}</View>
              </If>
            </View>
          </If>
        </View>
        <View class="min-w-0 flex-1 pb-0.5">
          <If when={props.continues !== true}>
            <View class="flex-row items-baseline gap-2">
              <Text class="text-sm font-semibold text-ink">{props.name}</Text>
              <Text class="min-w-0 shrink truncate text-xs text-muted">{props.meta}</Text>
            </View>
          </If>
          {props.children}
        </View>
      </View>
      {props.tools?.(hovered())}
    </View>
  );
}

/** A dispatch said as what it is for the user: who went to which issue; one line until it is opened, then the whole task. */
function Dispatch(props: { m: ChatMessage }) {
  const open = signal(false);
  const sent = useSession(() => props.m.session);
  const issue = useIssue(() => sent()?.issue);
  return (
    <View testID="dispatch" class="flex-row items-start gap-1.5">
      <View class="min-w-0 flex-1">
        <If
          when={open()}
          else={
            <If
              when={issue()}
              else={
                <View role="button" onPress={() => open.set(true)} class="w-full">
                  <Text class="truncate text-base text-ink">{plainText(props.m.text)}</Text>
                </View>
              }
            >
              {(i) => (
                <View class="min-w-0 flex-row items-baseline gap-1.5">
                  <Text class="shrink-0 text-base text-ink">{t("web.channel.messages.sentTo", { who: sent()?.name ?? "" })}</Text>
                  <A href={`/issues/${i().id}`} testID="dispatch-issue" class="min-w-0 shrink">
                    <Text class="truncate text-base font-medium text-water">{`#${i().number} ${i().title}`}</Text>
                  </A>
                  <If when={i().repo}>{(p) => <Text class="shrink-0 text-xs text-muted">{p()}</Text>}</If>
                </View>
              )}
            </If>
          }
        >
          <Markdown text={props.m.text} mentions />
        </If>
      </View>
      <View
        role="button"
        onPress={() => open.set(!open())}
        accessibilityLabel={open() ? t("web.channel.messages.foldDispatch") : t("web.channel.messages.unfoldDispatch")}
        accessibilityState={{ expanded: open() }}
        tooltip={<Bubble text={open() ? t("web.channel.messages.foldDispatch") : t("web.channel.messages.unfoldDispatch")} />}
        class="h-6 w-6 shrink-0 items-center justify-center rounded-md opacity-70 transition duration-120 ease-out hover:bg-hover hover:opacity-100"
      >
        <Icon name={open() ? "collapse" : "enlarge"} size={12} tone="muted" />
      </View>
    </View>
  );
}

function MessageRow(props: {
  m: ChatMessage;
  continues: boolean;
  thread?: Channel | undefined;
  inChannel?: boolean;
  where?: string | undefined;
  onJump?: (() => void) | undefined;
}) {
  const sessionsById = useSessionsMap();
  const editing = () => editingId() === props.m.id;
  const setEditing = (on: boolean) => setEditingId(on ? props.m.id : undefined);
  const orchestrators = useOrchestrators();
  const nameOf = (who: string) =>
    who === userId
      ? t("web.channel.messages.user")
      : (orchestrators().find((a) => a.id === who)?.name ??
        (who === defaultOrchestrator ? t("web.channel.orchestrator") : undefined) ??
        sessionsById().get(who)?.name ??
        who);
  const meta = () =>
    [props.where ? t("web.channel.messages.inThread", { address: props.where }) : "", props.m.pinned !== undefined ? t("web.channel.messages.pinned") : ""]
      .filter(Boolean)
      .join(" · ");
  const agentOf = useAgent(() => props.m.agent);
  const workerSession = useSession(() => (actorRoleOf(props.m.actor) === "worker" ? props.m.from : undefined));
  const session = workerSession;
  const who = () => {
    if (actorRoleOf(props.m.actor) !== "worker") return "";
    const agent = agentOf();
    const s = session();
    return [`@${props.m.from}`, s ? (runtimeLabel[s.runtime] ?? s.runtime) : "", agent?.duty ? dutyShort(agent.duty) : ""].filter(Boolean).join(" ");
  };
  const outcome = () => outcomeTag[props.m.outcome ?? "completed"];
  return (
    <Frame
      face={<SenderFace m={props.m} />}
      dot={<If when={session()}>{(s) => <Dot tone={phaseDot(s().phase)} size={8} />}</If>}
      name={props.m.actor.kind === "user" ? t("web.channel.messages.user") : props.m.name}
      meta={`${who() ? `${who()}  ` : ""}${workbenchClock(props.m.at)}${meta() ? `  ${meta()}` : ""}`}
      continues={props.continues}
      quote={props.m.replyTo !== undefined ? { channel: props.m.channel, number: props.m.replyTo } : undefined}
      tools={(hovered) => (
        <If
          when={props.onJump}
          else={
            <If when={props.m.deleted === undefined && !props.where}>
              <MessageTools m={props.m} inChannel={props.inChannel === true} onEdit={() => setEditing(true)} shown={hovered} />
            </If>
          }
        >
          {(jump) => (
            <If when={hovered}>
              <View
                role="button"
                testID="message-jump"
                onPress={() => jump()()}
                class="absolute -top-3 right-2 z-10 rounded-md border border-line bg-elevated px-2 py-0.5 shadow-float"
              >
                <Text class="text-xs text-ink">{t("web.channel.more.jump")}</Text>
              </View>
            </If>
          )}
        </If>
      )}
    >
      <If when={props.m.kind === "dispatch"}>
        <View class="mb-1">
          <Tag icon="send" label={t("web.channel.messages.dispatch")} tone="wait" />
        </View>
      </If>
      <If when={props.m.kind === "report"}>
        <View class="mb-1">
          <Tag icon={outcome().icon} label={outcome().label} tone={outcome().tone} />
        </View>
      </If>
      <If
        when={props.m.kind === "dispatch" && props.m.deleted === undefined}
        else={
          <If when={editing()} else={<MessageBody m={props.m} />}>
            <EditBox m={props.m} onDone={() => setEditing(false)} />
          </If>
        }
      >
        <Dispatch m={props.m} />
      </If>
      <If when={props.m.attachments.length > 0 ? props.m.attachments : undefined}>{(files) => <Attachments files={files()} />}</If>
      <If when={props.m.deleted === undefined ? props.m.artifact : undefined}>{(card) => <ArtifactCard card={card()} />}</If>
      <If when={props.m.deleted === undefined && (props.m.blocks?.length ?? 0) > 0 ? props.m.blocks : undefined}>
        {(blocks) => (
          <View class="mt-1 gap-1">
            <Each of={blocks()} key={(b) => `${b.artifactId}:${b.blockId}`}>
              {(b) => (
                <View
                  testID={`message-quoted-block-${b().blockId}`}
                  class="max-w-md flex-row items-center gap-2 rounded-md border-l-2 border-wheat bg-hover px-2 py-1"
                >
                  <Icon name="artifacts" size={12} tone="muted" />
                  <Text class="min-w-0 flex-1 truncate text-xs text-muted">
                    {t("web.channel.messages.quotedBlock", {
                      title: b().title,
                      text: b().deleted === true ? t("web.channel.messages.quotedGone") : (b().text ?? ""),
                    })}
                  </Text>
                </View>
              )}
            </Each>
          </View>
        )}
      </If>
      <If when={props.m.deleted === undefined && props.m.text !== "" ? props.m.text : undefined}>{(text) => <LinkedMessages text={text()} />}</If>
      <If when={props.m.deleted === undefined && props.m.embeds.length > 0 ? props.m.embeds : undefined}>{(embeds) => <Embeds embeds={embeds()} />}</If>
      <If when={props.m.reactions.length > 0}>
        <Reactions m={props.m} names={nameOf} />
      </If>
      <If when={props.m.spent && props.m.kind === "report" ? props.m.spent : undefined}>
        {(spent) => (
          <View class="mt-1 flex-row items-center gap-1">
            <Icon name="spend" size={12} tone="muted" />
            <Text class="text-xs text-muted">{t("web.channel.messages.spent", { spent: spentText(spent()) })}</Text>
          </View>
        )}
      </If>
      <If when={actorRoleOf(props.m.actor) === "orchestrator" && props.m.kind !== "dispatch"}>
        <RunSteps session={props.m.from} run={props.m.run} orchestrator />
      </If>
      <If when={actorRoleOf(props.m.actor) === "worker" && props.m.kind === "report"}>
        <RunSteps session={props.m.from} run={props.m.run} />
      </If>
      <If when={props.thread}>{(thread) => <ThreadPreview thread={thread()} />}</If>
    </Frame>
  );
}

function ThreadPreview(props: { thread: Channel }) {
  const router = useRouter();
  const now = useNow();
  const unread = () => unreadIn(props.thread);
  const last = () => props.thread.last;
  const session = useThreadOwner(() => props.thread);
  return (
    <View
      role="button"
      testID={`thread-preview-${props.thread.id}`}
      onPress={() => router.navigate(chatPath(props.thread))}
      class="mt-2 w-full max-w-xl gap-1.5 rounded-lg border border-line bg-page px-3 py-2 transition duration-120 ease-out hover:bg-hover"
    >
      <View class="w-full flex-row items-center gap-1.5">
        <Icon name="thread" size={14} tone="accent" />
        <Text class="text-sm font-semibold text-accent">
          {props.thread.replies > 0
            ? t("web.channel.replies", { n: props.thread.replies })
            : props.thread.subjectKind === "issue"
              ? t("web.channel.issues.thread")
              : t("web.channel.names.thread")}
        </Text>
        <If when={unread() > 0}>
          <Tag label={t("web.channel.messages.unread", { n: unread() })} tone="ok" />
        </If>
        <If when={session()} else={<View class="flex-1" />}>
          {(s) => (
            <>
              <PhaseGlyph phase={s().phase} size={12} />
              <Text class="min-w-0 flex-1 truncate text-xs text-muted">{phaseText(s(), now())}</Text>
            </>
          )}
        </If>
        <View class="opacity-60">
          <Icon name="expand" size={12} tone="muted" />
        </View>
      </View>
      <If when={last()}>
        {(m) => (
          <View class="w-full flex-row items-center gap-2">
            <Text class="shrink-0 text-sm font-medium text-ink">{m().from === userId ? t("web.channel.messages.user") : m().name}</Text>
            <Text class="min-w-0 flex-1 truncate text-sm text-muted">{plainText(m().text)}</Text>
            <Text class="shrink-0 text-xs text-muted">{workbenchClock(m().at)}</Text>
          </View>
        )}
      </If>
    </View>
  );
}
