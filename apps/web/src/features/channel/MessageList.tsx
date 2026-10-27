import { spentText } from "../../base/format";
import { chatWording } from "./words";
import { wording } from "@vibevalley/protocol/words";
import { createEffect, createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type ChatMessage, type Channel, type MessageHit, orchestratorAgent, type Outcome, ownerId } from "@vibevalley/protocol";
import { api } from "../../base/api";
import { Attachments, EditBox, MessageBody, MessageTools, Reactions, ReplyQuote } from "./MessageParts";
import { chatPath, feedOf, parentAt, phaseDot, phaseText, roleShort, runtimeLabel, threadOwnerOf, unreadIn, orchestratorTyping, workbenchClock } from "./rules";
import { aria, useNow } from "../../base/util";
import { useRouter } from "../../base/router";
import { useCore } from "../../base/frame";
import { OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { Dot, PhaseGlyph, SenderFace, Tag, ThinkingDots } from "./bits";
import { useMarkRead } from "./data";
import { followed, useFollowed, useMessage } from "./follow";
import { TurnSteps } from "../session";
import { useAgent } from "../../base/agents";

const outcomeTag: Record<Outcome, { label: string; fill: string; icon: string }> = {
  completed: { label: wording().outcome.completed, fill: "#b4cb7c", icon: "icon-harvest" },
  failed: { label: wording().outcome.failed, fill: "#e9a092", icon: "icon-bug" },
  interrupted: { label: wording().outcome.interrupted, fill: "#e2c995", icon: "icon-shovel" },
};

/** A channel's messages, newest at the bottom; filter keeps those containing it. */
export function MessageList(props: { channel: Channel | undefined; filter?: string; emptyText: string }) {
  const core = useCore();
  const id = () => props.channel?.id;
  const said = useFollowed(id);
  useMarkRead(() => props.channel);
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

  return (
    // Reversed, so it stays at the newest while you are there and older pages load above without a jump.
    <div class="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto" role="log" aria-label={chatWording().messages.label}>
      <div class="flex flex-col px-4 pt-3 pb-4">
        <div class="flex justify-center pb-2">
          <Show
            when={hasOlder() && !searching()}
            fallback={
              <span class="text-xs text-muted">
                {searching()
                  ? hits() === undefined
                    ? chatWording().messages.searching
                    : chatWording().messages.containing((props.filter ?? "").trim())
                  : chatWording().messages.start}
              </span>
            }
          >
            <button type="button" onClick={() => void followed.loadOlder(id()!)} class="cursor-pointer rounded px-2 py-1 text-xs text-faint hover:text-ink">
              {chatWording().messages.older}
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
          <p class="py-8 text-center text-sm text-muted">{searching() ? chatWording().messages.notFound : props.emptyText}</p>
        </Show>
        <For each={items()} keyed={(item) => item.message.id}>
          {(item) => (
            <div class={item().message.at > shownAt ? "transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0" : ""}>
              <Show when={item().day}>{(day) => <DayLine label={day()} />}</Show>
              <Show when={item().message.id === firstNew()}>
                <DayLine label={chatWording().messages.newMessages} tone="new" />
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
                  />
                }
              >
                <p class="px-6 py-2 text-center text-xs leading-relaxed text-muted">{item().message.text}</p>
              </Show>
            </div>
          )}
        </For>
        <Show when={typing()}>
          <Frame
            face={<OrchestratorFace size={36} />}
            name={chatWording().orchestrator}
            meta={typing() === "speaking" ? chatWording().messages.typing : chatWording().messages.thinking}
          >
            <div class="flex h-5 items-center">
              <ThinkingDots />
            </div>
          </Frame>
        </Show>
      </div>
    </div>
  );
}

const searchWaitMs = 200;

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
  above?: JSX.Element;
  tools?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class={["group/m relative rounded-md px-1 hover:bg-hover", props.continues ? "pt-0.5" : "mt-3 pt-1"]}>
      {props.tools}
      <Show when={props.above}>
        <div class="pl-[52px]">{props.above}</div>
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
        aria-label={open() ? chatWording().messages.foldDispatch : chatWording().messages.unfoldDispatch}
        aria-expanded={aria(open())}
        class="mt-[5px] cursor-pointer"
      >
        <Icon name={open() ? "button-collapse" : "button-enlarge"} size={12} class="opacity-50 group-hover/d:opacity-100" />
      </button>
    </div>
  );
}

