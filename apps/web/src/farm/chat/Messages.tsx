// The rows of the farm's chat window: bubbles for what is said (yours on the right in green), a turn report with its
// outcome, the thread a message has, the message a thread hangs from, and a long message folded to its first lines.

import { spentText } from "../../base/format";
import { farmWording } from "../words";
import { wording } from "@vibevalley/protocol/words";
import { createSignal, For, Match, Show, Switch, untrack } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Agent, attachmentPath, type ChatMessage, type Channel, type Outcome, ownerId } from "@vibevalley/protocol";
import { channelOf, drafts, EmojiPicker, messagePath, quickReactions, useMessage } from "../../features/channel";
import { api, reasonOf } from "../../base/api";
import { toast } from "../../ui/toasts";
import { aria, autofocus } from "../../base/util";
import { farmClock, readsLong } from "./text";
import { AgentFace, OrchestratorFace, OwnerFace } from "../../ui/Face";
import { useCore } from "../../base/frame";
import { PxMarkdown, SpriteIcon } from "../../ui/pixel";

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
  const size = () => props.size ?? 30;
  return (
    <Switch fallback={<AgentFace agentId={agentId()} look={agent()?.look} runtime={session()?.runtime ?? agent()?.runtime} size={size()} />}>
      <Match when={props.m.fromKind === "owner"}>
        <OwnerFace size={size()} />
      </Match>
      <Match when={props.m.fromKind === "orchestrator"}>
        <OrchestratorFace size={size()} agent={props.m.from} />
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

export function ChatRow(props: {
  mine: boolean;
  first: boolean;
  face?: JSX.Element;
  name?: JSX.Element;
  title?: string;
  actions?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <div class={["group/m relative flex items-start gap-2", { "pt-1": props.first, "justify-end": props.mine }]}>
      <Show when={props.mine}>{props.actions}</Show>
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
      <Show when={!props.mine}>{props.actions}</Show>
    </div>
  );
}

const menuItem = "w-full cursor-pointer px-2 py-1 text-left text-[12px] text-bark-900 hover:bg-leaf-300/40";

/** What the owner can do to a message from the farm's window: the same requests as the workbench's tools. */
function MessageMenu(props: { m: ChatMessage; onEdit: () => void }) {
  const core = useCore();
  const [open, setOpen] = createSignal(false);
  const [sure, setSure] = createSignal(false);
  const [every, setEvery] = createSignal(false);
  let plus: HTMLButtonElement | undefined;
  const run = (call: () => Promise<unknown>) => {
    setOpen(false);
    setEvery(false);
    void call().catch((e) => toast(reasonOf(e), "bad"));
  };
  const editable = () => props.m.from === ownerId && props.m.kind === "chat";
  return (
    <div class="relative self-center">
      <button
        type="button"
        aria-label={farmWording().chat.actions.open}
        title={farmWording().chat.actions.open}
        aria-expanded={aria(open())}
        onClick={() => {
          setOpen(!open());
          setSure(false);
        }}
        class="cursor-pointer p-0.5 opacity-0 group-hover/m:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
      >
        <SpriteIcon name="button-more" size={16} />
      </button>
      <Show when={open()}>
        <div
          role="menu"
          aria-label={farmWording().chat.actions.open}
          class="absolute right-0 bottom-full z-30 mb-1 w-40 border-2 border-cream-300 bg-cream-50 py-1 shadow-px"
        >
          <div role="group" aria-label={farmWording().chat.actions.react} class="flex flex-wrap gap-0.5 px-1 pb-1">
            <For each={quickReactions}>
              {(emoji) => (
                <button
                  type="button"
                  aria-label={emoji}
                  class="cursor-pointer px-1 text-[14px] hover:bg-leaf-300/40"
                  onClick={() => run(() => api.channel.reaction.toggle({ id: props.m.id, emoji }))}
                >
                  {emoji}
                </button>
              )}
            </For>
            <button
              type="button"
              ref={(el) => (plus = el)}
              aria-label={farmWording().chat.actions.moreEmoji}
              aria-expanded={aria(every())}
              class="cursor-pointer px-1 hover:bg-leaf-300/40"
              onClick={() => setEvery(!every())}
            >
              <SpriteIcon name="button-add" size={12} />
            </button>
          </div>
          <button type="button" role="menuitem" class={menuItem} onClick={() => run(async () => drafts.reply(props.m.channel, props.m))}>
            {farmWording().chat.actions.reply}
          </button>
          <button
            type="button"
            role="menuitem"
            class={menuItem}
            onClick={() =>
              run(async () => {
                await navigator.clipboard.writeText(location.origin + messagePath(channelOf(core()?.chat, props.m.channel), props.m.number));
                toast(farmWording().chat.actions.copied);
              })
            }
          >
            {farmWording().chat.actions.copyLink}
          </button>
          <Show when={editable()}>
            <button
              type="button"
              role="menuitem"
              class={menuItem}
              onClick={() => {
                setOpen(false);
                untrack(() => props.onEdit)();
              }}
            >
              {farmWording().chat.actions.edit}
            </button>
          </Show>
          <button
            type="button"
            role="menuitem"
            class={[menuItem, "text-berry"]}
            onClick={() => (sure() ? run(() => api.channel.message.delete({ id: props.m.id })) : setSure(true))}
          >
            {sure() ? farmWording().chat.actions.sure : farmWording().chat.actions.remove}
          </button>
        </div>
      </Show>
      <Show when={every()}>
        <EmojiPicker
          anchor={plus}
          onClose={() => setEvery(false)}
          onPick={(emoji) => {
            const id = untrack(() => props.m.id);
            run(() => api.channel.reaction.toggle({ id, emoji }));
          }}
        />
      </Show>
    </div>
  );
}

function FarmEdit(props: { m: ChatMessage; onDone: () => void }) {
  const { id, text: was } = untrack(() => props.m);
  const done = () => untrack(() => props.onDone)();
  const [text, setText] = createSignal(was);
  const save = () => {
    const words = text().trim();
    if (!words || words === was) return done();
    void api.channel.message
      .update({ id, text: words })
      .then(done)
      .catch((e) => toast(reasonOf(e), "bad"));
  };
  return (
    <div class="flex flex-col gap-1">
      <textarea
        ref={autofocus()}
        value={text()}
        aria-label={farmWording().chat.actions.edit}
        onInput={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            done();
          }
        }}
        class="min-w-48 resize-none bg-cream-50 px-1.5 py-1 font-pixel text-[12px] text-bark-900 outline-none [field-sizing:content] shadow-[inset_0_0_0_2px_#c8a46e]"
      />
      <span class={small}>{farmWording().chat.actions.editHint}</span>
    </div>
  );
}

