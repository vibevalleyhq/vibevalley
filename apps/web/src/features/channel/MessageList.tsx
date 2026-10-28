import { t } from "@vibevalley/i18n";
import type { IconName } from "../../ui/icons";
import { spentText } from "../../base/format";

import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type ChatMessage, type Channel, type MessageHit, defaultOrchestrator, type Outcome, ownerId } from "@vibevalley/protocol";
import { api } from "../../base/api";
import { Attachments, EditBox, Embeds, LinkedMessages, MessageBody, MessageTools, Reactions, ReplyQuote } from "./MessageParts";
import {
  channelOf,
  messagePath,
  chatPath,
  feedOf,
  parentAt,
  phaseDot,
  phaseText,
  dutyShort,
  runtimeLabel,
  threadOwnerOf,
  unreadIn,
  orchestratorTyping,
  workbenchClock,
} from "./rules";
import { aria, useNow } from "../../base/util";
import { useRouter } from "../../base/router";
import { useCore } from "../../base/frame";
import { OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { Dot, PhaseGlyph, SenderFace, Tag, ThinkingDots } from "./bits";
import { useMarkRead } from "./data";
import { editingId, setEditingId } from "./draft";
import { followed, useFollowed, useMessage } from "./follow";
import { TurnSteps } from "../session";
import { useAgent, useOrchestrators } from "../../base/agents";

const outcomeTag: Record<Outcome, { label: string; fill: string; icon: IconName }> = {
  completed: { label: t("shared.outcome.completed"), fill: "#b4cb7c", icon: "check" },
  failed: { label: t("shared.outcome.failed"), fill: "#e9a092", icon: "cross" },
  interrupted: { label: t("shared.outcome.interrupted"), fill: "#e2c995", icon: "stop" },
};

/** A channel's messages, newest at the bottom; filter keeps those containing it. */
export function MessageList(props: { channel: Channel | undefined; filter?: string; point?: number | undefined; emptyText: string }) {
  const core = useCore();
  const router = useRouter();
  const id = () => props.channel?.id;
  const said = useFollowed(id);
  useMarkRead(() => props.channel);
  let log: HTMLDivElement | undefined;
  // The message an address points at: older pages are read until it is among them, then it is scrolled to and lit up a
  // while. A string, so a change elsewhere in the list does not scroll again.
  const [lit, setLit] = createSignal<number>();
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
      const [what, at, n] = step.split(":") as [string, string, string];
      if (what === "older") return void followed.loadOlder(at);
      requestAnimationFrame(() => log?.querySelector(`[data-number="${n}"]`)?.scrollIntoView({ block: "center" }));
      setLit(Number(n));
      const off = setTimeout(() => setLit(undefined), litMs);
      return () => clearTimeout(off);
    },
  );
  // Rows newer than this arrived while the list was shown: they rise in; the rest just appear.
  const shownAt = Date.now();

  // Where the owner had read to as the list opened: the new ones below a line.
  const readTo = untrack(() => props.channel?.read ?? 0);
  const searching = () => (props.filter ?? "").trim() !== "";
  // A search is the server's, over the whole channel and its threads, not only the pages read here.
  const [hits, setHits] = createSignal<readonly MessageHit[] | undefined>();
  createEffect(
    () => ({ text: (props.filter ?? "").trim(), at: id() }),
    ({ text, at }) => {
      setHits(undefined);
      if (!text || !at) return;
      const wait = setTimeout(() => void api.channel.message.search({ text, channel: at }).then(setHits, () => setHits([])), searchWaitMs);
      return () => clearTimeout(wait);
    },
  );
  const items = createMemo(() =>
    searching()
      ? feedOf(
          core()?.chat,
          [...(hits() ?? [])].reverse().map((h) => h.message),
        )
      : feedOf(core()?.chat, said().messages),
  );
  const addressOf = (m: ChatMessage) => (m.channel === id() ? undefined : hits()?.find((h) => h.message.id === m.id)?.address);
  const firstNew = () => (searching() ? undefined : said().messages.find((m) => m.number > readTo && m.from !== ownerId)?.id);
  const parent = useMessage(() => (props.channel ? parentAt(core()?.chat, props.channel) : undefined));
  const hasOlder = () => !!id() && said().messages.length > 0 && !said().complete;
  const typing = () => orchestratorTyping(core(), props.channel);
  const orchestrators = useOrchestrators();

  return (
    // Reversed, so it stays at the newest while you are there and older pages load above without a jump.
    <div
      ref={(el) => (log = el)}
      class="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto"
      role="log"
      aria-label={t("web.channel.messages.label")}
      data-testid="messages"
    >
      <div class="flex flex-col px-4 pt-3 pb-4">
        <div class="flex justify-center pb-2">
          <Show
            when={hasOlder() && !searching()}
            fallback={
              <span class="text-xs text-muted">
                {searching()
                  ? hits() === undefined
                    ? t("web.channel.messages.searching")
                    : t("web.channel.messages.containing", { text: (props.filter ?? "").trim() })
                  : t("web.channel.messages.start")}
              </span>
            }
          >
            <button type="button" onClick={() => void followed.loadOlder(id()!)} class="cursor-pointer rounded px-2 py-1 text-xs text-faint hover:text-ink">
              {t("web.channel.messages.older")}
            </button>
          </Show>
        </div>
        <Show when={parent()}>
          {(m) => (
            <div class="mb-2 border-b border-line pb-2">
              <MessageRow m={m()} continues={false} />
            </div>
          )}
        </Show>
        <Show when={items().length === 0 && (!searching() || hits() !== undefined)}>
          <p data-testid="messages-empty" class="py-8 text-center text-sm text-muted">
            {searching() ? t("web.channel.messages.notFound") : props.emptyText}
          </p>
        </Show>
        <For each={items()} keyed={(item) => item.message.id}>
          {(item) => (
            <div
              data-testid="message"
              data-key={item().message.id}
              data-from={item().message.fromKind}
              data-kind={item().message.kind}
              data-number={item().message.channel === id() ? item().message.number : undefined}
              class={[
                "rounded-md transition-[opacity,translate,background-color] duration-200 ease-out",
                {
                  "starting:translate-y-2 starting:opacity-0": item().message.at > shownAt,
                  "bg-wheat/25": lit() === item().message.number && item().message.channel === id(),
                },
              ]}
            >
              <Show when={item().day}>{(day) => <DayLine label={day()} />}</Show>
              <Show when={item().message.id === firstNew()}>
                <DayLine label={t("web.channel.messages.newMessages")} tone="new" />
              </Show>
              <Show
                when={item().message.kind === "notice" || item().message.fromKind === "system"}
                fallback={
                  <MessageRow
                    m={item().message}
                    continues={item().continues && item().message.id !== firstNew()}
                    thread={item().thread}
                    inChannel={props.channel?.type === "channel"}
                    where={addressOf(item().message)}
                    {...(searching()
                      ? { onJump: () => router.navigate(messagePath(channelOf(core()?.chat, item().message.channel), item().message.number)) }
                      : {})}
                  />
                }
              >
                <p class="px-6 py-2 text-center text-xs leading-relaxed text-muted">{item().message.text}</p>
              </Show>
            </div>
          )}
        </For>
        <Show when={typing()}>
          {(typer) => (
            <Frame
              face={<OrchestratorFace size={36} agent={typer().agent} />}
              name={orchestrators().find((a) => a.id === typer().agent)?.name || t("web.channel.orchestrator")}
              meta={typer().mood === "speaking" ? t("web.channel.messages.typing") : t("web.channel.messages.thinking")}
            >
              <div class="flex h-5 items-center">
                <ThinkingDots />
              </div>
            </Frame>
          )}
        </Show>
      </div>
    </div>
  );
}

