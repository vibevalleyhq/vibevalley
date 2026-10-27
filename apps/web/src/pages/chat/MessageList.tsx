import { chatWording } from "./words";
import { wording } from "@vibevalley/protocol/words";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type ChatMessage, type Conversation, orchestratorAgent, type Outcome, ownerId } from "@vibevalley/protocol";
import {
  chatPath,
  feedOf,
  parentAt,
  phaseDot,
  phaseText,
  roleShort,
  runtimeLabel,
  spentText,
  threadOwnerOf,
  unreadIn,
  orchestratorTyping,
  workbenchClock,
} from "../../rules/chat";
import { aria, useNow } from "../../base/util";
import { useRouter } from "../../base/router";
import { useCore } from "../../base/frame";
import { OrchestratorFace } from "../../ui/Face";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { Dot, PhaseGlyph, SenderFace, Tag, ThinkingDots } from "./bits";
import { useMarkRead } from "./data";
import { rooms, useMessage, useRoom } from "../../data/rooms";
import { TurnSteps } from "./WorkLog";
import { useAgent } from "../../data/agents";

const outcomeTag: Record<Outcome, { label: string; fill: string; icon: string }> = {
  completed: { label: wording().outcome.completed, fill: "#b4cb7c", icon: "icon-harvest" },
  failed: { label: wording().outcome.failed, fill: "#e9a092", icon: "icon-bug" },
  interrupted: { label: wording().outcome.interrupted, fill: "#e2c995", icon: "icon-shovel" },
};

/** A conversation's messages, newest at the bottom; filter keeps those containing it. */
export function MessageList(props: { conversation: Conversation | undefined; filter?: string; emptyText: string }) {
  const core = useCore();
  const id = () => props.conversation?.id;
  const room = useRoom(id);
  useMarkRead(() => props.conversation);
  // Rows newer than this arrived while the list was shown: they rise in; the rest just appear.
  const shownAt = Date.now();

  const items = createMemo(() => feedOf(core()?.chat, room().messages, props.filter ?? ""));
  const parent = useMessage(() => (props.conversation ? parentAt(core()?.chat, props.conversation) : undefined));
  const searching = () => (props.filter ?? "").trim() !== "";
  const hasOlder = () => !!id() && room().messages.length > 0 && !room().complete;
  const typing = () => orchestratorTyping(core(), props.conversation);

  return (
    // Reversed, so it stays at the newest while you are there and older pages load above without a jump.
    <div class="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto" role="log" aria-label={chatWording().messages.label}>
      <div class="flex flex-col px-4 pt-3 pb-4">
        <div class="flex justify-center pb-2">
          <Show
            when={hasOlder() && !searching()}
            fallback={
              <span class="text-xs text-muted">
                {searching() ? chatWording().messages.containing((props.filter ?? "").trim()) : chatWording().messages.start}
              </span>
            }
          >
            <button type="button" onClick={() => void rooms.loadOlder(id()!)} class="cursor-pointer rounded px-2 py-1 text-xs text-faint hover:text-ink">
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
        <Show when={items().length === 0}>
          <p class="py-8 text-center text-sm text-muted">{searching() ? chatWording().messages.notFound : props.emptyText}</p>
        </Show>
        <For each={items()} keyed={(item) => item.message.id}>
          {(item) => (
            <div class={item().message.at > shownAt ? "transition-[opacity,translate] duration-200 ease-out starting:translate-y-2 starting:opacity-0" : ""}>
              <Show when={item().day}>{(day) => <DayLine label={day()} />}</Show>
              <Show
                when={item().message.kind === "notice" || item().message.fromKind === "system"}
                fallback={<MessageRow m={item().message} continues={item().continues} thread={item().thread} />}
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

function DayLine(props: { label: string }) {
  return (
    <div class="flex items-center gap-3 py-3 text-xs text-muted" role="separator">
      <span class="h-px flex-1 bg-line" />
      {props.label}
      <span class="h-px flex-1 bg-line" />
    </div>
  );
}

function Frame(props: { face: JSX.Element; dot?: JSX.Element; name: string; meta: string; continues?: boolean; children: JSX.Element }) {
  return (
    <div class={["flex gap-3 rounded-md px-1 hover:bg-hover", props.continues ? "pt-0.5" : "mt-3 pt-1"]}>
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

function MessageRow(props: { m: ChatMessage; continues: boolean; thread?: Conversation }) {
  const core = useCore();
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
      meta={`${who() ? `${who()}  ` : ""}${workbenchClock(props.m.at)}`}
      continues={props.continues}
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
      <Show when={props.m.kind === "dispatch"} fallback={<Markdown text={props.m.text} mentions />}>
        <Dispatch text={props.m.text} />
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

function ThreadPreview(props: { thread: Conversation }) {
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