export function ChatBubble(props: { m: ChatMessage; mine: boolean; first: boolean; face?: JSX.Element; tag?: string; folded?: boolean; after?: JSX.Element }) {
  const [editing, setEditing] = createSignal(false);
  return (
    <ChatRow
      mine={props.mine}
      first={props.first}
      face={props.face}
      name={<SenderName m={props.m} />}
      title={farmClock(props.m.at)}
      actions={props.m.deleted === undefined ? <MessageMenu m={props.m} onEdit={() => setEditing(true)} /> : undefined}
    >
      <Show when={props.tag}>
        <span class="mb-1 inline-block bg-wheat/40 px-1.5 text-[12px] text-bark-800">{props.tag}</span>
      </Show>
      <Show when={props.m.replyTo}>{(n) => <Answers channel={props.m.channel} number={n()} />}</Show>
      <Show when={props.m.deleted === undefined} fallback={<p class={["italic", small]}>{farmWording().chat.deleted}</p>}>
        <Show
          when={editing()}
          fallback={
            <Show when={props.folded} fallback={<ChatText text={props.m.text} link={props.mine ? "text-cream-50" : "text-leaf-700"} />}>
              <DispatchNote text={props.m.text} />
            </Show>
          }
        >
          <FarmEdit m={props.m} onDone={() => setEditing(false)} />
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
