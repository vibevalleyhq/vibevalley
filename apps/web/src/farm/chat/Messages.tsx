// The rows of the farm's chat window: bubbles for what is said (yours on the right in green), a turn report with its
// outcome, the thread a message has, the message a thread hangs from, and a long message folded to its first lines.

import { spentText } from "../../base/format";
import { farmWording } from "../words";
import { wording } from "@vibevalley/protocol/words";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Agent, attachmentPath, type ChatMessage, type Channel, type Outcome } from "@vibevalley/protocol";
import { useMessage } from "../../features/channel";
import { farmClock, readsLong } from "./text";
import { AgentFace, OrchestratorFace, OwnerFace } from "../../ui/Face";
import { useCore } from "../../base/frame";
import { PxMarkdown, SpriteIcon } from "../../ui/pixel";

import { usePrefs } from "../../base/prefs";

const small = "font-pixel text-[12px] leading-4 text-bark-500";

/** A message's text; a long one shows its first lines until opened. */
export function ChatText(props: { text: string; link?: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <Show when={readsLong(props.text)} fallback={<PxMarkdown text={props.text} mentions />}>
      <div class="flex flex-col items-start">
        <div class={open() ? "" : "max-h-[117px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]"}>
          <PxMarkdown text={props.text} mentions />
        </div>
        <button type="button" onClick={() => setOpen(!open())} class={["mt-1 cursor-pointer text-[12px] hover:underline", props.link ?? "text-leaf-700"]}>
          {open() ? farmWording().chat.less : farmWording().chat.more}
        </button>
      </div>
    </Show>
  );
}

/** A dispatch note: one line until tapped. */
function DispatchNote(props: { text: string }) {
  const [open, setOpen] = createSignal(false);
  return (
    <button
      type="button"
      aria-label={open() ? farmWording().chat.foldDispatch : farmWording().chat.unfoldDispatch}
      onClick={() => setOpen(!open())}
      class="group flex w-full cursor-pointer items-start gap-1.5 text-left"
    >
      <span class="min-w-0 flex-1">
        <Show when={open()} fallback={<span class="block truncate">{props.text.replace(/\s+/g, " ").trim()}</span>}>
          <PxMarkdown text={props.text} mentions />
        </Show>
      </span>
      <SpriteIcon name={open() ? "button-collapse" : "button-enlarge"} size={12} class="mt-1 opacity-60 group-hover:opacity-100" />
    </button>
  );
}

export function FaceOf(props: { m: ChatMessage; agents: ReadonlyMap<string, Agent>; size?: number }) {
  const core = useCore();
  const session = () => core()?.sessions.find((s) => s.id === (props.m.session ?? props.m.from));
  const agentId = () => props.m.agent ?? session()?.agent ?? props.m.from;
  const agent = () => props.agents.get(agentId());
  const look = usePrefs((p) => p.orchestratorLook);
  const size = () => props.size ?? 30;
  return (
    <Switch fallback={<AgentFace agentId={agentId()} look={agent()?.look} runtime={session()?.runtime ?? agent()?.runtime} size={size()} />}>
      <Match when={props.m.fromKind === "owner"}>
        <OwnerFace size={size()} />
      </Match>
      <Match when={props.m.fromKind === "orchestrator"}>
        <OrchestratorFace size={size()} look={look()} />
      </Match>
    </Switch>
  );
}

export function SenderName(props: { m: ChatMessage }) {
  return (
    <Show when={props.m.fromKind === "session"} fallback={<>{props.m.name}</>}>
      {props.m.name} <span class="font-mono text-bark-500">@{props.m.from}</span>
    </Show>
  );
}

