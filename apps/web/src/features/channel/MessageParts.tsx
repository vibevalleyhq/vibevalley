// What a message shows beside its words, and what the owner does to it in the workbench's chat: the line it answers,
// a deletion or an edit, its files, its reactions, and the row of tools on hover (react, reply, open a thread, pin, edit,
// delete). Every change is the server's (channel.*): the list shows it once the channel's follower hears it back.

import { chatWording } from "./words";
import { createSignal, For, Show, untrack } from "solid-js";
import { type Attachment, attachmentPath, type ChatMessage, ownerId } from "@vibevalley/protocol";
import { api, reasonOf } from "../../base/api";
import { useRouter } from "../../base/router";
import { Icon } from "../../ui/Icon";
import { Markdown } from "../../ui/Markdown";
import { toast } from "../../ui/toasts";
import { aria, autofocus } from "../../base/util";
import { drafts } from "./draft";
import { useMessage } from "./follow";

/** The reactions offered at a press; any other can still come from an agent. */
export const quickReactions = ["👍", "❤️", "😂", "🎉", "👀", "✅", "🙏", "🤔"];

const sizeText = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const nameOf = (m: ChatMessage) => (m.from === ownerId ? chatWording().messages.owner : m.name);

/** A server call whose result the follower brings back; a refusal shows as a toast. */
const run = (call: () => Promise<unknown>) => void call().catch((e) => toast(reasonOf(e), "bad"));