const searchWaitMs = 200;
const litMs = 2500;

function DayLine(props: { label: string; tone?: "new" }) {
  return (
    <div class={["flex items-center gap-3 py-3 text-xs", props.tone === "new" ? "text-berry" : "text-muted"]} role="separator">
      <span class={["h-px flex-1", props.tone === "new" ? "bg-berry" : "bg-line"]} />
      {props.label}
      <span class={["h-px flex-1", props.tone === "new" ? "bg-berry" : "bg-line"]} />
    </div>
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
  tools?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class={["group/m relative rounded-md px-1 hover:bg-hover", props.continues ? "pt-0.5" : "mt-3 pt-1"]}>
      {props.tools}
      <Show when={props.quote}>
        {(q) => (
          <div class="pl-[52px]">
            <ReplyQuote channel={q().channel} number={q().number} />
          </div>
        )}
      </Show>
      <div class="flex gap-3">
        <div class="relative w-10 shrink-0">
          <Show when={!props.continues}>
            {props.face}
            <Show when={props.dot}>
              <span class="absolute top-[26px] left-[26px]">{props.dot}</span>
            </Show>
          </Show>
        </div>
        <div class="min-w-0 flex-1 pb-0.5">
          <Show when={!props.continues}>
            <div class="flex items-baseline gap-2">
              <span class="text-sm font-semibold">{props.name}</span>
              <span class="truncate text-xs text-muted">{props.meta}</span>
            </div>
          </Show>
          {props.children}
        </div>
      </div>
    </div>
  );
}