export function ChatRow(props: { mine: boolean; first: boolean; face?: JSX.Element; name?: JSX.Element; title?: string; children: JSX.Element }) {
  return (
    <div class={["flex items-start gap-2", { "pt-1": props.first, "justify-end": props.mine }]}>
      <Show when={!props.mine}>
        <span class="w-[30px] shrink-0">{props.first ? props.face : null}</span>
      </Show>
      <div class={["flex max-w-[84%] flex-col", props.mine ? "items-end" : "items-start"]}>
        <Show when={!props.mine && props.first && props.name}>
          <span class={["mx-1 mb-0.5", small]}>{props.name}</span>
        </Show>
        <div
          title={props.title}
          class={[
            // Capped by its column: a one-line dispatch note is as wide as its whole line until it truncates.
            "max-w-full px-3 py-2 text-[12px] leading-[1.625]",
            props.mine
              ? "bg-leaf-500 text-cream-50 shadow-[0_2px_0_0_#3f6427]"
              : "border-[1.5px] border-cream-300 bg-cream-100 text-bark-900 shadow-[0_2px_0_0_#7a5f4029]",
          ]}
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}

export function ChatBubble(props: { m: ChatMessage; mine: boolean; first: boolean; face?: JSX.Element; tag?: string; folded?: boolean; after?: JSX.Element }) {
  return (
    <ChatRow mine={props.mine} first={props.first} face={props.face} name={<SenderName m={props.m} />} title={farmClock(props.m.at)}>
      <Show when={props.tag}>
        <span class="mb-1 inline-block bg-wheat/40 px-1.5 text-[12px] text-bark-800">{props.tag}</span>
      </Show>
      <Show when={props.m.replyTo}>{(n) => <Answers channel={props.m.channel} number={n()} />}</Show>
      <Show when={props.m.deleted === undefined} fallback={<p class={["italic", small]}>{farmWording().chat.deleted}</p>}>
        <Show when={props.folded} fallback={<ChatText text={props.m.text} link={props.mine ? "text-cream-50" : "text-leaf-700"} />}>
          <DispatchNote text={props.m.text} />
        </Show>
        <Show when={props.m.edited !== undefined}>
          <span class={small}>{farmWording().chat.edited}</span>
        </Show>
        <Show when={props.m.attachments}>
          {(files) => (
            <div class="mt-1 flex flex-wrap gap-1.5">
              <For each={files()} keyed={(f) => f.id}>
                {(f) => (
                  <a href={attachmentPath(f().id)} target="_blank" rel="noreferrer" class="block text-[13px] underline">
                    <Show when={f().type.startsWith("image/")} fallback={f().name}>
                      <img src={attachmentPath(f().id)} alt={f().name} class="max-h-40 max-w-56 object-contain" loading="lazy" />
                    </Show>
                  </a>
                )}
              </For>
            </div>
          )}
        </Show>
      </Show>
      <Show when={(props.m.reactions ?? []).length > 0}>
        <div class="mt-1 flex flex-wrap gap-1">
          <For each={props.m.reactions ?? []} keyed={(r) => r.emoji}>
            {(r) => (
              <span class="bg-cream-200 px-1.5 text-[12px] text-bark-800">
                {r().emoji} {r().by.length}
              </span>
            )}
          </For>
        </div>
      </Show>
      {props.after}
    </ChatRow>
  );
}

function Answers(props: { channel: string; number: number }) {
  const m = useMessage(() => ({ channel: props.channel, number: props.number }));
  return (
    <p class={["mb-0.5 truncate", small]}>
      {farmWording().chat.replyTo(m()?.name ?? `#${props.number}`, m()?.deleted === undefined ? (m()?.text ?? "") : farmWording().chat.deleted)}
    </p>
  );
}

const outcomeTag: Record<Outcome, [label: string, fill: string, ink: string]> = {
  completed: [wording().outcome.completed, "#e5a93c66", "#2f1f13"],
  failed: [wording().outcome.failed, "#c84a3a26", "#c84a3a"],
  interrupted: [wording().outcome.interrupted, "#e2c995", "#67482d"],
};

export function ChatReport(props: { m: ChatMessage; first: boolean; face: JSX.Element; steps?: JSX.Element }) {
  const tag = () => outcomeTag[props.m.outcome ?? "completed"];
  return (
    <ChatRow mine={false} first={props.first} face={props.face} name={<SenderName m={props.m} />} title={farmClock(props.m.at)}>
      <span class="mb-1 inline-block px-1.5 text-[12px]" style={{ background: tag()[1], color: tag()[2] }}>
        {tag()[0]}
      </span>
      <ChatText text={props.m.text} />
      <Show when={props.m.spent}>{(spent) => <p class={["mt-1", small]}>{farmWording().chat.spent(spentText(spent()))}</p>}</Show>
      {props.steps}
    </ChatRow>
  );
}

export function ThreadChip(props: { thread: Channel; unread: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={() => props.onOpen()}
      class="mt-1.5 flex cursor-pointer items-center gap-1.5 border border-cream-300 bg-cream-50/80 px-2 py-0.5 hover:bg-cream-50"
    >
      <SpriteIcon name="button-thread" size={12} />
      <span class="text-[12px] text-leaf-700">{props.thread.replies > 0 ? farmWording().chat.replies(props.thread.replies) : farmWording().chat.thread}</span>
      <Show when={props.unread > 0}>
        <span class="bg-berry px-1.5 text-[12px] text-cream-50">{farmWording().chat.newCount(props.unread)}</span>
      </Show>
      <SpriteIcon name="button-next" size={12} />
    </button>
  );
}

export function ParentMessage(props: { m: ChatMessage; face: JSX.Element }) {
  return (
    <div class="mb-1 flex items-start gap-2 bg-cream-100 px-2.5 py-2">
      {props.face}
      <div class="min-w-0 flex-1">
        <p class={small}>
          <SenderName m={props.m} /> · {farmClock(props.m.at)}
        </p>
        <div class="text-[12px] text-bark-800">
          <ChatText text={props.m.text} />
        </div>
      </div>
    </div>
  );
}