function MessageRow(props: { m: ChatMessage; continues: boolean; thread?: Channel; inChannel?: boolean; where?: string | undefined }) {
  const core = useCore();
  const [editing, setEditing] = createSignal(false);
  const nameOf = (who: string) =>
    who === ownerId
      ? chatWording().messages.owner
      : who === orchestratorAgent
        ? chatWording().orchestrator
        : ((core()?.sessions ?? []).find((h) => h.id === who)?.name ?? who);
  const meta = () =>
    [props.where ? chatWording().messages.inThread(props.where) : "", props.m.pinned !== undefined ? chatWording().messages.pinned : ""]
      .filter(Boolean)
      .join(" · ");
  const agentOf = useAgent(() => props.m.agent);
  const session = () => (props.m.fromKind === "session" ? (core()?.sessions ?? []).find((h) => h.id === props.m.from) : undefined);
  const who = () => {
    if (props.m.fromKind !== "session") return "";
    const agent = agentOf();
    const s = session();
    return [`@${props.m.from}`, s ? (runtimeLabel[s.runtime] ?? s.runtime) : "", agent?.role ? roleShort(agent.role) : ""].filter(Boolean).join(" ");
  };
  const outcome = () => outcomeTag[props.m.outcome ?? "completed"];
  return (
    <Frame
      face={<SenderFace m={props.m} />}
      dot={session() && <Dot tone={phaseDot(session()!.phase)} size={11} />}
      name={props.m.fromKind === "owner" ? chatWording().messages.owner : props.m.name}
      meta={`${who() ? `${who()}  ` : ""}${workbenchClock(props.m.at)}${meta() ? `  ${meta()}` : ""}`}
      continues={props.continues}
      above={props.m.replyTo !== undefined ? <ReplyQuote channel={props.m.channel} number={props.m.replyTo} /> : undefined}
      tools={
        props.m.deleted === undefined && !props.where ? <MessageTools m={props.m} inChannel={!!props.inChannel} onEdit={() => setEditing(true)} /> : undefined
      }
    >
      <Show when={props.m.kind === "dispatch"}>
        <div class="mb-1">
          <Tag icon="icon-seeds" label={chatWording().messages.dispatch} fill="#f3d38a" />
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
      <Show when={(props.m.reactions ?? []).length > 0}>
        <Reactions m={props.m} names={nameOf} />
      </Show>
      <Show when={props.m.spent && props.m.kind === "report" ? props.m.spent : undefined}>
        {(spent) => (
          <div class="mt-1 flex items-center gap-1 text-xs text-muted">
            <Icon name="icon-coin" size={12} />
            {chatWording().messages.spent(spentText(spent()))}
          </div>
        )}
      </Show>
      <Show when={props.m.fromKind === "orchestrator" && props.m.kind !== "dispatch"}>
        <TurnSteps session={orchestratorAgent} run={props.m.run} orchestrator />
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
        <Icon name="button-thread" size={16} />
        <span class="text-sm font-semibold text-accent">
          {props.thread.replies > 0 ? chatWording().replies(props.thread.replies) : chatWording().jobs.thread}
        </span>
        <Show when={unread() > 0}>
          <Tag label={chatWording().messages.unread(unread())} fill="#b4cb7c" />
        </Show>
        <Show when={session()} fallback={<span class="flex-1" />}>
          {(s) => (
            <>
              <PhaseGlyph phase={s().phase} />
              <span class="min-w-0 flex-1 truncate text-xs text-muted">{phaseText(s(), now())}</span>
            </>
          )}
        </Show>
        <Icon name="button-next" size={12} class="opacity-60 group-hover/t:opacity-100" />
      </span>
      <Show when={last()}>
        {(m) => (
          <span class="flex w-full items-center gap-2 text-sm">
            <span class="shrink-0 font-medium">{m().from === ownerId ? chatWording().messages.owner : m().name}</span>
            <span class="min-w-0 flex-1 truncate text-muted">{m().text}</span>
            <span class="shrink-0 text-xs text-muted">{workbenchClock(m().at)}</span>
          </span>
        )}
      </Show>
    </button>
  );
}