/** A dispatch: one line until it is opened, then the whole task in its place. */
function Dispatch(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="group/d flex items-start gap-1.5">
      <div class="min-w-0 flex-1">
        <Show
          when={open()}
          fallback={
            <button type="button" onClick={() => setOpen(true)} class="block w-full cursor-pointer truncate text-left text-base">
              {props.text.replace(/\s+/g, " ").trim()}
            </button>
          }
        >
          <Markdown text={props.text} mentions />
        </Show>
      </div>
      <button
        type="button"
        onClick={() => setOpen(!open())}
        aria-label={open() ? t("web.channel.messages.foldDispatch") : t("web.channel.messages.unfoldDispatch")}
        aria-expanded={aria(open())}
        class="mt-[5px] cursor-pointer"
      >
        <Icon name={open() ? "collapse" : "enlarge"} size={12} class="opacity-50 group-hover/d:opacity-100" />
      </button>
    </div>
  );
}

function MessageRow(props: { m: ChatMessage; continues: boolean; thread?: Channel; inChannel?: boolean; where?: string | undefined; onJump?: () => void }) {
  const core = useCore();
  const editing = () => editingId() === props.m.id;
  const setEditing = (on: boolean) => setEditingId(on ? props.m.id : undefined);
  const orchestrators = useOrchestrators();
  const nameOf = (who: string) =>
    who === ownerId
      ? t("web.channel.messages.owner")
      : (orchestrators().find((a) => a.id === who)?.name ??
        (who === defaultOrchestrator ? t("web.channel.orchestrator") : undefined) ??
        (core()?.sessions ?? []).find((h) => h.id === who)?.name ??
        who);
  const meta = () =>
    [props.where ? t("web.channel.messages.inThread", { address: props.where }) : "", props.m.pinned !== undefined ? t("web.channel.messages.pinned") : ""]
      .filter(Boolean)
      .join(" · ");
  const agentOf = useAgent(() => props.m.agent);
  const session = () => (props.m.fromKind === "session" ? (core()?.sessions ?? []).find((h) => h.id === props.m.from) : undefined);
  const who = () => {
    if (props.m.fromKind !== "session") return "";
    const agent = agentOf();
    const s = session();
    return [`@${props.m.from}`, s ? (runtimeLabel[s.runtime] ?? s.runtime) : "", agent?.duty ? dutyShort(agent.duty) : ""].filter(Boolean).join(" ");
  };
  const outcome = () => outcomeTag[props.m.outcome ?? "completed"];
  return (
    <Frame
      face={<SenderFace m={props.m} />}
      dot={session() && <Dot tone={phaseDot(session()!.phase)} size={11} />}
      name={props.m.fromKind === "owner" ? t("web.channel.messages.owner") : props.m.name}
      meta={`${who() ? `${who()}  ` : ""}${workbenchClock(props.m.at)}${meta() ? `  ${meta()}` : ""}`}
      continues={props.continues}
      quote={props.m.replyTo !== undefined ? { channel: props.m.channel, number: props.m.replyTo } : undefined}
      tools={
        props.onJump ? (
          <button
            type="button"
            onClick={() => props.onJump?.()}
            class="absolute -top-3 right-2 z-10 hidden cursor-pointer rounded-md border border-line bg-page px-2 py-0.5 text-xs shadow-float group-focus-within/m:block group-hover/m:block"
          >
            {t("web.channel.more.jump")}
          </button>
        ) : props.m.deleted === undefined && !props.where ? (
          <MessageTools m={props.m} inChannel={!!props.inChannel} onEdit={() => setEditing(true)} />
        ) : undefined
      }
    >
      <Show when={props.m.kind === "dispatch"}>
        <div class="mb-1">
          <Tag icon="send" label={t("web.channel.messages.dispatch")} fill="#f3d38a" />
        </div>
      </Show>
      <Show when={props.m.kind === "report"}>
        <div class="mb-1">
          <Tag icon={outcome().icon} label={outcome().label} fill={outcome().fill} />
        </div>
      </Show>
      <Show
        when={props.m.kind === "dispatch" && props.m.deleted === undefined}
        fallback={
          <Show when={editing()} fallback={<MessageBody m={props.m} />}>
            <EditBox m={props.m} onDone={() => setEditing(false)} />
          </Show>
        }
      >
        <Dispatch text={props.m.text} />
      </Show>
      <Show when={props.m.attachments}>{(files) => <Attachments files={files()} />}</Show>
      <Show when={props.m.deleted === undefined && props.m.text}>{(text) => <LinkedMessages text={text()} />}</Show>
      <Show when={props.m.deleted === undefined && (props.m.embeds ?? []).length > 0 ? props.m.embeds : undefined}>
        {(embeds) => <Embeds embeds={embeds()} />}
      </Show>
      <Show when={(props.m.reactions ?? []).length > 0}>
        <Reactions m={props.m} names={nameOf} />
      </Show>
      <Show when={props.m.spent && props.m.kind === "report" ? props.m.spent : undefined}>
        {(spent) => (
          <div class="mt-1 flex items-center gap-1 text-xs text-muted">
            <Icon name="spend" size={12} />
            {t("web.channel.messages.spent", { spent: spentText(spent()) })}
          </div>
        )}
      </Show>
      <Show when={props.m.fromKind === "orchestrator" && props.m.kind !== "dispatch"}>
        <TurnSteps session={props.m.from} run={props.m.run} orchestrator />
      </Show>
      <Show when={props.m.fromKind === "session" && props.m.kind === "report"}>
        <TurnSteps session={props.m.from} run={props.m.run} />
      </Show>
      <Show when={props.thread}>{(thread) => <ThreadPreview thread={thread()} />}</Show>
    </Frame>
  );
}