/** The line a message answers, from its channel, as it is now. */
export function ReplyQuote(props: { channel: string; number: number }) {
  const answered = useMessage(() => ({ channel: props.channel, number: props.number }));
  return (
    <div class="mb-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
      <Icon name="button-back" size={10} class="opacity-60" />
      <Show when={answered()} fallback={<span>#{props.number}</span>}>
        {(m) =>
          m().deleted !== undefined ? (
            <span class="italic">{chatWording().messages.replyGone}</span>
          ) : (
            <>
              <span class="shrink-0 font-medium text-ink">{nameOf(m())}</span>
              <span class="min-w-0 truncate">
                {m().text ||
                  m()
                    .attachments?.map((a) => a.name)
                    .join("、")}
              </span>
            </>
          )
        }
      </Show>
    </div>
  );
}

/** Its words, or that it is gone; an edit says so after the words. */
export function MessageBody(props: { m: ChatMessage }) {
  return (
    <Show when={props.m.deleted === undefined} fallback={<p class="text-sm text-muted italic">{chatWording().messages.deleted}</p>}>
      <Show when={props.m.text}>
        <Markdown text={props.m.text} mentions />
      </Show>
      <Show when={props.m.edited !== undefined}>
        <span class="text-xs text-faint">{chatWording().messages.edited}</span>
      </Show>
    </Show>
  );
}

/** Pictures shown as they are; any other file a chip to open it by. */
export function Attachments(props: { files: readonly Attachment[] }) {
  return (
    <div class="mt-1 flex flex-wrap gap-2">
      <For each={props.files} keyed={(f) => f.id}>
        {(f) => (
          <Show
            when={f().type.startsWith("image/")}
            fallback={
              <a
                href={attachmentPath(f().id)}
                target="_blank"
                rel="noreferrer"
                class="flex items-center gap-2 rounded-md border border-line bg-page px-3 py-2 text-sm hover:bg-hover"
              >
                <Icon name="button-folder" size={16} />
                <span class="flex min-w-0 flex-col">
                  <span class="max-w-64 truncate">{f().name}</span>
                  <span class="text-xs text-muted">{chatWording().messages.file(sizeText(f().size))}</span>
                </span>
              </a>
            }
          >
            <a href={attachmentPath(f().id)} target="_blank" rel="noreferrer" class="block">
              <img src={attachmentPath(f().id)} alt={f().name} class="max-h-64 max-w-80 rounded-md border border-line object-contain" loading="lazy" />
            </a>
          </Show>
        )}
      </For>
    </div>
  );
}

/** Each reaction with how many; the owner's own is marked, and pressing one takes the owner's back or adds it. */
export function Reactions(props: { m: ChatMessage; names: (id: string) => string }) {
  return (
    <div class="mt-1 flex flex-wrap gap-1">
      <For each={props.m.reactions ?? []} keyed={(r) => r.emoji}>
        {(r) => {
          const mine = () => r().by.includes(ownerId);
          return (
            <button
              type="button"
              aria-pressed={aria(mine())}
              title={chatWording().messages.reactedBy(r().emoji, r().by.map(props.names).join("、"))}
              onClick={() => run(() => api.channel.reaction.toggle({ id: props.m.id, emoji: r().emoji }))}
              class={[
                "flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
                mine() ? "border-accent bg-selected" : "border-line bg-page hover:bg-hover",
              ]}
            >
              <span>{r().emoji}</span>
              <span>{r().by.length}</span>
            </button>
          );
        }}
      </For>
    </div>
  );
}

const tool = "inline-flex size-7 cursor-pointer items-center justify-center rounded hover:bg-hover";

/** The row of tools over a message on hover: react, reply, open a thread (in a channel), pin, and edit and delete. */
export function MessageTools(props: { m: ChatMessage; inChannel: boolean; onEdit: () => void }) {
  const router = useRouter();
  const [picking, setPicking] = createSignal(false);
  const [sure, setSure] = createSignal(false);
  const editable = () => props.m.from === ownerId && props.m.kind === "chat";
  return (
    <div
      role="toolbar"
      aria-label={chatWording().tools.label}
      class="absolute -top-3 right-2 z-10 hidden items-center gap-0.5 rounded-md border border-line bg-page p-0.5 shadow-float group-focus-within/m:flex group-hover/m:flex"
    >
      <Show when={picking()}>
        <div role="group" aria-label={chatWording().tools.pick} class="flex items-center gap-0.5 border-r border-line pr-0.5">
          <For each={quickReactions}>
            {(emoji) => (
              <button
                type="button"
                class={tool}
                aria-label={emoji}
                onClick={() => {
                  setPicking(false);
                  run(() => api.channel.reaction.toggle({ id: props.m.id, emoji }));
                }}
              >
                {emoji}
              </button>
            )}
          </For>
        </div>
      </Show>
      <button type="button" class={tool} aria-label={chatWording().tools.react} title={chatWording().tools.react} onClick={() => setPicking(!picking())}>
        <Icon name="icon-hand" size={16} />
      </button>
      <button
        type="button"
        class={tool}
        aria-label={chatWording().tools.reply}
        title={chatWording().tools.reply}
        onClick={() => drafts.reply(props.m.channel, props.m)}
      >
        <Icon name="button-back" size={14} />
      </button>
      <Show when={props.inChannel}>
        <button
          type="button"
          class={tool}
          aria-label={chatWording().tools.thread}
          title={chatWording().tools.thread}
          onClick={() =>
            run(async () => {
              const thread = await api.channel.thread.create({ id: props.m.id });
              router.navigate(`/chat/${thread}`);
            })
          }
        >
          <Icon name="button-thread" size={16} />
        </button>
      </Show>
      <button
        type="button"
        class={tool}
        aria-label={props.m.pinned !== undefined ? chatWording().tools.unpin : chatWording().tools.pin}
        title={props.m.pinned !== undefined ? chatWording().tools.unpin : chatWording().tools.pin}
        aria-pressed={aria(props.m.pinned !== undefined)}
        onClick={() => run(() => api.channel.pin.toggle({ id: props.m.id }))}
      >
        <Icon name="icon-star" size={16} class={props.m.pinned !== undefined ? "" : "opacity-60"} />
      </button>
      <Show when={editable()}>
        <button type="button" class={tool} aria-label={chatWording().tools.edit} title={chatWording().tools.edit} onClick={() => props.onEdit()}>
          <Icon name="button-edit" size={14} />
        </button>
      </Show>
      <button
        type="button"
        class={[tool, { "bg-berry/15": sure() }]}
        aria-label={sure() ? chatWording().tools.sure : chatWording().tools.remove}
        title={sure() ? chatWording().tools.sure : chatWording().tools.remove}
        onBlur={() => setSure(false)}
        onClick={() => {
          if (!sure()) return void setSure(true);
          setSure(false);
          run(() => api.channel.message.delete({ id: props.m.id }));
        }}
      >
        <Icon name="button-delete" size={14} />
      </button>
    </div>
  );
}

/** The owner's own words, changed in place: Enter saves, Esc keeps them as they were. */
export function EditBox(props: { m: ChatMessage; onDone: () => void }) {
  // The words as they were when editing began: a change heard meanwhile does not move the box under the owner's hands.
  const { id, text: was } = untrack(() => props.m);
  const done = () => untrack(() => props.onDone)();
  const [text, setText] = createSignal(was);
  const save = () => {
    const words = text().trim();
    if (!words || words === was) return done();
    run(async () => {
      await api.channel.message.update({ id, text: words });
      done();
    });
  };
  return (
    <div class="mt-0.5">
      <textarea
        ref={autofocus()}
        value={text()}
        aria-label={chatWording().tools.edit}
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
        class="block w-full resize-none rounded-md border border-focus bg-page px-2 py-1.5 text-base outline-none [field-sizing:content]"
      />
      <p class="mt-1 text-xs text-muted">{chatWording().tools.editHint}</p>
    </div>
  );
}