function ThreadPreview(props: { thread: Channel }) {
  const core = useCore();
  const router = useRouter();
  const now = useNow();
  const unread = () => unreadIn(props.thread);
  const last = () => props.thread.last;
  const session = () => threadOwnerOf(props.thread, core()?.sessions ?? []);
  return (
    <button
      type="button"
      onClick={() => router.navigate(chatPath(props.thread))}
      class="group/t mt-2 flex w-full max-w-xl cursor-pointer flex-col gap-1 rounded-lg border border-line px-3 py-2 text-left hover:bg-hover focus-visible:border-focus"
    >
      <span class="flex w-full items-center gap-1.5">
        <Icon name="thread" size={16} />
        <span class="text-sm font-semibold text-accent">
          {props.thread.replies > 0
            ? t("web.channel.replies", { n: props.thread.replies })
            : props.thread.subjectKind === "issue"
              ? t("web.channel.jobs.thread")
              : t("web.channel.names.thread")}
        </span>
        <Show when={unread() > 0}>
          <Tag label={t("web.channel.messages.unread", { n: unread() })} fill="#b4cb7c" />
        </Show>
        <Show when={session()} fallback={<span class="flex-1" />}>
          {(s) => (
            <>
              <PhaseGlyph phase={s().phase} />
              <span class="min-w-0 flex-1 truncate text-xs text-muted">{phaseText(s(), now())}</span>
            </>
          )}
        </Show>
        <Icon name="expand" size={12} class="opacity-60 group-hover/t:opacity-100" />
      </span>
      <Show when={last()}>
        {(m) => (
          <span class="flex w-full items-center gap-2 text-sm">
            <span class="shrink-0 font-medium">{m().from === ownerId ? t("web.channel.messages.owner") : m().name}</span>
            <span class="min-w-0 flex-1 truncate text-muted">{m().text}</span>
            <span class="shrink-0 text-xs text-muted">{workbenchClock(m().at)}</span>
          </span>
        )}
      </Show>
    </button>
  );
}
